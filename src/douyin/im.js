// 抖音社交通道：douyin-im（无浏览器）。测时注入 createFakeImClient；真机动态 import('douyin-im')。
// 会话目录默认 dataDir('douyin','im')，凭证不进仓库。
// 登录：面板内二维码（system.login.qrcode → dataURL）+ 状态轮询；成功才算 loggedIn；短信/滑块在面板提示。

import { mkdirSync } from 'node:fs'
import { dataDir } from '../core/store.js'

export const IM_NOT_LOGGED_IN = '抖音 IM 还没登录。请到面板「IM 登录」扫码 / 短信登录后再私信、分享或回主人私信。'

const FAKE_QR = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

function phaseMessage(phase) {
  return ({
    idle: '',
    waiting_scan: '请用抖音 App 扫码',
    scanned: '已扫码，请在手机上确认',
    logged_in: '已登录',
    expired: '二维码已过期，请点刷新',
    sms_required: '需要短信验证码',
    voice_required: '需要语音验证码',
    verification_required: '需要安全验证（滑块等）',
    error: '登录失败',
  })[phase] || phase || ''
}

function toDataUrl(b64) {
  const s = String(b64 || '')
  if (!s) return ''
  if (s.startsWith('data:')) return s
  return `data:image/png;base64,${s}`
}

