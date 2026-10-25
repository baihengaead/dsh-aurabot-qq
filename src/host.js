// Aurabot · 宿主半边（DSH 插件入口）
//
// 让 DSH 里的 AI 以独立 QQ 号「大肥鱼」住在 QQ 里：
//   SnowLuma（OneBot v11）⇄ 本插件 ⇄ DSH 会话（Aurabot 自带的 preset + 人格）
// 面板在侧栏「自动化任务」下面（网页半边见 client/client.js），这里提供它要的 /aurabot/api/* 接口。
//
// ⚠ 安全默认：总开关关、试运行开。不手动打开，一句都不会真的发到 QQ。

import { readFileSync, existsSync, writeFileSync, unlinkSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfig, saveConfig, publicConfig, mergeFromPanel } from './core/config.js'
import { createLogger } from './core/logger.js'
import { registerSecret, redact } from './core/redact.js'
import { createOneBotClient } from './onebot/client.js'
import { createSnowLumaManager, DOWNLOAD_PAGE } from './snowluma/manager.js'
import { createHub, WORKSPACE_DIR } from './chat/hub.js'
import { createStickerStore, stickerPath } from './features/stickers.js'
import { createQzone } from './features/qzone.js'
import { createQzoneSocial } from './features/qzone-social.js'
import { createBili } from './bili/duty.js'
import { createLocal, fileOf } from './local/local.js'
import { createMood, createSpeakUp } from './features/companion.js'
import { createSongStudio, checkRoot, listDrives } from './song/studio.js'
import { createMemoryStore } from './features/memory.js'
import { createImageGen } from './features/imagegen.js'
import { textToSpeech, edgeInstalled, installEdge } from './voice/tts.js'
import { buildTools } from './tools/tools.js'
import { createGroupRoles } from './chat/group-roles.js'
import { defaultModel } from './core/llm.js'
import { mimeOf } from './chat/inbound.js'
import { dataDir, ensureDir } from './core/store.js'
import { createUpdateChecker, changelogSection } from './core/update.js'
import { parseCommand, runCommand, createMutes, commandList } from './chat/commands.js'
import { listPersonas, readPersona, savePersona, deletePersona, currentPersonaText, rulesText, seedPersonas } from './persona/personas.js'

export const name = 'aurabot'
export const inject = ['agents', 'sessions', 'webServer', 'timer', 'workspaceRegistry', 'attachments', 'systemPrompt', 'llm']

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PKG = (() => {
  try { return JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) } catch (error) { return { version: '?' } }
})()
const VERSION = PKG.version
const PREFIX = '/aurabot/api'

