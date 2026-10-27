// ChatGPT 订阅生图：OAuth 纯函数 + 令牌刷新 + 生图请求形状（全部用假 fetch，不联网）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs'
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

/** 造一个带 chatgpt_account_id / email 的 JWT（不验签，只需要 payload） */
function fakeJwt (payload) {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${enc({ alg: 'none' })}.${enc(payload)}.sig`
}

const silent = { info () {}, warn () {}, debug () {}, error () {} }

test('PKCE：challenge 是 verifier 的 sha256(base64url)', () => {
  const { verifier, challenge } = createPkce()
  assert.ok(verifier.length >= 43)
  assert.equal(challenge, createHash('sha256').update(verifier).digest('base64url'))
})

test('授权地址带上必要参数', () => {
  const url = new URL(buildAuthUrl({ challenge: 'CH', state: 'ST', originator: 'pi' }))
  assert.equal(url.origin + url.pathname, 'https://auth.openai.com/oauth/authorize')
  assert.equal(url.searchParams.get('response_type'), 'code')
  assert.equal(url.searchParams.get('client_id'), 'app_EMoamEEZ73f0CkXaXp7hrann')
  assert.equal(url.searchParams.get('redirect_uri'), 'http://localhost:1455/auth/callback')
  assert.equal(url.searchParams.get('scope'), 'openid profile email offline_access')
  assert.equal(url.searchParams.get('code_challenge'), 'CH')
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256')
  assert.equal(url.searchParams.get('state'), 'ST')
})

test('粘贴回调地址能取出 code；只粘 code 也行', () => {
  assert.deepEqual(parseAuthInput('http://localhost:1455/auth/callback?code=abc&state=xyz'), { code: 'abc', state: 'xyz' })
  assert.equal(parseAuthInput('abc123').code, 'abc123')
  assert.equal(parseAuthInput('code=abc&state=1').code, 'abc')
})

test('JWT 里取 accountId / email', () => {
  const access = fakeJwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acc-1' } })
  const id = fakeJwt({ email: 'me@example.com' })
  assert.equal(accountIdOf(access, id), 'acc-1')
  assert.equal(emailOf(id), 'me@example.com')
  assert.equal(decodeJwt('garbage'), null)
})

test('401 会触发刷新；刷新后状态和邮箱跟着更新', async () => {
  const calls = []
  const access = fakeJwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acc-2' } })
  const idt = fakeJwt({ email: 'new@example.com' })
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: String(init.body) })
    return new Response(JSON.stringify({ access_token: access, refresh_token: 'rt2', expires_in: 3600, id_token: idt }), { status: 200 })
  }
  const auth = createCodexAuth({ log: silent, fetchImpl })
  writeFileSync(join(dataDir, 'codex-auth.json'), JSON.stringify({
    type: 'oauth', access: 'old', refresh: 'rt1', expires: Date.now() - 1000, accountId: 'acc-1', email: 'old@example.com',
  }))
  const got = await auth.ensureAccess()
  assert.equal(got.access, access)
  assert.equal(got.accountId, 'acc-2')
  assert.match(calls[0].body, /grant_type=refresh_token/)
  assert.match(calls[0].body, /refresh_token=rt1/)
  const st = auth.status()
  assert.equal(st.loggedIn, true)
  assert.equal(st.email, 'new@example.com')
  assert.equal(st.expired, false)
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
  const cfg = normalize({ imageGen: { enabled: true, provider: 'codex' } })
  const gen = createImageGen({
    getConfig: () => cfg,
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