/** 测用假 IM：不碰真包、不写 session。含可脚本化的扫码状态机。 */
export function createFakeImClient(script = {}) {
  const state = {
    loggedIn: script.loggedIn !== false && !script.needLogin,
    needLogin: !!script.needLogin,
    uid: script.uid || 'self_uid',
    nickname: script.nickname || '肥鱼IM',
    secUid: script.secUid || 'self_sec',
    inbox: (script.inbox || []).slice(),
    sent: [],
    shared: [],
    peers: new Map(),
    failSend: !!script.failSend,
    failMessage: script.failMessage || '发送失败：无回执',
    log: [],
    login: {
      phase: script.loggedIn !== false && !script.needLogin ? 'logged_in' : 'idle',
      qrDataUrl: '',
      message: '',
      verifyHint: '',
      error: '',
      nickname: '',
      uid: '',
    },
  }
  for (const p of script.peers || []) {
    const peer = { uid: String(p.uid), secUid: String(p.secUid || ''), nickname: p.nickname || '' }
    state.peers.set(peer.uid, peer)
    if (peer.secUid) state.peers.set(`sec:${peer.secUid}`, peer)
  }
  if (script.owner) {
    const o = {
      uid: String(script.owner.uid || 'owner_uid'),
      secUid: String(script.owner.secUid || 'owner_sec'),
      nickname: script.owner.nickname || '主人',
    }
    state.peers.set(o.uid, o)
    if (o.secUid) state.peers.set(`sec:${o.secUid}`, o)
  }

  function resolvePeer({ uid, secUid } = {}) {
    if (uid && state.peers.has(String(uid))) return { ok: true, ...state.peers.get(String(uid)) }
    if (secUid && state.peers.has(`sec:${secUid}`)) return { ok: true, ...state.peers.get(`sec:${secUid}`) }
    if (uid) {
      const peer = { uid: String(uid), secUid: String(secUid || ''), nickname: '' }
      state.peers.set(peer.uid, peer)
      return { ok: true, ...peer }
    }
    if (secUid) return { ok: false, message: `IM 里认不出对方（sec_uid=${secUid}），请先有会话或填数字 uid` }
    return { ok: false, message: '没有对方 uid / sec_uid' }
  }

  function snapshot(started = false) {
    const loggedIn = state.loggedIn && !state.needLogin
    const phase = loggedIn ? 'logged_in' : state.login.phase
    return {
      ok: phase !== 'error',
      started: !!started || (phase !== 'idle' && phase !== 'logged_in' && phase !== 'error'),
      loggedIn,
      phase,
      qrDataUrl: state.login.qrDataUrl || '',
      message: loggedIn
        ? (`已登录：${state.nickname || state.uid}`)
        : (state.login.message || phaseMessage(phase)),
      nickname: loggedIn ? state.nickname : (state.login.nickname || ''),
      uid: loggedIn ? state.uid : (state.login.uid || ''),
      verifyHint: state.login.verifyHint || '',
      error: state.login.error || '',
    }
  }

  return {
    status() {
      return {
        loggedIn: state.loggedIn && !state.needLogin,
        needLogin: !state.loggedIn || state.needLogin,
        uid: state.loggedIn ? state.uid : '',
        secUid: state.loggedIn ? state.secUid : '',
        nickname: state.loggedIn ? state.nickname : '',
        reason: state.needLogin || !state.loggedIn ? '还没登录 IM' : '',
      }
    },
    async ensureOnline() {
      const st = this.status()
      if (!st.loggedIn) return { ok: false, message: IM_NOT_LOGGED_IN }
      return { ok: true }
    },
    async sendText(target, text) {
      const online = await this.ensureOnline()
      if (!online.ok) throw new Error(online.message)
      const peer = resolvePeer(target)
      if (!peer.ok) throw new Error(peer.message)
      if (state.failSend) throw new Error(state.failMessage)
      const msg = String(text || '')
      state.sent.push({ uid: peer.uid, secUid: peer.secUid, text: msg, at: Date.now() })
      state.log.push(['sendText', peer.uid, msg])
      return { ok: true, receipt: { clientMessageId: `fake-${state.sent.length}` } }
    },
    async shareWork(target, work, text = '') {
      const online = await this.ensureOnline()
      if (!online.ok) throw new Error(online.message)
      const peer = resolvePeer(target)
      if (!peer.ok) throw new Error(peer.message)
      if (state.failSend) throw new Error(state.failMessage)
      const itemId = String(work?.itemId || work?.awemeId || '')
      if (!itemId) throw new Error('没有作品 id，不能分享')
      state.shared.push({ uid: peer.uid, secUid: peer.secUid, itemId, text: String(text || ''), at: Date.now() })
      state.log.push(['shareWork', peer.uid, itemId])
      if (text) {
        state.sent.push({ uid: peer.uid, secUid: peer.secUid, text: String(text), at: Date.now() })
      }
      return { ok: true, receipt: { clientMessageId: `fake-share-${state.shared.length}` } }
    },
    async listInbox() {
      const online = await this.ensureOnline()
      if (!online.ok) throw new Error(online.message)
      return state.inbox.map((x, i) => ({
        id: x.id || `in-${i}`,
        uid: x.uid || '',
        secUid: x.secUid || '',
        nickname: x.nickname || '',
        text: x.text || '',
        at: x.at || Date.now(),
      }))
    },
    /** 开始扫码登录：只返回 started + QR，绝不把「已开始」当成已登录。 */
    async startQrLogin() {
      if (script.loginFail) {
        state.login = {
          phase: 'error',
          qrDataUrl: '',
          message: script.loginFailMessage || '假 IM 登录失败',
          verifyHint: '',
          error: script.loginFailMessage || '假 IM 登录失败',
          nickname: '',
          uid: '',
        }
        return { ...snapshot(false), ok: false, started: false, loggedIn: false }
      }
      state.loggedIn = false
      state.needLogin = true
      state.login = {
        phase: 'waiting_scan',
        qrDataUrl: script.qrDataUrl || FAKE_QR,
        message: '请用抖音 App 扫码',
        verifyHint: '',
        error: '',
        nickname: '',
        uid: '',
      }
      state.log.push(['startQrLogin'])
      return snapshot(true)
    },
    getLoginStatus() {
      return snapshot(state.login.phase !== 'idle' && state.login.phase !== 'logged_in')
    },
    async refreshQrLogin() {
      return this.startQrLogin()
    },
    async submitLoginSms(code) {
      const c = String(code || '').trim()
      if (!c) return { ok: false, started: true, loggedIn: false, phase: state.login.phase, message: '请填验证码', qrDataUrl: '', verifyHint: state.login.verifyHint, error: '' }
      if (state.login.phase !== 'sms_required' && state.login.phase !== 'voice_required') {
        return { ok: false, started: true, loggedIn: false, phase: state.login.phase, message: '当前不需要验证码', qrDataUrl: state.login.qrDataUrl, verifyHint: state.login.verifyHint, error: '' }
      }
      if (script.smsFail) {
        state.login.error = script.smsFailMessage || '验证码错误'
        state.login.message = state.login.error
        return { ...snapshot(true), ok: false }
      }
      state.loggedIn = true
      state.needLogin = false
      state.login = {
        phase: 'logged_in',
        qrDataUrl: '',
        message: `已登录：${state.nickname}`,
        verifyHint: '',
        error: '',
        nickname: state.nickname,
        uid: state.uid,
      }
      return snapshot(false)
    },
    /** @deprecated 用 startQrLogin；保留别名避免旧调用误以为已登录成功 */
    async startLogin() {
      return this.startQrLogin()
    },
    /** 测用：推进登录状态机 scanned → confirmed → logged_in / expired / sms / verification */
    _advanceLogin(phase, extra = {}) {
      const p = String(phase || '')
      if (p === 'scanned') {
        state.login.phase = 'scanned'
        state.login.message = '已扫码，请在手机上确认'
      } else if (p === 'confirmed') {
        state.login.phase = 'scanned'
        state.login.message = '已确认，正在登录…'
        if (extra.nickname) state.login.nickname = extra.nickname
      } else if (p === 'logged_in' || p === 'loggedIn') {
        state.loggedIn = true
        state.needLogin = false
        if (extra.nickname) state.nickname = extra.nickname
        if (extra.uid) state.uid = extra.uid
        state.login = {
          phase: 'logged_in',
          qrDataUrl: '',
          message: `已登录：${state.nickname}`,
          verifyHint: '',
          error: '',
          nickname: state.nickname,
          uid: state.uid,
        }
      } else if (p === 'expired') {
        state.login.phase = 'expired'
        state.login.qrDataUrl = ''
        state.login.message = '二维码已过期，请点刷新'
      } else if (p === 'sms_required') {
        state.login.phase = 'sms_required'
        state.login.qrDataUrl = ''
        state.login.message = '需要短信验证码'
        state.login.verifyHint = extra.verifyHint || '请输入短信验证码后提交。'
      } else if (p === 'voice_required') {
        state.login.phase = 'voice_required'
        state.login.qrDataUrl = ''
        state.login.message = '需要语音验证码'
        state.login.verifyHint = extra.verifyHint || '请输入语音验证码后提交。'
      } else if (p === 'verification_required') {
        state.login.phase = 'verification_required'
        state.login.qrDataUrl = ''
        state.login.message = '需要安全验证'
        state.login.verifyHint = extra.verifyHint || '需要滑块验证。请完成后再点刷新状态。'
      } else if (p === 'error') {
        state.login.phase = 'error'
        state.login.error = extra.error || '登录失败'
        state.login.message = state.login.error
        state.login.qrDataUrl = ''
      } else {
        state.login.phase = p || 'idle'
      }
      return snapshot(true)
    },
    _state: state,
    _resolvePeer: resolvePeer,
  }
}

