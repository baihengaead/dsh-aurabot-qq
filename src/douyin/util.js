// 刷抖音用到的纯函数：日期、随机、认主页链接 / 抖音号、头像对比、feed 整理、验证码识别。不碰浏览器，好测。

import { resolve as pathResolve, sep as pathSep } from 'node:path'

export const dayKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

/** [lo, hi] 之间随机一个整数；rand 方便测试替换。 */
export const between = (lo, hi, rand = Math.random) => Math.floor(lo + rand() * (Math.max(lo, hi) - lo + 1))

/** 从模型输出里取 JSON（对象或数组），取不到返回 fallback。 */
export function pickJson(out, fallback) {
  const s = String(out || '')
  const m = s.match(/\[[\s\S]*\]/) || s.match(/\{[\s\S]*\}/)
  if (!m) return fallback
  try { return JSON.parse(m[0]) } catch (error) { return fallback }
}

/**
 * 主人填的「抖音号 / 主页链接」认成什么。
 * 主页链接（douyin.com/user/<sec_uid>）直接拿到 secUid；短链（v.douyin.com/xxx）要先跟随跳转；其余当抖音号（字母数字下划线点，4~24 位）。
 */
export function parseUserInput(input) {
  const t = String(input ?? '').trim()
  if (!t) return null
  const prof = t.match(/douyin\.com\/user\/([A-Za-z0-9_-]{20,})/i)
  if (prof) return { secUid: prof[1] }
  const iesProf = t.match(/[?&]sec_uid=([A-Za-z0-9_-]{20,})/i)
  if (iesProf) return { secUid: iesProf[1] }
  const short = t.match(/https?:\/\/v\.douyin\.com\/[A-Za-z0-9_-]+\/?/i)
  if (short) return { short: short[0] }
  const id = t.replace(/^@/, '').match(/^[A-Za-z0-9_.-]{2,40}$/)
  if (id) return { uniqueId: id[0] }
  return null
}

/** 从一段文字里找视频：抖音视频链接、/video/<id>、modal_id=<id>、纯数字 aweme_id。 */
export function findAwemeId(text) {
  const t = String(text ?? '')
  const a = t.match(/douyin\.com\/(?:video|note)\/(\d{8,25})/i) || t.match(/[?&]modal_id=(\d{8,25})/i) || t.match(/iesdouyin\.com\/share\/video\/(\d{8,25})/i)
  if (a) return { awemeId: a[1] }
  const short = t.match(/https?:\/\/v\.douyin\.com\/[A-Za-z0-9_-]+\/?/i)
  if (short) return { short: short[0] }
  const n = t.trim().match(/^\d{15,25}$/)
  return n ? { awemeId: n[0] } : null
}

export const videoLink = (id) => `https://www.douyin.com/video/${id}`

/** 只认 5~20 位纯数字 uid（IM friend 查找用）。 */
export function normalizeOwnerUid(uid) {
  const s = String(uid ?? '').trim()
  return /^\d{5,20}$/.test(s) ? s : ''
}

/**
 * 从主页快照抠 secUid + 数字 uid。
 * RENDER_DATA 在真机上是 URL 编码 JSON，裸 html 正则经常扫不到 "uid"。
 */
export function extractOwnerProfile({ href = '', html = '', renderData = '', nickname = '', avatar = '' } = {}) {
  let secUid = ''
  const hm = String(href || '').match(/\/user\/([A-Za-z0-9_-]{20,})/)
  if (hm) secUid = hm[1]

  let uid = ''
  // 只认「带匹配 secUid 的节点」上的 uid，避免吃到浏览器登录态自己的 uid
  const preferUid = (cand, sid) => {
    const n = normalizeOwnerUid(cand)
    if (!n) return
    if (secUid && sid && sid === secUid) uid = n
  }

  const walk = (node) => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) { for (const x of node) walk(x); return }
    const sid = String(node.secUid || node.sec_uid || '')
    preferUid(node.uid ?? node.user_id ?? node.userId, sid)
    for (const k of Object.keys(node)) walk(node[k])
  }

  if (renderData) {
    try {
      const raw = String(renderData)
      const decoded = raw.includes('%') ? decodeURIComponent(raw) : raw
      walk(JSON.parse(decoded))
    } catch (error) { /* RENDER_DATA 坏了就走 html */ }
  }

  const blob = String(html || '')
  const patterns = [
    /"uid"\s*:\s*"?(\d{5,20})"?/,
    /"user_id"\s*:\s*"?(\d{5,20})"?/,
    /"userId"\s*:\s*"?(\d{5,20})"?/,
    /uid%22%3A%22(\d{5,20})/,
    /uid%22%3A(\d{5,20})/,
  ]
  // 在 secUid 附近窗口抠 uid（窗口本身已限定主人，不再要求同节点带 sid）
  if (!uid && secUid) {
    const idx = blob.indexOf(secUid)
    if (idx >= 0) {
      const win = blob.slice(Math.max(0, idx - 2500), idx + 2500)
      for (const re of patterns) {
        const m = win.match(re)
        if (m) {
          const n = normalizeOwnerUid(m[1])
          if (n) { uid = n; break }
        }
      }
    }
  }
  // 故意不再做「整页任意 uid」回落，避免吃到浏览器登录态自己的 uid
  if (!secUid) {
    const sm = blob.match(/"secUid"\s*:\s*"([A-Za-z0-9_-]{20,})"/) || blob.match(/"sec_uid"\s*:\s*"([A-Za-z0-9_-]{20,})"/)
    if (sm) secUid = sm[1]
  }

  return {
    secUid,
    uid: normalizeOwnerUid(uid),
    nickname: String(nickname || '').split('\n')[0].slice(0, 40),
    avatar: String(avatar || ''),
  }
}


