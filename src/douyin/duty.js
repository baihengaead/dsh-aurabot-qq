// 刷抖音：CDP（Edge）管内容——刷流 / 点赞 / 评论 / 回评论 / 关注 / 改资料；
// 社交（私信、分享主人、回主人私信）走 douyin-im，无浏览器。测时注入 createFakeDriver / createFakeImClient。

import { dataDir, readJson, writeJson } from '../core/store.js'
import { isSilence } from '../chat/reply.js'
import {
  dayKey, between, pickJson, parseUserInput, findAwemeId, videoLink,
  ownerConfirmed, isOwnerSec, digestOf, cleanText, looksLikeVerify,
  filterNickname, filterSignature, sniffImageType, AVATAR_MAX_BYTES,
  normalizeOwnerUid,
} from './util.js'
import { readFileSync, existsSync } from 'node:fs'
import { basename } from 'node:path'
import { createBrowserDriver } from './cdp.js'
import { IM_NOT_LOGGED_IN, openImClient } from './im.js'

const WRITE_OPS = ['like', 'comment', 'replyComment', 'follow', 'dm', 'shareOwner', 'dmReply', 'sign', 'nickname', 'avatar']
const emptyDay = () => ({
  day: '', runs: 0, watched: 0, writes: 0,
  like: 0, comment: 0, replyComment: 0, follow: 0, dm: 0, shareOwner: 0, dmReply: 0,
  sign: 0, nickname: 0, avatar: 0,
  lastSignText: '', lastNicknameText: '',
  lastWriteAt: 0,
  failStreak: Object.fromEntries(WRITE_OPS.map((k) => [k, 0])),
  disabledOps: Object.fromEntries(WRITE_OPS.map((k) => [k, false])),
  dmTargets: {}, // secUid → 今天已私信次数（任何人：每目标最多 1）
  ownerDmStreak: 0, // 连续回主人私信条数（主人没新话就停在 3）
  pauseNotified: false,
})

const emptyState = () => ({
  ...emptyDay(),
  lastRun: 0, nextDueAt: 0, lastSkipReason: '',
  lastReplyCheck: 0, lastDmCheck: 0,
  seen: [], history: [], repliedComments: [], repliedDms: [],
  pauseDay: '', pauseReason: '',
  selfSecUid: '', selfNickname: '',
  loginAt: 0, // 首次确认登录的时间戳；前 newAccountDays 天上限减半
})

