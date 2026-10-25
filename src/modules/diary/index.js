// 内置模块：空间日记。每天挑几个时间，按当天的聊天和心情写一条 QQ 空间说说；主人私聊里也能让她发说说。
// 导出 createQzone 的返回值：writeDiary / post / remove / history / nextTime / tick。

import { createQzone } from '../../features/qzone.js'
import { defineTool, str } from '../../tools/tools.js'

export default {
  id: 'diary',
  name: '空间日记',
  version: '1.0.0',
  description: '每天自己写几条 QQ 空间说说；主人私聊里能让她发说说（qq_send_qzone）',
  tab: 'diary',
  files: ['features/qzone.js'],
  setup(api) {
    const { hub, onebot, http } = api.core
    const memory = api.lazy('memory')
    const qzone = createQzone({
      getConfig: api.config, onebot, hub, log: api.log,
      // 写过的空间日记也进记忆库：以后聊到相关的事，她会想起自己那天写过什么
      onDiary: (text) => memory.add?.({ text: `我在 QQ 空间写过：${text}`, importance: 0.55, tags: ['空间日记'], source: 'diary' }),
    })
    api.every(60_000, () => qzone.tick(), '空间日记')

    api.tool(({ chat, level }) => (level === 'full' && chat.kind !== 'system' ? defineTool({
      name: 'qq_send_qzone',
      description: '在你自己的 QQ 空间发一条说说。content 是正文（第一人称，口语）；images 可选，本地路径或网址。',
      properties: {
        content: str('说说正文'),
        images: { type: 'array', items: { type: 'string' }, description: '可选，图片路径或网址，最多 4 张' },
        visibility: { type: 'string', enum: ['all', 'friends', 'self'], description: '谁能看：all 所有人，friends 好友，self 仅自己' },
      },
      required: ['content'],
      execute: async ({ content, images, visibility }) => {
        const r = await qzone.post(String(content || ''), { images: Array.isArray(images) ? images.slice(0, 4) : [], visibility })
        return r.ok ? { ok: true, message: '发好了', tid: r.tid } : { ok: false, message: r.message }
      },
    }) : []))

    api.route('/diary/run', async (req) => qzone.writeDiary({ visibility: (await http.body(req)).visibility }))
    api.route('/diary/history', async () => ({ ok: true, items: qzone.history(), next: qzone.nextTime() }))
    api.route('/qzone/delete', async (req) => {
      await qzone.remove((await http.body(req)).tid)
      return { ok: true, message: '删掉了' }
    })
    return qzone
  },
}