/** 当前网址是不是「推荐」信息流（不是精选 / 关注 / 搜索 / 个人页）。 */
export function isRecommendUrl(url) {
  let u
  try { u = new URL(String(url)) } catch (error) { return false }
  if (!/(^|\.)douyin\.com$/.test(u.hostname)) return false
  if (u.pathname !== '/' && u.pathname !== '') return false
  return u.searchParams.get('recommend') === '1'
}

/** 头像网址去掉大小 / 签名参数，只比图片本体：路径最后一段去掉 ~ 之后的缩放后缀。 */
export function avatarKey(url) {
  const s = String(url || '').trim()
  if (!s) return ''
  let path = s
  try { path = new URL(s.startsWith('//') ? 'https:' + s : s).pathname } catch (error) { path = s.split('?')[0] }
  const last = path.split('/').filter(Boolean).pop() || ''
  return last.split('~')[0].replace(/\.(jpe?g|png|webp|image|awebp)$/i, '')
}
export const sameAvatar = (a, b) => { const x = avatarKey(a); return x !== '' && x === avatarKey(b) }

/** 主人在抖音上是不是「确认过的那个人」：只认 secUid，并且面板里的输入没被改过。 */
export function ownerConfirmed(cfg) {
  const o = cfg?.douyin?.owner || {}
  return Boolean(o.secUid && o.input && o.confirmedInput === o.input)
}
export const isOwnerSec = (cfg, secUid) => ownerConfirmed(cfg) && Boolean(secUid) && String(secUid) === cfg.douyin.owner.secUid

/** 页面上出现这些字样 = 要验证 / 要滑块 / 风控，立刻停手。 */
const VERIFY_RE = /验证码|滑块|拖动.{0,6}完成|请完成安全验证|安全验证|身份验证|captcha|verify/i
export const looksLikeVerify = (text) => VERIFY_RE.test(String(text || ''))
/** 这些响应码 / 文案说明账号被限制了（操作频繁、被风控），也当风控处理。 */
const LIMIT_RE = /操作过于频繁|行为异常|账号.{0,6}(异常|限制)|频繁操作|稍后再试/
export const looksLimited = (text) => LIMIT_RE.test(String(text || ''))

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0 }

/** 把 feed 响应里的一条整理成她看的样子；广告 / 直播 / 没 id 的返回 null。 */
export function normalizeAweme(a) {
  const x = a?.aweme_info || a
  if (!x || typeof x !== 'object') return null
  const id = String(x.aweme_id || x.awemeId || '')
  if (!id || x.is_ads || x.is_live || x.cell_room || x.live_reason) return null
  const st = x.statistics || {}
  const au = x.author || {}
  return {
    awemeId: id,
    desc: String(x.desc || '').slice(0, 300),
    author: String(au.nickname || ''),
    authorSecUid: String(au.sec_uid || ''),
    authorId: String(au.unique_id || au.short_id || ''),
    likes: num(st.digg_count),
    comments: num(st.comment_count),
    shares: num(st.share_count),
    duration: num(x.duration || x.video?.duration) / 1000,
    tags: (x.text_extra || []).map((t) => t?.hashtag_name).filter(Boolean).slice(0, 8),
    createdAt: num(x.create_time) * 1000,
    isImages: Array.isArray(x.images) && x.images.length > 0,
  }
}

