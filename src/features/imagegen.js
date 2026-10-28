// 生图：三种接法
//   ① openai —— 兼容 OpenAI /v1/images/generations 的服务（硅基流动、通义兼容层、ComfyUI/SD WebUI 的 OpenAI 代理……）
//   ② custom —— 自己填接口：GET/POST、URL 模板（{prompt} 占位）、自定义参数名
//   ③ codex  —— ChatGPT 订阅（OAuth 登录，走 chatgpt.com 的 Codex 生图端点，不花 API 额度）
// 地址和密钥由主人在面板里填；生成结果统一成 Buffer 交给 QQ 发出。

import { randomUUID } from 'node:crypto'
import { fetchImage } from '../core/net.js'
import { mimeOf } from '../chat/inbound.js'
import { askModel, canSeeImages } from '../core/llm.js'
import { findFfmpeg, shrinkImage } from '../core/img.js'
import { createCodexAuth } from './codex-auth.js'

// 工具结果里带的图超过这个大小就先缩一下：2MB 的图直接塞进上下文会把下一轮请求搞挂
const TOOL_IMAGE_MAX_BYTES = 500 * 1024

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

/** 画面比例 → 各家的实际尺寸（OpenAI 兼容 / 自定义接口用） */
export const SHAPE_SIZE = {
  square: '1024x1024',
  portrait: '1024x1536',
  landscape: '1536x1024',
  wide: '1536x864',
}

/**
 * 画面比例 → 给模型的构图提示。
 * Codex 订阅那条路**不认 size 参数**（实测请求 1024×1536 也会被它改成自己的尺寸），
 * 但提示词里的构图描述是认的：写「竖版构图（3:4）」出 1086×1448，写「宽幅（16:9）」出 1672×941。
 */
export const SHAPE_HINT = {
  square: '方版构图（1:1），主体居中',
  portrait: '竖版构图（3:4），主体居中',
  landscape: '横版构图（3:2），两侧留出环境',
  wide: '宽幅横版构图（16:9），两侧留出环境',
}

/** 这次用哪个比例：她指定的 > 面板默认的（her = 让她自己按画面定）。 */
export function pickShape (shape, c) {
  const ok = ['square', 'portrait', 'landscape', 'wide']
  if (ok.includes(shape)) return shape
  const def = c && c.shape
  return ok.includes(def) ? def : 'her'
}

