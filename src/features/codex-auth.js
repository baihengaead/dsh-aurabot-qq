// ChatGPT（Codex 订阅）的 OAuth：浏览器登录 → 存令牌 → 过期自动刷新。
//
// 走 Codex CLI 那条流程（client_id 是公开的 app_EMoamEEZ73f0CkXaXp7hrann）：
//   授权 https://auth.openai.com/oauth/authorize
//   换票 https://auth.openai.com/oauth/token
// 为什么不用 "Sign in with ChatGPT" 动态客户端流程（/api/accounts/authorize）：
//   那条流程发的 token 只面向 api.openai.com（scope 里是 resource.invoke + chatgpt.tokens.use.direct），
//   JWT 里没有 chatgpt_account_id；而图片端点 chatgpt.com/backend-api/codex/images/generations
//   必须带 chatgpt-account-id 头，否则一律 401。所以生图必须用这条 token。
//
// 令牌只存在本机 data/codex-auth.json，不写日志、不回传给面板。

import { createHash, randomBytes } from 'node:crypto'
import { existsSync, unlinkSync } from 'node:fs'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { dataDir, readJson, writeJson } from '../core/store.js'

const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
const AUTHORIZE_URL = 'https://auth.openai.com/oauth/authorize'
const TOKEN_URL = 'https://auth.openai.com/oauth/token'
const SCOPE = 'openid profile email offline_access'
const CALLBACK_HOST = '127.0.0.1'
const CALLBACK_PORT = 1455
const CALLBACK_PATH = '/auth/callback'
// 这条流程的 redirect_uri 必须是注册过的固定地址（Codex CLI 用的就是它），不能随机端口
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`
const JWT_CLAIM_PATH = 'https://api.openai.com/auth'
const REFRESH_SKEW_MS = 2 * 60_000

/** PKCE：verifier 随机串，challenge 是它的 sha256(b64url)。 */
export function createPkce () {
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

/** 拼授权地址（参数同 Codex CLI）。 */
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

/** access token 里的 chatgpt_account_id（生图必需）。 */
export function accountIdOf (accessToken, idToken) {
  for (const t of [accessToken, idToken]) {
    const p = decodeJwt(t)
    const id = p && p[JWT_CLAIM_PATH] && p[JWT_CLAIM_PATH].chatgpt_account_id
    if (typeof id === 'string' && id) return id
  }
  return ''
}

/** id_token 里的邮箱。 */
export function emailOf (idToken) {
  const p = decodeJwt(idToken)
  return (p && (p.email || (p[JWT_CLAIM_PATH] && p[JWT_CLAIM_PATH].email))) || ''
}

/** 从用户粘贴的整条回调地址 / code 里取出授权码。 */
export function parseAuthInput (input) {
  const v = String(input || '').trim()
  if (!v) return {}
  let url = null
  try { url = new URL(v) } catch (error) {}
  if (url) {
    // 1455 打不开时浏览器地址栏里仍是一条 localhost 回调地址，这里不强校验主机名
    return {
      code: url.searchParams.get('code') || '',
      state: url.searchParams.get('state') || '',
      error: url.searchParams.get('error') || '',
    }
  }
  if (v.includes('code=')) {
    const q = new URLSearchParams(v.replace(/^[^?]*\?/, ''))
    return { code: q.get('code') || '', state: q.get('state') || '', error: q.get('error') || '' }
  }
  return { code: v, state: '', error: '' }
}

/**
 * 用系统默认浏览器打开链接。
 * ⚠ Windows 上**不能**用 `cmd /c start "" <url>`：链接里的 `&` 会被 cmd 当成命令分隔符，
 *   浏览器只拿到第一个 `&` 之前的部分（授权链接就是这么被截断、登不进去的）。
 *   rundll32 直接收 argv，不经过 shell，`&`、`?`、`=` 都原样带过去。
 */
export function openInBrowser (url, { run = spawn, platform = process.platform } = {}) {
  try {
    const opts = { detached: true, stdio: 'ignore' }
    if (platform === 'win32') run('rundll32', ['url.dll,FileProtocolHandler', url], opts).unref()
    else if (platform === 'darwin') run('open', [url], opts).unref()
    else run('xdg-open', [url], opts).unref()
    return true
  } catch (error) {
    return false
  }
}

/**
 * @param {object} deps
 * @param {object} [deps.log]
 * @param {Function} [deps.fetchImpl] 测试可注入
 * @param {Function} [deps.openUrl] 测试可注入
 */
export function createCodexAuth ({ log, fetchImpl, openUrl } = {}) {
  const doFetch = fetchImpl || ((...a) => globalThis.fetch(...a))
  const file = () => dataDir('codex-auth.json')
  const defaultOpenUrl = (url) => openInBrowser(url)
  let pending = null // { state, verifier, server, status, error, email, needPaste }

  function read () {
    const v = readJson(file(), () => null)
    // 旧格式（没有 accountId，比如之前那版动态客户端流程存下的）一律当没登录：生图必须要账号 ID
    return v && v.access && v.refresh && v.accountId ? v : null
  }

  function save (cred) { writeJson(file(), cred) }

  function clear () {
    try { if (existsSync(file())) unlinkSync(file()) } catch (error) {}
  }

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

  function toCredential (json, prev = {}) {
    if (!json || !json.access_token || !json.refresh_token) {
      throw new Error('登录返回缺字段（access_token / refresh_token）')
    }
    if (typeof json.expires_in !== 'number' || !Number.isFinite(json.expires_in) || json.expires_in <= 0) {
      throw new Error('登录返回的 expires_in 不正常')
    }
    const access = json.access_token
    const idToken = json.id_token || ''
    const accountId = accountIdOf(access, idToken) || prev.accountId || ''
    if (!accountId) {
      throw new Error('登录成功但 token 里没有 chatgpt_account_id（生图要用），请确认这个账号是 ChatGPT Plus/Pro')
    }
    return {
      type: 'oauth',
      access,
      refresh: json.refresh_token,
      expires: Date.now() + json.expires_in * 1000 - REFRESH_SKEW_MS,
      accountId,
      email: emailOf(idToken) || prev.email || '',
    }
  }

  async function postToken (form) {
    const r = await doFetch(TOKEN_URL, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
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

  /** 本地回调服务（固定 1455）；端口被占返回 server=null，面板改用手动粘贴。 */
  function startCallbackServer (state) {
    return new Promise((resolve) => {
      let settle = () => {}
      const result = new Promise((res) => { settle = res })
      const server = createServer((req, res) => {
        const html = (code, body) => { res.writeHead(code, { 'content-type': 'text/html; charset=utf-8' }); res.end(`<meta charset="utf-8">${body}`) }
        try {
          const url = new URL(req.url || '', `http://${CALLBACK_HOST}:${CALLBACK_PORT}`)
          if (url.pathname !== CALLBACK_PATH) return html(404, '回调路径不对')
          const err = url.searchParams.get('error')
          if (err) { html(400, '登录没有完成：' + err); settle({ error: err }); return }
          const code = url.searchParams.get('code') || ''
          const gotState = url.searchParams.get('state') || ''
          if (!code) return html(400, '没有 code')
          if (gotState && gotState !== state) return html(400, 'state 不匹配')
          html(200, '<h2>登录成功，可以关掉这个页面了</h2><p>回到 Aurabot 面板继续。</p>')
          try { server.close() } catch (error) {}
          settle({ code })
        } catch (error) {
          html(500, '处理回调出错')
        }
      })
      server.once('error', () => resolve({ server: null, result: null }))
      server.listen(CALLBACK_PORT, CALLBACK_HOST, () => resolve({ server, result }))
    })
  }

  /** 开始登录：返回授权地址；1455 能起就在后台等回调，否则让用户手动粘贴。 */
  async function startLogin ({ agentName = 'pi', openBrowser = true } = {}) {
    if (pending) cancelLogin('重新发起登录')
    const { verifier, challenge } = createPkce()
    const state = randomBytes(16).toString('hex')
    const url = buildAuthUrl({ challenge, state, originator: agentName })
    const p = { state, verifier, status: 'waiting', error: '', email: '', needPaste: false }
    pending = p
    const cb = await startCallbackServer(state)
    if (cb.server) {
      p.server = cb.server
      cb.result.then(async (r) => {
        try {
          if (r.error) throw new Error('授权失败：' + r.error)
          const cred = await exchange(r.code, verifier)
          p.status = 'done'
          p.email = cred.email || ''
        } catch (error) {
          p.status = 'error'
          p.error = error.message
        }
      }).catch(() => {})
    } else {
      p.needPaste = true
      log?.info?.('本地 1455 端口被占用，改用手动粘贴回调地址')
    }
    if (openBrowser) (openUrl || defaultOpenUrl)(url)
    return { url, needPaste: p.needPaste }
  }

  /** 手动粘贴整条回调地址（或只有 code）。 */
  async function completeLogin (input) {
    const verifier = pending && pending.verifier
    if (!verifier) throw new Error('登录会话已失效，请重新点「登录 ChatGPT」')
    const parsed = parseAuthInput(input)
    if (parsed.error) throw new Error('授权失败：' + parsed.error)
    if (!parsed.code) throw new Error('没找到授权码')
    if (parsed.state && parsed.state !== pending.state) throw new Error('state 不匹配，请重新登录')
    const cred = await exchange(parsed.code, verifier)
    pending.status = 'done'
    pending.email = cred.email || ''
    return cred
  }

  function loginStatus () {
    if (!pending) return { state: read() ? 'done' : 'idle' }
    return { state: pending.status, error: pending.error || '', email: pending.email || '', needPaste: !!pending.needPaste }
  }

  function cancelLogin (why) {
    try { pending?.server?.close?.() } catch (error) {}
    if (pending && pending.status === 'waiting') { pending.status = 'error'; pending.error = why || '已取消' }
    return { ok: true }
  }

  /** 拿可用的 access token（过期就刷新）。 */
  async function ensureAccess ({ force = false } = {}) {
    let c = read()
    if (!c) throw new Error('还没登录 ChatGPT 订阅（生图页点「登录 ChatGPT」）')
    if (force || (Number(c.expires) && Number(c.expires) < Date.now() + REFRESH_SKEW_MS)) {
      const json = await postToken({
        grant_type: 'refresh_token',
        refresh_token: c.refresh,
        client_id: CLIENT_ID,
      })
      const next = toCredential({ refresh_token: c.refresh, ...json }, c)
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
