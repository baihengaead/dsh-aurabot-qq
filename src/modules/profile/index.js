// 内置模块：主人私聊时查看自己的 QQ 资料，以及按权限修改昵称、签名、头像。
// 三个都是 SnowLuma 的扩展动作（不是标准 OneBot v11）：set_qq_profile / set_self_longnick / set_qq_avatar。
// 每个操作单独一档权限（面板「权限」页）：off 关 / owner 仅主人私聊（默认）/ all 所有人。B 站签名在 bili 模块里。

import { defineTool, str } from '../../tools/tools.js'
import { isOwner, profileToolVisible, profilePermits } from '../../chat/access.js'
import { createQqProfile } from '../../features/qq-profile.js'

const NICK_MAX = 36
const SIGN_MAX = 80

export function profileResultBlocks(_args, value) {
  const blocks = [{ type: 'text', text: value?.ok === false ? '✗ ' + value.message : value?.message || '✓' }]
  if (value?.ok !== false && value?.image?.attachment) blocks.push(value.image)
  return blocks
}

/** 头像来源只收 http(s) 网址或「last」（这个聊天里最近一张图）；本地路径一律不收，免得被人拿去读电脑上的文件。 */
export function avatarSource(input, lastUrl) {
  const s = String(input || '').trim()
  if (!s || /^(last|刚才|上一张|最近)/i.test(s)) return lastUrl ? { ok: true, file: lastUrl } : { ok: false, message: '这个聊天里还没人发过图' }
  if (/^https?:\/\//i.test(s)) return { ok: true, file: s }
  return { ok: false, message: '头像只能用网址图片，或者刚才发的那张图' }
}

export default {
  id: 'profile',
  name: '改资料',
  version: '1.2.0',
  description: '主人私聊时查看自己的 QQ 资料与头像图片（qq_get_profile）、发送当前头像（qq_send_avatar）；按权限修改 QQ 资料',
  files: ['features/qq-profile.js'],
  setup(api, { fetchAvatar, ask } = {}) {
    const { hub, onebot } = api.core
    const reader = createQqProfile({ getConfig: api.config, onebot, dsh: api.dsh, log: api.log, fetchAvatar, ask })
    api.onDispose(reader.dispose)
    api.rule((kind) => kind === 'private' ? '主人谈到你自己的 QQ 昵称、个性签名或头像时，可以主动用 qq_get_profile 查看当前资料，不必等主人明确说“查询”。例如“你现在叫什么”“签名是什么”“喜欢这个头像吗”。问头像画面时传 view_avatar=true，依据本次头像附件和描述回答；查不到就如实说明，不凭旧聊天记录猜。主人明确说“把现在头像发出来”“发你的头像给我”时，用 qq_send_avatar 直接发送，不必先识图；只有工具报告 sent=true 才能说发出去了，成功后不要再用链接或 Markdown 重复发图。查询不会发送图片或修改资料；普通无关聊天无需查询。' : '')
    const lastImage = new Map() // chatId → 最近一张图的网址

    api.on('message', (msg) => {
      const seg = (msg.images || []).slice(-1)[0]
      const url = seg?.data?.url
      if (url && /^https?:\/\//i.test(url)) lastImage.set(msg.chatId, url)
      return false
    })

    // 统一套路：dryRun 只说不做；执行前再按最新配置查一遍权限
    const guarded = (key, chat, sessionId, run) => async (args) => {
      const cfg = api.config()
      const p = profilePermits(cfg, key, chat, hub.turnSendersAllOwner(sessionId))
      if (!p.ok) return p
      return run(args, cfg)
    }

    api.tool(({ chat, sessionId }) => {
      if (chat.kind !== 'private' && chat.kind !== 'group') return []
      const cfg = api.config()
      const tools = []
      const allowed = () => chat.kind === 'private' && isOwner(api.config(), chat.userId) && hub.turnSendersAllOwner(sessionId)
      // 查询权限独立于修改权限，始终只给主人私聊，读取对象固定为机器人自己。
      if (chat.kind === 'private' && isOwner(cfg, chat.userId)) tools.push(defineTool({
        name: 'qq_get_profile',
        description: '查看你自己的当前 QQ 昵称、个性签名和头像地址。主人私聊谈到资料时可主动查询；需要看头像长什么样、评价头像时传 view_avatar=true，返回实际头像图片附件及辅助描述。只读，不发送图片或修改资料；主人要你发头像时用 qq_send_avatar。',
        properties: { view_avatar: { type: 'boolean', description: '是否实际查看头像画面；讨论头像外观时填 true，默认 false' } },
        render: profileResultBlocks,
        execute: async ({ view_avatar }) => {
          if (!allowed()) return { ok: false, message: '只有主人 QQ 私聊时才能查看我的 QQ 资料' }
          const result = await reader.read({ viewAvatar: view_avatar === true, model: view_avatar === true ? hub.modelFor?.(chat) : null })
          if (!allowed()) return { ok: false, message: '主人身份已变化，请在主人 QQ 私聊中重新查询' }
          return result
        },
      }))
      if (chat.kind === 'private' && isOwner(cfg, chat.userId)) tools.push(defineTool({
        name: 'qq_send_avatar',
        description: '主人明确要求“把现在头像发出来”“发你的头像给我”时，发送你自己的当前 QQ 头像图片到本次主人私聊。无需先识图，不接受地址、QQ 号或发送目标。发送成功后不要再重复发图。',
        execute: async () => {
          try {
            if (!allowed()) throw new Error('只有主人 QQ 私聊时才能发送我的 QQ 头像')
            const ready = () => {
              reader.assertCurrent(String(api.config().botQQ || ''))
              if (!api.config().enabled) throw new Error('插件总开关已关闭，未发送头像')
              return api.config().dryRun || api.config().debug
            }
            if (ready()) return { ok: true, sent: false, simulated: true, message: '试运行或调试模式：不会真实发送 QQ 头像' }
            const avatar = await reader.avatar()
            reader.assertCurrent(avatar.qq)
            if (!allowed()) throw new Error('主人身份已变化，未发送头像')
            if (ready()) return { ok: true, sent: false, simulated: true, message: '已切换到试运行或调试模式，未发送头像' }
            const sent = await hub.sendSegments(chat.chatId, [{ type: 'image', data: { file: 'base64://' + avatar.bytes.toString('base64') } }], '[当前 QQ 头像]')
            if (sent?.message_id == null) throw new Error('未收到 QQ 网关的头像发送确认，请检查连接；不要重复发送')
            api.log?.info?.('当前 QQ 头像已发送给主人私聊')
            return { ok: true, sent: true, messageId: sent.message_id, message: '当前 QQ 头像图片已发送给本次主人私聊，不要再用链接或 Markdown 重复发图' }
          } catch (error) {
            api.log?.warn?.('QQ 头像未确认发送：', error.message)
            return { ok: false, sent: false, message: error.message }
          }
        },
      }))
      if (profileToolVisible(cfg, 'qqNickname', chat)) tools.push(defineTool({
        name: 'qq_set_nickname',
        description: `改你自己的 QQ 昵称（最多 ${NICK_MAX} 字）。有人让你改名时用。`,
        properties: { name: str('新昵称') },
        required: ['name'],
        execute: guarded('qqNickname', chat, sessionId, async ({ name }, c) => {
          const nick = String(name || '').trim()
          if (!nick) return { ok: false, message: '昵称不能是空的' }
          if ([...nick].length > NICK_MAX) return { ok: false, message: `昵称最多 ${NICK_MAX} 个字` }
          if (c.dryRun) return { ok: true, message: `试运行：本来要把 QQ 昵称改成：${nick}` }
          await onebot.call('set_qq_profile', { nickname: nick }, { timeoutMs: 15000 })
          return { ok: true, message: `QQ 昵称改好了：${nick}` }
        }),
      }))
      if (profileToolVisible(cfg, 'qqSignature', chat)) tools.push(defineTool({
        name: 'qq_set_signature',
        description: `改你自己的 QQ 个性签名（最多 ${SIGN_MAX} 字）。有人让你改签名时用。`,
        properties: { text: str('新签名') },
        required: ['text'],
        execute: guarded('qqSignature', chat, sessionId, async ({ text }, c) => {
          const sign = String(text || '').trim()
          if (!sign) return { ok: false, message: '签名不能是空的' }
          if ([...sign].length > SIGN_MAX) return { ok: false, message: `签名最多 ${SIGN_MAX} 个字` }
          if (c.dryRun) return { ok: true, message: `试运行：本来要把 QQ 签名改成：${sign}` }
          await onebot.call('set_self_longnick', { longNick: sign }, { timeoutMs: 15000 })
          return { ok: true, message: `QQ 签名改好了：${sign}` }
        }),
      }))
      if (profileToolVisible(cfg, 'qqAvatar', chat)) tools.push(defineTool({
        name: 'qq_set_avatar',
        description: '换你自己的 QQ 头像。image 填图片网址；填 last 就用这个聊天里刚才别人发的那张图。',
        properties: { image: str('图片网址（http/https），或 last 表示刚才发的那张图') },
        required: ['image'],
        execute: guarded('qqAvatar', chat, sessionId, async ({ image }, c) => {
          const src = avatarSource(image, lastImage.get(hub.chatOfSession(sessionId) || chat.chatId))
          if (!src.ok) return src
          if (c.dryRun) return { ok: true, message: `试运行：本来要把 QQ 头像换成：${src.file}` }
          await onebot.call('set_qq_avatar', { file: src.file }, { timeoutMs: 30000 })
          return { ok: true, message: 'QQ 头像换好了' }
        }),
      }))
      return tools
    })
    return {}
  },
}
