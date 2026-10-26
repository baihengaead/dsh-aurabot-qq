// 会话复用：老数据（没有 mode / sessions 字段）不能被当成「模式不匹配」而新建；
// 切换调试/正式之后要接回各自原来那条。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REPO = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const dataDir = mkdtempSync(join(tmpdir(), 'aurabot-sessmode-'))
process.env.AURABOT_DATA_DIR = dataDir
process.env.AURABOT_WORKSPACE = join(dataDir, 'ws')
mkdirSync(dataDir, { recursive: true })

const OWNER = '10000001'
const BOT = '20000002'
const MAP = join(dataDir, 'sessions.json')
writeFileSync(join(dataDir, 'config.json'), JSON.stringify({
  enabled: true, dryRun: true, debug: false, setupDone: true, botQQ: BOT, ownerQQ: OWNER,
  allow: { private: [], groups: [] },
  snowluma: { autoStart: false, autoAttach: false, dir: join(dataDir, 'none') },
  voice: { enabled: false }, merge: { enabled: false },
}))

const { createFakeDsh } = await import(`file:///${REPO}/test/helpers/fake-dsh.js`)
const fake = createFakeDsh({ brain: async () => '嗯嗯' })
const host = await import(`file:///${REPO}/src/host.js`)
const api = host.apply(fake.ctx)
await api.ready
await new Promise((r) => setTimeout(r, 400))

const CHAT = `private:${OWNER}`
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const entry = () => JSON.parse(readFileSync(MAP, 'utf8')).chats[CHAT] || {}
const say = (text) => api.hub.onMessage({
  post_type: 'message', message_type: 'private', sub_type: 'friend',
  self_id: Number(BOT), user_id: Number(OWNER), time: Math.floor(Date.now() / 1000),
  message_id: Math.floor(Math.random() * 1e6),
  message: [{ type: 'text', data: { text } }],
  sender: { user_id: Number(OWNER), nickname: '主人' },
})
const createdCount = async () => ((await fake.call('/logs?limit=500')).json().entries || [])
  .filter((e) => String(e.text).includes(`为 ${CHAT} 新建了 DSH 会话`)).length

test('先正常建一条会话', async () => {
  await say('一')
  await wait(1200)
  assert.ok(entry().sessionId, '应该有会话了')
  assert.equal(await createdCount(), 1)
})

test('老数据（没有 mode / sessions）继续用原会话，不新建', async () => {
  const A = entry().sessionId
  // 抹掉新字段，还原成「调试功能之前」的老数据
  const m = JSON.parse(readFileSync(MAP, 'utf8'))
  delete m.chats[CHAT].mode
  delete m.chats[CHAT].sessions
  writeFileSync(MAP, JSON.stringify(m))

  const before = await createdCount()
  await say('二')
  await wait(1200)
  assert.equal(entry().sessionId, A, '应该还是原来那条会话')
  assert.equal(await createdCount(), before, '不该新建')
})

test('切到调试再切回来，各自接回原来的会话', async () => {
  const A = entry().sessionId

  api.setConfig({ ...api.getConfig(), debug: true, dryRun: true })
  await api.hub.ensureDebugSession()
  await wait(1000)
  const B = entry().sessions.debug
  assert.ok(B, '调试会话应该记下来')
  assert.notEqual(String(B), String(A), '调试和正式是两条会话')
  assert.equal(String(entry().sessions.live), String(A), '正式那条没被顶掉')

  const before = await createdCount()
  api.setConfig({ ...api.getConfig(), debug: false, dryRun: true })
  await say('三')
  await wait(1200)
  assert.equal(String(entry().sessions.live), String(A), '切回正式接回原来那条')
  assert.equal(await createdCount(), before, '切模式不该新建会话')
})

test.after(() => fake.dispose())
