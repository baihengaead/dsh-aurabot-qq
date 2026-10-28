// 内置模块：生图。她能画图发到聊天里（OpenAI 兼容的生图服务、自定义接口、ChatGPT 订阅，或「本地接口」里的 SD WebUI / ComfyUI）。

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createImageGen, drawResultBlocks, drawToolMessage } from '../../features/imagegen.js'
import { listPaintings, openPaintFolder, paintingPath, removePainting } from '../../features/paintings.js'
import { defineTool, str } from '../../tools/tools.js'
import { dataDir } from '../../core/store.js'
import { mimeOf } from '../../chat/inbound.js'

/** 把画好的图存一份，返回路径（她自己能去读，主人也能回看画过什么）。 */
function saveImage (buf, prompt) {
  try {
    const dir = dataDir('imagegen')
    mkdirSync(dir, { recursive: true })
    const d = new Date()
    const p = (n) => String(n).padStart(2, '0')
    const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
    const slug = String(prompt || '图').replace(/[\\/:*?"<>|\s]+/g, '-').slice(0, 20)
    const ext = mimeOf(buf) === 'image/jpeg' ? 'jpg' : 'png'
    const file = join(dir, `${stamp}-${slug}.${ext}`)
    writeFileSync(file, buf)
    return file
  } catch (error) {
    return ''
  }
}

export default {
  id: 'imagegen',
  name: '生图',
  version: '1.0.0',
  description: '画一张图发到聊天里（qq_draw_image）',
  tab: 'imagegen',
  files: ['features/imagegen.js', 'features/codex-auth.js'],
  setup(api) {
    const { hub, local } = api.core
    const memory = api.lazy('memory')
    const gen = createImageGen({ getConfig: api.config, log: api.log, local, dsh: api.dsh })
    const auth = gen.codexAuth

    // ChatGPT 订阅登录（OAuth）：发起 → 轮询状态 → 手动粘贴 → 退出
    api.route('/image/codex/status', async () => ({ ok: true, ...auth.status(), login: auth.loginStatus() }))
    api.route('/image/codex/login', async () => {
      try {
        const r = await auth.startLogin({})
        return { ok: true, ...r, ...auth.loginStatus() }
      } catch (error) {
        return { ok: false, message: error.message }
      }
    })
    api.route('/image/codex/login/status', async () => ({ ok: true, ...auth.loginStatus(), ...auth.status() }))
    api.route('/image/codex/complete', async (req) => {
      const b = await api.core.http.body(req).catch(() => ({}))
      try {
        const c = await auth.completeLogin(String((b && b.input) || ''))
        return { ok: true, email: c.email || '', accountId: c.accountId || '' }
      } catch (error) {
        return { ok: false, message: error.message }
      }
    })
    api.route('/image/codex/cancel', async () => ({ ok: true, ...auth.cancelLogin('已取消') }))
    api.route('/image/codex/logout', async () => ({ ok: true, ...auth.logout() }))

    // 她的画作：面板底下那个图库（直接读存图目录，不单独维护索引）
    api.route('/image/gallery', async (req) => {
      const q = api.core.http.query(req)
      const limit = q && q.limit ? Number(q.limit) : api.config().imageGen.galleryShown
      return { ok: true, ...listPaintings({ limit }), dir: dataDir('imagegen') }
    })
    api.route('/image/gallery/image', async (req, res) => {
      const p = paintingPath(api.core.http.query(req).file)
      if (!p) return api.core.http.send(res, 404, '')
      const buf = readFileSync(p)
      api.core.http.send(res, 200, buf, String(mimeOf(buf) || 'image/png'))
    })
    api.route('/image/gallery/delete', async (req) => {
      const b = await api.core.http.body(req).catch(() => ({}))
      return removePainting(String((b && b.file) || ''))
    })
    api.route('/image/open-folder', async () => openPaintFolder())

    api.tool(({ chat, sessionId }) => (gen.enabled() && chat.kind !== 'system' ? defineTool({
      name: 'qq_draw_image',
      description: '画一张图并发到当前 QQ 聊天里。prompt 用中文或英文详细描述画面（主体、动作、场景、风格）。shape 用来定画面比例：画立绘/壁纸用竖图，画风景/长卷用宽幅，表情/头像用方图；拿不准就不填，按内容自己定。画好会直接发出去；你自己能看图时会把原图一并给你，不能看图时给你一段画面描述。回复里简单说一两句就行。',
      properties: {
        prompt: str('画面描述'),
        shape: {
          type: 'string',
          enum: ['square', 'portrait', 'landscape', 'wide'],
          description: '画面比例：square 方图 / portrait 竖图 / landscape 横图 / wide 宽幅。不填就按内容自己定',
        },
      },
      required: ['prompt'],
      // 允许看图时工具结果里带原图（附件块），她当轮就能看见自己画了什么
      render: drawResultBlocks,
      execute: async ({ prompt, shape }) => {
        if (api.config().imageGen.ownerOnly && !hub.turnSendersAllOwner(sessionId)) return { ok: false, message: '画图只给主人画哦' }
        const buf = await gen.generate(String(prompt || ''), { shape: String(shape || '') })
        await hub.sendSegments(chat.chatId, [{ type: 'image', data: { file: 'base64://' + buf.toString('base64') } }], `[生图] ${String(prompt).slice(0, 30)}`)
        const saved = saveImage(buf, String(prompt || ''))
        if (saved) api.log.debug(`生图已存盘：${saved}`)

        // 「画完自己看一眼」是总开关：关掉就当没视觉能力处理 —— 既不给图，也不调模型看图。
        // 不然会出现「模型能看图、图也塞了、但没描述」的模糊中间态（#37 反馈）。
        const visual = await gen.canSee()
        const seeOwn = api.config().imageGen.seeOwn !== false
        const allowLook = visual && seeOwn
        const seen = allowLook ? await gen.look(buf, String(prompt || '')) : ''

        memory.addEvent?.({ text: `画了一张图：${String(prompt).slice(0, 40)}`, about: chat.kind === 'private' ? chat.userId : '', tags: ['画画'], importance: 0.4 })
        const out = { ok: true, message: drawToolMessage({ saved, seen, visual, seeOwn }) }
        // 图要先缩、再登记成 DSH 附件块 —— 直接塞 base64 会让下一轮请求整轮失败（实测）
        if (allowLook) {
          const img = await gen.toolImage(buf)
          if (img) out.image = img
          else api.log.debug('这次生图没把图交给模型（缩图/登记失败），只给文字')
        }
        return out
      },
    }) : []))
    return gen
  },
}
