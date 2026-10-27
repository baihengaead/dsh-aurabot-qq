// ChatGPT（Codex）订阅的 OAuth：浏览器登录 → 存令牌 → 过期自动刷新。
//
// 协议照 OpenAI Codex 的官方实现做（client_id 是 Codex CLI 那个公开的）：
//   授权 https://auth.openai.com/oauth/authorize   （PKCE S256，回调 http://localhost:1455/auth/callback）
//   换票 https://auth.openai.com/oauth/token
// 令牌只存在本机 data/codex-auth.json，access/refresh 不写日志、不回传给面板。

import { createHash, randomBytes } from 'node:crypto'
import { existsSync, readFileSync, unlinkSync } from 'node:fs'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { dataDir, readJson, writeJson } from '../core/store.js'

const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
const AUTH_BASE = 'https://auth.openai.com'
const AUTHORIZE_URL = `${AUTH_BASE}/oauth/authorize`
const TOKEN_URL = `${AUTH_BASE}/oauth/token`
const REDIRECT_URI = 'http://localhost:1455/auth/callback'
const SCOPE = 'openid profile email offline_access'
const CALLBACK_PORT = 1455
const CALLBACK_PATH = '/auth/callback'
const JWT_CLAIM_PATH = 'https://api.openai.com/auth'
const LOGIN_TIMEOUT_MS = 10 * 60_000
const REFRESH_SKEW_MS = 2 * 60_000