export function createDouyin({ getConfig, hub, memory, log, driver: injected, im: injectedIm, dataFile, now: nowFn } = {}) {
  const now = () => (nowFn ? nowFn() : Date.now())
  const cfg = () => getConfig().douyin
  const file = () => dataFile || dataDir('douyin.json')
  const load = () => readJson(file(), emptyState)
  const save = (s) => writeJson(file(), s)
  const today = (s) => {
    if (s.day !== dayKey(new Date(now()))) {
      Object.assign(s, emptyDay(), { day: dayKey(new Date(now())) })
    }
    if (!s.failStreak) s.failStreak = Object.fromEntries(WRITE_OPS.map((k) => [k, 0]))
    if (!s.disabledOps) s.disabledOps = Object.fromEntries(WRITE_OPS.map((k) => [k, false]))
    if (!s.dmTargets) s.dmTargets = {}
    return s
  }
  let busy = false
  let socialBusy = false
  let driver = injected || null
  let im = injectedIm || null

  const ownerName = () => getConfig().ownerName || '主人'
  const profileDir = () => dataDir('douyin', 'edge-profile')
  const isFake = () => Boolean(driver && driver._state)

  function ensureDriver() {
    if (driver) return driver
    const c = cfg()
    driver = createBrowserDriver({
      profileDir: profileDir(),
      browserPath: c.browserPath,
      minimize: c.minimize !== false,
      log,
    })
    return driver
  }

  async function ensureIm() {
    if (im) return im
    im = await openImClient({ dataPath: dataDir('douyin', 'im') })
    return im
  }

  async function requireIm() {
    try {
      const client = await ensureIm()
      const online = await client.ensureOnline()
      if (!online.ok) return { ok: false, message: online.message || IM_NOT_LOGGED_IN }
      return { ok: true, im: client }
    } catch (error) {
      return { ok: false, message: String(error?.message || error) }
    }
  }

  function ownerImTarget() {
    const o = cfg().owner || {}
    return { uid: o.uid || '', secUid: o.secUid || '' }
  }

  function socialInterruptOn() {
    return cfg().socialInterruptBrowse !== false // 默认开
  }

  async function withSocialBusy(fn) {
    socialBusy = true
    try { return await fn() }
    finally { socialBusy = false }
  }

  function browseInterrupted(s) {
    if (!socialInterruptOn() || !socialBusy) return false
    s.lastSkipReason = '社交优先：私信/分享打断了刷流'
    return true
  }

  const record = (s, item) => { s.history.unshift({ at: now(), ...item }); s.history = s.history.slice(0, 40) }
  const perm = (key) => {
    const p = getConfig().profilePerms?.[key]
    return p === 'off' ? 'off' : (p || 'owner')
  }
  const paused = (s) => s.pauseDay === dayKey(new Date(now()))
  const isNewAccount = (s) => {
    const days = Number(cfg().gate?.newAccountDays ?? 3)
    if (!s.loginAt || days <= 0) return false
    return now() - s.loginAt < days * 86400_000
  }
  const capOf = (s, key) => {
    let cap = Number(cfg().caps?.[key] ?? 0)
    if (isNewAccount(s)) cap = Math.floor(cap / 2)
    return cap
  }
  const left = (s, key) => Math.max(0, capOf(s, key) - (s[key] || 0))
  const writeBudget = (s) => {
    let max = Number(cfg().gate?.maxWritesPerDay ?? 60)
    if (isNewAccount(s)) max = Math.floor(max / 2)
    return Math.max(0, max - (s.writes || 0))
  }
  const dry = () => Boolean(getConfig().dryRun)

  /** 验证码 / 风控：停全部写操作，只通知主人一次。 */
  function pauseAll(s, why) {
    s.pauseDay = dayKey(new Date(now()))
    s.pauseReason = why || '风控'
    log.warn(`今天先不在抖音动手了：${s.pauseReason}`)
    if (!s.pauseNotified && getConfig().ownerQQ) {
      s.pauseNotified = true
      hub.sendText?.(`private:${getConfig().ownerQQ}`, `抖音这边要验证 / 被限制了，今天所有动手的操作都停了：${s.pauseReason}`).catch?.(() => {})
    }
    save(s)
  }

  /** 写操作总闸：日总上限、间隔、单项上限、连续失败禁用、验证码、试运行不计次。 */
  async function doWrite(s, kind, act, meta = {}) {
    if (paused(s)) return { ok: false, message: '今天暂停：' + s.pauseReason }
    if (s.disabledOps?.[kind]) return { ok: false, message: `${kind} 今天连续失败太多次，先停了` }
    if (left(s, kind) <= 0) return { ok: false, message: `今天 ${kind} 次数用完了` }
    if (writeBudget(s) <= 0) return { ok: false, message: '今天写操作总次数用完了' }
    const gapSec = Number(cfg().gate?.minWriteGapSec ?? 20)
    const since = now() - (s.lastWriteAt || 0)
    if (gapSec > 0 && s.lastWriteAt && since < gapSec * 1000) {
      return { ok: false, message: `写太勤了，再等 ${Math.ceil((gapSec * 1000 - since) / 1000)} 秒` }
    }
    // 试运行：只记日志，不占真实日上限 / 总闸 / 间隔
    if (dry()) {
      log.info(`试运行：本来要 ${kind}`, meta.awemeId || meta.secUid || meta.text || '')
      record(s, { kind: 'dry:' + kind, awemeId: meta.awemeId, author: meta.author, text: meta.text || '', secUid: meta.secUid })
      save(s)
      return { ok: true, dryRun: true }
    }
    try {
      await act()
    } catch (error) {
      const msg = String(error?.message || error)
      log.warn(`抖音${kind}失败：`, msg)
      record(s, { kind: 'error', awemeId: meta.awemeId, text: `${kind}没成功：${msg}` })
      const drv = ensureDriver()
      if (drv.paused || looksLikeVerify(msg) || /验证|风控|频繁|异常/.test(msg)) {
        pauseAll(s, drv.pauseReason || msg.slice(0, 40))
      } else {
        s.failStreak[kind] = (s.failStreak[kind] || 0) + 1
        if (s.failStreak[kind] >= 3) {
          s.disabledOps[kind] = true
          log.warn(`${kind} 连续失败 3 次，今天先禁用`)
        }
        save(s)
      }
      return { ok: false, message: msg }
    }
    s[kind] = (s[kind] || 0) + 1
    s.writes = (s.writes || 0) + 1
    s.lastWriteAt = now()
    s.failStreak[kind] = 0
    record(s, { kind, awemeId: meta.awemeId, author: meta.author, text: meta.text || '', secUid: meta.secUid })
    save(s)
    return { ok: true }
  }

  function turnText(out) {
    if (out == null) return ''
    if (typeof out === 'string') return out
    if (typeof out?.text === 'string') return out.text
    return String(out)
  }

  /** 刷流 think：可调 shareBias（stingy|normal|proactive）。 */
  function shareBiasHint() {
    const bias = String(cfg().shareBias || 'proactive').toLowerCase()
    if (bias === 'stingy' || bias === 'off') return '觉得主人一定会喜欢再写 share，拿不准就空着。'
    if (bias === 'normal') return '觉得主人会喜欢才写 share，不然空。'
    return '分享要积极：好看、有趣、值得主人一看的就填 share，别空着；今天额度没用完就尽量推。'
  }

  async function think(prompt) {
    return turnText(await hub.runSystemTurn('douyin', 'QQ · 刷抖音', `【刷抖音，不是聊天，这一轮不会发到聊天里】\n${prompt}`, { timeoutMs: 180000 }))
  }

  /** 抖音 IM 私信：同 QQ 走 hub.runSystemTurn，但关工具；正文经 IM 发出。 */
  async function thinkImReply(prompt) {
    return turnText(await hub.runSystemTurn(
      'douyin-im',
      '抖音 · 私信',
      `【抖音私信，用你的口气回；这一轮没有工具，回复会经抖音 IM 发给对方】\n${prompt}`,
      { timeoutMs: 180000, noTools: true },
    ))
  }

  async function boot() {
    const d = ensureDriver()
    const r = await d.launch()
    if (!r.ok) return r
    const gate = await d.checkGate()
    if (!gate.ok) {
      if (gate.verify) {
        const s = today(load())
        pauseAll(s, gate.reason || '要验证')
      }
      return gate
    }
    return { ok: true }
  }

  async function account(force = false) {
    try {
      const d = ensureDriver()
      if (force || !d._state) await d.launch()
      const self = await d.selfInfo()
      const gate = await d.checkGate()
      const isLogin = !gate.needLogin && !gate.verify
      if (isLogin) {
        const s = today(load())
        if (!s.loginAt) { s.loginAt = now(); save(s) }
        if (self?.secUid) { s.selfSecUid = self.secUid; s.selfNickname = self.nickname || ''; save(s) }
      }
      return {
        isLogin,
        needLogin: !!gate.needLogin,
        verify: !!gate.verify,
        reason: gate.reason || '',
        secUid: self?.secUid || '',
        nickname: self?.nickname || '',
      }
    } catch (error) {
      return { isLogin: false, error: error.message }
    }
  }

  async function confirmOwner(input) {
    const raw = String(input ?? cfg().owner?.input ?? '').trim()
    const parsed = parseUserInput(raw)
    if (!parsed) return { ok: false, message: '请填抖音号，或主页链接（douyin.com/user/…）' }
    const d = ensureDriver()
    const launched = await d.launch()
    if (!launched.ok) return launched
    const r = await d.resolveUser(parsed)
    if (!r.ok) return r
    const uid = normalizeOwnerUid(r.uid)
    getConfig._setOwner?.({ input: raw, secUid: r.secUid, uid, nickname: r.nickname || '', avatar: r.avatar || '', confirmedInput: raw })
    return { ok: true, message: `已核对：${r.nickname || r.secUid}`, secUid: r.secUid, uid, nickname: r.nickname, avatar: r.avatar }
  }

  async function dwellMs() {
    const c = cfg()
    return between(c.dwellMin, c.dwellMax) * 1000
  }

  /** 刷流里对一条视频做点赞 / 评论 / 分享（关注不在刷流里，只走 douyin_follow 工具）。 */
  async function watchOne(s, v, decisions) {
    const d = decisions || {}
    const feeling = cleanText(d.feeling, 60)
    memory?.addEvent?.({ text: `在抖音看了 ${v.author || '有人'} 的视频${feeling ? '：' + feeling : ''}`, tags: ['抖音'], importance: 0.4 })
    if (d.remember && !isSilence(d.remember)) memory?.add?.({ text: String(d.remember).slice(0, 200), tags: ['抖音'], importance: 0.5, source: 'event' })
    record(s, { kind: 'watch', awemeId: v.awemeId, author: v.author, text: feeling || v.desc?.slice(0, 40) || '' })
    s.watched = (s.watched || 0) + 1
    save(s)

    const drv = ensureDriver()
    if (paused(s)) return

    if (d.like && perm('douyinLike') !== 'off') {
      const r = await doWrite(s, 'like', async () => {
        const ok = await drv.clickLike()
        if (!ok) throw new Error('找不到点赞按钮')
      }, { awemeId: v.awemeId, author: v.author })
      if (!r.ok && paused(s)) return
    }
    if (cleanText(d.comment) && perm('douyinComment') !== 'off' && !paused(s)) {
      const text = cleanText(d.comment, 100)
      const r = await doWrite(s, 'comment', async () => {
        await drv.openComments()
        const ok = await drv.typeAndSend(text)
        if (!ok) throw new Error('评论框打不开')
      }, { awemeId: v.awemeId, author: v.author, text })
      if (r.ok && !r.dryRun) memory?.addEvent?.({ text: `在抖音评论：${text.slice(0, 60)}`, tags: ['抖音'], importance: 0.4 })
      if (!r.ok && paused(s)) return
    }
    if (cleanText(d.share) && perm('douyinShareOwner') !== 'off' && ownerConfirmed(getConfig()) && !paused(s)) {
      const text = cleanText(d.share, 80)
      const target = ownerImTarget()
      const r = await doWrite(s, 'shareOwner', async () => {
        const need = await requireIm()
        if (!need.ok) throw new Error(need.message)
        await need.im.shareWork(target, {
          itemId: v.awemeId, title: v.desc, author: v.author, authorSecUid: v.authorSecUid,
        }, text)
      }, { awemeId: v.awemeId, text, secUid: target.secUid })
      if (r.ok && !r.dryRun) memory?.addEvent?.({ text: `把抖音视频私信分享给${ownerName()}：${text.slice(0, 40)}`, tags: ['抖音'], importance: 0.45 })
    }
  }

  async function run({ force = false } = {}) {
    const c = cfg()
    if (busy) return { ok: false, message: '正在刷' }
    if (!c.enabled && !force) return { ok: false, message: '抖音没打开' }
    if (perm('douyinBrowse') === 'off' && !force) return { ok: false, message: '刷抖音在权限里关掉了' }
    busy = true
    const s = today(load())
    try {
      if (paused(s)) return { ok: false, message: '今天暂停：' + s.pauseReason }
      if ((s.watched || 0) >= c.maxWatchPerDay) return { ok: false, message: `今天已经看了 ${s.watched} 个（上限 ${c.maxWatchPerDay}）` }

      const booted = await boot()
      if (!booted.ok) {
        s.lastSkipReason = booted.reason || booted.message || '启动失败'
        return { ok: false, message: s.lastSkipReason }
      }
      const drv = ensureDriver()
      const rec = await drv.ensureRecommend()
      if (!rec.ok) {
        s.lastSkipReason = rec.message || '不在推荐页'
        return { ok: false, message: s.lastSkipReason }
      }

      const seen = new Set(s.seen || [])
      const want = Math.min(c.perRun, Math.max(0, c.maxWatchPerDay - (s.watched || 0)))
      const list = await drv.nextAwemes({ seen, want })
      if (!list.length) {
        s.lastSkipReason = '这次没刷到新视频'
        return { ok: false, message: s.lastSkipReason }
      }

      const looked = []
      for (const v of list) {
        if (browseInterrupted(s)) {
          save(s)
          return { ok: false, message: s.lastSkipReason, interrupted: true }
        }
        // 真机按面板停留；假驱动跳过以免拖慢测试
        const waitMs = await dwellMs()
        if (!isFake()) await new Promise((r) => setTimeout(r, waitMs))
        const active = await drv.activeAwemeId().catch(() => '')
        if (active && active !== v.awemeId && list.every((x) => x.awemeId !== active)) {
          log.debug(`当前播的是 ${active}，和预期 ${v.awemeId} 不一致，跳过`)
          continue
        }
        seen.add(v.awemeId)
        looked.push(v)
        s.seen = [...seen].slice(-500)
        save(s)
      }
      if (!looked.length) return { ok: false, message: '视频对不上，这轮没看' }

      const likeLeft = left(s, 'like')
      const commentLeft = left(s, 'comment')
      const shareLeft = ownerConfirmed(getConfig()) ? left(s, 'shareOwner') : 0
      const out = await think(
        `你在抖音刷到了这几个视频：\n\n${looked.map((v, i) => `【${i + 1}】${digestOf(v)}`).join('\n\n')}\n\n` +
        `看完说说你的想法。对每个视频给一个对象：{"i":序号,"feeling":"一句真实感受","like":true/false,"comment":"想发的评论（不想就空字符串）","share":"想私信分享给${ownerName()}的话","remember":"值得记住的（没有就空）"}。` +
        `（关注不在刷流里做，有人让你关注再用工具。）这次最多点赞 ${likeLeft}、评论 ${commentLeft}、分享 ${shareLeft}。${shareBiasHint()}只输出 JSON 数组。`)
      const decisions = pickJson(out, [])
      const byI = new Map((Array.isArray(decisions) ? decisions : []).map((d) => [Number(d.i) || 0, d]))

      for (let i = 0; i < looked.length; i++) {
        if (paused(s)) break
        if (browseInterrupted(s)) {
          save(s)
          return { ok: false, message: s.lastSkipReason, interrupted: true, watched: looked.length }
        }
        await watchOne(s, looked[i], byI.get(i + 1) || {})
      }

      if (!force) {
        s.runs++
        const jitter = 0.8 + Math.random() * 0.5
        s.nextDueAt = now() + Math.round(c.intervalHours * 3600_000 * jitter)
      }
      s.lastRun = now()
      s.lastSkipReason = ''
      log.info(`刷了一轮抖音：看了 ${looked.length} 个`)
      return { ok: true, message: `看了 ${looked.length} 个视频`, watched: looked.length }
    } catch (error) {
      log.warn('刷抖音出错：', error.message)
      s.lastSkipReason = error.message
      return { ok: false, message: error.message }
    } finally {
      save(s)
      busy = false
    }
  }

  async function checkOwnerDms() {
    if (perm('douyinReplyOwnerDm') === 'off') return { ok: false, message: '回主人私信在权限里关掉了' }
    if (!ownerConfirmed(getConfig())) return { ok: false, message: '还没核对主人的抖音号' }
    const s = today(load())
    if (paused(s)) return { ok: false, message: '今天暂停：' + s.pauseReason }
    s.lastDmCheck = now()
    return withSocialBusy(async () => {
      const need = await requireIm()
      if (!need.ok) { save(s); return need }
      let n = 0
      try {
        const done = new Set(s.repliedDms || [])
        const inbox = await need.im.listInbox()
        const owner = getConfig().douyin.owner || {}
        const ownerSec = owner.secUid
        if (inbox.length && !inbox.some((x) => x.secUid || x.uid)) {
          return { ok: false, message: '私信列表认不出对方身份，回主人私信先不开' }
        }
        const isOwnerMsg = (x) => {
          if (x.secUid && isOwnerSec(getConfig(), x.secUid)) return true
          if (owner.uid && x.uid && String(x.uid) === String(owner.uid)) return true
          return false
        }
        const cutoff = now() - 30 * 60_000
        const fresh = inbox.filter((x) => {
          if (!isOwnerMsg(x) || !x.text) return false
          const key = `${x.secUid || x.uid}:${x.text}`
          if (done.has(key)) return false
          const at = Number(x.at) || now()
          if (at < cutoff) return false
          return true
        }).slice(0, 5)
        if (fresh.length) s.ownerDmStreak = 0

        for (const m of fresh) {
          if (left(s, 'dmReply') <= 0) break
          if ((s.ownerDmStreak || 0) >= 3) break
          done.add(`${m.secUid || m.uid}:${m.text}`)
          hub.logChat?.('douyin', m.nickname || '主人抖音', `抖音私信你：${m.text}`, '')
          // 不 silent log-only：走 thinkImReply → hub.runSystemTurn（无工具），再 doWrite/IM 发出
          const out = await thinkImReply(`这是${ownerName()}在抖音给你发的私信：「${m.text}」
用你的口气回一句（像平时私聊，别太长）；不想回就只输出 [沉默]。只输出回复正文。`)
          const reply = cleanText(String(out || '').split(/\n+/)[0], 100)
          if (!reply || isSilence(reply)) continue
          const r = await doWrite(s, 'dmReply', async () => {
            await need.im.sendText(ownerImTarget(), reply)
          }, { text: `${m.text} → ${reply}`, secUid: ownerSec })
          if (r.ok) {
            n++
            s.ownerDmStreak = (s.ownerDmStreak || 0) + 1
            if (!r.dryRun) memory?.addEvent?.({ text: `在抖音回了${ownerName()}的私信：${reply.slice(0, 50)}`, tags: ['抖音'], importance: 0.5 })
            save(s)
          }
          if (paused(s)) break
        }
        s.repliedDms = [...done].slice(-200)
        return { ok: true, message: `回了 ${n} 条主人私信`, replied: n }
      } catch (error) {
        return { ok: false, message: error.message }
      } finally { save(s) }
    })
  }

  async function checkCommentReplies() {
    if (perm('douyinReplyComment') === 'off') return { ok: false, message: '回评论在权限里关掉了' }
    const s = today(load())
    if (paused(s)) return { ok: false, message: '今天暂停：' + s.pauseReason }
    s.lastReplyCheck = now()
    const booted = await boot()
    if (!booted.ok) { save(s); return { ok: false, message: booted.reason || booted.message } }
    const drv = ensureDriver()
    let n = 0
    try {
      const list = typeof drv.listCommentReplies === 'function' ? await drv.listCommentReplies() : []
      const done = new Set(s.repliedComments || [])
      for (const x of list || []) {
        if (!x?.id || done.has(x.id) || left(s, 'replyComment') <= 0 || paused(s)) continue
        done.add(x.id)
        const out = await think(`有人在抖音回你的评论：「${x.text}」（对方：${x.name || '?'}）\n想回就用你的口气回一句，不想回就 [沉默]。只输出回复正文。`)
        const reply = cleanText(String(out || '').split(/\n+/)[0], 100)
        if (!reply || isSilence(reply)) continue
        const r = await doWrite(s, 'replyComment', async () => {
          if (x.awemeId) await drv.navigate(videoLink(x.awemeId)).catch(() => {})
          await drv.openComments().catch(() => {})
          const ok = await drv.typeAndSend(reply)
          if (!ok) throw new Error('回评论没发出去')
        }, { text: `${x.name}：${x.text} → ${reply}`, awemeId: x.awemeId })
        if (r.ok) n++
        if (paused(s)) break
      }
      s.repliedComments = [...done].slice(-300)
      return { ok: true, message: `回了 ${n} 条评论`, replied: n }
    } catch (error) {
      return { ok: false, message: error.message }
    } finally { save(s) }
  }

  async function resolveTarget(target) {
    const parsed = parseUserInput(target) || (String(target).length > 20 ? { secUid: String(target).trim() } : null)
    if (!parsed) return { ok: false, message: '请给对方抖音主页链接或 sec_uid' }
    const drv = ensureDriver()
    if (parsed.secUid) return { ok: true, secUid: parsed.secUid }
    return drv.resolveUser(parsed)
  }

  /** 工具：主动私信（每目标每天最多 1 次）。走 IM，不经 CDP。 */
  async function dmTo(target, text) {
    if (perm('douyinDm') === 'off') return { ok: false, message: '私信在权限里关掉了' }
    const s = today(load())
    if (paused(s)) return { ok: false, message: '今天暂停：' + s.pauseReason }
    const msg = cleanText(text, 100)
    if (!msg) return { ok: false, message: '私信内容不能是空的' }
    return withSocialBusy(async () => {
      const need = await requireIm()
      if (!need.ok) return need
      const parsed = parseUserInput(target) || (String(target).length > 20 ? { secUid: String(target).trim() } : null)
      let secUid = parsed?.secUid || ''
      let uid = ''
      if (!secUid) {
        // 抖音号 / 短链仍靠 CDP 解析
        const booted = await boot()
        if (!booted.ok) return { ok: false, message: booted.reason || booted.message }
        const user = await resolveTarget(target)
        if (!user.ok) return user
        secUid = user.secUid
      }
      if ((s.dmTargets[secUid] || 0) >= 1) return { ok: false, message: '今天已经给这个人发过私信了（每人每天最多 1 条）' }
      const r = await doWrite(s, 'dm', async () => {
        await need.im.sendText({ uid, secUid }, msg)
      }, { secUid, text: msg })
      if (r.ok) {
        if (!r.dryRun) {
          s.dmTargets[secUid] = (s.dmTargets[secUid] || 0) + 1
          memory?.addEvent?.({ text: `在抖音私信了别人：${msg.slice(0, 40)}`, tags: ['抖音'], importance: 0.4 })
          save(s)
        }
      }
      return r.ok ? { ok: true, message: r.dryRun ? '试运行：本来要发私信' : '私信发出去了' } : r
    })
  }

  async function followUser(target) {
    if (perm('douyinFollow') === 'off') return { ok: false, message: '关注在权限里关掉了' }
    const s = today(load())
    if (paused(s)) return { ok: false, message: '今天暂停：' + s.pauseReason }
    const booted = await boot()
    if (!booted.ok) return { ok: false, message: booted.reason || booted.message }
    const user = await resolveTarget(target)
    if (!user.ok) return user
    const drv = ensureDriver()
    const r = await doWrite(s, 'follow', async () => {
      await drv.navigate(`https://www.douyin.com/user/${user.secUid}`)
      const ok = await drv.clickFollow()
      if (!ok) throw new Error('找不到关注按钮（可能已关注）')
    }, { secUid: user.secUid, author: user.nickname })
    if (r.ok && !r.dryRun) memory?.addEvent?.({ text: `在抖音关注了 ${user.nickname || user.secUid}`, tags: ['抖音'], importance: 0.35 })
    return r.ok ? { ok: true, message: r.dryRun ? '试运行：本来要关注' : '关注好了' } : r
  }

  /** 工具：给当前 / 指定视频点赞。 */
  async function likeVideo(link) {
    if (perm('douyinLike') === 'off') return { ok: false, message: '点赞在权限里关掉了' }
    const s = today(load())
    const w = await watch(link)
    if (!w.ok) return w
    const drv = ensureDriver()
    const r = await doWrite(s, 'like', async () => {
      const ok = await drv.clickLike()
      if (!ok) throw new Error('找不到点赞按钮')
    }, { awemeId: w.awemeId })
    return r.ok ? { ok: true, message: r.dryRun ? '试运行：本来要点赞' : '点赞好了' } : r
  }

  /** 工具：在视频下评论。 */
  async function commentVideo(link, text) {
    if (perm('douyinComment') === 'off') return { ok: false, message: '评论在权限里关掉了' }
    const msg = cleanText(text, 100)
    if (!msg) return { ok: false, message: '评论不能是空的' }
    const s = today(load())
    const w = await watch(link)
    if (!w.ok) return w
    const drv = ensureDriver()
    const r = await doWrite(s, 'comment', async () => {
      await drv.openComments()
      const ok = await drv.typeAndSend(msg)
      if (!ok) throw new Error('评论框打不开')
    }, { awemeId: w.awemeId, text: msg })
    if (r.ok && !r.dryRun) memory?.addEvent?.({ text: `在抖音评论：${msg.slice(0, 60)}`, tags: ['抖音'], importance: 0.4 })
    return r.ok ? { ok: true, message: r.dryRun ? '试运行：本来要评论' : '评论发出去了' } : r
  }

  /** 工具：把视频分享到主人抖音。 */
  /** 工具：把视频分享到主人抖音（IM segment.share；作品页仍可经 CDP watch）。 */
  async function shareToOwner(link, text) {
    if (perm('douyinShareOwner') === 'off') return { ok: false, message: '分享在权限里关掉了' }
    if (!ownerConfirmed(getConfig())) return { ok: false, message: '还没核对主人的抖音号' }
    return withSocialBusy(async () => {
      const need = await requireIm()
      if (!need.ok) return need
      const s = today(load())
      const w = await watch(link)
      if (!w.ok) return w
      const msg = cleanText(text || '分享给你', 80)
      const target = ownerImTarget()
      const r = await doWrite(s, 'shareOwner', async () => {
        await need.im.shareWork(target, { itemId: w.awemeId, title: w.desc, author: w.author }, msg)
      }, { awemeId: w.awemeId, text: msg, secUid: target.secUid })
      return r.ok ? { ok: true, message: r.dryRun ? '试运行：本来要分享' : '分享出去了' } : r
    })
  }

  async function setSign(text) {
    if (perm('douyinSign') === 'off') return { ok: false, message: '改抖音签名在权限里关掉了' }
    const filtered = filterSignature(text)
    if (!filtered.ok) return filtered
    const s = today(load())
    if (paused(s)) return { ok: false, message: '今天暂停：' + s.pauseReason }
    if (s.lastSignText && s.lastSignText === filtered.text) {
      return { ok: false, message: '今天已经改成这句签名了，不用再改' }
    }
    const booted = await boot()
    if (!booted.ok) return { ok: false, message: booted.reason || booted.message }
    const drv = ensureDriver()
    const r = await doWrite(s, 'sign', async () => {
      const out = await drv.editSignature(filtered.text)
      if (!out?.ok) throw new Error(out?.message || '签名没改成')
    }, { text: filtered.text })
    if (r.ok && !r.dryRun) {
      s.lastSignText = filtered.text
      memory?.addEvent?.({ text: `把抖音签名改成：${filtered.text.slice(0, 60)}`, tags: ['抖音'], importance: 0.45 })
      save(s)
    }
    return r.ok ? { ok: true, message: r.dryRun ? `试运行：本来要把抖音签名改成：${filtered.text}` : `抖音签名改好了：${filtered.text}` } : r
  }

  /** 工具：改抖音昵称（日上限默认 2，过写闸）。 */
  async function setNickname(text) {
    if (perm('douyinNickname') === 'off') return { ok: false, message: '改抖音昵称在权限里关掉了' }
    const filtered = filterNickname(text)
    if (!filtered.ok) return filtered
    const s = today(load())
    if (paused(s)) return { ok: false, message: '今天暂停：' + s.pauseReason }
    if (s.lastNicknameText && s.lastNicknameText === filtered.text) {
      return { ok: false, message: '今天已经改成这个昵称了，不用再改' }
    }
    const booted = await boot()
    if (!booted.ok) return { ok: false, message: booted.reason || booted.message }
    const drv = ensureDriver()
    const r = await doWrite(s, 'nickname', async () => {
      const out = await drv.editNickname(filtered.text)
      if (!out?.ok) throw new Error(out?.message || '昵称没改成')
    }, { text: filtered.text })
    if (r.ok && !r.dryRun) {
      s.lastNicknameText = filtered.text
      s.selfNickname = filtered.text
      memory?.addEvent?.({ text: `把抖音昵称改成：${filtered.text}`, tags: ['抖音'], importance: 0.45 })
      save(s)
    }
    return r.ok ? { ok: true, message: r.dryRun ? `试运行：本来要把抖音昵称改成：${filtered.text}` : `抖音昵称改好了：${filtered.text}` } : r
  }

  /** 工具：换抖音头像。filePath 为本机可读图片路径（模块侧已解析 last/http/白名单本地）。 */
  async function setAvatar(filePath) {
    if (perm('douyinAvatar') === 'off') return { ok: false, message: '换抖音头像在权限里关掉了' }
    const path = String(filePath || '').trim()
    if (!path) return { ok: false, message: '没有头像文件' }
    if (!existsSync(path)) return { ok: false, message: '找不到头像文件' }
    let buf
    try { buf = readFileSync(path) } catch (error) {
      return { ok: false, message: '读不了头像文件：' + (error.message || error) }
    }
    if (!buf?.length) return { ok: false, message: '头像文件是空的' }
    if (buf.length > AVATAR_MAX_BYTES) return { ok: false, message: `头像太大了，最多 ${Math.floor(AVATAR_MAX_BYTES / 1024 / 1024)}MB` }
    const mime = sniffImageType(buf)
    if (!mime) return { ok: false, message: '不是能认的图片（要 png / jpg / gif / webp）' }
    const s = today(load())
    if (paused(s)) return { ok: false, message: '今天暂停：' + s.pauseReason }
    const booted = await boot()
    if (!booted.ok) return { ok: false, message: booted.reason || booted.message }
    const drv = ensureDriver()
    const r = await doWrite(s, 'avatar', async () => {
      const out = await drv.editAvatar(path)
      if (!out?.ok) throw new Error(out?.message || '头像没换上')
    }, { text: basename(path) })
    if (r.ok && !r.dryRun) {
      memory?.addEvent?.({ text: '换了抖音头像', tags: ['抖音'], importance: 0.45 })
      save(s)
    }
    return r.ok ? { ok: true, message: r.dryRun ? '试运行：本来要换抖音头像' : '抖音头像换好了' } : r
  }

  async function watch(text) {
    const id = findAwemeId(text)
    if (!id) return { ok: false, message: '没认出抖音视频链接' }
    const booted = await boot()
    if (!booted.ok) return { ok: false, message: booted.reason || booted.message }
    const drv = ensureDriver()
    let awemeId = id.awemeId
    if (id.short) {
      await drv.navigate(id.short)
      if (!isFake()) await new Promise((r) => setTimeout(r, 1200))
      awemeId = (await drv.activeAwemeId()) || awemeId
    } else {
      await drv.navigate(videoLink(awemeId))
    }
    if (!awemeId) return { ok: false, message: '打不开这个视频' }
    const s = today(load())
    const v = { awemeId, author: '', desc: '', likes: 0, comments: 0, tags: [] }
    const hit = (drv.recentFeed?.() || []).find((x) => x.awemeId === awemeId)
    if (hit) Object.assign(v, hit)
    memory?.addEvent?.({ text: `看了别人发来的抖音视频 ${awemeId}`, tags: ['抖音'], importance: 0.4 })
    record(s, { kind: 'watch', awemeId, text: '（点开链接看的）' })
    s.watched = (s.watched || 0) + 1
    s.seen = [...new Set([...(s.seen || []), awemeId])].slice(-500)
    save(s)
    return { ok: true, message: digestOf(v), awemeId }
  }

  let runStartedAt = 0
  async function tick() {
    const g = getConfig()
    const c = g.douyin
    if (!g.enabled || !c.enabled) return
    const h = new Date(now()).getHours()
    if (h < g.speakUp.awakeFrom || h >= g.speakUp.awakeTo) return
    const s = today(load())

    if (busy && runStartedAt && now() - runStartedAt > 15 * 60_000) {
      log.warn('刷抖音超过 15 分钟还没结束，强制解锁')
      busy = false
    }

    const dmEvery = (c.dmPollMinutes || 7) * 60_000
    const replyEvery = (c.replyPollMinutes || 25) * 60_000
    if (now() - (s.lastDmCheck || 0) > dmEvery * (0.7 + Math.random() * 0.7)) {
      if (ownerConfirmed(g) && perm('douyinReplyOwnerDm') !== 'off') await checkOwnerDms().catch((e) => log.debug(e.message))
    }
    if (now() - (s.lastReplyCheck || 0) > replyEvery) {
      if (perm('douyinReplyComment') !== 'off') await checkCommentReplies().catch((e) => log.debug(e.message))
    }

    if (!c.autoBrowse || perm('douyinBrowse') === 'off') return
    if (s.runs >= c.maxRunsPerDay) { s.lastSkipReason = '今天轮数满了'; save(s); return }
    if (paused(s)) return
    const due = s.nextDueAt || 0
    if (due && now() < due) return
    if (!due && s.lastRun && now() - s.lastRun < c.intervalHours * 3600_000) return
    runStartedAt = now()
    await run()
    runStartedAt = 0
  }

  async function imStatus() {
    try {
      const client = await ensureIm()
      return client.status()
    } catch (error) {
      return { loggedIn: false, needLogin: true, reason: String(error?.message || error), uid: '', nickname: '' }
    }
  }

  async function startImLogin() {
    try {
      const client = await ensureIm()
      if (typeof client.startQrLogin === 'function') return client.startQrLogin()
      if (typeof client.startLogin === 'function') return client.startLogin({ method: 'qr' })
      return { ok: false, started: false, loggedIn: false, phase: 'error', message: '当前 IM 客户端不支持面板登录', qrDataUrl: '' }
    } catch (error) {
      return { ok: false, started: false, loggedIn: false, phase: 'error', message: String(error?.message || error), qrDataUrl: '' }
    }
  }

  async function imLoginStatus() {
    try {
      const client = await ensureIm()
      if (typeof client.getLoginStatus === 'function') return client.getLoginStatus()
      const st = client.status()
      return {
        ok: true,
        started: false,
        loggedIn: !!st.loggedIn,
        phase: st.loggedIn ? 'logged_in' : 'idle',
        qrDataUrl: '',
        message: st.loggedIn ? (`已登录：${st.nickname || st.uid}`) : (st.reason || '还没登录 IM'),
        nickname: st.nickname || '',
        uid: st.uid || '',
        verifyHint: '',
        error: '',
      }
    } catch (error) {
      return { ok: false, started: false, loggedIn: false, phase: 'error', message: String(error?.message || error), qrDataUrl: '' }
    }
  }

  async function refreshImLogin() {
    try {
      const client = await ensureIm()
      if (typeof client.refreshQrLogin === 'function') return client.refreshQrLogin()
      return startImLogin()
    } catch (error) {
      return { ok: false, started: false, loggedIn: false, phase: 'error', message: String(error?.message || error), qrDataUrl: '' }
    }
  }

  async function submitImLoginSms(code) {
    try {
      const client = await ensureIm()
      if (typeof client.submitLoginSms === 'function') return client.submitLoginSms(code)
      return { ok: false, started: true, loggedIn: false, phase: 'sms_required', message: '当前 IM 客户端不支持面板填验证码', qrDataUrl: '' }
    } catch (error) {
      return { ok: false, started: false, loggedIn: false, phase: 'error', message: String(error?.message || error), qrDataUrl: '' }
    }
  }

  async function startBrowserLogin() {
    try {
      const d = ensureDriver()
      if (typeof d.startLoginQr === 'function') return d.startLoginQr()
      const r = await account(true)
      return {
        ok: !r.error,
        started: !!r.needLogin,
        loggedIn: !!r.isLogin,
        phase: r.isLogin ? 'logged_in' : (r.verify ? 'verification_required' : (r.needLogin ? 'waiting_scan' : 'idle')),
        qrDataUrl: '',
        message: r.isLogin ? (`已登录：${r.nickname || r.secUid}`) : (r.reason || r.error || '请扫码登录'),
        verifyHint: r.verify ? (r.reason || '需要安全验证') : '',
        nickname: r.nickname || '',
        error: r.error || '',
      }
    } catch (error) {
      return { ok: false, started: false, loggedIn: false, phase: 'error', message: String(error?.message || error), qrDataUrl: '' }
    }
  }

  async function browserLoginStatus() {
    try {
      const d = ensureDriver()
      if (typeof d.pollLoginQr === 'function') {
        // 已在登录流程中则只轮询；否则用 account 轻量检查
        const snap = await d.pollLoginQr()
        if (snap.loggedIn) {
          const s = today(load())
          if (!s.loginAt) { s.loginAt = now(); save(s) }
        }
        return snap
      }
      return startBrowserLogin()
    } catch (error) {
      return { ok: false, started: false, loggedIn: false, phase: 'error', message: String(error?.message || error), qrDataUrl: '' }
    }
  }

  async function refreshBrowserLogin() {
    try {
      const d = ensureDriver()
      if (typeof d.refreshLoginQr === 'function') return d.refreshLoginQr()
      return startBrowserLogin()
    } catch (error) {
      return { ok: false, started: false, loggedIn: false, phase: 'error', message: String(error?.message || error), qrDataUrl: '' }
    }
  }

  function state() {
    const s = today(load())
    return {
      runs: s.runs, watched: s.watched, writes: s.writes || 0,
      like: s.like, comment: s.comment, replyComment: s.replyComment,
      follow: s.follow, dm: s.dm, shareOwner: s.shareOwner, dmReply: s.dmReply,
      sign: s.sign || 0, nickname: s.nickname || 0, avatar: s.avatar || 0,
      lastSignText: s.lastSignText || '', lastNicknameText: s.lastNicknameText || '',
      lastRun: s.lastRun, nextDueAt: s.nextDueAt, lastSkipReason: s.lastSkipReason,
      history: (s.history || []).slice(0, 20),
      pauseReason: paused(s) ? s.pauseReason : '',
      disabledOps: { ...s.disabledOps },
      newAccount: isNewAccount(s),
      ownerConfirmed: ownerConfirmed(getConfig()),
      socialBusy,
      owner: {
        input: cfg().owner?.input || '',
        secUid: cfg().owner?.secUid || '',
        uid: cfg().owner?.uid || '',
        nickname: cfg().owner?.nickname || '',
        hasAvatar: Boolean(cfg().owner?.avatar),
      },
    }
  }

  return {
    run, tick, watch, dmTo, followUser, likeVideo, commentVideo, shareToOwner,
    setSign, setNickname, setAvatar,
    checkOwnerDms, checkCommentReplies, confirmOwner, account, imStatus, startImLogin, imLoginStatus, refreshImLogin, submitImLoginSms, startBrowserLogin, browserLoginStatus, refreshBrowserLogin, state,
    setDriver: (d) => { driver = d },
    setIm: (c) => { im = c },
    _setSocialBusy: (v) => { socialBusy = !!v },
  }
}
