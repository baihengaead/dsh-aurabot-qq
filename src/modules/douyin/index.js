// 内置模块：刷抖音。CDP（Edge）管内容；douyin-im 管社交（私信 / 分享主人 / 回主人私信）。
// 权限同前。关注仅工具；点赞/评论可刷流也可工具；分享刷流与工具均走 IM。

import { createDouyin } from '../../douyin/duty.js'
import { defineTool, str } from '../../tools/tools.js'
import { profileToolVisible, profilePermits } from '../../chat/access.js'
import { parseUserInput, resolveAvatarSource, sniffImageType, AVATAR_MAX_BYTES, NICK_MAX, SIGN_MAX } from '../../douyin/util.js'
import { dataDir } from '../../core/store.js'
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

export default {
  id: 'douyin',
  name: '刷抖音',
  version: '1.0.1',
  description: 'CDP 刷抖音内容 + douyin-im 社交：看推荐、点赞、评论、关注（仅工具）、私信、分享给主人、回主人私信；改签名/昵称/头像',
  tab: 'douyin',
  files: ['douyin/duty.js', 'douyin/cdp.js', 'douyin/im.js', 'douyin/util.js'],
  setup(api) {
    const { hub, http } = api.core

    const dy = createDouyin({
      getConfig: api.config,
      hub,
      memory: api.lazy('memory'),
      log: api.log,
    })

    const originalConfirm = dy.confirmOwner
    dy.confirmOwner = async (input) => {
      const raw = String(input ?? api.config().douyin?.owner?.input ?? '').trim()
      const parsed = parseUserInput(raw)
      if (!parsed) return { ok: false, message: '请填抖音号，或主页链接（douyin.com/user/…）' }
      api.config._setOwner = (owner) => {
        api.setConfig((cur) => ({
          ...cur,
          douyin: { ...cur.douyin, owner: { ...cur.douyin.owner, ...owner } },
        }))
      }
      try {
        return await originalConfirm(raw)
      } finally {
        delete api.config._setOwner
      }
    }

    const lastImage = new Map() // chatId → 最近一张图（http 或本地）
    api.on('message', (msg) => {
      const seg = (msg.images || []).slice(-1)[0]
      const url = seg?.data?.url || seg?.data?.file
      if (url) lastImage.set(msg.chatId, String(url))
      return false
    })

    async function materializeAvatar(image, chat, sessionId) {
      const roots = [dataDir(), dataDir('douyin'), dataDir('douyin', 'uploads')]
      const src = resolveAvatarSource(image, lastImage.get(hub.chatOfSession?.(sessionId) || chat.chatId), roots)
      if (!src.ok) return src
      const dir = dataDir('douyin', 'uploads')
      mkdirSync(dir, { recursive: true })
      if (src.path) {
        if (!existsSync(src.path)) return { ok: false, message: '找不到头像文件' }
        const buf = readFileSync(src.path)
        if (!buf?.length) return { ok: false, message: '头像文件是空的' }
        if (buf.length > AVATAR_MAX_BYTES) return { ok: false, message: `头像太大了，最多 ${Math.floor(AVATAR_MAX_BYTES / 1024 / 1024)}MB` }
        if (!sniffImageType(buf)) return { ok: false, message: '不是能认的图片（要 png / jpg / gif / webp）' }
        return { ok: true, path: src.path }
      }
      // http(s)：拉到数据目录再交给 duty
      let res
      try {
        res = await fetch(src.url, { redirect: 'follow' })
      } catch (error) {
        return { ok: false, message: '下不了这张图：' + (error.message || error) }
      }
      if (!res.ok) return { ok: false, message: `下图失败：HTTP ${res.status}` }
      const ab = await res.arrayBuffer()
      const buf = Buffer.from(ab)
      if (!buf.length) return { ok: false, message: '下到的图是空的' }
      if (buf.length > AVATAR_MAX_BYTES) return { ok: false, message: `头像太大了，最多 ${Math.floor(AVATAR_MAX_BYTES / 1024 / 1024)}MB` }
      let mime = String(res.headers.get('content-type') || '').split(';')[0].trim()
      if (!/^image\//i.test(mime)) mime = sniffImageType(buf)
      if (!mime) return { ok: false, message: '不是能认的图片（要 png / jpg / gif / webp）' }
      const ext = mime.includes('png') ? '.png' : mime.includes('webp') ? '.webp' : mime.includes('gif') ? '.gif' : '.jpg'
      const path = join(dir, `avatar-${Date.now()}${ext}`)
      writeFileSync(path, buf)
      return { ok: true, path }
    }

    api.every(60_000, () => dy.tick(), '刷抖音')

    const guarded = (key, chat, sessionId, run) => async (args) => {
      const cfg = api.config()
      if (!cfg.douyin.enabled) return { ok: false, message: '抖音没打开' }
      const p = profilePermits(cfg, key, chat, hub.turnSendersAllOwner(sessionId))
      if (!p.ok) return p
      return run(args, cfg)
    }

    api.tool(({ chat, sessionId }) => {
      const cfg = api.config()
      if (!cfg.douyin.enabled || chat.kind === 'system') return []
      const tools = []
      if (profileToolVisible(cfg, 'douyinBrowse', chat)) tools.push(defineTool({
        name: 'douyin_watch',
        description: '打开一个抖音视频看看：读文案和热评。别人发来抖音链接时用。link 填视频链接。',
        properties: { link: str('抖音视频链接或 v.douyin.com 短链') },
        required: ['link'],
        execute: guarded('douyinBrowse', chat, sessionId, async ({ link }) => dy.watch(String(link || ''))),
      }))
      if (profileToolVisible(cfg, 'douyinLike', chat)) tools.push(defineTool({
        name: 'douyin_like',
        description: '给一个抖音视频点赞。link 填视频链接。',
        properties: { link: str('抖音视频链接') },
        required: ['link'],
        execute: guarded('douyinLike', chat, sessionId, async ({ link }) => dy.likeVideo(String(link || ''))),
      }))
      if (profileToolVisible(cfg, 'douyinComment', chat)) tools.push(defineTool({
        name: 'douyin_comment',
        description: '在抖音视频下发评论。link 填视频链接，text 是评论内容。',
        properties: { link: str('抖音视频链接'), text: str('评论内容') },
        required: ['link', 'text'],
        execute: guarded('douyinComment', chat, sessionId, async ({ link, text }) => dy.commentVideo(String(link || ''), String(text || ''))),
      }))
      if (profileToolVisible(cfg, 'douyinFollow', chat)) tools.push(defineTool({
        name: 'douyin_follow',
        description: '关注某个抖音用户。刷流不会自动关注，只有别人明确让你关注时才用。target 填对方主页链接或 sec_uid。',
        properties: { target: str('对方主页链接或 sec_uid') },
        required: ['target'],
        execute: guarded('douyinFollow', chat, sessionId, async ({ target }) => dy.followUser(String(target || ''))),
      }))
      if (profileToolVisible(cfg, 'douyinDm', chat)) tools.push(defineTool({
        name: 'douyin_dm',
        description: '给某个抖音用户发私信。每人每天最多 1 条。target 填对方主页链接或 sec_uid，text 是私信内容。建议用小号。只有别人明确让你发时才用。',
        properties: { target: str('对方主页链接或 sec_uid'), text: str('私信内容') },
        required: ['target', 'text'],
        execute: guarded('douyinDm', chat, sessionId, async ({ target, text }) => dy.dmTo(String(target || ''), String(text || ''))),
      }))
      if (profileToolVisible(cfg, 'douyinShareOwner', chat)) tools.push(defineTool({
        name: 'douyin_share',
        description: '把抖音视频私信分享给已核对的主人。link 填视频链接，text 是捎的话。',
        properties: { link: str('抖音视频链接'), text: str('捎给主人的话（可空）') },
        required: ['link'],
        execute: guarded('douyinShareOwner', chat, sessionId, async ({ link, text }) => dy.shareToOwner(String(link || ''), String(text || ''))),
      }))
      if (profileToolVisible(cfg, 'douyinSign', chat)) tools.push(defineTool({
        name: 'douyin_set_sign',
        description: `改你自己的抖音个性签名（最多 ${SIGN_MAX} 字）。有人让你改抖音签名时用。每天有次数上限。`,
        properties: { text: str('新签名') },
        required: ['text'],
        execute: guarded('douyinSign', chat, sessionId, async ({ text }) => dy.setSign(String(text || ''))),
      }))
      if (profileToolVisible(cfg, 'douyinNickname', chat)) tools.push(defineTool({
        name: 'douyin_set_nickname',
        description: `改你自己的抖音昵称（最多 ${NICK_MAX} 字）。有人让你改抖音名字时用。每天有次数上限。`,
        properties: { text: str('新昵称') },
        required: ['text'],
        execute: guarded('douyinNickname', chat, sessionId, async ({ text }) => dy.setNickname(String(text || ''))),
      }))
      if (profileToolVisible(cfg, 'douyinAvatar', chat)) tools.push(defineTool({
        name: 'douyin_set_avatar',
        description: '换你自己的抖音头像。image 填图片网址；填 last 就用这个聊天里刚才别人发的那张图；也可用数据目录里的本地图片路径。每天最多换 1 次。',
        properties: { image: str('图片网址（http/https）、last，或数据目录内本地路径') },
        required: ['image'],
        execute: guarded('douyinAvatar', chat, sessionId, async ({ image }) => {
          const mat = await materializeAvatar(image, chat, sessionId)
          if (!mat.ok) return mat
          return dy.setAvatar(mat.path)
        }),
      }))
      return tools
    })

    api.route('/douyin/state', async () => ({ ok: true, ...dy.state(), account: await dy.account(), im: await dy.imStatus() }))
    api.route('/douyin/account', async () => dy.account(true))
    api.route('/douyin/im', async () => dy.imStatus())
    api.route('/douyin/im-login', async () => dy.startImLogin())
    api.route('/douyin/im-login/status', async () => dy.imLoginStatus())
    api.route('/douyin/im-login/refresh', async () => dy.refreshImLogin())
    api.route('/douyin/im-login/sms', async (req) => {
      const b = await http.body(req).catch(() => ({}))
      return dy.submitImLoginSms(b?.code ?? b?.sms ?? '')
    })
    api.route('/douyin/browser-login', async () => dy.startBrowserLogin())
    api.route('/douyin/browser-login/status', async () => dy.browserLoginStatus())
    api.route('/douyin/browser-login/refresh', async () => dy.refreshBrowserLogin())
    api.route('/douyin/run', async () => dy.run({ force: true }))
    api.route('/douyin/share', async (req) => {
      const b = await http.body(req).catch(() => ({}))
      return dy.shareToOwner(String(b?.link || ''), String(b?.text || ''))
    })
    api.route('/douyin/dms', async () => dy.checkOwnerDms())
    api.route('/douyin/replies', async () => dy.checkCommentReplies())
    api.route('/douyin/confirm-owner', async (req) => {
      const b = await http.body(req).catch(() => ({}))
      const input = b?.input ?? api.config().douyin?.owner?.input ?? ''
      return dy.confirmOwner(input)
    })
    // 兼容旧路径：改为面板内二维码浏览器登录，不再弹前台扫码窗提示
    api.route('/douyin/open-login', async () => dy.startBrowserLogin())

    return dy
  },
}
