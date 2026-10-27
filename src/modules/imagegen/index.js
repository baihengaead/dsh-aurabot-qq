// 内置模块：生图。她能画图发到聊天里（OpenAI 兼容的生图服务，或「本地接口」里接的 SD WebUI / ComfyUI）。

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createImageGen } from '../../features/imagegen.js'
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

    api.tool(({ chat, sessionId }) => (gen.enabled() && chat.kind !== 'system' ? defineTool({
      name: 'qq_draw_image',
      description: '画一张图并发到当前 QQ 聊天里。prompt 用中文或英文详细描述画面（主体、动作、场景、风格）。画好会直接发出去，同时把你自己看到的画面告诉你；回复里简单说一两句就行。',
      properties: { prompt: str('画面描述') },
      required: ['prompt'],
      execute: async ({ prompt }) => {
        if (api.config().imageGen.ownerOnly && !hub.turnSendersAllOwner(sessionId)) return { ok: false, message: '画图只给主人画哦' }
        const buf = await gen.generate(String(prompt || ''))
        await hub.sendSegments(chat.chatId, [{ type: 'image', data: { file: 'base64://' + buf.toString('base64') } }], `[生图] ${String(prompt).slice(0, 30)}`)
        const saved = saveImage(buf, String(prompt || ''))
        if (saved) api.log.debug(`生图已存盘：${saved}`)
        // 自己回头看一眼：这样她才知道自己画成了什么，用户问「画得怎么样」时有话说
        const seen = await gen.look(buf, String(prompt || ''))
        memory.addEvent?.({ text: `画了一张图：${String(prompt).slice(0, 40)}`, about: chat.kind === 'private' ? chat.userId : '', tags: ['画画'], importance: 0.4 })
        const where = saved ? `（存在 ${saved}，你想看可以自己读它）` : ''
        return { ok: true, message: seen ? `画好发出去了${where}。你自己看到的画面：${seen}` : `画好发出去了${where}` }
      },
    }) : []))
    return gen
  },
}