export function createImageGen({ getConfig, log, local, dsh, fetchImpl, codexAuth }) {
  const fetch = fetchImpl || ((...a) => globalThis.fetch(...a))
  const auth = codexAuth || createCodexAuth({ log, fetchImpl: fetchImpl })

  async function generate(prompt, { shape } = {}) {
    const c = getConfig().imageGen
    const picked = pickShape(shape, c)
    const size = SHAPE_SIZE[picked] || c.size
    const hint = SHAPE_HINT[picked] || ''
    // 本地接口接管：用用户自己电脑上的画图服务
    if (local?.active('image')) {
      const { toImageBuffer } = await import('../local/local.js')
      const t = Date.now()
      const buf = await toImageBuffer(await local.call('image', { prompt: [c.stylePrompt, prompt, hint].filter(Boolean).join('，'), size }))
      log.info(`本地画好了一张图（${Math.round(buf.length / 1024)}KB，${Math.round((Date.now() - t) / 1000)}s）：${prompt.slice(0, 40)}`)
      return buf
    }
    if (!c.enabled) throw new Error('生图还没开启')
    let full = [c.stylePrompt, prompt].filter(Boolean).join('，')
    const t = Date.now()
    let buf
    if (c.provider === 'custom') buf = await viaCustom(c, full, size)
    else if (c.provider === 'codex') {
      // 这条路的 size 不管用，构图要靠提示词
      if (hint) full += '，' + hint
      buf = await viaCodex(c, full)
    } else {
      full += hint ? '，' + hint : ''
      buf = await viaOpenAI(c, full, size)
    }
    if (!buf || !buf.length) throw new Error('生图接口没有返回图片')
    if (!String(mimeOf(buf)).startsWith('image/')) throw new Error('生图接口返回的不是图片')
    log.info(`画好了一张图（${Math.round(buf.length / 1024)}KB，${Math.round((Date.now() - t) / 1000)}s）：${prompt.slice(0, 40)}`)
    return buf
  }

  /** 自定义接口：GET 直接把参数拼在地址上，POST 放进 JSON / 表单。 */
  async function viaCustom (c, prompt, size) {
    const cp = c.custom || {}
    if (!cp.url) throw new Error('还没填自定义生图接口地址')
    const req = customRequest(size ? { ...c, size } : c, prompt)
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

  /**
   * ChatGPT 订阅生图（Codex 端点）。
   * 走订阅额度，不用 API Key；令牌来自生图页里的 OAuth 登录。
   */
  async function viaCodex (c, prompt) {
    const cx = c.codex || {}
    const body = {
      prompt,
      model: String(cx.model || 'gpt-image-2'),
      quality: String(cx.quality || 'auto'),
      size: 'auto', // 实测这条端点不认尺寸，改由提示词里的构图描述引导
      background: String(cx.background || 'auto'),
    }
    const once = async (access, accountId) => fetch('https://chatgpt.com/backend-api/codex/images/generations', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${access}`,
        'chatgpt-account-id': accountId,
        accept: 'application/json',
        'content-type': 'application/json',
        originator: 'pi',
        'x-codex-image-turn-id': randomUUID(),
        'user-agent': 'aurabot-qq',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(180000),
    })
    let { access, accountId } = await auth.ensureAccess()
    // 图片端点必须带 chatgpt-account-id；没有就说明登录拿到的 token 不对，别拿 401 当"过期"
    if (!accountId) throw new Error('登录信息里没有账号 ID，去生图页重新登录一次 ChatGPT')
    log.info(`生图走 ChatGPT 订阅：${body.model} / ${body.size} / 质量 ${body.quality}`)
    let r = await once(access, accountId)
    // 令牌可能刚好过期：刷一次再试
    if (r.status === 401) {
      try { ({ access, accountId } = await auth.ensureAccess({ force: true })) } catch (error) {
        throw new Error('订阅登录已过期，去生图页重新登录 ChatGPT')
      }
      r = await once(access, accountId)
    }
    const text = await r.text().catch(() => '')
    let j = null
    try { j = JSON.parse(text) } catch (error) {}
    if (!r.ok) {
      if (r.status === 401) throw new Error('订阅登录已失效，去生图页重新登录 ChatGPT')
      if (r.status === 403) throw new Error('这个订阅 / 工作区不能用生图（HTTP 403）')
      if (r.status === 429) throw new Error('订阅生图用得太频繁或额度用完了（HTTP 429）')
      const msg = (j && (j.error?.message || j.message || j.detail)) || text.slice(0, 200)
      throw new Error(`订阅生图失败（HTTP ${r.status}）${msg ? '：' + msg : ''}`)
    }
    const item = (j && Array.isArray(j.data) ? j.data[0] : null) || {}
    if (typeof item.b64_json === 'string' && item.b64_json) return Buffer.from(item.b64_json, 'base64')
    if (typeof item.url === 'string' && item.url) return fetchImage(item.url, { maxBytes: 20 * 1024 * 1024, allowLocal: false })
    const v = j ? findImage(j) : null
    if (v) return valueToBuffer(v)
    throw new Error('订阅生图没有返回图片')
  }

  /** OpenAI 兼容接口。 */
  async function viaOpenAI (c, prompt, size) {
    const base = String(c.baseUrl || '').replace(/\/+$/, '')
    if (!base || !c.model) throw new Error('还没填生图服务地址或模型')
    const headers = { 'content-type': 'application/json' }
    if (c.apiKey) headers.authorization = `Bearer ${c.apiKey}`
    const r = await fetch(`${base}/images/generations`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: c.model, prompt, size: size || c.size, n: 1, response_format: 'b64_json', image_size: size || c.size }),
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
        // ⚠ 别给太小：模型会先思考，预算太小会被思考吃光，正文就是空的（表情起名踩过）
        maxTokens: 1000,
        temperature: 0.5,
      })
      const t = String(text || '').trim()
      if (t) log.info(`画完自己看了一眼：${t.slice(0, 60)}`)
      else log.warn('画完想看自己画的图，但模型没返回文字')
      return t
    } catch (error) {
      log.debug('画完看图失败（模型可能不支持看图）：', error.message)
      return ''
    }
  }

  /**
   * 当前模型能不能看图：面板「视觉能力」手动声明优先，其次看 DSH 声明的元数据。
   * 只有明确能看图才返回 true —— 拿不准就当不能，别把纯文本模型搞崩。
   */
  async function canSee () {
    if (!dsh) return false
    return (await canSeeImages(dsh, getConfig())) === true
  }

  /**
   * 工具结果里要带的那张图：直接复用模块级的 imageToolBlock（本地/上游一份实现）。
   * 缩图大小之类的细节由 imageToolBlock 自己打日志。
   */
  async function toolImage (buf) {
    if (!dsh) return null
    return imageToolBlock(dsh, buf, { ffmpegPath: getConfig().bili && getConfig().bili.ffmpegPath, log })
  }

  const enabled = () => {
    if (local?.active('image')) return true
    const c = getConfig().imageGen
    if (!c.enabled) return false
    if (c.provider === 'codex') return Boolean(auth.status().loggedIn)
    return c.provider === 'custom' ? Boolean(c.custom && c.custom.url) : Boolean(c.baseUrl && c.model)
  }

  return { generate, look, canSee, toolImage, enabled, codexAuth: auth }
}

/**
 * qq_draw_image 工具结果里那句话。三种情况分别说清楚，别让她瞎猜画面里有什么：
 * - 看过（有描述）：把描述带回去
 * - 能看图但「画完自己看一眼」关着：这次没给图，别描述
 * - 模型看不了图（或图没登记成功）：如实说没看到，别让她照着提示词编画面细节
 *
 * ⚠ 不告诉她文件路径：给了路径她就会自己用文件工具去读图，"不给看"的开关就形同虚设
 *   （图已经发到聊天里了，她不需要路径；图库是给主人看的）。
 */
export function drawToolMessage ({ seen = '', visual = false, seeOwn = true } = {}) {
  if (seen) return `画好发出去了。你自己看到的画面：${seen}`
  if (!visual) return '画好发出去了，但这次没能把图片交给你看；别描述画面里有什么'
  if (!seeOwn) return '画好发出去了。这次没把图给你看，别描述画面里有什么'
  return '画好发出去了'
}

/**
 * qq_draw_image 的工具结果怎么渲染：一行文字 +（有图时）image 块。
 * image 一般是 DSH 附件块（imageToolBlock() 登记过的），原样透传；没图就只回文字。
 */
export function drawResultBlocks (_args, value) {
  const text = value && value.ok === false ? '✗ ' + (value.message || '没成功') : (value && value.message) || '✓'
  const blocks = [{ type: 'text', text }]
  const img = value && value.image
  if (img && img.attachment) blocks.push({ ...img, type: 'image' })
  return blocks
}

/**
 * 工具结果里要带的那张图：太大的先缩图，再交给 DSH 的附件服务登记成附件块。
 * ⚠ 必须走附件服务：模型适配层只认附件块，把 base64 直接塞进工具结果会让下一轮请求整轮失败
 * （实测 2MB 的 PNG 直接塞进去 → "DeepSeek Messages transport failed"，重试 5 次全挂）。
 * 缩图或登记失败都返回 null —— 只给文字，宁可少给也不要崩。
 */
export async function imageToolBlock (dsh, buf, { ffmpegPath = '', maxSide = 1024, maxBytes = TOOL_IMAGE_MAX_BYTES, log = null } = {}) {
  if (!dsh) return null
  let data = buf
  let mediaType = mimeOf(buf)
  if (buf.length > maxBytes) {
    const ffmpeg = findFfmpeg(ffmpegPath)
    const small = ffmpeg ? await shrinkImage(buf, maxSide, ffmpeg) : null
    if (!small || small.length > maxBytes) {
      log?.debug?.(`生图 ${Math.round(buf.length / 1024)}KB 太大又缩不了，工具结果里就不带图了`)
      return null
    }
    log?.debug?.(`工具结果里的图缩到 ${Math.round(small.length / 1024)}KB（原 ${Math.round(buf.length / 1024)}KB）`)
    data = small
    mediaType = 'image/jpeg'
  }
  const att = dsh.attachments || (typeof dsh.get === 'function' ? dsh.get('attachments') : null)
  if (!att || typeof att.admitPromptContent !== 'function') return null
  try {
    const [block] = await att.admitPromptContent([{ type: 'image', data: data.toString('base64'), mediaType }])
    if (block && block.type === 'image' && block.attachment) return block
    log?.debug?.('宿主没把图登记成附件块，工具结果里不带图')
  } catch (error) {
    log?.debug?.('生图的图登记成附件失败：', error.message)
  }
  return null
}