/** 从一次响应的 JSON 里捞所有视频（recommend feed: aweme_list；搜索 / 其它: data[].aweme_info）。 */
export function awemesFromResponse(json) {
  const list = json?.aweme_list || (Array.isArray(json?.data) ? json.data : []) || []
  return list.map(normalizeAweme).filter(Boolean)
}

/** 一个视频交给她看的样子。 */
export function digestOf(v, comments = []) {
  return [
    `作者：${v.author || '?'}  点赞 ${v.likes || 0}  评论 ${v.comments || 0}${v.duration ? '  时长 ' + Math.round(v.duration) + ' 秒' : ''}`,
    v.desc ? `文案：${v.desc}` : '（没有文案）',
    v.tags?.length ? `话题：${v.tags.join('、')}` : '',
    comments.length ? '热评：\n' + comments.slice(0, 6).map((c) => `  ${c}`).join('\n') : '',
    `${v.awemeId}`,
  ].filter(Boolean).join('\n')
}

/** 评论 / 私信正文：去掉换行和过长部分；空的返回空串。 */
export const cleanText = (t, max = 100) => [...String(t ?? '').replace(/\s+/g, ' ').trim()].slice(0, max).join('')

/** 抖音昵称 / 签名上限（以常见页面为准；超长在保存前拒）。 */
export const NICK_MAX = 20
export const SIGN_MAX = 100
export const AVATAR_MAX_BYTES = 5 * 1024 * 1024

const PHONE_RE = /(?:\+?86[-\s]?)?1[3-9]\d{9}/
const LINK_RE = /https?:\/\/|www\.|v\.douyin\.com|抖音\.com|\.com\/|\.cn\//i
const AT_RE = /@[\w\u4e00-\u9fff]/
const AD_RE = /加微|加v|vx|微信|优惠券|免费领|代刷|引流|广告|私聊领取|限时特价/i
const FORBIDDEN_NICK_RE = /^[\s._\-•·]+$|[<>{}[\]\\|]/

/** 按文件头认图片类型（QQ 图床常标 octet-stream）。 */
export function sniffImageType(buf) {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf || [])
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png'
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'image/gif'
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp'
  return ''
}

/** 昵称过滤：空 / 超长 / 禁字符 / 链接 / @ / 手机 / 广告。 */
export function filterNickname(text) {
  const nick = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (!nick) return { ok: false, message: '昵称不能是空的' }
  if ([...nick].length > NICK_MAX) return { ok: false, message: `昵称最多 ${NICK_MAX} 个字` }
  if (FORBIDDEN_NICK_RE.test(nick) || LINK_RE.test(nick) || AT_RE.test(nick) || PHONE_RE.test(nick) || AD_RE.test(nick)) {
    return { ok: false, message: '昵称里不能有链接、@、手机号、广告或禁用字符' }
  }
  return { ok: true, text: nick }
}

/** 签名过滤：空 / 超长 / 链接 / @ / 手机 / 广告。 */
export function filterSignature(text) {
  const sign = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (!sign) return { ok: false, message: '签名不能是空的' }
  if ([...sign].length > SIGN_MAX) return { ok: false, message: `签名最多 ${SIGN_MAX} 个字` }
  if (LINK_RE.test(sign) || AT_RE.test(sign) || PHONE_RE.test(sign) || AD_RE.test(sign)) {
    return { ok: false, message: '签名里不能有链接、@、手机号或广告口吻' }
  }
  return { ok: true, text: sign }
}


/** 头像来源：last / http(s) / 白名单本地路径（必须落在 allowRoots 下）。 */
export function resolveAvatarSource(input, lastUrl, allowRoots = []) {
  const s = String(input || '').trim()
  if (!s || /^(last|刚才|上一张|最近)/i.test(s)) {
    const last = String(lastUrl || '').trim()
    if (!last) return { ok: false, message: '这个聊天里还没人发过图' }
    if (/^https?:\/\//i.test(last)) return { ok: true, url: last }
    return resolveAvatarSource(last, '', allowRoots)
  }
  if (/^https?:\/\//i.test(s)) return { ok: true, url: s }
  const resolved = pathResolve(s)
  const roots = (allowRoots || []).map((r) => pathResolve(String(r || ''))).filter(Boolean)
  const under = roots.some((r) => resolved === r || resolved.startsWith(r + pathSep))
  if (!under) return { ok: false, message: '本地头像只能用数据目录里的图' }
  return { ok: true, path: resolved }
}
