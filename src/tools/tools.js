// 挂给 Aurabot 会话的工具。按会话注册（agent.ctx.tools.register），只出现在 Aurabot 的会话里。
// 工具定义一旦确定尽量别改：改一次，DeepSeek 的前缀缓存就失效一次。

import { fetchImage } from '../core/net.js'
import { memoryLine } from '../features/memory.js'
import { parseMessageEvent } from '../chat/inbound.js'

/** 和 @deepseek-ai/dsh-tools 的 defineTool 产物同形：parameters / output.schema 是 JSON Schema。 */
export function defineTool({ name, description, properties = {}, required = [], execute }) {
  const parameters = { type: 'object', properties, required, additionalProperties: false }
  return {
    name,
    description,
    parameters,
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: (_args, value) => [{ type: 'text', text: value && value.ok === false ? '✗ ' + (value.message || '没成功') : (value && value.message) || '✓' }],
    },
    async execute(args, exec) {
      try {
        const r = await execute(args || {}, exec)
        return JSON.parse(JSON.stringify(r ?? { ok: true }))
      } catch (error) {
        return { ok: false, message: String(error && error.message ? error.message : error) }
      }
    },
  }
}

const str = (description) => ({ type: 'string', description })
const int = (description) => ({ type: 'integer', description })

/**
 * @param {object} deps
 * @param {{chat:object, level:string, sessionId:string}} where
 */
