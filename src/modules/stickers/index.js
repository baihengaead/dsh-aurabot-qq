// 内置模块：表情包。偷表情、回复时按情绪配一张、她自己整理表情库。
// 导出的就是表情库（createStickerStore 的返回值），聊天中枢发表情、偷表情都找它。

import { readFileSync, existsSync } from 'node:fs'
import { createStickerStore, stickerPath } from '../../features/stickers.js'
import { defineTool, str, int } from '../../tools/tools.js'
import { fetchImage } from '../../core/net.js'

export default {
  id: 'stickers',
  name: '表情包',
  version: '1.0.0',
  description: '偷表情、回复时按情绪配表情、她自己改名删图；关掉后不发也不收表情',
  tab: 'stickers',
  files: ['features/stickers.js'],
  setup(api) {
    const { hub, onebot, http } = api.core
    const store = createStickerStore({ dsh: api.dsh, getConfig: api.config, onebot, log: api.log })

    api.tool(({ chat, level, sessionId }) => {
      if (chat.kind === 'system') return []
      const current = chat.chatId
      const tools = [
        defineTool({
          name: 'qq_send_sticker',
          description: '在当前 QQ 聊天里发一张表情包。name 写表情的名字或情绪（如「委屈」「开心」「早晚安」），会在表情库里模糊匹配。一般直接在回复里写 <sticker:名字> 就行，这个工具用于回复之外单独补发。',
          properties: { name: str('表情名字或情绪关键词') },
          required: ['name'],
          execute: async ({ name }) => {
            const ok = await hub.sendSticker(current, String(name || ''))
            return ok ? { ok: true, message: '发了' } : { ok: false, message: '表情库里没找到合适的' }
          },
        }),
        defineTool({
          name: 'qq_list_stickers',
          description: '看看表情库里有哪些表情（名字和标签），挑表情前可以先看。',
          properties: { query: str('可选，按名字/标签筛选') },
          execute: async ({ query }) => {
            const items = store.library().items
            const q = String(query || '').trim()
            const hit = (q ? items.filter((i) => (i.name || '').includes(q) || (i.tags || []).some((t) => t.includes(q))) : items).slice(-60)
            return { ok: true, count: items.length, message: hit.length ? hit.map((i) => `${i.name || '未命名'}${i.tags?.length ? '（' + i.tags.join('/') + '）' : ''}`).join('、') : '没有符合的表情', items: hit.map((i) => ({ name: i.name, tags: i.tags })) }
          },
        }),
        defineTool({
          name: 'qq_edit_sticker',
          description: '整理表情库：给一张表情改名字、改标签，或者删掉。名字不贴切、别人建议改名、标签不对的时候用；不喜欢、重复、发不出去的表情可以删。sticker 写现在的名字或标签（模糊匹配）。',
          properties: {
            sticker: str('要改的那张表情现在的名字或标签'),
            new_name: str('新名字（12 字以内，不改就不填）'),
            tags: { type: 'array', items: { type: 'string' }, description: '新标签（情绪 / 用途，比如 开心、委屈、嘲讽；不改就不填）' },
            delete: { type: 'boolean', description: 'true = 删掉这张表情' },
          },
          required: ['sticker'],
          execute: async ({ sticker, new_name, tags, delete: del }) => {
            const item = store.match(String(sticker || ''))
            if (!item) return { ok: false, message: '表情库里没找到这张' }
            const label = item.name || item.md5.slice(0, 8)
            if (del) {
              // 主人亲手加的表情，主人开口才删
              if ((item.from === 'manual' || item.from === 'panel') && !hub.turnHasOwner(sessionId)) return { ok: false, message: '这张是主人加的，主人说删才删' }
              const r = await store.remove(item.md5)
              return r.ok ? { ok: true, message: `删掉了「${label}」` } : { ok: false, message: r.reason || '没删成' }
            }
            if (!new_name && !(Array.isArray(tags) && tags.length)) return { ok: false, message: '要说改成什么' }
            const r = store.rename(item.md5, new_name ? String(new_name).trim().slice(0, 12) : undefined, Array.isArray(tags) && tags.length ? tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 5) : undefined)
            return r.ok ? { ok: true, message: `改好了：「${label}」→「${r.item.name}」${r.item.tags?.length ? '（' + r.item.tags.join('/') + '）' : ''}` } : { ok: false, message: '没改成' }
          },
        }),
      ]
      // 「她挑」模式：聊天里刚收到的表情，喜欢就凭编号收下（各档位都能用）
      tools.push(defineTool({
        name: 'qq_collect_sticker',
        description: '把刚才聊天里出现的表情收进自己的表情库（喜欢才收，不喜欢就别调）。index 从 1 开始；name 是你给它起的名字。',
        properties: {
          index: int('第几张表情（从 1 开始，默认 1）'),
          name: str('给它起的名字（≤12 字）'),
          tags: { type: 'array', items: { type: 'string' }, description: '标签，如 开心/委屈' },
        },
        required: [],
        execute: async ({ index, name, tags }) => {
          const seg = hub.stickerOf(chat.chatId, index || 1)
          if (!seg) return { ok: false, message: '这张表情已经拿不到了（太久了，或者这一轮里没有这张）' }
          const r = await store.saveFromSegment(seg, {
            name: String(name || '').trim().slice(0, 12),
            tags: Array.isArray(tags) ? tags.slice(0, 3) : [],
            from: chat.chatId,
          })
          if (!r.ok) return { ok: false, message: r.reason }
          if (r.existed) {
            const label = r.item.name ? `「${r.item.name}」` : '（还没起名）'
            return { ok: true, message: `这张已经在库里了，叫${label}${r.touched ? '，名字已经补上' : ''}` }
          }
          return { ok: true, message: `收好了，叫「${r.item.name || '未命名'}」` }
        },
      }))
      // 主人私聊（完整权限）才能往库里加图
      if (level === 'full') tools.push(defineTool({
        name: 'qq_add_sticker',
        description: '把一张图片收进表情库并收藏到 QQ。source 是本地图片路径或图片网址；name 是不超过 12 个字的备注。',
        properties: { source: str('本地路径或 http(s) 地址'), name: str('备注（≤12 字）'), tags: { type: 'array', items: { type: 'string' }, description: '标签，如 开心/委屈' } },
        required: ['source'],
        execute: async ({ source, name, tags }) => {
          const buf = await fetchImage(String(source), { maxBytes: 5 * 1024 * 1024 })
          const r = await store.addFromBuffer(buf, { name: name || '', tags: Array.isArray(tags) ? tags.slice(0, 3) : [], from: 'tool' })
          if (!r.ok) return { ok: false, message: r.reason }
          // 这张可能在收到它的那一刻就被后台自动收进库了：说清楚，别让她以为失败了
          if (r.existed) {
            const label = r.item.name ? `「${r.item.name}」` : '（还没起名）'
            return { ok: true, message: `这张之前就收过了，库里叫${label}${r.touched ? '，这次给的名字/标签已经补上' : ''}` }
          }
          return { ok: true, message: `收好了「${r.item.name || '未命名'}」` }
        },
      }))
      return tools
    })

    api.route('/stickers', async () => ({ ok: true, items: store.library().items.slice().reverse() }))
    api.route('/sticker/image', async (req, res) => {
      const it = store.library().items.find((i) => i.md5 === http.query(req).md5)
      if (!it || !existsSync(stickerPath(it))) return http.send(res, 404, '')
      const ext = it.file.split('.').pop()
      http.send(res, 200, readFileSync(stickerPath(it)), ext === 'png' ? 'image/png' : ext === 'gif' ? 'image/gif' : ext === 'webp' ? 'image/webp' : 'image/jpeg')
    })
    api.route('/sticker/rename', async (req) => {
      const b = await http.body(req)
      return store.rename(b.md5, b.name, Array.isArray(b.tags) ? b.tags : undefined)
    })
    api.route('/sticker/delete', async (req) => {
      const b = await http.body(req)
      return store.remove(b.md5, { fromQQ: b.fromQQ !== false })
    })
    api.route('/sticker/upload', async (req) => {
      const b = await http.body(req)
      const buf = Buffer.from(String(b.data || '').replace(/^data:[^,]+,/, ''), 'base64')
      if (!buf.length || buf.length > 5 * 1024 * 1024) return { ok: false, message: '图片太大或是空的' }
      return store.addFromBuffer(buf, { name: b.name || '', tags: b.tags || [], from: 'panel' })
    })

    return store
  },
}
