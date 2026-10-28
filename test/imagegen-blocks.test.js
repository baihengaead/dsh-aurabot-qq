// 生图工具结果：能看图的模型拿原图（image 块），纯文本模型只拿文字
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { drawResultBlocks, createImageGen } = await import('../src/features/imagegen.js')
const { shrinkImage } = await import('../src/core/img.js')
const { defineTool } = await import('../src/tools/tools.js')

const silent = { info () {}, warn () {}, debug () {}, error () {} }

test('drawResultBlocks：有图时文字 + image 块，没图时只有文字', () => {
  // 正常走的是 DSH 附件块（toolImage() 登记过），要原样透传
  const attachment = { type: 'image', attachment: { attachmentId: 'att-1' }, mediaType: 'image/png' }
  const withImg = drawResultBlocks({}, { ok: true, message: '画好发出去了', image: attachment })
  assert.equal(withImg.length, 2)
  assert.deepEqual(withImg[0], { type: 'text', text: '画好发出去了' })
  assert.deepEqual(withImg[1], attachment, '附件块原样进工具结果')

  // 没登记过的裸 data 也认（老的调用方式/测试）
  const raw = drawResultBlocks({}, { ok: true, message: 'x', image: { data: 'AA', mediaType: 'image/jpeg' } })
  assert.deepEqual(raw[1], { type: 'image', data: 'AA', mediaType: 'image/jpeg' })

  const noImg = drawResultBlocks({}, { ok: true, message: '画好发出去了' })
  assert.deepEqual(noImg, [{ type: 'text', text: '画好发出去了' }], '纯文本模型只有文字，不能出现 image 块')

  // 形状不对（既没 attachment 也没 data）别硬塞 image 块
  assert.deepEqual(drawResultBlocks({}, { ok: true, message: 'x', image: { mediaType: 'image/png' } }), [{ type: 'text', text: 'x' }])

  const bad = drawResultBlocks({}, { ok: false, message: '生图服务没配' })
  assert.deepEqual(bad, [{ type: 'text', text: '✗ 生图服务没配' }])
})

test('toolImage：小图登记成附件块；没附件服务 / 登记失败 → null', async () => {
  const buf = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')
  const cfg = { model: { provider: 'p', model: 'm', vision: 'on' }, imageGen: { enabled: true }, bili: {} }
  const make = (dsh) => createImageGen({ getConfig: () => cfg, log: silent, local: { active: () => false }, dsh, codexAuth: { status: () => ({ loggedIn: false }) } })

  const ok = make({ attachments: { admitPromptContent: async ([b]) => [{ type: 'image', attachment: { attachmentId: 'att-9' }, mediaType: b.mediaType }] } })
  assert.deepEqual(await ok.toolImage(buf), { type: 'image', attachment: { attachmentId: 'att-9' }, mediaType: 'image/png' })

  assert.equal(await make({}).toolImage(buf), null, '没有附件服务 → 不带图')
  assert.equal(await make({ attachments: { admitPromptContent: async () => { throw new Error('nope') } } }).toolImage(buf), null, '登记失败 → 不带图')
  assert.equal(await make(null).toolImage(buf), null, '没有 dsh → 不带图')
})

test('shrinkImage：没有 ffmpeg 时安静返回 null', async () => {
  const buf = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')
  assert.equal(await shrinkImage(buf, 512, 'definitely-not-a-real-ffmpeg', { timeoutMs: 800 }), null)
})

test('defineTool：自定义 render 生效，默认 render 不变', () => {
  const custom = defineTool({
    name: 't1',
    description: 'd',
    execute: async () => ({ ok: true }),
    render: () => [{ type: 'image', data: 'AA', mediaType: 'image/png' }],
  })
  assert.deepEqual(custom.output.render({}, { ok: true }), [{ type: 'image', data: 'AA', mediaType: 'image/png' }])

  const plain = defineTool({ name: 't2', description: 'd', execute: async () => ({ ok: true }) })
  assert.deepEqual(plain.output.render({}, { ok: true, message: '好了' }), [{ type: 'text', text: '好了' }])
  assert.deepEqual(plain.output.render({}, { ok: false, message: '坏了' }), [{ type: 'text', text: '✗ 坏了' }])
})

function stubDsh (mods) {
  return {
    llm: { resolveModelInfo: async () => ({ inputModalities: mods }) },
    get: () => null,
  }
}

const gen = (dsh, cfg) => createImageGen({
  getConfig: () => cfg,
  log: silent,
  local: { active: () => false },
  dsh,
  codexAuth: { status: () => ({ loggedIn: false }) },
})

const base = {
  model: { provider: 'p', model: 'm', vision: 'auto' },
  imageGen: { enabled: true, provider: 'openai', baseUrl: 'http://x', model: 'm', seeOwn: true },
}

test('canSee：按「视觉能力」开关 + 模型元数据判定，拿不准当不能', async () => {
  // 每个断言用不同的 provider::model，避开 llm.js 里的探测缓存（同一进程 10 分钟）
  const withModel = (model, vision = 'auto') => ({
    ...base,
    model: { provider: 'p', model, vision },
  })

  // 面板手动声明
  assert.equal(await gen(stubDsh(['text']), withModel('m-on', 'on')).canSee(), true, '手动声明支持 → 能看')
  assert.equal(await gen(stubDsh(['text', 'image']), withModel('m-off', 'off')).canSee(), false, '手动声明不支持 → 不能看')

  // 自动：按元数据
  assert.equal(await gen(stubDsh(['text', 'image']), withModel('m-see')).canSee(), true)
  assert.equal(await gen(stubDsh(['text']), withModel('m-blind')).canSee(), false)
  assert.equal(await gen(stubDsh(undefined), withModel('m-unknown')).canSee(), false, '宿主没说清楚 → 当不能看（保守）')
  assert.equal(await gen({ get: () => null }, withModel('m-nollm')).canSee(), false, '没有 llm 服务 → 不能看')
  assert.equal(await gen(null, withModel('m-nodsh')).canSee(), false, '没有 dsh（模块没起来）→ 不能看')
})
