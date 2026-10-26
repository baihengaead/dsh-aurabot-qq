// 生图：两种接法
//   ① openai —— 兼容 OpenAI /v1/images/generations 的服务（硅基流动、通义兼容层、ComfyUI/SD WebUI 的 OpenAI 代理……）
//   ② custom —— 自己填接口：GET/POST、URL 模板（{prompt} 占位）、自定义参数名
// 地址和密钥由主人在面板里填；生成结果统一成 Buffer 交给 QQ 发出。

import { fetchImage } from '../core/net.js'
import { mimeOf } from '../chat/inbound.js'
import { askModel, canSeeImages } from '../core/llm.js'

/** 把模板里的 {占位符} 替换掉；不认识的占位符原样留着。 */
function fill (tpl, vars) {
  return String(tpl ?? '').replace(/\{(\w+)\}/g, (m, k) => (vars[k] === undefined || vars[k] === null ? m : String(vars[k])))
}

function dimsOf (size) {
  const m = /^(\d+)\s*[x×*]\s*(\d+)$/i.exec(String(size || ''))
  return m ? { width: m[1], height: m[2] } : { width: '', height: '' }
}

/** 按 "data.0.url" 这种路径取值。 */
function dotted (obj, path) {
  let cur = obj
  for (const k of String(path || '').split('.').map((s) => s.trim()).filter(Boolean)) {
    if (cur === null || cur === undefined) return null
    cur = cur[k]
  }
  return cur ?? null
}