export function apply(ctx) {
  const logger = createLogger({ dsh: ctx })
  const log = logger.child('core')
  let cfg = loadConfig()
  const getConfig = () => cfg
  const setConfig = (next) => {
    cfg = saveConfig(next)
    for (const k of ['webuiPassword', 'httpToken', 'wsToken']) registerSecret(cfg.snowluma[k]); registerSecret(cfg.imageGen.apiKey)
    return cfg
  }
  for (const k of ['webuiPassword', 'httpToken', 'wsToken']) registerSecret(cfg.snowluma[k]); registerSecret(cfg.imageGen.apiKey)
  seedPersonas()

  // ---------- 人格与规则：通过提示词变量注入到 Aurabot 的两个 preset ----------
  const variable = (n, fn) => ctx.effect(() => ctx.systemPrompt.variable(n, fn), `aurabot: 变量 ${n}`)
  variable('aurabot_persona', () => currentPersonaText(cfg.persona.current))
  variable('aurabot_rules_private', () => rulesText('private', cfg))
  variable('aurabot_rules_social', () => rulesText('social', cfg))

  // ---------- QQ 网关 ----------
  const snowluma = createSnowLumaManager({
    getConfig,
    log: logger.child('snowluma'),
    // 控制台密码由插件自动生成并保存，用户不用管
    savePassword: (pw) => setConfig({ ...cfg, snowluma: { ...cfg.snowluma, webuiPassword: pw, passwordAuto: true } }),
  })
  const endpoint = () => {
    const s = cfg.snowluma
    const auto = s.httpUrl && s.wsUrl ? null : snowluma.endpoint()
    return {
      httpUrl: s.httpUrl || auto?.httpUrl || '',
      wsUrl: s.wsUrl || auto?.wsUrl || '',
      httpToken: s.httpToken || auto?.httpToken || '',
      wsToken: s.wsToken || auto?.wsToken || '',
    }
  }
  let onebotState = 'stopped'
  let hub = null
  let groupRoles = null
  const onebot = createOneBotClient({
    endpoint,
    log: logger.child('onebot'),
    onState: (s, d) => {
      onebotState = s
      logger.child('onebot').info(`QQ 网关：${s}${d ? '（' + d + '）' : ''}`)
    },
    onEvent: (ev) => {
      if (ev.post_type === 'message' || ev.post_type === 'message_sent') {
        if (ev.post_type === 'message') hub.onMessage(ev).catch((error) => log.error('处理消息出错：', error.message))
      } else if (ev.post_type === 'notice' && ev.notice_type === 'notify' && ev.sub_type === 'poke') {
        hub.onPoke(ev).catch((error) => log.error('处理戳一戳出错：', error.message))
      }
    },
  })
  groupRoles = createGroupRoles({ onebot, getConfig, log: logger.child('chat') })


  // ---------- 功能 ----------
  const stickers = createStickerStore({ dsh: ctx, getConfig, onebot, log: logger.child('sticker') })
  const mood = createMood({ getConfig, dsh: ctx })
  let memory = null
  const local = createLocal({ getConfig, log: logger })
  const song = createSongStudio({
    local,
    getConfig,
    log: logger.child('song'),
    sendVoiceFile: (chatId, file, note) => hub.sendVoiceFile(chatId, file, note),
    sendText: (chatId, text) => hub.sendText(chatId, text),
    onSung: (title, chatId) => {
      mood.nudge(8, `唱完了「${title}」`)
      // 唱过的歌记成她的经历：私聊记到对方头上
      const uid = String(chatId).startsWith('private:') ? String(chatId).slice(8) : ''
      const who = uid === String(cfg.ownerQQ) ? cfg.ownerName || '主人' : uid ? '对方' : '群里'
      memory?.addEvent({ text: `给${who}唱了《${title}》`, about: uid, tags: ['唱歌'], importance: 0.5 })
    },
  })
  const imageGen = createImageGen({ getConfig, log: logger.child('imagegen'), local })
  const tts = {
    speak: async (text) => {
      // 本地接口接管语音合成；出错退回内置
      if (local.active('tts')) {
        try {
          const file = fileOf(await local.call('tts', { text }))
          if (file && existsSync(file)) return { file, engine: 'local' }
        } catch (error) {}
      }
      return textToSpeech(text, cfg.voice, logger.child('voice'))
    },
  }
  let qzone = null
  const mutes = createMutes()
  /** DSH 里能用的所有模型：[{provider, model, name}] */
  async function listModels() {
    const llm = ctx.llm || ctx.get('llm')
    const out = []
    for (const p of llm.listProviders() || []) {
      const provider = typeof p === 'string' ? p : p.provider || p.id || p.name
      try {
        for (const m of (await llm.listModels(provider)) || []) out.push({ provider, model: m.id || m.model, name: m.name || m.id || m.model })
      } catch (error) {}
    }
    return out
  }
  hub = createHub({
    localApi: local,
    dsh: ctx,
    getConfig,
    log: logger.child('chat'),
    onebot,
    stickers,
    tts,
    buildTools: (where) => buildTools({ hub, getConfig, stickers, qzone, memory, song, onebot, imageGen, groupRoles, bili }, where),
    contextProviders: [
      // 她在这个群的身份：没管理权限就别答应禁言踢人
      ({ chat }) => {
        if (chat.kind !== 'group') return ''
        const role = groupRoles.peek(chat.groupId)
        if (!role) return ''
        return groupRoles.canManage(role) ? `你在这个群是${groupRoles.label(role)}，主人要求时可以用群管工具。` : '你在这个群只是普通成员，没有管理权限：禁言、踢人这些做不了，主人要求时直接说明。'
      },
({ chat }) => (chat.kind === 'system' ? '' : mood.contextLine()), ({ chat, sessionId }) => (chat.kind === 'system' ? '' : memory.contextFor(chat, sessionId))],
    onActivity: (a) => {
      if (a.kind === 'in' && a.text) mood.observe(a.text, a.nickname, { direct: a.direct, owner: a.owner })
      // 模型判心情（开了才判）：系统提醒开头的是她自己主动找人
      if (a.kind === 'out' && a.reply && !String(a.chatId).startsWith('system:')) {
        const speakUp = String(a.userText).startsWith('【系统提醒')
        mood.judge({ userText: a.userText, reply: a.reply, who: String(a.chatId).startsWith('group:') ? '群里的人' : String(a.chatId) === `private:${cfg.ownerQQ}` ? cfg.ownerName || '主人' : '对方', origin: speakUp ? 'speak-up' : 'user' }).catch(() => {})
      }
    },
    // 群聊话题和她的记忆有多相关（插话判断用）
    memoryScore: (text) => (memory ? memory.topicScore(text) : 0),
    // QQ 里的主人命令
    onCommand: async (msg) => {
      const cmd = parseCommand(msg.text)
      return cmd ? runCommand(cmd, msg, { getConfig, setConfig, mutes, hub, mood, memory, qzone, song, listModels, defaultModel: () => defaultModel(ctx, { model: {} }) }) : null
    },
    isMuted: (chatId) => mutes.muted(chatId),
    moodEffects: () => mood.effects(),
  })
  memory = createMemoryStore({ dsh: ctx, getConfig, hub, log: logger.child('memory') })
  qzone = createQzone({
    getConfig, onebot, hub, log: logger.child('qzone'),
    // 写过的空间日记也进记忆库：以后聊到相关的事，她会想起自己那天写过什么
    onDiary: (text) => memory.add({ text: `我在 QQ 空间写过：${text}`, importance: 0.55, tags: ['空间日记'], source: 'diary' }),
  })
  const bili = createBili({ getConfig, hub, memory, log: logger.child('bili'), dsh: ctx })
  const qzoneSocial = createQzoneSocial({ getConfig, onebot, hub, memory, log: logger.child('qzone') })
  const speakUp = createSpeakUp({ getConfig, hub, log: logger.child('speakup'), isMuted: (chatId) => mutes.muted(chatId) })

  // ---------- 盯会话：一轮结束就发回 QQ ----------
  ctx.effect(() => {
    const off = ctx.on('session/event', (session, event) => {
      try {
        hub.onSessionEvent(session, event)
      } catch (error) {
        log.warn('会话事件处理出错：', error.message)
      }
    })
    return () => { try { if (typeof off === 'function') off() } catch (error) {} }
  }, 'aurabot: 盯会话')

  // ---------- 启动 / 看门狗 ----------
  async function watchdog() {
    if (!cfg.enabled) {
      if (onebot.state !== 'stopped') onebot.stop()
      return
    }
    const inst = snowluma.detect()
    if (inst.installed && cfg.snowluma.autoStart && !(await snowluma.running())) {
      const r = await snowluma.start()
      log.info('SnowLuma：', r.message)
    }
    if (onebot.state === 'stopped') onebot.start()
    if (cfg.snowluma.autoAttach && cfg.snowluma.webuiPassword && onebotState !== 'connected' && (await snowluma.running())) {
      const last = snowluma.lastAttach
      if (Date.now() - last.at > 60_000) {
        const r = await snowluma.attachBot()
        log.info('接入机器人号：', r.message)
      }
    }
  }
  const safe = (fn, label) => () => { Promise.resolve().then(fn).catch((error) => log.warn(`${label}出错：`, error.message)) }
  ctx.effect(() => ctx.interval(safe(watchdog, '看门狗'), 30_000), 'aurabot: 看门狗')
  ctx.effect(() => ctx.interval(safe(() => qzone.tick(), '空间日记'), 60_000), 'aurabot: 空间日记')
  ctx.effect(() => ctx.interval(safe(() => speakUp.tick(), '主动搭话'), 60_000), 'aurabot: 主动搭话')
  ctx.effect(() => ctx.interval(safe(() => qzoneSocial.tick(), '空间互动'), 60_000), 'aurabot: 空间互动')
  ctx.effect(() => ctx.interval(safe(() => bili.tick(), '刷B站'), 60_000), 'aurabot: 刷B站')
  ctx.effect(() => ctx.interval(safe(() => memory.tick(), '整理记忆'), 60_000), 'aurabot: 每日整理记忆')
  setTimeout(safe(watchdog, '看门狗'), 3000).unref?.()
  ctx.effect(() => () => {
    onebot.stop()
    snowluma.dispose()
  }, 'aurabot: 收尾')

  // ---------- 面板接口 ----------
  const send = (res, code, body, type = 'application/json; charset=utf-8') => {
    try {
      res.statusCode = code
      res.setHeader?.('content-type', type)
      res.setHeader?.('cache-control', 'no-store')
      res.end?.(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body))
    } catch (error) {}
  }
  const readBody = async (req) => {
    let s = ''
    try { for await (const c of req) s += c } catch (error) {}
    try { return JSON.parse(s || '{}') } catch (error) { return {} }
  }
  /** 原样读请求体（上传大文件用），超过 max 字节就报错。 */
  const readRaw = async (req, max) => {
    const parts = []
    let n = 0
    for await (const c of req) {
      const b = Buffer.isBuffer(c) ? c : Buffer.from(c)
      n += b.length
      if (n > max) throw new Error(`文件太大了（最多 ${Math.round(max / 1024 / 1024)}MB）`)
      parts.push(b)
    }
    return Buffer.concat(parts)
  }
  const query = (req) => {
    try { return Object.fromEntries(new URL(req.url, 'http://x').searchParams) } catch (error) { return {} }
  }
  const route = (path, handler) =>
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: PREFIX + path,
      handler: async (req, res) => {
        try {
          const r = await handler(req, res)
          if (r !== undefined) send(res, 200, r)
        } catch (error) {
          send(res, 200, { ok: false, message: redact(String(error && error.message ? error.message : error)) })
        }
      },
    }), `aurabot: 路由 ${path}`)

  let consentCache = { at: 0, value: null }
  async function consented(running) {
    if (!running) return null
    if (Date.now() - consentCache.at < 30_000) return consentCache.value
    let value = null
    try { value = !(await snowluma.agreements()).consentRequired } catch (error) {}
    consentCache = { at: Date.now(), value }
    return value
  }

  async function overview() {
    const inst = snowluma.detect()
    const running = inst.installed ? await snowluma.running() : false
    let login = null
    if (onebotState === 'connected') {
      try {
        const info = await onebot.call('get_login_info', {}, { timeoutMs: 5000 })
        login = { uin: String(info?.user_id ?? ''), nickname: info?.nickname || '' }
      } catch (error) {}
    }
    const lib = stickers.library()
    return {
      ok: true,
      version: VERSION,
      config: publicConfig(cfg),
      onebot: { state: onebotState, login, endpoint: { httpUrl: endpoint().httpUrl, wsUrl: endpoint().wsUrl } },
      snowluma: { ...inst, running, consented: await consented(running), owns: snowluma.ownsProcess, lastAttach: snowluma.lastAttach, downloadPage: DOWNLOAD_PAGE, webui: snowluma.webuiUrl() },
      stats: hub.stats(),
      mood: mood.state(),
      stickers: { count: lib.items.length },
      diary: { next: qzone.nextTime(), last: qzone.history()[0] || null },
      qzoneSocial: qzoneSocial.state(),
      speakUp: speakUp.state(),
      memory: { lastConsolidate: memory.lastConsolidate() },
      avatar: avatarInfo(),
      voice: { edgeInstalled: edgeInstalled() },
      song: song.status(),
      sessions: hub.sessions(),
      workspaceDir: WORKSPACE_DIR,
      personas: listPersonas(),
    }
  }

  route('/state', async () => overview())

  route('/save', async (req) => {
    const body = await readBody(req)
    const before = cfg
    setConfig(mergeFromPanel(cfg, body))
    const changedConn = ['httpUrl', 'wsUrl', 'httpToken', 'wsToken', 'dir'].some((k) => before.snowluma[k] !== cfg.snowluma[k])
    if (changedConn && onebot.state !== 'stopped') onebot.restart()
    if (!before.enabled && cfg.enabled) setTimeout(safe(watchdog, '看门狗'), 100)
    if (before.enabled && !cfg.enabled) onebot.stop()
    log.info(`设置已保存｜总开关 ${cfg.enabled ? '开' : '关'}｜试运行 ${cfg.dryRun ? '开' : '关'}`)
    return { ...(await overview()), message: '保存好了' }
  })

  route('/logs', async (req) => {
    const q = query(req)
    return { ok: true, entries: logger.recent(Number(q.limit) || 300, { level: q.level || '', area: q.area || '' }) }
  })

  // SnowLuma
  route('/snowluma/start', async () => snowluma.start())
  route('/snowluma/stop', async () => snowluma.stop())
  route('/snowluma/attach', async () => snowluma.attachBot())
  route('/commands', async () => ({ ok: true, list: commandList() }))
  // 更新：检查 GitHub 上有没有新版本；这次更新了什么
  const checkUpdate = createUpdateChecker({ pkg: PKG, log })
  route('/update/check', async (req) => checkUpdate({ force: new URL(req.url, 'http://x').searchParams.get('force') === '1' }))
  route('/changelog', async () => {
    let text = ''
    try { text = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8') } catch (error) {}
    return { ok: true, version: VERSION, notes: changelogSection(text, VERSION) }
  })
  // 翻唱
  route('/song/status', async () => ({ ok: true, ...song.status() }))
  route('/song/install', async () => song.install())
  route('/song/root/check', async (req) => ({ ok: true, ...checkRoot(query(req).path || '') }))
  route('/song/drives', async () => ({ ok: true, list: listDrives() }))
  route('/song/search', async (req) => {
    const q = new URL(req.url, 'http://x').searchParams.get('q') || ''
    try { return { ok: true, list: await song.search(q) } } catch (error) { return { ok: false, message: error.message, list: [] } }
  })
  route('/song/account', async () => song.account())
  // 导入音色：面板把文件原样传上来（.zip / .pth / .index），文件名放在 ?name= 里
  route('/song/import', async (req) => {
    const name = query(req).name || ''
    try {
      const buf = await readRaw(req, 1024 * 1024 * 1024)
      if (!buf.length) return { ok: false, message: '文件是空的' }
      const r = song.importModels(name, buf)
      if (r.ok) log.info('导入音色：' + r.message)
      return r
    } catch (error) {
      return { ok: false, message: '导入失败：' + error.message }
    }
  })
  route('/song/voice/delete', async (req) => song.deleteVoice(String((await readBody(req)).id || '')))
  route('/song/request', async (req) => {
    const b = await readBody(req)
    // 面板里试唱：发到主人私聊
    return song.request({ song: b.song, songId: b.songId, pitch: b.pitch, voice: b.voice, chatId: b.chatId || `private:${cfg.ownerQQ}` })
  })
  route('/groups/roles', async () => {
    const list = await Promise.all(cfg.allow.groups.map(async (gid) => {
      const role = await groupRoles.get(gid, { fresh: true })
      return { groupId: gid, name: await hub.groupName(String(gid)), role, label: role ? groupRoles.label(role) : '查不到（她在群里吗？）', canManage: groupRoles.canManage(role) }
    }))
    return { ok: true, list }
  })
  route('/snowluma/login-check', async () => ({ ...(await snowluma.canLogin()), passwordAuto: cfg.snowluma.passwordAuto, running: await snowluma.running() }))
  route('/snowluma/agreements', async () => {
    try { return { ok: true, ...(await snowluma.agreements()) } } catch (error) { return { ok: false, message: error.message } }
  })
  route('/snowluma/consent', async (req) => {
    const b = await readBody(req)
    if (b.agree !== true) return { ok: false, message: '要先勾选「我已阅读并同意」' }
    consentCache = { at: 0, value: null }
    return snowluma.consent(b.version)
  })
  route('/snowluma/reset-password', async () => snowluma.resetPassword())
  route('/setup/done', async () => {
    if (!cfg.botQQ || !cfg.ownerQQ) return { ok: false, message: '先填好机器人 QQ 和你的 QQ' }
    setConfig({ ...cfg, setupDone: true })
    log.info('首次使用向导完成')
    return { ...(await overview()), message: '设置完成，大肥鱼可以上线啦' }
  })
  route('/snowluma/processes', async () => {
    try { return { ok: true, list: await snowluma.processes() } } catch (error) { return { ok: false, message: error.message, list: [] } }
  })
  route('/onebot/reconnect', async () => {
    onebot.restart()
    return { ok: true, message: '正在重连' }
  })
  route('/onebot/test', async () => {
    try {
      const info = await onebot.call('get_login_info', {}, { timeoutMs: 8000 })
      const uin = String(info?.user_id ?? '')
      return { ok: uin === cfg.botQQ, message: uin === cfg.botQQ ? `连上了：${info.nickname}（${uin}）` : `连上的是 ${uin}，不是机器人号 ${cfg.botQQ}！`, info }
    } catch (error) {
      return { ok: false, message: error.message }
    }
  })
  route('/test-send', async () => {
    if (!cfg.enabled) return { ok: false, message: '先打开总开关' }
    if (cfg.dryRun) return { ok: false, message: '现在是试运行，先关掉试运行再测' }
    const r = await hub.sendText(`private:${cfg.ownerQQ}`, '【Aurabot 自测】大肥鱼到此一游～')
    return r ? { ok: true, message: '发给主人了，去 QQ 看看' } : { ok: false, message: '没发出去（看日志）' }
  })

  route('/sessions/reset', async () => {
    const n = hub.resetSessions()
    return { ok: true, message: n ? `归档了 ${n} 个会话，下一条消息起她会重新开始` : '本来就没有会话' }
  })

  // 人格
  route('/personas', async () => ({ ok: true, list: listPersonas(), current: cfg.persona.current }))
  route('/persona/get', async (req) => {
    const p = readPersona(query(req).id)
    return p ? { ok: true, persona: p } : { ok: false, message: '没有这个人格' }
  })
  route('/persona/save', async (req) => {
    const b = await readBody(req)
    const p = savePersona(b.id, b)
    return { ok: true, persona: p, message: '人格已保存，下一轮起生效' }
  })
  route('/persona/delete', async (req) => {
    const b = await readBody(req)
    if (b.id === cfg.persona.current) return { ok: false, message: '正在用的人格不能删' }
    deletePersona(b.id)
    return { ok: true, list: listPersonas() }
  })
  route('/persona/use', async (req) => {
    const b = await readBody(req)
    if (!readPersona(b.id)) return { ok: false, message: '没有这个人格' }
    setConfig({ ...cfg, persona: { current: b.id } })
    log.info(`切换人格 → ${b.id}`)
    return { ok: true, current: b.id, message: '切换好了，下一轮回复起生效' }
  })

  // 表情
  route('/stickers', async () => ({ ok: true, items: stickers.library().items.slice().reverse() }))
  route('/sticker/image', async (req, res) => {
    const it = stickers.library().items.find((i) => i.md5 === query(req).md5)
    if (!it || !existsSync(stickerPath(it))) return send(res, 404, '')
    const ext = it.file.split('.').pop()
    send(res, 200, readFileSync(stickerPath(it)), ext === 'png' ? 'image/png' : ext === 'gif' ? 'image/gif' : ext === 'webp' ? 'image/webp' : 'image/jpeg')
  })
  route('/sticker/rename', async (req) => {
    const b = await readBody(req)
    return stickers.rename(b.md5, b.name, Array.isArray(b.tags) ? b.tags : undefined)
  })
  route('/sticker/delete', async (req) => {
    const b = await readBody(req)
    return stickers.remove(b.md5, { fromQQ: b.fromQQ !== false })
  })
  route('/sticker/upload', async (req) => {
    const b = await readBody(req)
    const buf = Buffer.from(String(b.data || '').replace(/^data:[^,]+,/, ''), 'base64')
    if (!buf.length || buf.length > 5 * 1024 * 1024) return { ok: false, message: '图片太大或是空的' }
    return stickers.addFromBuffer(buf, { name: b.name || '', tags: b.tags || [], from: 'panel' })
  })

  // 空间
  route('/diary/run', async (req) => {
    const b = await readBody(req)
    return qzone.writeDiary({ visibility: b.visibility })
  })
  route('/diary/history', async () => ({ ok: true, items: qzone.history(), next: qzone.nextTime() }))
  route('/qzone/social/run', async () => qzoneSocial.run({ force: true }))
  // 本地接口
  route('/local/status', async () => ({ ok: true, dir: local.dir(), list: local.status() }))
  route('/local/template', async (req) => {
    const slot = String((await readBody(req)).slot || '')
    if (!local.pathOf || !['tts', 'image', 'song', 'asr'].includes(slot)) return { ok: false, message: '没有这一项' }
    return local.template(slot)
  })
  route('/local/open', async () => {
    const { mkdirSync } = await import('node:fs')
    mkdirSync(local.dir(), { recursive: true })
    const { spawn } = await import('node:child_process')
    spawn('explorer.exe', [local.dir()], { detached: true, stdio: 'ignore' }).unref()
    return { ok: true, message: '打开了' }
  })
  route('/local/test', async (req) => {
    const slot = String((await readBody(req)).slot || '')
    try {
      if (slot === 'tts') {
        const file = fileOf(await local.call('tts', { text: '你好呀，我是大肥鱼，这是本地语音测试。' }))
        if (!file || !existsSync(file)) return { ok: false, message: '脚本没返回音频文件' }
        return { ok: true, message: `念好了：${file}` }
      }
      if (slot === 'image') {
        const { toImageBuffer } = await import('./local/local.js')
        const buf = await toImageBuffer(await local.call('image', { prompt: '一条胖乎乎的蓝色小鱼，可爱，插画', size: cfg.imageGen.size || '1024x1024' }))
        return { ok: true, message: `画好了（${Math.round(buf.length / 1024)} KB）`, image: buf.toString('base64') }
      }
      return { ok: false, message: '这一项没法单独试：翻唱换声去 QQ 里点首歌，语音识别发条语音条试试' }
    } catch (error) {
      return { ok: false, message: '出错了：' + error.message }
    }
  })
  // B 站
  route('/bili/state', async () => ({ ok: true, ...bili.state(), account: await bili.account() }))
  route('/bili/account', async () => bili.account(true))
  route('/bili/run', async () => bili.run({ force: true }))
  route('/bili/replies', async () => bili.checkReplies())
  // 截图库（面板里看全部、手动删）
  route('/bili/shots', async () => ({ ...bili.libraryShots(), limit: cfg.bili.shotLibrary }))
  route('/bili/shot/image', async (req, res) => {
    const p = bili.shotFileOf(query(req).file)
    if (!p) return send(res, 404, '')
    send(res, 200, readFileSync(p), 'image/jpeg')
  })
  route('/bili/shot/delete', async (req) => bili.deleteShot(String((await readBody(req)).file || '')))
  route('/qzone/social/state', async () => ({ ok: true, ...qzoneSocial.state() }))
  route('/qzone/delete', async (req) => {
    const b = await readBody(req)
    await qzone.remove(b.tid)
    return { ok: true, message: '删掉了' }
  })

  // 语音
  route('/voice/test', async (req) => {
    const b = await readBody(req)
    const { file, engine } = await tts.speak(String(b.text || '你好呀，我是大肥鱼'))
    const buf = readFileSync(file)
    return { ok: true, engine, mime: file.endsWith('.wav') ? 'audio/wav' : 'audio/mpeg', data: buf.toString('base64') }
  })
  route('/voice/install', async () => installEdge(logger.child('voice')))
  // DSH 自带语音识别：看状态 / 下载模型
  route('/voice/asr-status', async () => {
    const stt = ctx.get('speechToText')
    if (!stt || typeof stt.snapshot !== 'function') return { ok: false, enabled: false, message: 'DSH 里没有开启「语音输入」插件' }
    const s = stt.snapshot()
    const p = s.providers.find((x) => x.id === s.selection.providerId) || s.providers[0]
    return { ok: true, enabled: true, provider: p?.id, phase: p?.preparation?.phase || 'ready', detail: p?.preparation }
  })
  route('/voice/asr-prepare', async () => {
    const stt = ctx.get('speechToText')
    if (!stt || typeof stt.snapshot !== 'function') return { ok: false, message: 'DSH 里没有开启「语音输入」插件' }
    const s = stt.snapshot()
    stt.prepare(s.selection.providerId)
    return { ok: true, message: '开始下载识别模型（约 200MB，下好后常驻本机）' }
  })
  // 自检「听语音」（真 QQ）：拿和某人私聊里最近一条语音，走一遍 get_record → 16k → DSH 识别
  route('/voice/asr-last', async (req) => {
    const b = await readBody(req)
    const uid = Number(b.userId || cfg.ownerQQ)
    const h = await onebot.call('get_friend_msg_history', { user_id: uid, count: 30 })
    const recs = (h?.messages || []).filter((m) => String(m.user_id) === String(uid)).flatMap((m) => (m.message || []).filter((s) => s.type === 'record').map((s) => ({ seg: s, time: m.time })))
    const last = recs.at(-1)
    if (!last) return { ok: false, message: '最近的聊天里没有对方发的语音' }
    const t = Date.now()
    const text = await hub.localTranscribe(last.seg)
    return { ok: Boolean(text), heard: text, at: new Date(last.time * 1000).toLocaleString(), ms: Date.now() - t }
  })
  // 自检「听语音」：Windows 语音念一句 → 转 16k 单声道 → DSH 自带识别 → 看能不能认回来
  route('/voice/asr-test', async (req) => {
    const b = await readBody(req)
    const stt = ctx.get('speechToText')
    if (!stt || typeof stt.resolve !== 'function') return { ok: false, message: 'DSH 里没有开启语音识别（设置 → 插件 → 语音输入）' }
    const text = String(b.text || '今天想吃白米饭')
    const { file } = await textToSpeech(text, { engine: 'windows' })
    const { toMono16k } = await import('./voice/wav.js')
    const t = Date.now()
    const spec = stt.resolve({ audio: new Uint8Array(toMono16k(readFileSync(file))) })
    const r = await stt.transcribe(spec, AbortSignal.timeout(120000))
    const heard = typeof r === 'string' ? r : r?.text || r?.transcript || JSON.stringify(r)
    return { ok: Boolean(heard), said: text, heard, ms: Date.now() - t }
  })

  // 模型：列出 DSH 里可用的模型，测一下哪个回得快
  route('/models', async () => {
    try {
      return { ok: true, list: await listModels() }
    } catch (error) {
      return { ok: false, message: error.message, list: [] }
    }
  })
  route('/model/ping', async (req) => {
    const b = await readBody(req)
    const t = Date.now()
    try {
      const { askModel } = await import('./core/llm.js')
      const text = await askModel(ctx, { cfg: { model: { provider: b.provider, model: b.model } }, system: '只回复两个字：在呢', text: '在吗', maxTokens: 800 })
      return { ok: true, ms: Date.now() - t, text: text.slice(0, 40) }
    } catch (error) {
      return { ok: false, ms: Date.now() - t, message: error.message }
    }
  })

  // 记忆 / 心情 / 主动搭话
  route('/memories', async (req) => ({ ok: true, items: memory.list(query(req).q || '').slice(0, 300), stats: memory.stats() }))
  route('/memory/add', async (req) => {
    const b = await readBody(req)
    return memory.add({ text: b.text, aboutName: b.aboutName || '', about: b.about || '', importance: b.importance ?? 0.6, tags: b.tags || [], source: 'panel' })
  })
  route('/memory/update', async (req) => {
    const b = await readBody(req)
    return memory.update(b.id, b)
  })
  route('/memory/delete', async (req) => {
    const b = await readBody(req)
    return memory.remove(b.id)
  })
  route('/insights', async () => ({ ok: true, items: memory.insights(), styles: memory.styles() }))
  route('/memory/recalls', async () => ({ ok: true, list: memory.recalls() }))
  route('/memory/restore', async (req) => memory.restore((await readBody(req)).id))
  route('/profiles', async () => ({ ok: true, list: memory.profiles() }))
  route('/profiles/save', async (req) => {
    const b = await readBody(req)
    memory.setProfile(String(b.qq || ''), String(b.text || ''))
    return { ok: true, message: b.text ? '小档案已保存' : '小档案已清空' }
  })
  route('/profiles/rebuild', async (req) => {
    const b = await readBody(req)
    try {
      return (await memory.buildProfile(String(b.qq || ''))) ? { ok: true, message: '按记忆重写好了' } : { ok: false, message: '关于 TA 的记忆还太少（至少 3 条）' }
    } catch (error) {
      return { ok: false, message: error.message }
    }
  })
  route('/memory/import', async (req) => {
    const b = await readBody(req)
    try { return { ok: true, list: await memory.importCandidates(String(b.text || '').slice(0, 30000)) } } catch (error) { return { ok: false, message: error.message, list: [] } }
  })
  route('/memory/import/commit', async (req) => {
    const n = memory.importCommit((await readBody(req)).items || [])
    return { ok: true, message: `存进记忆库 ${n} 条` }
  })
  route('/style/save', async (req) => {
    const b = await readBody(req)
    memory.setStyle(String(b.key || ''), (b.list || []).map((t) => String(t).trim()).filter(Boolean))
    return { ok: true, message: '说话方式已保存' }
  })
  route('/insights/save', async (req) => {
    const b = await readBody(req)
    memory.setInsights(String(b.key || ''), (b.list || []).map((t) => String(t).trim()).filter(Boolean))
    return { ok: true, message: '相处经验已保存' }
  })
  route('/memory/extract', async (req) => {
    const b = await readBody(req)
    // 立即整理一次：连今天的也提炼（今天的聊天流水不删，写日记还要用）
    return memory.consolidate({ includeToday: b.includeToday !== false })
  })
  route('/speakup/fire', async () => {
    if (!cfg.enabled) return { ok: false, message: '先打开总开关' }
    await speakUp.fire('手动')
    return { ok: true, message: '叫她去找你了' }
  })

  // 形象图
  // 头像：自定义的放在数据目录（重装插件不丢），没有就用插件自带的大肥鱼
  const AVATAR = () => dataDir('avatar.img')
  const avatarInfo = () => {
    try { return { custom: true, at: statSync(AVATAR()).mtimeMs } } catch (error) { return { custom: false, at: 0 } }
  }
  route('/avatar', async (req, res) => {
    if (existsSync(AVATAR())) {
      const buf = readFileSync(AVATAR())
      return send(res, 200, buf, mimeOf(buf))
    }
    const p = join(ROOT, 'assets', 'dafeiyu.jpg')
    if (!existsSync(p)) return send(res, 404, '')
    send(res, 200, readFileSync(p), 'image/jpeg')
  })
  route('/avatar/upload', async (req) => {
    const b = await readBody(req)
    const buf = Buffer.from(String(b.data || '').replace(/^data:[^,]+,/, ''), 'base64')
    if (!buf.length || buf.length > 5 * 1024 * 1024) return { ok: false, message: '图片太大（最多 5MB）或是空的' }
    if (!mimeOf(buf).startsWith('image/')) return { ok: false, message: '只支持 PNG、JPG、GIF、WebP 图片' }
    ensureDir(dataDir())
    writeFileSync(AVATAR(), buf)
    log.info('换了面板头像')
    return { ok: true, message: '头像换好了', avatar: avatarInfo() }
  })
  route('/avatar/reset', async () => {
    try { unlinkSync(AVATAR()) } catch (error) {}
    return { ok: true, message: '恢复成默认头像了', avatar: avatarInfo() }
  })
  route('/avatar/sync-qq', async () => {
    const buf = existsSync(AVATAR()) ? readFileSync(AVATAR()) : readFileSync(join(ROOT, 'assets', 'dafeiyu.jpg'))
    try {
      await onebot.call('set_qq_avatar', { file: 'base64://' + buf.toString('base64') })
      return { ok: true, message: '已经设成机器人号的 QQ 头像' }
    } catch (error) {
      return { ok: false, message: 'QQ 头像没换成：' + error.message }
    }
  })

  log.info(`Aurabot v${VERSION} 已加载｜总开关 ${cfg.enabled ? '开' : '关'}｜试运行 ${cfg.dryRun ? '开' : '关'}｜工作区 ${WORKSPACE_DIR}`)

  return { hub, onebot, snowluma, stickers, qzone, mood, memory, getConfig, setConfig, logger }
}