export function buildTools(deps, { chat, level, sessionId }) {
  const { hub, getConfig, stickers, qzone, memory, song, onebot, groupRoles } = deps
  const current = chat.chatId
  const isSystem = chat.kind === 'system'
  const tools = []

  if (!isSystem) {
    tools.push(defineTool({
      name: 'qq_send_sticker',
      description: '在当前 QQ 聊天里发一张表情包。name 写表情的名字或情绪（如「委屈」「开心」「早晚安」），会在表情库里模糊匹配。一般直接在回复里写 <sticker:名字> 就行，这个工具用于回复之外单独补发。',
      properties: { name: str('表情名字或情绪关键词') },
      required: ['name'],
      execute: async ({ name }) => {
        const ok = await hub.sendSticker(current, String(name || ''))
        return ok ? { ok: true, message: '发了' } : { ok: false, message: '表情库里没找到合适的' }
      },
    }))

    tools.push(defineTool({
      name: 'qq_list_stickers',
      description: '看看表情库里有哪些表情（名字和标签），挑表情前可以先看。',
      properties: { query: str('可选，按名字/标签筛选') },
      execute: async ({ query }) => {
        const items = stickers.library().items
        const q = String(query || '').trim()
        const hit = (q ? items.filter((i) => (i.name || '').includes(q) || (i.tags || []).some((t) => t.includes(q))) : items).slice(-60)
        return { ok: true, count: items.length, message: hit.length ? hit.map((i) => `${i.name || '未命名'}${i.tags?.length ? '（' + i.tags.join('/') + '）' : ''}`).join('、') : '没有符合的表情', items: hit.map((i) => ({ name: i.name, tags: i.tags })) }
      },
    }))

    tools.push(defineTool({
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
        const item = stickers.match(String(sticker || ''))
        if (!item) return { ok: false, message: '表情库里没找到这张' }
        const label = item.name || item.md5.slice(0, 8)
        if (del) {
          // 主人亲手加的表情，主人开口才删
          if ((item.from === 'manual' || item.from === 'panel') && !hub.turnHasOwner(sessionId)) return { ok: false, message: '这张是主人加的，主人说删才删' }
          const r = await stickers.remove(item.md5)
          return r.ok ? { ok: true, message: `删掉了「${label}」` } : { ok: false, message: r.reason || '没删成' }
        }
        if (!new_name && !(Array.isArray(tags) && tags.length)) return { ok: false, message: '要说改成什么' }
        const r = stickers.rename(item.md5, new_name ? String(new_name).trim().slice(0, 12) : undefined, Array.isArray(tags) && tags.length ? tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 5) : undefined)
        return r.ok ? { ok: true, message: `改好了：「${label}」→「${r.item.name}」${r.item.tags?.length ? '（' + r.item.tags.join('/') + '）' : ''}` } : { ok: false, message: '没改成' }
      },
    }))

    tools.push(defineTool({
      name: 'qq_chat_history',
      description: '翻翻当前这个聊天之前的聊天记录（只读，最多 50 条）。想不起前面聊过什么、别人问「刚才谁说的」、要回顾一段对话时用。',
      properties: { count: int('要翻多少条，默认 20，最多 50') },
      execute: async ({ count }) => {
        const n = Math.max(1, Math.min(50, Number(count) || 20))
        const r = chat.kind === 'group'
          ? await onebot.call('get_group_msg_history', { group_id: Number(chat.groupId), count: n }, { timeoutMs: 15000 })
          : await onebot.call('get_friend_msg_history', { user_id: Number(chat.userId), count: n }, { timeoutMs: 15000 })
        const msgs = (r?.messages || []).slice(-n)
        if (!msgs.length) return { ok: true, message: '没翻到聊天记录' }
        const self = String(getConfig().botQQ)
        const lines = msgs.map((m) => {
          const p = parseMessageEvent({ ...m, message_type: m.message_type || (chat.kind === 'group' ? 'group' : 'private') }, self)
          const who = String(m.user_id ?? m.sender?.user_id) === self ? '你' : (m.sender?.card || m.sender?.nickname || String(m.user_id ?? ''))
          const t = m.time ? new Date(m.time * 1000).toTimeString().slice(0, 5) : ''
          return `${t} ${who}：${(p.text || '（图片/表情）').slice(0, 150)}`
        })
        return { ok: true, message: lines.join('\n') }
      },
    }))
  }

  // 主人私聊（完整权限）才有的
  if (level === 'full') {
    tools.push(defineTool({
      name: 'qq_send_message',
      description: '主动给某个 QQ 好友或群发一条消息（不是回复当前聊天时用）。target 写 private:QQ号 或 group:群号；只能发给白名单里的人和群。',
      properties: { target: str('private:QQ号 或 group:群号'), text: str('要发的话，可以用 ||| 分多条、<voice>…</voice> 发语音、<sticker:名字> 发表情') },
      required: ['target', 'text'],
      execute: async ({ target, text }) => {
        const cfg = getConfig()
        const [kind, id] = String(target || '').split(':')
        const okList = kind === 'group' ? cfg.allow.groups : kind === 'private' ? [cfg.ownerQQ, ...cfg.allow.private] : []
        if (!okList.includes(String(id))) return { ok: false, message: '不在白名单里，不能发' }
        await hub.deliver(`${kind}:${id}`, String(text || ''))
        return { ok: true, message: '发出去了' }
      },
    }))

    tools.push(defineTool({
      name: 'qq_add_sticker',
      description: '把一张图片收进表情库并收藏到 QQ。source 是本地图片路径或图片网址；name 是不超过 12 个字的备注。',
      properties: { source: str('本地路径或 http(s) 地址'), name: str('备注（≤12 字）'), tags: { type: 'array', items: { type: 'string' }, description: '标签，如 开心/委屈' } },
      required: ['source'],
      execute: async ({ source, name, tags }) => {
        const buf = await fetchImage(String(source), { maxBytes: 5 * 1024 * 1024 })
        const r = await stickers.addFromBuffer(buf, { name: name || '', tags: Array.isArray(tags) ? tags.slice(0, 3) : [], from: 'tool' })
        return r.ok ? { ok: true, message: r.existed ? '库里已经有这张了' : `收好了「${r.item.name || '未命名'}」` } : { ok: false, message: r.reason }
      },
    }))

    tools.push(defineTool({
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
    }))
  }

  // 群管：工具层校验——这一轮说话的人必须全是主人
  if (chat.kind === 'group' || level === 'full') {
    tools.push(defineTool({
      name: 'qq_group_admin',
      description: '群管理：禁言 / 解禁 / 踢人 / 改头衔 / 发群公告。只有主人要求时才能用；别人要求会被系统拒绝。',
      properties: {
        action: { type: 'string', enum: ['ban', 'unban', 'kick', 'title', 'notice'], description: 'ban 禁言，unban 解禁，kick 踢出，title 改专属头衔，notice 发公告' },
        group_id: str('群号；在群里用时可省略，默认当前群'),
        user_id: str('对象 QQ 号（notice 不需要）'),
        minutes: int('禁言分钟数，默认 10'),
        text: str('头衔内容或公告内容'),
      },
      required: ['action'],
      execute: async ({ action, group_id, user_id, minutes, text }) => {
        // 这一轮里主人说过话才行；群里别人顺带插话不影响，但谁都不能拿群管对付主人
        if (!hub.turnHasOwner(sessionId)) return { ok: false, message: '只有主人能让我做群管操作' }
        const gid = Number(group_id || (chat.kind === 'group' ? chat.groupId : 0))
        if (!gid) return { ok: false, message: '不知道是哪个群' }
        if (!getConfig().allow.groups.includes(String(gid))) return { ok: false, message: '这个群不在白名单里' }
        const uid = Number(user_id || 0)
        if (action !== 'notice' && !uid) return { ok: false, message: '要说清楚对谁（QQ 号）' }
        if (uid && String(uid) === String(getConfig().ownerQQ) && action !== 'unban' && action !== 'title') return { ok: false, message: '不能对主人做这个' }
        if (groupRoles) {
          const role = await groupRoles.get(gid, { fresh: true })
          if (role && !groupRoles.canManage(role)) return { ok: false, message: '我在这个群只是普通成员，没有管理权限' }
          if (role === 'admin' && action === 'title') return { ok: false, message: '改专属头衔要群主才行，我只是管理员' }
        }
        if (getConfig().dryRun) return { ok: true, message: `试运行：本来要对群 ${gid} 做 ${action}` }
        switch (action) {
          case 'ban': await onebot.call('set_group_ban', { group_id: gid, user_id: uid, duration: Math.max(1, Number(minutes) || 10) * 60 }); break
          case 'unban': await onebot.call('set_group_ban', { group_id: gid, user_id: uid, duration: 0 }); break
          case 'kick': await onebot.call('set_group_kick', { group_id: gid, user_id: uid, reject_add_request: false }); break
          case 'title': await onebot.call('set_group_special_title', { group_id: gid, user_id: uid, special_title: String(text || '') }); break
          case 'notice': await onebot.call('_send_group_notice', { group_id: gid, content: String(text || '') }); break
          default: return { ok: false, message: '不认识的操作' }
        }
        return { ok: true, message: '做好了' }
      },
    }))
  }

  if (memory && getConfig().memory.enabled && !isSystem) {
    tools.push(defineTool({
      name: 'remember',
      description: '把一件值得长期记住的事记下来（对方的名字、喜好、约定、重要的事）。一条只记一件事；日常琐事不用记；记的时候安静地记，别在回复里说「我记住了」。',
      properties: {
        text: str('要记住的事，一句话，主语写清楚'),
        about: str('这件事是关于谁的（名字），可选'),
        importance: { type: 'number', description: '0~1，约定、关系、核心喜好写高一点，随口一提写低一点，不确定写 0.5' },
      },
      required: ['text'],
      execute: async ({ text, about, importance }) => memory.add({ text, aboutName: about || '', about: chat.kind === 'private' ? chat.userId : '', importance: importance ?? 0.5, source: 'tool', chatId: current }),
    }))
    tools.push(defineTool({
      name: 'recall_memory',
      description: '翻一翻记忆库：想不起对方以前说过什么、喜欢什么、约过什么时用。query 写关键词或一句话。',
      properties: { query: str('想找什么') },
      required: ['query'],
      execute: async ({ query }) => {
        const hits = memory.recall(String(query || ''), { about: chat.userId, limit: 8, where: current + '（翻记忆）' })
        return hits.length ? { ok: true, message: hits.map((h) => memoryLine(h.it)).join('；') } : { ok: true, message: '没想起相关的事' }
      },
    }))
  }

  if (deps.imageGen && deps.imageGen.enabled() && !isSystem) {
    tools.push(defineTool({
      name: 'qq_draw_image',
      description: '画一张图并发到当前 QQ 聊天里。prompt 用中文或英文详细描述画面（主体、动作、场景、风格）。画好会直接发出去，回复里简单说一句就行。',
      properties: { prompt: str('画面描述') },
      required: ['prompt'],
      execute: async ({ prompt }) => {
        if (getConfig().imageGen.ownerOnly && !hub.turnSendersAllOwner(sessionId)) return { ok: false, message: '画图只给主人画哦' }
        const buf = await deps.imageGen.generate(String(prompt || ''))
        await hub.sendSegments(current, [{ type: 'image', data: { file: 'base64://' + buf.toString('base64') } }], `[生图] ${String(prompt).slice(0, 30)}`)
        memory?.addEvent?.({ text: `画了一张图：${String(prompt).slice(0, 40)}`, about: chat.kind === 'private' ? chat.userId : '', tags: ['画画'], importance: 0.4 })
        return { ok: true, message: '画好发出去了' }
      },
    }))
  }

  // B 站：看视频（谁发的链接都能看），评论要主人开口
  if (deps.bili && getConfig().bili.enabled && !isSystem) {
    tools.push(defineTool({
      name: 'bili_watch',
      description: '打开一个 B 站视频看看：读标题、简介、字幕和热评，看完再跟大家聊。别人发来 B 站链接、BV 号或分享卡片时用。link 填链接或 BV 号。',
      properties: { link: str('B 站链接、b23.tv 短链或 BV 号') },
      required: ['link'],
      execute: async ({ link }) => deps.bili.watch(String(link || '')),
    }))
    tools.push(defineTool({
      name: 'bili_comment',
      description: '在一个 B 站视频下发评论（只有主人让你发的时候才用）。link 填链接或 BV 号，text 是评论内容。',
      properties: { link: str('B 站链接或 BV 号'), text: str('评论内容') },
      required: ['link', 'text'],
      execute: async ({ link, text }) => {
        if (!hub.turnHasOwner(sessionId)) return { ok: false, message: '只有主人能让我去发评论' }
        return deps.bili.comment(String(link || ''), String(text || ''))
      },
    }))
    // 截图：刷 B 站看画面时截下来的那些帧，存在本机，随时能挑一张发出来
    tools.push(defineTool({
      name: 'qq_send_shot',
      description: '把你在 B 站视频里截到的画面发到当前聊天。主人说「发张截图」「给我看看你刷到的」「刚才那个视频长啥样」这类话时用。query 填视频标题里的词或想看的内容，不填就挑最近的一张。',
      properties: { query: str('可选：视频标题关键词，或想看的内容') },
      required: [],
      execute: async ({ query }) => deps.bili.sendShot({ chatId: current, query: String(query || '') }),
    }))
    tools.push(defineTool({
      name: 'qq_list_shots',
      description: '看看你手上还有哪些 B 站截图（来自哪个视频、第几秒）。挑截图之前可以先看一眼。',
      properties: { query: str('可选，按视频标题筛选') },
      required: [],
      execute: async ({ query }) => deps.bili.listShots(String(query || '')),
    }))
  }

  // 翻唱：面板里打开了才给她（没开就别让她答应唱歌）
  if (song && getConfig().song.enabled && !isSystem) tools.push(defineTool({
    name: 'qq_song_cover',
    description: '用你自己的声音翻唱一首歌，做好后自动以语音条发到当前聊天（要两三分钟，调用后先简单回一句「等我一下」就好）。song 写歌名，最好带上歌手，比如「小幸运 田馥甄」。pitch 是变调半音：你是女声，原唱是男声时一般 +12，原唱是女声时 0。',
    properties: { song: str('歌名（可以带歌手）'), pitch: int('变调半音：原唱男声 +12，女声 0') },
    required: ['song'],
    execute: async ({ song: name, pitch }) => {
      if (getConfig().song.ownerOnly && !hub.turnHasOwner(sessionId)) return { ok: false, message: '只有主人能点歌' }
      return song.request({ song: name, pitch, chatId: current })
    },
  }))

  return tools
}