/**
 * 真机包装：动态加载 douyin-im。失败时给出明确提示（Node 版本 / 未安装）。
 * 不在模块顶层 import，以便 Node 20 测试箱仍能跑假客户端。
 */
export async function createRealImClient({ dataPath } = {}) {
  const dir = dataPath || dataDir('douyin', 'im')
  mkdirSync(dir, { recursive: true })
  let mod
  try {
    mod = await import('douyin-im')
  } catch (error) {
    const msg = String(error?.message || error)
    throw new Error(
      `加载 douyin-im 失败（需要 Node ≥22.13 且已安装依赖）：${msg}`,
    )
  }
  const { createClient, segment } = mod
  const client = createClient({ dataDir: dir })
  let account = null
  let loginAccount = null
  let listenersWired = false
  const login = {
    phase: 'idle',
    qrDataUrl: '',
    message: '',
    verifyHint: '',
    error: '',
    nickname: '',
    uid: '',
    updatedAt: 0,
  }

  function currentAccount() {
    if (account?.uid) return account
    const list = typeof client.accounts === 'function'
      ? client.accounts()
      : (client.getAccounts?.() || [])
    const arr = Array.isArray(list) ? list : [...(list || [])]
    account = arr.find((a) => a?.uid) || arr[0] || account
    return account
  }

  function snapshotLogin(started = false) {
    const st = status()
    const loggedIn = st.loggedIn || login.phase === 'logged_in'
    const phase = loggedIn ? 'logged_in' : login.phase
    return {
      ok: phase !== 'error',
      started: !!started || (phase !== 'idle' && phase !== 'logged_in' && phase !== 'error'),
      loggedIn,
      phase,
      qrDataUrl: login.qrDataUrl || '',
      message: loggedIn
        ? (`已登录：${st.nickname || login.nickname || st.uid || login.uid}`)
        : (login.message || phaseMessage(phase)),
      nickname: loggedIn ? (st.nickname || login.nickname || '') : (login.nickname || ''),
      uid: loggedIn ? (st.uid || login.uid || '') : (login.uid || ''),
      verifyHint: login.verifyHint || '',
      error: login.error || '',
    }
  }

  function status() {
    const acc = currentAccount()
    const uid = acc?.uid || ''
    return {
      loggedIn: Boolean(uid),
      needLogin: !uid,
      uid,
      secUid: acc?.profile?.secUid || '',
      nickname: acc?.nickname || '',
      reason: uid ? '' : '还没登录 IM',
    }
  }

  function wireLoginListeners() {
    if (listenersWired) return
    listenersWired = true

    client.on('system.login.qrcode', async (ev) => {
      loginAccount = ev.account || loginAccount
      login.qrDataUrl = toDataUrl(ev.qrcodeBase64)
      login.phase = 'waiting_scan'
      login.message = '请用抖音 App 扫码'
      login.error = ''
      login.verifyHint = ''
      login.updatedAt = Date.now()
      try {
        await ev.account?.continueLogin?.()
      } catch (error) {
        const msg = String(error?.message || error)
        if (/expir|过期/i.test(msg)) {
          login.phase = 'expired'
          login.message = '二维码已过期，请点刷新'
          login.qrDataUrl = ''
        }
      }
    })

    client.on('system.login.qrcode.status', (ev) => {
      const s = ev.status
      if (s === 'scanned') {
        login.phase = 'scanned'
        login.message = '已扫码，请在手机上确认'
      } else if (s === 'confirmed') {
        login.phase = 'scanned'
        login.message = '已确认，正在登录…'
        if (ev.screenName) login.nickname = String(ev.screenName)
      } else if (s === 'expired') {
        login.phase = 'expired'
        login.message = '二维码已过期，请点刷新'
        login.qrDataUrl = ''
      } else if (s === 'new') {
        login.phase = 'waiting_scan'
        login.message = '请用抖音 App 扫码'
      }
      login.updatedAt = Date.now()
    })

    client.on('system.online', (ev) => {
      account = ev.account || account
      loginAccount = ev.account || loginAccount
      login.phase = 'logged_in'
      login.qrDataUrl = ''
      login.nickname = String(ev.screenName || ev.account?.nickname || login.nickname || '')
      login.uid = String(ev.platformUid || ev.account?.uid || login.uid || '')
      login.message = `已登录：${login.nickname || login.uid}`
      login.verifyHint = ''
      login.error = ''
      login.updatedAt = Date.now()
    })

    const needCode = (phase, hint) => (ev) => {
      loginAccount = ev.account || loginAccount
      login.phase = phase
      login.qrDataUrl = ''
      login.message = phaseMessage(phase)
      login.verifyHint = hint(ev)
      login.updatedAt = Date.now()
    }
    client.on('system.login.sms', needCode('sms_required', (ev) => `需要短信验证码${ev.mobile ? `（${ev.mobile}）` : ''}。请在面板输入后提交。`))
    client.on('system.login.voice', needCode('voice_required', (ev) => `需要语音验证码${ev.mobile ? `（${ev.mobile}）` : ''}。请在面板输入后提交。`))
    client.on('system.login.sms-required', needCode('sms_required', () => '服务端要求短信验证。请在面板输入验证码后提交。'))

    client.on('system.login.verification', async (ev) => {
      loginAccount = ev.account || loginAccount
      const methods = Array.isArray(ev.verification?.methods) ? ev.verification.methods.join('、') : '滑块/安全验证'
      login.phase = 'verification_required'
      login.qrDataUrl = ''
      login.message = '需要安全验证'
      let hint = `需要验证：${methods}。请在本机完成验证后点「刷新状态」。`
      try {
        const url = await ev.verification?.openUrl?.({ openBrowser: false })
        if (url) hint += ` 验证地址：${url}`
      } catch (error) {
        hint += `（打开验证页失败：${error?.message || error}）`
      }
      login.verifyHint = hint
      login.updatedAt = Date.now()
    })

    client.on('system.login.error', (ev) => {
      login.phase = 'error'
      login.error = String(ev.error?.message || ev.error || '登录失败')
      login.message = login.error
      login.qrDataUrl = ''
      login.updatedAt = Date.now()
    })
  }

  async function resolvePeer(acc, { uid, secUid } = {}) {
    if (uid) {
      const f = acc.pickFriend?.(String(uid)) || acc.pickStranger?.(String(uid))
      if (f) return { ok: true, uid: String(uid), secUid: f.secUid || secUid || '', contact: f }
      const friend = acc.pickFriend?.(String(uid))
      if (friend) return { ok: true, uid: String(uid), secUid: secUid || '', contact: friend }
      return { ok: true, uid: String(uid), secUid: secUid || '', contact: null, lazyUid: String(uid) }
    }
    if (secUid) {
      await acc.getFriendList?.().catch(() => {})
      await acc.getStrangerList?.().catch(() => {})
      for (const f of [...(acc.fl?.values?.() || []), ...(acc.sl?.values?.() || [])]) {
        if (f?.secUid === secUid || f?.profile?.secUid === secUid) {
          return { ok: true, uid: String(f.uid || f.id), secUid, contact: f }
        }
      }
      return { ok: false, message: `IM 通讯录里找不到 sec_uid=${secUid} 的人，请填数字 uid 或先有会话` }
    }
    return { ok: false, message: '没有对方 uid / sec_uid' }
  }

  async function contactFor(acc, peer) {
    if (peer.contact?.sendMsg) return peer.contact
    if (peer.lazyUid || peer.uid) {
      let c = acc.pickFriend?.(peer.uid) || acc.pickStranger?.(peer.uid)
      if (!c && typeof acc.pickFriend === 'function') {
        c = acc.pickFriend(peer.uid)
      }
      if (!c?.sendMsg) throw new Error(`IM 无法打开与 ${peer.uid} 的会话`)
      return c
    }
    throw new Error('没有可发送的联系人')
  }

  async function startQrLogin() {
    wireLoginListeners()
    login.phase = 'waiting_scan'
    login.qrDataUrl = ''
    login.message = '正在获取二维码…'
    login.verifyHint = ''
    login.error = ''
    login.nickname = ''
    login.uid = ''
    login.updatedAt = Date.now()
    try {
      loginAccount = client.createAccount?.({ login: { method: 'qr' } }) || loginAccount
      // login() 会等到 online 才 resolve；这里只触发，靠事件拿 QR / 状态
      client.login?.().catch((error) => {
        if (login.phase === 'logged_in') return
        login.phase = 'error'
        login.error = String(error?.message || error)
        login.message = login.error
        login.qrDataUrl = ''
      })
      const deadline = Date.now() + 20000
      while (Date.now() < deadline) {
        if (
          login.qrDataUrl
          || login.phase === 'error'
          || login.phase === 'logged_in'
          || login.phase === 'sms_required'
          || login.phase === 'voice_required'
          || login.phase === 'verification_required'
          || login.phase === 'expired'
          || login.phase === 'scanned'
        ) break
        await new Promise((r) => setTimeout(r, 200))
      }
      if (!login.qrDataUrl && login.phase === 'waiting_scan') {
        login.message = '还没拿到二维码，请稍后点刷新'
      }
      return snapshotLogin(true)
    } catch (error) {
      login.phase = 'error'
      login.error = String(error?.message || error)
      login.message = login.error
      return { ...snapshotLogin(false), ok: false, started: false, loggedIn: false }
    }
  }

  async function refreshQrLogin() {
    return startQrLogin()
  }

  async function submitLoginSms(code) {
    const c = String(code || '').trim()
    if (!c) {
      return { ...snapshotLogin(true), ok: false, message: '请填验证码' }
    }
    const acc = loginAccount || currentAccount()
    if (!acc?.continueLoginWithSms) {
      return { ...snapshotLogin(true), ok: false, message: '当前没有可提交验证码的登录会话' }
    }
    try {
      await acc.continueLoginWithSms(c)
      const deadline = Date.now() + 15000
      while (Date.now() < deadline) {
        if (login.phase === 'logged_in' || login.phase === 'error' || login.phase === 'verification_required') break
        await new Promise((r) => setTimeout(r, 200))
      }
      return snapshotLogin(login.phase !== 'logged_in')
    } catch (error) {
      login.phase = 'error'
      login.error = String(error?.message || error)
      login.message = login.error
      return { ...snapshotLogin(false), ok: false }
    }
  }

  return {
    client,
    status,
    getLoginStatus: () => snapshotLogin(login.phase !== 'idle' && login.phase !== 'logged_in'),
    startQrLogin,
    refreshQrLogin,
    submitLoginSms,
    /** @deprecated 用 startQrLogin */
    startLogin: startQrLogin,
    async ensureOnline() {
      const st = status()
      if (!st.loggedIn) return { ok: false, message: IM_NOT_LOGGED_IN }
      return { ok: true }
    },
    async sendText(target, text) {
      const online = await this.ensureOnline()
      if (!online.ok) throw new Error(online.message)
      const acc = currentAccount()
      const peer = await resolvePeer(acc, target)
      if (!peer.ok) throw new Error(peer.message)
      const contact = await contactFor(acc, peer)
      const r = await contact.sendMsg(String(text || ''))
      if (r && r.statusCode != null && Number(r.statusCode) !== 0) {
        throw new Error(r.statusMsg || `私信回执失败（${r.statusCode}）`)
      }
      return { ok: true, receipt: r }
    },
    async shareWork(target, work, text = '') {
      const online = await this.ensureOnline()
      if (!online.ok) throw new Error(online.message)
      const acc = currentAccount()
      const peer = await resolvePeer(acc, target)
      if (!peer.ok) throw new Error(peer.message)
      const contact = await contactFor(acc, peer)
      const itemId = String(work?.itemId || work?.awemeId || '')
      if (!itemId) throw new Error('没有作品 id，不能分享')
      const card = segment.share({
        itemId,
        title: work?.title || work?.desc || '',
        authorSecUid: work?.authorSecUid || '',
        authorName: work?.author || work?.authorName || '',
        coverUrl: work?.coverUrl || '',
      })
      const r = await contact.sendMsg(card)
      if (r && r.statusCode != null && Number(r.statusCode) !== 0) {
        throw new Error(r.statusMsg || `分享回执失败（${r.statusCode}）`)
      }
      if (text) await contact.sendMsg(String(text)).catch(() => {})
      return { ok: true, receipt: r }
    },
    async listInbox() {
      const online = await this.ensureOnline()
      if (!online.ok) throw new Error(online.message)
      const acc = currentAccount()
      const out = []
      const pushFrom = (contact) => {
        const hist = contact.getCachedHistory?.(20) || []
        for (const m of hist) {
          const from = m.senderUid || m.from_id || contact.uid || contact.id
          if (String(from) === String(acc.uid)) continue
          out.push({
            id: String(m.serverMessageId || m.clientMessageId || `${from}:${m.time || ''}`),
            uid: String(from || ''),
            secUid: contact.secUid || '',
            nickname: contact.nickname || contact.remark || '',
            text: m.text || m.raw_message || '',
            at: (m.time ? Number(m.time) * (String(m.time).length > 12 ? 1 : 1000) : Date.now()),
          })
        }
      }
      for (const f of acc.fl?.values?.() || []) pushFrom(f)
      for (const s of acc.sl?.values?.() || []) pushFrom(s)
      return out.slice(0, 40)
    },
  }
}

/** 统一入口：有注入用注入；否则尝试真机（失败则抛错，由调用方转提示）。 */
export async function openImClient({ injected, dataPath } = {}) {
  if (injected) return injected
  return createRealImClient({ dataPath })
}
