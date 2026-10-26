// 内置模块：生图。她能画图发到聊天里（OpenAI 兼容的生图服务，或「本地接口」里接的 SD WebUI / ComfyUI）。

import { createImageGen } from '../../features/imagegen.js'
import { defineTool, str } from '../../tools/tools.js'

export default {
  id: 'imagegen',
  name: '生图',
  version: '1.0.0',
  description: '画一张图发到聊天里（qq_draw_image）',
  tab: 'imagegen',
  files: ['features/imagegen.js'],
  setup(api) {
    const { hub, local } = api.core
    const memory = api.lazy('memory')
    const gen = createImageGen({ getConfig: api.config, log: api.log, local, dsh: api.dsh })
    api.tool(({ chat, sessionId }) => (gen.enabled() && chat.kind !== 'system' ? defineTool({
      name: 'qq_draw_image',
      description: '画一张图并发到当前 QQ 聊天里。prompt 用中文或英文详细描述画面（主体、动作、场景、风格）。画好会直接发出去，同时把你自己看到的画面告诉你；回复里简单说一两句就行。',
      properties: { prompt: str('画面描述') },
      required: ['prompt'],
      execute: async ({ prompt }) => {
        if (api.config().imageGen.ownerOnly && !hub.turnSendersAllOwner(sessionId)) return { ok: false, message: '画图只给主人画哦' }
        const buf = await gen.generate(String(prompt || ''))
        await hub.sendSegments(chat.chatId, [{ type: 'image', data: { file: 'base64://' + buf.toString('base64') } }], `[生图] ${String(prompt).slice(0, 30)}`)
        // 自己回头看一眼：这样她才知道自己画成了什么，用户问「画得怎么样」时有话说
        const seen = await gen.look(buf, String(prompt || ''))
        memory.addEvent?.({ text: `画了一张图：${String(prompt).slice(0, 40)}`, about: chat.kind === 'private' ? chat.userId : '', tags: ['画画'], importance: 0.4 })
        return { ok: true, message: seen ? `画好发出去了。你自己看到的画面：${seen}` : '画好发出去了' }
      },
    }) : []))
    return gen
  },
}
