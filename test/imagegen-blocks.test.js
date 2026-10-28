// 生图工具结果：能看图的模型拿原图（image 块），纯文本模型只拿文字
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { drawResultBlocks, createImageGen } = await import('../src/features/imagegen.js')
const { defineTool } = await import('../src/tools/tools.js')

const silent = { info () {}, warn () {}, debug () {}, error () {} }

test('drawResultBlocks：能看图时文字 + image 块，否则只有文字', () => {
  const png = { data: 'iVBORw0KGgo=', mediaType: 'image/png' }
  const withImg = drawResultBlocks({}, { ok: true, message: '画好发出去了', image: png })
  assert.equal(withImg.length, 2)
  assert.deepEqual(withImg[0], { type: 'text', text: '画好发出去了' })
  assert.deepEqual(withImg[1], { type: 'image', data: png.data, mediaType: 'image/png' })

  const noImg = drawResultBlocks({}, { ok: true, message: '画好发出去了' })
  assert.deepEqual(noImg, [{ type: 'text', text: '画好发出去了' }], '纯文本模型只有文字，不能出现 image 块')

  // 形状不对（比如 base64 丢了）也别硬塞 image 块
  assert.deepEqual(drawResultBlocks({}, { ok: true, message: 'x', image: { mediaType: 'image/png' } }), [{ type: 'text', text: 'x' }])

  const bad = drawResultBlocks({}, { ok: false, message: '生图服务没配' })
  assert.deepEqual(bad, [{ type: 'text', text: '✗ 生图服务没配' }])

  // 默认 mediaType
  const noType = drawResultBlocks({}, { ok: true, message: 'x', image: { data: 'AA' } })
  assert.equal(noType[1].mediaType, 'image/png')
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
