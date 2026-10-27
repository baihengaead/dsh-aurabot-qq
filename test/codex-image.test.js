// ChatGPT 订阅生图：OAuth（Sign in with ChatGPT 动态客户端流程）+ 令牌刷新 + 生图请求形状
// 全部用假 fetch，不联网。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dataDir = mkdtempSync(join(tmpdir(), 'aurabot-codex-'))
process.env.AURABOT_DATA_DIR = dataDir
mkdirSync(dataDir, { recursive: true })

const { createCodexAuth, createPkce, buildAuthUrl, parseAuthInput, accountIdOf, emailOf, decodeJwt } = await import('../src/features/codex-auth.js')
const { createImageGen } = await import('../src/features/imagegen.js')
const { normalize } = await import('../src/core/config.js')

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)])
const b64 = PNG.toString('base64')
const silent = { info () {}, warn () {}, debug () {}, error () {} }
const CALLBACK = 'http://127.0.0.1:1455/auth/callback'

/** 造一个带 chatgpt_account_id / email 的 JWT（不验签，只需要 payload） */
function fakeJwt (payload) {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${enc({ alg: 'none' })}.${enc(payload)}.sig`
}

/** 令牌响应（新流程必须带 scope，且含 chatgpt.tokens.use.direct） */
function tokenJson (overrides = {}) {
  const access = overrides.access_token || fakeJwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acc-1' } })
  return {
    access_token: access,
    refresh_token: 'rt-1',
    id_token: fakeJwt({ email: 'me@example.com' }),
    expires_in: 3600,
    scope: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct',
    ...overrides,
  }
}

test('PKCE：challenge 是 verifier 的 sha256(base64url)', () => {
  const { verifier, challenge } = createPkce()
  assert.ok(verifier.length >= 43)
  assert.equal(challenge, createHash('sha256').update(verifier).digest('base64url'))
})

test('授权地址走新的 /api/accounts/authorize，带上动态 client / host id / resource', () => {
  const url = new URL(buildAuthUrl({ challenge: 'CH', state: 'ST', nonce: 'NO', hostId: 'urn:uuid:11111111-2222-3333-4444-555555555555' }))
  assert.equal(url.origin + url.pathname, 'https://auth.openai.com/api/accounts/authorize')
  const p = url.searchParams
  assert.equal(p.get('client_id'), 'dynamic_agent_client')
  assert.equal(p.get('response_type'), 'code')
  assert.equal(p.get('redirect_uri'), CALLBACK)
  assert.equal(p.get('resource'), 'https://api.openai.com/v1')
  assert.match(p.get('scope'), /chatgpt\.tokens\.use\.direct/)
  assert.equal(p.get('ext_agent_host_id'), 'urn:uuid:11111111-2222-3333-4444-555555555555')
  assert.equal(p.get('code_challenge'), 'CH')
  assert.equal(p.get('code_challenge_method'), 'S256')
  assert.equal(p.get('state'), 'ST')
  assert.equal(p.get('nonce'), 'NO')
  assert.equal(p.get('agent_name_hint'), 'Aurabot')
})

test('粘贴回调地址能取出 code / state / 下发的 client_id；别的地址会拒绝', () => {
  const full = `${CALLBACK}?code=abc&state=xyz&client_id=client_123`
  assert.deepEqual(parseAuthInput(full), { code: 'abc', state: 'xyz', clientId: 'client_123', error: '' })
  assert.equal(parseAuthInput('abc123').code, 'abc123')
  assert.throws(() => parseAuthInput('http://evil.com/auth/callback?code=1'), /必须是以/)
  assert.throws(() => parseAuthInput('http://127.0.0.1:1455/other?code=1'), /必须是以/)
})

test('JWT 里取 accountId / email', () => {
  const access = fakeJwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acc-1' } })
  const id = fakeJwt({ email: 'me@example.com' })
  assert.equal(accountIdOf(access, id), 'acc-1')
  assert.equal(emailOf(id), 'me@example.com')
  assert.equal(decodeJwt('garbage'), null)
})

test('令牌过期会刷新：带 resource + 存下来的 client_id，更新邮箱与有效期', async () => {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: String(init.body) })
    return new Response(JSON.stringify(tokenJson({
      access_token: fakeJwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acc-2' } }),
      id_token: fakeJwt({ email: 'new@example.com' }),
      refresh_token: 'rt-2',
    })), { status: 200 })
  }
  const auth = createCodexAuth({ log: silent, fetchImpl })
  writeFileSync(join(dataDir, 'codex-auth.json'), JSON.stringify({
    type: 'oauth', access: 'old', refresh: 'rt-1', expires: Date.now() - 1000, clientId: 'client_stored', accountId: 'acc-1', email: 'old@example.com',
  }))
  const got = await auth.ensureAccess()
  assert.equal(got.accountId, 'acc-2')
  const body = calls[0].body
  assert.match(body, /grant_type=refresh_token/)
  assert.match(body, /refresh_token=rt-1/)
  assert.match(body, /client_id=client_stored/)
  assert.match(body, new RegExp('resource=' + encodeURIComponent('https://api.openai.com/v1')))
  const st = auth.status()
  assert.equal(st.loggedIn, true)
  assert.equal(st.email, 'new@example.com')
  auth.logout()
  assert.equal(auth.status().loggedIn, false)
})

test('没登录时 ensureAccess 给出明确提示', async () => {
  const auth = createCodexAuth({ log: silent, fetchImpl: async () => new Response('{}') })
  auth.logout()
  await assert.rejects(() => auth.ensureAccess(), /还没登录 ChatGPT 订阅/)
})

test('生图请求：地址/头/请求体都对，b64 解成图片', async () => {
  const seen = []
  const fetchImpl = async (url, init) => {
    seen.push({ url, init })
    return new Response(JSON.stringify({ data: [{ b64_json: b64 }] }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  const cfg = normalize({
    imageGen: { enabled: true, provider: 'codex', size: '1024x768', stylePrompt: '日系二次元', codex: { model: 'gpt-image-2', quality: 'high', background: 'opaque' } },
  })
  const gen = createImageGen({
    getConfig: () => cfg,
    log: silent,
    fetchImpl,
    codexAuth: { status: () => ({ loggedIn: true }), ensureAccess: async () => ({ access: 'TOKEN', accountId: 'ACC' }) },
  })
  assert.equal(gen.enabled(), true)
  const buf = await gen.generate('一只橘猫')
  assert.ok(Buffer.isBuffer(buf) && buf.length > 8)
  assert.equal(buf[0], 0x89)

  const { url, init } = seen[0]
  assert.equal(url, 'https://chatgpt.com/backend-api/codex/images/generations')
  assert.equal(init.method, 'POST')
  assert.equal(init.headers.authorization, 'Bearer TOKEN')
  assert.equal(init.headers['chatgpt-account-id'], 'ACC')
  assert.equal(init.headers.originator, 'pi')
  assert.ok(init.headers['x-codex-image-turn-id'])
  const body = JSON.parse(init.body)
  assert.equal(body.prompt, '日系二次元，一只橘猫')
  assert.equal(body.model, 'gpt-image-2')
  assert.equal(body.quality, 'high')
  assert.equal(body.size, '1024x768')
  assert.equal(body.background, 'opaque')
})

test('令牌过期（401）会刷新一次再重试', async () => {
  let n = 0
  let refreshed = 0
  const fetchImpl = async () => {
    n++
    if (n === 1) return new Response(JSON.stringify({ error: { message: 'token expired' } }), { status: 401 })
    return new Response(JSON.stringify({ data: [{ b64_json: b64 }] }), { status: 200 })
  }
  const gen = createImageGen({
    getConfig: () => normalize({ imageGen: { enabled: true, provider: 'codex' } }),
    log: silent,
    fetchImpl,
    codexAuth: {
      status: () => ({ loggedIn: true }),
      ensureAccess: async (opts) => { if (opts && opts.force) refreshed++; return { access: 'T', accountId: 'A' } },
    },
  })
  const buf = await gen.generate('猫')
  assert.ok(buf.length > 8)
  assert.equal(refreshed, 1)
  assert.equal(n, 2)
})

test('403 / 429 给人话', async () => {
  const mk = (status) => createImageGen({
    getConfig: () => normalize({ imageGen: { enabled: true, provider: 'codex' } }),
    log: silent,
    fetchImpl: async () => new Response('{}', { status }),
    codexAuth: { status: () => ({ loggedIn: true }), ensureAccess: async () => ({ access: 'T', accountId: 'A' }) },
  })
  await assert.rejects(() => mk(403).generate('猫'), /不能用生图/)
  await assert.rejects(() => mk(429).generate('猫'), /额度|频繁/)
})

test('配置：codex 型号/质量越界会回落', () => {
  const c = normalize({ imageGen: { provider: 'codex', codex: { model: '乱写', quality: 'ultra', background: 'rainbow' } } }).imageGen
  assert.equal(c.codex.model, 'gpt-image-2')
  assert.equal(c.codex.quality, 'auto')
  assert.equal(c.codex.background, 'auto')
  assert.equal(c.provider, 'codex')
})

test('干净环境：没有令牌文件时 status 是未登录', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-codex-clean-'))
  process.env.AURABOT_DATA_DIR = dir
  const auth = createCodexAuth({ log: silent, fetchImpl: async () => new Response('{}') })
  assert.deepEqual(auth.status(), { loggedIn: false })
  assert.ok(!existsSync(join(dir, 'codex-auth.json')))
  process.env.AURABOT_DATA_DIR = dataDir
})

test('缺 chatgpt.tokens.use.direct 的授权会被拒绝（说明订阅没生效）', async () => {
  const auth = createCodexAuth({
    log: silent,
    fetchImpl: async () => new Response(JSON.stringify(tokenJson({ scope: 'openid profile email' })), { status: 200 }),
  })
  writeFileSync(join(dataDir, 'codex-auth.json'), JSON.stringify({ type: 'oauth', access: 'a', refresh: 'r', expires: Date.now() - 1, clientId: 'c' }))
  await assert.rejects(() => auth.ensureAccess(), /chatgpt\.tokens\.use\.direct/)
  auth.logout()
})

test('Windows 打开浏览器不能走 cmd（URL 里的 & 会被截断）', async () => {
  const { openInBrowser } = await import('../src/features/codex-auth.js')
  const calls = []
  const run = (bin, args) => ({ unref () { calls.push({ bin, args }) } })
  const url = 'https://auth.openai.com/api/accounts/authorize?client_id=dynamic_agent_client&scope=a+b&nonce=n'
  assert.equal(openInBrowser(url, { run, platform: 'win32' }), true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].bin, 'rundll32')
  assert.equal(calls[0].args[1], url, '整条链接要原样交给浏览器')
  assert.ok(!/cmd/i.test(calls[0].bin), '不能走 cmd：& 会被当成命令分隔符')
  // 其它平台照旧
  openInBrowser(url, { run, platform: 'darwin' })
  assert.equal(calls[1].bin, 'open')
  openInBrowser(url, { run, platform: 'linux' })
  assert.equal(calls[2].bin, 'xdg-open')
})