/** PKCE：verifier 是随机串，challenge 是它的 sha256(b64url)。 */
export function createPkce () {
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

/** 拼授权地址（参数和官方 Codex 一致）。 */
export function buildAuthUrl ({ challenge, state, originator = 'pi' }) {
  const url = new URL(AUTHORIZE_URL)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', CLIENT_ID)
  url.searchParams.set('redirect_uri', REDIRECT_URI)
  url.searchParams.set('scope', SCOPE)
  url.searchParams.set('code_challenge', challenge)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('state', state)
  url.searchParams.set('id_token_add_organizations', 'true')
  url.searchParams.set('codex_cli_simplified_flow', 'true')
  url.searchParams.set('originator', originator)
  return url.toString()
}

/** 从 JWT 里读 payload（不验签，只用来取 accountId / email）。 */
export function decodeJwt (token) {
  try {
    const parts = String(token || '').split('.')
    if (parts.length !== 3) return null
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
  } catch (error) {
    return null
  }
}

/** access token 里的 chatgpt_account_id。 */
export function accountIdOf (accessToken, idToken) {
  for (const t of [accessToken, idToken]) {
    const p = decodeJwt(t)
    const id = p && p[JWT_CLAIM_PATH] && p[JWT_CLAIM_PATH].chatgpt_account_id
    if (typeof id === 'string' && id) return id
  }
  return ''
}

/** id_token 里的邮箱（给面板显示"登的是哪个号"）。 */
export function emailOf (idToken) {
  const p = decodeJwt(idToken)
  return (p && (p.email || (p[JWT_CLAIM_PATH] && p[JWT_CLAIM_PATH].email))) || ''
}

/** 从用户粘贴的整条回调地址 / code 里取出授权码。 */
export function parseAuthInput (input) {
  const v = String(input || '').trim()
  if (!v) return {}
  try {
    const url = new URL(v)
    return { code: url.searchParams.get('code') || '', state: url.searchParams.get('state') || '' }
  } catch (error) {}
  if (v.includes('code=')) {
    const q = new URLSearchParams(v.replace(/^[^?]*\?/, ''))
    return { code: q.get('code') || '', state: q.get('state') || '' }
  }
  return { code: v }
}

/**
 * @param {object} deps
 * @param {() => object} deps.getLog 日志
 * @param {Function} [deps.fetchImpl] 测试可注入
 * @param {Function} [deps.openUrl] 测试可注入（默认用系统默认浏览器打开）
 */
export function createCodexAuth ({ log, fetchImpl, openUrl } = {}) {
  const doFetch = fetchImpl || ((...a) => fetch(...a))
  const file = () => dataDir('codex-auth.json')
  let pending = null // { state, verifier, at, server, resolve, reject, done, error }

  function read () {
    const v = readJson(file(), () => null)
    return v && v.access && v.refresh ? v : null
  }

  function save (cred) {
    // 令牌只落本机数据目录；不写日志、不回传给面板
    writeJson(file(), cred)
  }

  function clear () {
    try { if (existsSync(file())) unlinkSync(file()) } catch (error) {}
  }

  /** 面板/工具用的只读状态。 */
  function status () {
    const c = read()
    if (!c) return { loggedIn: false }
    return {
      loggedIn: true,
      email: c.email || '',
      accountId: c.accountId || '',
      expires: Number(c.expires) || 0,
      expired: Number(c.expires) > 0 && Number(c.expires) < Date.now(),
    }
  }

  function toCredential (json, idToken) {
    if (!json || !json.access_token || !json.refresh_token || typeof json.expires_in !== 'number') {
      throw new Error('登录返回缺字段（access_token / refresh_token / expires_in）')
    }
    const access = json.access_token
    const accountId = accountIdOf(access, json.id_token || idToken)
    if (!accountId) throw new Error('登录成功但没拿到 accountId（订阅可能没激活）')
    return {
      type: 'oauth',
      access,
      refresh: json.refresh_token,
      expires: Date.now() + json.expires_in * 1000,
      accountId,
      email: emailOf(json.id_token || idToken),
    }
  }

  async function postToken (form) {
    const r = await doFetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form).toString(),
      signal: AbortSignal.timeout(30000),
    })
    const text = await r.text().catch(() => '')
    if (!r.ok) throw new Error(`换取令牌失败（HTTP ${r.status}）：${text.slice(0, 200)}`)
    try { return JSON.parse(text) } catch (error) { throw new Error('换取令牌返回的不是 JSON') }
  }

  async function exchange (code, verifier) {
    const json = await postToken({
      grant_type: 'authorization_code',
      client_id: CLIENT_ID,
      code,
      code_verifier: verifier,
      redirect_uri: REDIRECT_URI,
    })
    const cred = toCredential(json)
    save(cred)
    log?.info?.(`ChatGPT 订阅登录成功：${cred.email || cred.accountId}`)
    return cred
  }

  function defaultOpenUrl (url) {
    try {
      if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref()
      else if (process.platform === 'darwin') spawn('open', [url], { detached: true, stdio: 'ignore' }).unref()
      else spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref()
      return true
    } catch (error) {
      return false
    }
  }

  /** 起一个只监听本机的回调服务；端口被占就返回 server=null（让用户手动粘贴）。 */
  function startCallbackServer (state) {
    return new Promise((resolve) => {
      let settle = () => {}
      const codePromise = new Promise((res) => { settle = res })
      const server = createServer((req, res) => {
        try {
          const url = new URL(req.url, `http://127.0.0.1:${CALLBACK_PORT}`)
          if (url.pathname !== CALLBACK_PATH) { res.writeHead(404); res.end('not found'); return }
          const code = url.searchParams.get('code') || ''
          const gotState = url.searchParams.get('state') || ''
          if (!code) { res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' }); res.end('<meta charset="utf-8">没有 code'); return }
          if (gotState && gotState !== state) { res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' }); res.end('<meta charset="utf-8">state 不匹配'); return }
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
          res.end('<meta charset="utf-8"><h2>登录成功，可以关掉这个页面了</h2><p>回到 Aurabot 面板继续。</p>')
          try { server.close() } catch (error) {}
          settle(code)
        } catch (error) {
          res.writeHead(500); res.end('error')
        }
      })
      server.once('error', () => resolve({ server: null, codePromise: null }))
      server.listen(CALLBACK_PORT, '127.0.0.1', () => resolve({ server, codePromise }))
    })
  }

  /**
   * 开始登录：返回授权地址，并在后台等回调。
   * 面板拿到 url 后自己决定是打开浏览器还是显示给用户复制。
   */
  async function startLogin ({ originator = 'pi', openBrowser = true } = {}) {
    if (pending && pending.state) cancelLogin('重新发起登录')
    const { verifier, challenge } = createPkce()
    const state = randomBytes(16).toString('hex')
    const url = buildAuthUrl({ challenge, state, originator })
    const p = { state, verifier, at: Date.now(), status: 'waiting', error: '', email: '' }
    pending = p
    const cb = await startCallbackServer(state)
    if (cb.server) {
      p.server = cb.server
      cb.codePromise.then(async (code) => {
        try {
          const cred = await exchange(code, verifier)
          p.status = 'done'
          p.email = cred.email || ''
        } catch (error) {
          p.status = 'error'
          p.error = error.message
        }
      }).catch(() => {})
    } else {
      log?.info?.('回调端口 1455 被占用，改用手动粘贴授权码')
    }
    if (openBrowser) (openUrl || defaultOpenUrl)(url)
    return { url, needPaste: !cb.server }
  }

  /** 手动粘贴：整条 http://localhost:1455/auth/callback?code=…&state=… 或只有 code。 */
  async function completeLogin (input) {
    const { code, state } = parseAuthInput(input)
    if (!code) throw new Error('没找到授权码')
    const verifier = pending && pending.verifier
    if (!verifier) throw new Error('登录会话已失效，请重新点「登录 ChatGPT」')
    if (state && pending && state !== pending.state) throw new Error('state 不匹配，请重新登录')
    const cred = await exchange(code, verifier)
    if (pending) { pending.status = 'done'; pending.email = cred.email || '' }
    return cred
  }

  function loginStatus () {
    if (!pending) return { state: read() ? 'done' : 'idle' }
    return { state: pending.status, error: pending.error || '', email: pending.email || '', needPaste: !pending.server }
  }

  function cancelLogin (why) {
    try { pending?.server?.close?.() } catch (error) {}
    if (pending && pending.status === 'waiting') { pending.status = 'error'; pending.error = why || '已取消' }
    return true
  }

  /** 拿可用的 access token（过期就刷新）。 */
  async function ensureAccess ({ force = false } = {}) {
    let c = read()
    if (!c) throw new Error('还没登录 ChatGPT 订阅（生图页点「登录 ChatGPT」）')
    if (force || (Number(c.expires) && Number(c.expires) - REFRESH_SKEW_MS < Date.now())) {
      const json = await postToken({ grant_type: 'refresh_token', refresh_token: c.refresh, client_id: CLIENT_ID })
      const next = { ...c, ...toCredential({ refresh_token: c.refresh, ...json }), refresh: json.refresh_token || c.refresh }
      if (!next.accountId) next.accountId = c.accountId
      save(next)
      log?.debug?.('ChatGPT 订阅令牌已刷新')
      c = next
    }
    return { access: c.access, accountId: c.accountId }
  }

  function logout () {
    cancelLogin('已退出登录')
    pending = null
    clear()
    return { ok: true }
  }

  return { status, startLogin, completeLogin, loginStatus, cancelLogin, ensureAccess, logout }
}
