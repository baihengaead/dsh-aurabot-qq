// ChatGPT（Codex 订阅）的 OAuth：浏览器登录 → 存令牌 → 过期自动刷新。
//
// 走的是新的 "Sign in with ChatGPT" 公开客户端流程（和 DSH 的 oauth/openai-chatgpt.js 一致）：
//   授权 https://auth.openai.com/api/accounts/authorize
//        client_id=dynamic_agent_client（每次登录由服务端下发真正可用的 client_id，从回调里取）
//        ext_agent_host_id=urn:uuid:<本机 UUID>、resource=https://api.openai.com/v1
//        scope 含 chatgpt.tokens.use.direct
//   换票 https://auth.openai.com/api/accounts/oauth/token
// 旧的 Codex CLI 流程（client_id=app_EMoa…、/oauth/authorize）现在会报「缺少必填参数」，不要再走。

import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { existsSync, unlinkSync } from 'node:fs'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { dataDir, readJson, writeJson } from '../core/store.js'

const DYNAMIC_CLIENT_ID = 'dynamic_agent_client'
const AUTHORIZE_URL = 'https://auth.openai.com/api/accounts/authorize'
const TOKEN_URL = 'https://auth.openai.com/api/accounts/oauth/token'
const RESOURCE = 'https://api.openai.com/v1'
const DIRECT_TOKEN_SCOPE = 'chatgpt.tokens.use.direct'
const SCOPE = `openid profile email offline_access resource.invoke ${DIRECT_TOKEN_SCOPE}`
const CALLBACK_HOST = '127.0.0.1'
const CALLBACK_PORT = 1455
const CALLBACK_PATH = '/auth/callback'
const REDIRECT_URI = `http://${CALLBACK_HOST}:${CALLBACK_PORT}${CALLBACK_PATH}`
const JWT_CLAIM_PATH = 'https://api.openai.com/auth'
const REFRESH_SKEW_MS = 3 * 60_000
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** PKCE：verifier 随机串，challenge 是它的 sha256(b64url)。 */
export function createPkce () {
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

/** 拼授权地址（新流程：带 host id / nonce / resource）。 */
export function buildAuthUrl ({ challenge, state, nonce, hostId, redirectUri = REDIRECT_URI, agentName = 'Aurabot' }) {
  const url = new URL(AUTHORIZE_URL)
  url.search = new URLSearchParams({
    client_id: DYNAMIC_CLIENT_ID,
    agent_name_hint: agentName,
    ext_agent_host_id: hostId,
    response_type: 'code',
    redirect_uri: redirectUri,
    resource: RESOURCE,
    scope: SCOPE,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    nonce,
  }).toString()
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

/** id_token 里的邮箱。 */
export function emailOf (idToken) {
  const p = decodeJwt(idToken)
  return (p && (p.email || (p[JWT_CLAIM_PATH] && p[JWT_CLAIM_PATH].email))) || ''
}

/**
 * 解析回调地址 / 手动粘贴的地址：
 * 新流程的回调里会带服务端下发的 client_id，必须一起取出来。
 */
export function parseAuthInput (input, redirectUri = REDIRECT_URI) {
  const v = String(input || '').trim()
  if (!v) return {}
  let url = null
  try { url = new URL(v) } catch (error) {}
  if (url) {
    const want = new URL(redirectUri)
    if (url.origin !== want.origin || url.pathname !== want.pathname) {
      throw new Error(`粘贴的地址必须是以 ${redirectUri} 开头的整条回调地址`)
    }
    return {
      code: url.searchParams.get('code') || '',
      state: url.searchParams.get('state') || '',
      clientId: (url.searchParams.get('client_id') || '').trim(),
      error: url.searchParams.get('error') || '',
    }
  }
  if (v.includes('code=')) {
    const q = new URLSearchParams(v.replace(/^[^?]*\?/, ''))
    return { code: q.get('code') || '', state: q.get('state') || '', clientId: (q.get('client_id') || '').trim(), error: q.get('error') || '' }
  }
  return { code: v, state: '', clientId: '', error: '' }
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
  const deviceFile = () => dataDir('codex-device.json')
  let pending = null // { state, verifier, nonce, server, status, error, email, needPaste }

  /** 本机安装标识（uuid），第一次用时生成并持久化。 */
  function deviceId () {
    const cur = readJson(deviceFile(), () => null)
    if (cur && UUID_RE.test(String(cur.id || ''))) return String(cur.id)
    const id = randomUUID()
    writeJson(deviceFile(), { id })
    return id
  }

  function read () {
    const v = readJson(file(), () => null)
    return v && v.access && v.refresh && v.clientId ? v : null
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

  /** 令牌响应 → 本地凭据。新流程要求返回 scope 里含 chatgpt.tokens.use.direct。 */
  function toCredential (json, clientId, prev = {}) {
    if (!json || !json.access_token || !json.refresh_token) {
      throw new Error('登录返回缺字段（access_token / refresh_token）')
    }
    if (typeof json.expires_in !== 'number' || !Number.isFinite(json.expires_in) || json.expires_in <= 0) {
      throw new Error('登录返回的 expires_in 不正常')
    }
    const scopes = String(json.scope || '').trim().split(/\s+/).filter(Boolean)
    if (scopes.length && !scopes.includes(DIRECT_TOKEN_SCOPE)) {
      throw new Error(`这次授权没拿到 ${DIRECT_TOKEN_SCOPE}（订阅可能没生效）`)
    }
    const access = json.access_token
    const idToken = json.id_token || ''
    const next = {
      type: 'oauth',
      access,
      refresh: json.refresh_token,
      expires: Date.now() + json.expires_in * 1000 - REFRESH_SKEW_MS,
      clientId: clientId || prev.clientId || '',
      scopes: scopes.length ? scopes : (prev.scopes || []),
      accountId: accountIdOf(access, idToken) || prev.accountId || '',
      email: emailOf(idToken) || prev.email || '',
    }
    if (!next.clientId) throw new Error('没拿到服务端下发的 client_id')
    return next
  }

  async function postToken (params) {
    const r = await doFetch(TOKEN_URL, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ ...params, resource: RESOURCE }).toString(),
      signal: AbortSignal.timeout(30000),
    })
    const text = await r.text().catch(() => '')
    if (!r.ok) throw new Error(`换取令牌失败（HTTP ${r.status}）：${text.slice(0, 200)}`)
    try { return JSON.parse(text) } catch (error) { throw new Error('换取令牌返回的不是 JSON') }
  }

  async function exchange (code, verifier, clientId, redirectUri = REDIRECT_URI) {
    if (!clientId) throw new Error('回调里没有 client_id（授权没走动态注册流程？）')
    const json = await postToken({
      grant_type: 'authorization_code',
      client_id: clientId,
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
    })
    const cred = toCredential(json, clientId)
    save(cred)
    log?.info?.(`ChatGPT 订阅登录成功：${cred.email || cred.accountId || '(已登录)'}`)
    return cred
  }

  const defaultOpenUrl = (url) => openInBrowser(url)

  /**
   * 本地回调服务：先试 1455（Codex CLI 的约定端口），被占用就换一个随机端口。
   * 端口用随机值时，redirect_uri 也跟着变；服务端在换票时会核对，所以两处要一致。
   */
  function startCallbackServer (state) {
    return new Promise((resolve) => {
      let settle = () => {}
      const result = new Promise((res) => { settle = res })
      const handler = (req, res) => {
        const html = (code, body) => { res.writeHead(code, { 'content-type': 'text/html; charset=utf-8' }); res.end(`<meta charset="utf-8">${body}`) }
        try {
          const url = new URL(req.url || '', 'http://127.0.0.1')
          if (url.pathname !== CALLBACK_PATH) return html(404, '回调路径不对')
          const err = url.searchParams.get('error')
          if (err) { html(400, '登录没有完成：' + err); settle({ error: err }); return }
          const code = url.searchParams.get('code') || ''
          const gotState = url.searchParams.get('state') || ''
          const clientId = (url.searchParams.get('client_id') || '').trim()
          if (!code) return html(400, '没有 code')
          if (gotState !== state) return html(400, 'state 不匹配')
          html(200, '<h2>登录成功，可以关掉这个页面了</h2><p>回到 Aurabot 面板继续。</p>')
          try { server.close() } catch (error) {}
          settle({ code, clientId })
        } catch (error) {
          html(500, '处理回调出错')
        }
      }
      let server = null
      const listen = (port, fallback) => {
        server = createServer(handler)
        server.once('error', () => {
          try { server.close() } catch (error) {}
          if (fallback) listen(0, false)
          else resolve({ server: null, port: 0, result: null })
        })
        server.listen(port, CALLBACK_HOST, () => {
          const actual = server.address() && server.address().port
          resolve({ server, port: actual || port, result })
        })
      }
      listen(CALLBACK_PORT, true)
    })
  }

  /** 开始登录：返回授权地址；有回调服务时后台等它，否则等用户手动粘贴。 */
  async function startLogin ({ agentName = 'Aurabot', openBrowser = true } = {}) {
    if (pending) cancelLogin('重新发起登录')
    const { verifier, challenge } = createPkce()
    const state = randomBytes(32).toString('base64url')
    const nonce = randomBytes(32).toString('base64url')
    const hostId = `urn:uuid:${deviceId().toLowerCase()}`
    const cb = await startCallbackServer(state)
    const redirectUri = `http://${CALLBACK_HOST}:${cb.port || CALLBACK_PORT}${CALLBACK_PATH}`
    const url = buildAuthUrl({ challenge, state, nonce, hostId, redirectUri, agentName })
    const p = { state, verifier, nonce, redirectUri, status: 'waiting', error: '', email: '', needPaste: false }
    pending = p
    if (cb.server) {
      p.server = cb.server
      cb.result.then(async (r) => {
        try {
          if (r.error) throw new Error('授权失败：' + r.error)
          const cred = await exchange(r.code, verifier, r.clientId, redirectUri)
          p.status = 'done'
          p.email = cred.email || ''
        } catch (error) {
          p.status = 'error'
          p.error = error.message
        }
      }).catch(() => {})
    } else {
      p.needPaste = true
      log?.info?.('本地回调端口起不来，改用手动粘贴回调地址')
    }
    if (openBrowser) (openUrl || defaultOpenUrl)(url)
    return { url, needPaste: p.needPaste, redirectUri }
  }

  /** 手动粘贴整条回调地址（必须带 code / state / client_id）。 */
  async function completeLogin (input) {
    const verifier = pending && pending.verifier
    if (!verifier) throw new Error('登录会话已失效，请重新点「登录 ChatGPT」')
    const parsed = parseAuthInput(input, pending.redirectUri || REDIRECT_URI)
    if (parsed.error) throw new Error('授权失败：' + parsed.error)
    if (!parsed.code) throw new Error('没找到授权码')
    if (parsed.state && parsed.state !== pending.state) throw new Error('state 不匹配，请重新登录')
    const cred = await exchange(parsed.code, verifier, parsed.clientId, pending.redirectUri || REDIRECT_URI)
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
        client_id: c.clientId,
        refresh_token: c.refresh,
      })
      const next = toCredential({ refresh_token: c.refresh, ...json }, c.clientId, c)
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

  return { status, startLogin, completeLogin, loginStatus, cancelLogin, ensureAccess, logout, deviceId }
}