/** 没配取值路径时，在返回的 JSON 里随便找个像图片的东西（http 地址 / data:image）。 */
function findImage (obj, depth = 0) {
  if (depth > 6 || obj === null || obj === undefined) return null
  if (typeof obj === 'string') {
    if (/^data:image\//i.test(obj)) return obj
    if (/^https?:\/\//i.test(obj) && /\.(png|jpe?g|webp|gif|bmp)(\?|$)/i.test(obj)) return obj
    return null
  }
  if (Array.isArray(obj)) {
    for (const it of obj) { const r = findImage(it, depth + 1); if (r) return r }
    return null
  }
  if (typeof obj === 'object') {
    for (const k of ['url', 'image', 'imageUrl', 'image_url', 'output', 'data', 'images', 'result']) {
      if (k in obj) { const r = findImage(obj[k], depth + 1); if (r) return r }
    }
    for (const v of Object.values(obj)) { const r = findImage(v, depth + 1); if (r) return r }
  }
  return null
}

/**
 * 自定义接口这一次要发什么（纯函数，方便单独测）。
 * 返回 { url, method, headers, body }。
 */
export function customRequest (imageGen, prompt) {
  const cp = imageGen.custom || {}
  const method = String(cp.method || 'GET').toUpperCase() === 'GET' ? 'GET' : 'POST'
  const { width, height } = dimsOf(imageGen.size)
  const raw = { prompt, model: imageGen.model || '', size: imageGen.size || '', width, height }
  const enc = { ...raw, prompt: encodeURIComponent(prompt) }
  const params = (Array.isArray(cp.params) ? cp.params : [])
    .map((p) => ({ key: String(p && p.key != null ? p.key : '').trim(), value: p ? p.value : '' }))
    .filter((p) => p.key)

  let url = fill(cp.url, enc)
  if (method === 'GET' && params.length) {
    const q = params.map((p) => `${encodeURIComponent(p.key)}=${encodeURIComponent(fill(p.value, raw))}`).join('&')
    url += (url.includes('?') ? '&' : '?') + q
  }

  const headers = {}
  if (imageGen.apiKey) headers.authorization = `Bearer ${imageGen.apiKey}`

  let body
  if (method === 'POST') {
    const obj = {}
    for (const p of params) obj[p.key] = fill(p.value, raw)
    if (cp.bodyType === 'form') {
      headers['content-type'] = 'application/x-www-form-urlencoded'
      body = new URLSearchParams(obj).toString()
    } else {
      headers['content-type'] = 'application/json'
      body = JSON.stringify(obj)
    }
  }
  return { url, method, headers, body }
}

/** 接口返回的「图片地址 / base64」变成 Buffer。 */
async function valueToBuffer (v) {
  if (typeof v !== 'string' || !v) throw new Error('生图接口没有返回图片')
  const b64 = /^data:image\/[^;]+;base64,(.+)$/i.exec(v)
  if (b64) return Buffer.from(b64[1], 'base64')
  if (/^https?:\/\//i.test(v)) return fetchImage(v, { maxBytes: 20 * 1024 * 1024, allowLocal: false })
  throw new Error('生图接口返回的既不是图片地址也不是图片')
}

export function createImageGen({ getConfig, log, local, dsh }) {
  async function generate(prompt) {
    const c = getConfig().imageGen
    // 本地接口接管：用用户自己电脑上的画图服务
    if (local?.active('image')) {
      const { toImageBuffer } = await import('../local/local.js')
      const t = Date.now()
      const buf = await toImageBuffer(await local.call('image', { prompt: [c.stylePrompt, prompt].filter(Boolean).join('，'), size: c.size }))
      log.info(`本地画好了一张图（${Math.round(buf.length / 1024)}KB，${Math.round((Date.now() - t) / 1000)}s）：${prompt.slice(0, 40)}`)
      return buf
    }
    if (!c.enabled) throw new Error('生图还没开启')
    const full = [c.stylePrompt, prompt].filter(Boolean).join('，')
    const t = Date.now()
    let buf
    if (c.provider === 'custom') buf = await viaCustom(c, full)
    else buf = await viaOpenAI(c, full)
    if (!buf || !buf.length) throw new Error('生图接口没有返回图片')
    if (!String(mimeOf(buf)).startsWith('image/')) throw new Error('生图接口返回的不是图片')
    log.info(`画好了一张图（${Math.round(buf.length / 1024)}KB，${Math.round((Date.now() - t) / 1000)}s）：${prompt.slice(0, 40)}`)
    return buf
  }

  /** 自定义接口：GET 直接把参数拼在地址上，POST 放进 JSON / 表单。 */
  async function viaCustom (c, prompt) {
    const cp = c.custom || {}
    if (!cp.url) throw new Error('还没填自定义生图接口地址')
    const req = customRequest(c, prompt)
    log.info(`生图请求：${req.method} ${req.url.slice(0, 160)}`)
    const r = await fetch(req.url, {
      method: req.method,
      headers: req.headers,
      body: req.body,
      signal: AbortSignal.timeout(180000),
    })
    const type = String(r.headers.get('content-type') || '')
    // 直接返回图片字节（pollinations 这类）
    if (type.startsWith('image/')) {
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      return Buffer.from(await r.arrayBuffer())
    }
    const j = await r.json().catch(() => null)
    if (!r.ok) throw new Error((j && (j.error?.message || j.message)) || `HTTP ${r.status}`)
    if (!j) throw new Error('生图接口没有返回图片')
    const v = (cp.responsePath ? dotted(j, cp.responsePath) : null) || findImage(j)
    if (!v) throw new Error('生图接口没有返回图片地址')
    return valueToBuffer(v)
  }

  /** OpenAI 兼容接口。 */
  async function viaOpenAI (c, prompt) {
    const base = String(c.baseUrl || '').replace(/\/+$/, '')
    if (!base || !c.model) throw new Error('还没填生图服务地址或模型')
    const headers = { 'content-type': 'application/json' }
    if (c.apiKey) headers.authorization = `Bearer ${c.apiKey}`
    const r = await fetch(`${base}/images/generations`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: c.model, prompt, size: c.size, n: 1, response_format: 'b64_json', image_size: c.size }),
      signal: AbortSignal.timeout(180000),
    })
    const j = await r.json().catch(() => ({}))
    if (!r.ok) throw new Error(j?.error?.message || j?.message || `HTTP ${r.status}`)
    const item = (j.data || j.images || [])[0] || {}
    if (item.b64_json) return Buffer.from(item.b64_json, 'base64')
    if (item.url) return fetchImage(item.url, { maxBytes: 20 * 1024 * 1024, allowLocal: false })
    // 有的服务把地址放在别处，兜一下
    const v = findImage(j)
    if (v) return valueToBuffer(v)
    throw new Error('生图服务没有返回图片')
  }

  /**
   * 画完自己看一眼：让能看图的模型描述一下成品，她才「知道」自己画成了什么，
   * 用户追问「画得怎么样」时才有话说。模型看不了图就安静跳过。
   */
  async function look (buf, prompt) {
    const c = getConfig().imageGen
    if (!dsh || c.seeOwn === false) return ''
    // 模型明确看不了图就别浪费一次调用
    if ((await canSeeImages(dsh, getConfig())) === false) return ''
    try {
      const text = await askModel(dsh, {
        cfg: getConfig(),
        system: '你刚画完一张图，现在要跟朋友讲你画了什么。用第一人称，两三句话说清画面的主体、风格、颜色和细节，语气自然，别用「这张图片展示了」这种说法。',
        text: `画这张图时用的提示词：${String(prompt || '').slice(0, 500)}`,
        images: [{ data: buf.toString('base64'), mediaType: mimeOf(buf) }],
        maxTokens: 300,
        temperature: 0.5,
      })
      const t = String(text || '').trim()
      if (t) log.info(`画完自己看了一眼：${t.slice(0, 60)}`)
      return t
    } catch (error) {
      log.debug('画完看图失败（模型可能不支持看图）：', error.message)
      return ''
    }
  }

  const enabled = () => {
    if (local?.active('image')) return true
    const c = getConfig().imageGen
    if (!c.enabled) return false
    return c.provider === 'custom' ? Boolean(c.custom && c.custom.url) : Boolean(c.baseUrl && c.model)
  }

  return { generate, look, enabled }
}
