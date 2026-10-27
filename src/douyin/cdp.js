// 抖音专用 Edge：独立用户资料 + 本机随机调试端口，经 CDP（Node 全局 WebSocket）控制。
// 不签 a_bogus：刷流靠被动截获页面自己的 Network.responseReceived。
// 所有真正点开浏览器的步骤都经「driver」接口，测时注入假驱动，不需要真开 Edge。

import { createServer } from 'node:net'
import { spawn, execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve as pathResolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { looksLikeVerify, looksLimited, awemesFromResponse, isRecommendUrl, extractOwnerProfile, normalizeOwnerUid } from './util.js'

const EDGE_CANDIDATES = [
  process.env.EDGE_PATH,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/microsoft-edge',
  '/usr/bin/microsoft-edge-stable',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
].filter(Boolean)
const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean)

export function findBrowser(explicit = '') {
  if (explicit && existsSync(explicit)) return explicit
  for (const p of [...EDGE_CANDIDATES, ...CHROME_CANDIDATES]) if (p && existsSync(p)) return p
  return ''
}

/** 本机空闲端口（127.0.0.1）。 */
export function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer()
    s.unref()
    s.on('error', reject)
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)) })
  })
}

/** 规范化资料路径，方便和进程命令行比对（大小写 / 斜杠）。 */
export function normalizeProfilePath(p) {
  try {
    return pathResolve(String(p || '')).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  } catch (error) {
    return String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  }
}

/**
 * 读 Chromium/Edge 的 DevToolsActivePort：第一行是调试端口。
 * 进程仍在时 Harness 重启后凭此 attach，避免再 spawn 抢同一 user-data-dir。
 */
export function readDevToolsActivePort(profileDir, { readFile = readFileSync, exists = existsSync } = {}) {
  const file = join(String(profileDir || ''), 'DevToolsActivePort')
  if (!exists(file)) return 0
  try {
    const first = String(readFile(file, 'utf8')).split(/\r?\n/)[0].trim()
    const n = Number(first)
    return Number.isInteger(n) && n > 0 && n < 65536 ? n : 0
  } catch (error) {
    return 0
  }
}

/** 探测本机调试端口是否已起来（/json/version）。 */
export async function probeDebugPort(port, { fetchJson = getJson } = {}) {
  const p = Number(port)
  if (!Number.isInteger(p) || p <= 0) return null
  try {
    const v = await fetchJson(`http://127.0.0.1:${p}/json/version`)
    if (v && (v.webSocketDebuggerUrl || v.Browser || v['Protocol-Version'])) return v
    return v || null
  } catch (error) {
    return null
  }
}

function cmdlineHasProfile(cmdline, profileDir) {
  const cmd = String(cmdline || '').replace(/\\/g, '/')
  const want = normalizeProfilePath(profileDir)
  if (!want) return false
  const low = cmd.toLowerCase()
  if (!/--user-data-dir=/i.test(cmd)) return false
  if (low.includes(want)) return true
  // 命令行里的路径可能带引号或未 resolve
  const m = cmd.match(/--user-data-dir=(?:"([^"]+)"|'([^']+)'|([^\s]+))/i)
  if (!m) return false
  return normalizeProfilePath(m[1] || m[2] || m[3] || '') === want
}

function portFromCmdline(cmdline) {
  const m = String(cmdline || '').match(/--remote-debugging-port=(\d{2,5})/i)
  if (!m) return 0
  const n = Number(m[1])
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : 0
}

/**
 * Windows 扫进程用的 PowerShell 脚本正文（整段，不手工拼接 -Command）。
 * 由 encodePowerShellEncodedCommand 编成 -EncodedCommand，避免 `\` / -replace / Where-Object 被 JS↔PS 转义弄坏。
 */
export function buildWindowsBrowserScanScript(profileDir) {
  const want = normalizeProfilePath(profileDir).replace(/'/g, "''")
  return [
    "$ProgressPreference='SilentlyContinue'",
    `$want = '${want}'`,
    'Get-CimInstance Win32_Process | Where-Object {',
    "  $_.Name -match '^(msedge|chrome|chromium)\\.exe$' -and $_.CommandLine -and",
    "  ($_.CommandLine -replace '\\\\','/').ToLower().Contains($want)",
    '} | ForEach-Object { "{0}`t{1}" -f $_.ProcessId, $_.CommandLine }',
  ].join('\n')
}

/** PowerShell -EncodedCommand：UTF-16LE → Base64（不要用手拼长 -Command）。 */
export function encodePowerShellEncodedCommand(script) {
  return Buffer.from(String(script ?? ''), 'utf16le').toString('base64')
}

/** 解析扫进程输出行：`pid\\tcmdline`（Windows）或 `pid cmdline`（ps）。 */
export function parseBrowserProcessScanLine(line, profileDir) {
  const raw = String(line || '').trim()
  if (!raw) return null
  let pid
  let cmdline
  const tab = raw.indexOf('\t')
  if (tab >= 0) {
    pid = raw.slice(0, tab)
    cmdline = raw.slice(tab + 1)
  } else {
    const m = raw.match(/^(\d+)\s+(.*)$/)
    if (!m) return null
    pid = m[1]
    cmdline = m[2]
  }
  const n = Number(pid)
  if (!Number.isInteger(n) || n <= 0) return null
  if (!cmdlineHasProfile(cmdline, profileDir)) return null
  if (!/msedge|chrome|chromium|microsoft-edge/i.test(String(cmdline))) return null
  return { pid: n, port: portFromCmdline(cmdline) }
}

/**
 * 找出占用本 profile（user-data-dir）的本机 Edge/Chrome 进程。
 * 返回 [{ pid, port }]；port 来自命令行 --remote-debugging-port（可能为 0）。
 * Windows 走 -EncodedCommand，禁止 join(' ') / 手拼 -Command。
 */
export function findBrowserProcessesForProfile(profileDir, { execFile = execFileSync, platform = process.platform } = {}) {
  const out = []
  try {
    let text = ''
    if (platform === 'win32') {
      const script = buildWindowsBrowserScanScript(profileDir)
      const encoded = encodePowerShellEncodedCommand(script)
      text = String(execFile('powershell.exe', ['-NoProfile', '-EncodedCommand', encoded], {
        encoding: 'utf8', timeout: 20000, windowsHide: true, maxBuffer: 8 * 1024 * 1024,
      }) || '')
    } else {
      text = String(execFile('ps', ['-ao', 'pid=,args='], {
        encoding: 'utf8', timeout: 10000, maxBuffer: 8 * 1024 * 1024,
      }) || '')
    }
    for (const line of text.split(/\r?\n/)) {
      const row = parseBrowserProcessScanLine(line, profileDir)
      if (row) out.push(row)
    }
  } catch (error) {
    return out
  }
  const seen = new Set()
  return out.filter((x) => (seen.has(x.pid) ? false : (seen.add(x.pid), true)))
}

/**
 * Edge 常不写 DevToolsActivePort；spawn 成功后若缺失则自写 port + 路径，
 * 供 Harness 重启后 attach。
 */
export function ensureDevToolsActivePort(profileDir, port, {
  exists = existsSync,
  readFile = readFileSync,
  writeFile = writeFileSync,
} = {}) {
  const p = Number(port)
  if (!Number.isInteger(p) || p <= 0 || p >= 65536) return false
  const dir = String(profileDir || '')
  if (!dir) return false
  const current = readDevToolsActivePort(dir, { exists, readFile })
  if (current === p) return false
  const file = join(dir, 'DevToolsActivePort')
  try {
    writeFile(file, `${p}\n/devtools/browser/aurabot\n`, 'utf8')
    return true
  } catch (error) {
    return false
  }
}

/** 温和结束占用本 profile 的浏览器进程（只动匹配到的 pid）。 */
export function killBrowserProcessesForProfile(profileDir, { find = findBrowserProcessesForProfile, kill = (pid, sig) => process.kill(pid, sig) } = {}) {
  const procs = find(profileDir)
  const killed = []
  for (const p of procs) {
    try {
      kill(p.pid, 'SIGTERM')
      killed.push(p.pid)
    } catch (error) { /* 已退出 */ }
  }
  return killed
}

/**
 * Harness 重启后优先复用已开的调试端口；否则列出需清理的占用进程再 spawn。
 * @returns {{ mode: 'attach', port: number } | { mode: 'spawn', killPids: number[] }}
 */
export async function resolveLaunchTarget(profileDir, {
  readPort = readDevToolsActivePort,
  probe = probeDebugPort,
  findProcs = findBrowserProcessesForProfile,
} = {}) {
  const filePort = readPort(profileDir)
  if (filePort && await probe(filePort)) {
    return { mode: 'attach', port: filePort }
  }
  const procs = findProcs(profileDir)
  for (const p of procs) {
    if (p.port && await probe(p.port)) {
      return { mode: 'attach', port: p.port, pid: p.pid }
    }
  }
  // DevToolsActivePort 过期但进程还在：也要清掉再开
  if (filePort && !(await probe(filePort))) {
    /* fallthrough */
  }
  return { mode: 'spawn', killPids: procs.map((p) => p.pid) }
}


/** CDP WebSocket：发命令、收事件。wsFactory 方便测时替换。 */
export function createCdpSession(wsUrl, { wsFactory, log } = {}) {
  const WS = wsFactory || globalThis.WebSocket
  if (!WS) throw new Error('当前 Node 没有 WebSocket（请用 --experimental-websocket 或 Node ≥ 22）')
  let sock
  let nextId = 1
  const pending = new Map()
  const listeners = new Map()
  let closed = false

  const emit = (method, params) => {
    for (const fn of listeners.get(method) || []) try { fn(params) } catch (error) { log?.debug?.('cdp listener', error.message) }
    for (const fn of listeners.get('*') || []) try { fn(method, params) } catch (error) {}
  }

  const open = () => new Promise((resolve, reject) => {
    sock = new WS(wsUrl)
    const t = setTimeout(() => reject(new Error('连不上浏览器调试端口')), 15000)
    sock.addEventListener('open', () => { clearTimeout(t); resolve() })
    sock.addEventListener('error', (e) => { clearTimeout(t); reject(e.error || e) })
    sock.addEventListener('message', (ev) => {
      let msg
      try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString()) } catch (error) { return }
      if (msg.id != null && pending.has(msg.id)) {
        const { resolve: ok, reject: bad } = pending.get(msg.id)
        pending.delete(msg.id)
        if (msg.error) bad(Object.assign(new Error(msg.error.message || 'CDP 出错'), { code: msg.error.code }))
        else ok(msg.result)
      } else if (msg.method) emit(msg.method, msg.params || {})
    })
    sock.addEventListener('close', () => {
      closed = true
      for (const [, { reject: bad }] of pending) bad(new Error('浏览器调试连接断了'))
      pending.clear()
    })
  })

  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    if (closed) return reject(new Error('浏览器已关'))
    const id = nextId++
    pending.set(id, { resolve, reject })
    const payload = { id, method, params }
    if (sessionId) payload.sessionId = sessionId
    try { sock.send(JSON.stringify(payload)) } catch (error) { pending.delete(id); reject(error) }
  })

  const on = (method, fn) => {
    if (!listeners.has(method)) listeners.set(method, new Set())
    listeners.get(method).add(fn)
    return () => listeners.get(method)?.delete(fn)
  }

  const close = () => { try { sock?.close() } catch (error) {} }

  return { open, send, on, close, get closed() { return closed } }
}

/** HTTP GET JSON（拉 /json/version、/json/list）。 */
async function getJson(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(8000) })
  if (!r.ok) throw new Error(`读 ${url} 失败：${r.status}`)
  return r.json()
}

/**
 * 真浏览器驱动。profileDir = 独立用户资料目录；browserPath 可空（自动找）。
 * 返回的对象实现 createFakeDriver 同形接口，duty 只认这些方法。
 */
export function createBrowserDriver({ profileDir, browserPath = '', minimize = true, log, wsFactory, hooks = {} } = {}) {
  let child = null
  let session = null
  let port = 0
  let pageSessionId = ''
  const feed = [] // 最近截到的 aweme
  const caps = { verify: false, reason: '' }
  let lastUserProfile = null // { secUid, uid, nickname, avatar } 来自 profile API / 主页
  let offNet = null
  const h = {
    freePort,
    spawn,
    getJson,
    sleep,
    findBrowser: (p) => findBrowser(p),
    readDevToolsActivePort,
    probeDebugPort,
    findBrowserProcessesForProfile,
    ensureDevToolsActivePort,
    killPid: (pid, sig) => { try { process.kill(pid, sig) } catch (error) { /* gone */ } },
    resolveLaunchTarget,
    ...hooks,
  }

  const markVerify = (why) => { caps.verify = true; caps.reason = why || '要验证' }
  const clearVerify = () => { caps.verify = false; caps.reason = '' }

  async function attachPage() {
    const list = await h.getJson(`http://127.0.0.1:${port}/json/list`)
    const page = (list || []).find((t) => t.type === 'page' && t.webSocketDebuggerUrl) || list?.[0]
    if (!page?.webSocketDebuggerUrl) throw new Error('浏览器没开出可调试的标签页')
    session = createCdpSession(page.webSocketDebuggerUrl, { wsFactory, log })
    await session.open()
    await session.send('Page.enable')
    await session.send('Runtime.enable')
    await session.send('Network.enable')
    await session.send('Page.setMuted', { muted: true }).catch(() => {})
    const pendingNet = new Map()
    const ingestResponse = async (url, requestId) => {
      let body = null
      for (let i = 0; i < 8; i++) {
        body = await session.send('Network.getResponseBody', { requestId }).catch(() => null)
        if (body?.body) break
        await h.sleep(120 + i * 80)
      }
      if (!body?.body) return
      const text = body.base64Encoded ? Buffer.from(body.body, 'base64').toString('utf8') : body.body
      if (looksLikeVerify(text) || looksLimited(text)) { markVerify(looksLikeVerify(text) ? '页面要验证' : '账号被限制'); return }
      let json
      try { json = JSON.parse(text) } catch (error) { return }
      if (/user\/profile\/(other|self)|web\/user\/profile/i.test(url)) {
        const u = json?.user || json?.user_info || json?.data?.user || json?.data?.user_info || json?.data || json
        const sec = String(u?.sec_uid || u?.secUid || '')
        const id = normalizeOwnerUid(u?.uid || u?.user_id || u?.userId || '')
        if (sec || id) {
          lastUserProfile = {
            secUid: sec,
            uid: id,
            nickname: String(u?.nickname || u?.nick_name || '').slice(0, 40),
            avatar: String(u?.avatar_thumb?.url_list?.[0] || u?.avatarUrl || u?.avatar || ''),
          }
        }
      }
      const list = awemesFromResponse(json)
      for (const a of list) {
        if (!feed.some((x) => x.awemeId === a.awemeId)) feed.push(a)
      }
      if (feed.length > 80) feed.splice(0, feed.length - 80)
    }
    offNet = session.on('Network.responseReceived', (p) => {
      try {
        const url = p?.response?.url || ''
        if (!/douyin\.com|amemv\.com|snssdk\.com/.test(url)) return
        if (!/aweme|feed|recommend|comment|message|im\/|user\/profile/i.test(url)) return
        pendingNet.set(p.requestId, url)
      } catch (error) { /* ignore */ }
    })
    const offLoad = session.on('Network.loadingFinished', (p) => {
      const url = pendingNet.get(p.requestId)
      if (!url) return
      pendingNet.delete(p.requestId)
      ingestResponse(url, p.requestId).catch(() => {})
    })
    const prevOffNet = offNet
    offNet = () => { try { prevOffNet?.() } catch (e) {} try { offLoad?.() } catch (e) {} }
  }

  const browserLogin = {
    phase: 'idle',
    qrDataUrl: '',
    message: '',
    verifyHint: '',
    error: '',
  }

  function browserLoginSnapshot(started = false) {
    const loggedIn = browserLogin.phase === 'logged_in'
    return {
      ok: browserLogin.phase !== 'error',
      started: !!started || (browserLogin.phase !== 'idle' && browserLogin.phase !== 'logged_in' && browserLogin.phase !== 'error'),
      loggedIn,
      phase: browserLogin.phase,
      qrDataUrl: browserLogin.qrDataUrl || '',
      message: browserLogin.message || '',
      verifyHint: browserLogin.verifyHint || '',
      error: browserLogin.error || '',
      nickname: '',
      uid: '',
    }
  }

  async function moveOffscreen() {
    if (!session || session.closed) return
    try {
      const { windowId } = await session.send('Browser.getWindowForTarget', {})
      await session.send('Browser.setWindowBounds', {
        windowId,
        bounds: { left: -32000, top: -32000, width: 1000, height: 800, windowState: 'normal' },
      })
    } catch (error) {
      await evalJs(`try{window.moveTo(-32000,-32000);window.resizeTo(1000,800)}catch(e){}`).catch(() => {})
    }
  }

  async function minimizeWindow() {
    if (!session || session.closed) return
    try {
      const { windowId } = await session.send('Browser.getWindowForTarget', {})
      await session.send('Browser.setWindowBounds', {
        windowId,
        bounds: { windowState: 'minimized' },
      })
    } catch (error) {
      await evalJs(`try{window.blur()}catch(e){}`).catch(() => {})
    }
  }

  async function launch(opts = {}) {
    const offscreen = !!opts.offscreen
    if (session && !session.closed) {
      if (offscreen) await moveOffscreen()
      return { ok: true }
    }

    // 1) Harness 重启后优先 attach 已存在的 Edge（同 edge-profile + 调试端口）
    const target = await h.resolveLaunchTarget(profileDir, {
      readPort: h.readDevToolsActivePort,
      probe: (p) => h.probeDebugPort(p, { fetchJson: h.getJson }),
      findProcs: h.findBrowserProcessesForProfile,
    })
    if (target.mode === 'attach' && target.port) {
      port = target.port
      try {
        await attachPage()
        child = null // 不是我们 spawn 的，close 时不要误杀
        if (offscreen) await moveOffscreen()
        return { ok: true, attached: true, port }
      } catch (error) {
        try { session?.close() } catch (e) {}
        session = null
        log?.debug?.('attach 已有浏览器失败，改清资料目录再开', error?.message || error)
      }
    }

    const bin = h.findBrowser(browserPath)
    if (!bin) return { ok: false, message: '找不到 Edge / Chrome。请在面板填浏览器路径，或先装好 Microsoft Edge。' }

    // 2) 必须 spawn：先温和结束占用「本」user-data-dir 的旧 Edge，避免双开抢资料目录导致调试端口起不来
    const killPids = [...new Set([...(target.killPids || []), ...h.findBrowserProcessesForProfile(profileDir).map((p) => p.pid)])]
    const killed = []
    for (const pid of killPids) {
      try { h.killPid(pid, 'SIGTERM'); killed.push(pid) } catch (error) {}
    }
    if (killed.length) await h.sleep(600)

    port = await h.freePort()
    const args = [
      `--user-data-dir=${profileDir}`,
      `--remote-debugging-port=${port}`,
      '--remote-debugging-address=127.0.0.1',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=Translate,MediaRouter',
      '--window-size=1000,800',
    ]
    // 登录用离屏窗口位置，避免抢前台；不用 headless，降低风控差异
    if (offscreen || minimize) {
      args.push('--window-position=-2400,-2400')
    }
    args.push('https://www.douyin.com/?recommend=1')
    child = h.spawn(bin, args, { stdio: 'ignore', detached: true })
    child.unref?.()
    // 等调试端口起来
    let last = null
    for (let i = 0; i < 40; i++) {
      try {
        await h.getJson(`http://127.0.0.1:${port}/json/version`)
        last = null
        break
      } catch (error) { last = error; await h.sleep(250) }
    }
    if (last) {
      return {
        ok: false,
        message: `浏览器资料目录被占用或调试端口没起来（profile=${profileDir}，port=${port}${killed.length ? `，已尝试结束旧进程 ${killed.join(',')}` : ''}）：${last.message}`,
      }
    }
    await attachPage()
    // Edge 常不落 DevToolsActivePort：自写，Harness 重启才能 attach
    try { h.ensureDevToolsActivePort(profileDir, port) } catch (error) { log?.debug?.('写 DevToolsActivePort 失败', error?.message || error) }
    if (offscreen) await moveOffscreen()
    else if (minimize) await evalJs(`try{window.moveTo(0,0);window.resizeTo(900,700)}catch(e){}`).catch(() => {})
    return { ok: true, attached: false, port, killed }
  }

  /** CDP 截登录二维码区，或取 img/canvas 的 dataURL / src。 */
  async function captureLoginQr() {
    await evalJs(`(() => {
      const nodes = [...document.querySelectorAll('div,span,button,a,p,li')];
      const tab = nodes.find((n) => {
        const t = (n.textContent || '').trim();
        return t === '扫码登录' || t === '二维码登录';
      });
      if (tab) try { tab.click(); } catch (e) {}
    })()`).catch(() => {})
    await sleep(600)
    const info = await evalJs(`(() => {
      const imgs = [...document.querySelectorAll('img')];
      for (const img of imgs) {
        const src = img.currentSrc || img.src || '';
        const meta = (img.alt || '') + ' ' + (img.className || '') + ' ' + (img.id || '') + ' ' + src;
        if (src.startsWith('data:image') && (img.naturalWidth || img.width) >= 100) {
          return { type: 'data', data: src };
        }
        if (/qrcode|qr-code|login-qr|二维码|qr\./i.test(meta) && src) {
          return src.startsWith('data:') ? { type: 'data', data: src } : { type: 'url', data: src };
        }
      }
      for (const c of document.querySelectorAll('canvas')) {
        if (c.width >= 100 && c.width <= 520 && c.height >= 100 && c.height <= 520) {
          try { return { type: 'data', data: c.toDataURL('image/png') }; } catch (e) {}
        }
      }
      for (const img of imgs) {
        const r = img.getBoundingClientRect();
        if (r.width >= 120 && r.width <= 420 && r.height >= 120 && r.height <= 420 && r.bottom > 0 && r.right > 0) {
          return { type: 'clip', x: r.x, y: r.y, w: r.width, h: r.height };
        }
      }
      return null;
    })()`).catch(() => null)

    if (info?.type === 'data' && info.data) return String(info.data)
    if (info?.type === 'url' && info.data) {
      const data = await evalJs(`fetch(${JSON.stringify(info.data)},{credentials:'include'}).then((r)=>r.blob()).then((b)=>new Promise((res,rej)=>{const fr=new FileReader();fr.onload=()=>res(fr.result);fr.onerror=rej;fr.readAsDataURL(b)})).catch(()=>'')`).catch(() => '')
      if (data) return String(data)
    }
    if (info?.type === 'clip' && info.w > 0 && info.h > 0) {
      try {
        const shot = await session.send('Page.captureScreenshot', {
          format: 'png',
          clip: { x: info.x, y: info.y, width: info.w, height: info.h, scale: 1 },
          fromSurface: true,
          captureBeyondViewport: true,
        })
        if (shot?.data) return `data:image/png;base64,${shot.data}`
      } catch (error) { /* fall through */ }
    }
    // 兜底：截视口中部一块（常见登录卡位置）
    try {
      const box = await evalJs(`(() => {
        const w = Math.min(280, window.innerWidth * 0.4);
        const h = w;
        const x = Math.max(0, (window.innerWidth - w) / 2);
        const y = Math.max(0, window.innerHeight * 0.22);
        return { x, y, w, h };
      })()`).catch(() => null)
      if (box?.w) {
        const shot = await session.send('Page.captureScreenshot', {
          format: 'png',
          clip: { x: box.x, y: box.y, width: box.w, height: box.h, scale: 1 },
          fromSurface: true,
          captureBeyondViewport: true,
        })
        if (shot?.data) return `data:image/png;base64,${shot.data}`
      }
    } catch (error) {}
    return ''
  }

  async function startLoginQr() {
    const r = await launch({ offscreen: true })
    if (!r.ok) {
      browserLogin.phase = 'error'
      browserLogin.error = r.message || '打不开浏览器'
      browserLogin.message = browserLogin.error
      browserLogin.qrDataUrl = ''
      return { ...browserLoginSnapshot(false), ok: false, started: false, loggedIn: false }
    }
    await moveOffscreen()
    const gate = await checkGate({ ignoreCaps: true }).catch((e) => ({ ok: false, needLogin: true, reason: e.message }))
    if (gate.ok) {
      clearVerify()
      const self = await selfInfo().catch(() => null)
      browserLogin.phase = 'logged_in'
      browserLogin.qrDataUrl = ''
      browserLogin.message = `已登录：${self?.nickname || self?.secUid || ''}`
      browserLogin.verifyHint = ''
      browserLogin.error = ''
      if (minimize) await minimizeWindow()
      const snap = browserLoginSnapshot(false)
      snap.loggedIn = true
      snap.nickname = self?.nickname || ''
      return snap
    }
    if (gate.verify) {
      browserLogin.phase = 'verification_required'
      browserLogin.message = '需要安全验证'
      browserLogin.verifyHint = gate.reason || '页面要验证（滑块等）。请完成后再点刷新状态。'
      browserLogin.qrDataUrl = ''
      return browserLoginSnapshot(true)
    }
    // 确保落在登录墙
    await navigate('https://www.douyin.com/').catch(() => {})
    await sleep(1200)
    const qr = await captureLoginQr()
    browserLogin.phase = 'waiting_scan'
    browserLogin.qrDataUrl = qr || ''
    browserLogin.message = qr
      ? '请用抖音 App 扫码（浏览器已离屏，二维码在本面板）'
      : '还没抓到二维码，请点刷新'
    browserLogin.verifyHint = ''
    browserLogin.error = ''
    return browserLoginSnapshot(true)
  }

  async function pollLoginQr() {
    if (!session || session.closed) {
      // 未启动时若已有会话资料，account() 路径会 launch；这里保持 idle
      if (browserLogin.phase === 'idle') {
        return { ok: true, started: false, loggedIn: false, phase: 'idle', qrDataUrl: '', message: '', verifyHint: '', error: '', nickname: '', uid: '' }
      }
      return browserLoginSnapshot(true)
    }
    const gate = await checkGate({ ignoreCaps: true }).catch((e) => ({ ok: false, needLogin: true, reason: e.message }))
    if (gate.ok) {
      clearVerify()
      const self = await selfInfo().catch(() => null)
      browserLogin.phase = 'logged_in'
      browserLogin.qrDataUrl = ''
      browserLogin.message = `已登录：${self?.nickname || self?.secUid || ''}`
      browserLogin.verifyHint = ''
      browserLogin.error = ''
      if (minimize) await minimizeWindow()
      const snap = browserLoginSnapshot(false)
      snap.loggedIn = true
      snap.nickname = self?.nickname || ''
      return snap
    }
    if (gate.verify) {
      browserLogin.phase = 'verification_required'
      browserLogin.message = '需要安全验证'
      browserLogin.verifyHint = gate.reason || '页面要验证（滑块等）。请在面板提示下完成，再点刷新状态。'
      browserLogin.qrDataUrl = ''
      return browserLoginSnapshot(true)
    }
    const qr = await captureLoginQr()
    if (qr) {
      browserLogin.qrDataUrl = qr
      browserLogin.phase = 'waiting_scan'
      browserLogin.message = '请用抖音 App 扫码'
      browserLogin.error = ''
    } else if (browserLogin.phase === 'waiting_scan' && !browserLogin.qrDataUrl) {
      browserLogin.message = '还没抓到二维码，请点刷新'
    }
    return browserLoginSnapshot(true)
  }

  async function refreshLoginQr() {
    return startLoginQr()
  }

  async function evalJs(expression) {
    if (!session || session.closed) throw new Error('浏览器没连上')
    const r = await session.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (r?.exceptionDetails) throw new Error(r.exceptionDetails.text || '页面脚本出错')
    return r?.result?.value
  }

  async function navigate(url) {
    if (!session || session.closed) throw new Error('浏览器没连上')
    await session.send('Page.navigate', { url })
    await h.sleep(1500)
  }

  async function currentUrl() {
    return String(await evalJs('location.href') || '')
  }

  async function clickRecommendTab() {
    return Boolean(await evalJs(`(() => {
      const links = [...document.querySelectorAll('a[href]')];
      const byHref = links.find((a) => {
        try {
          const u = new URL(a.href, location.origin);
          return (u.pathname === '/' || u.pathname === '') && u.searchParams.get('recommend') === '1';
        } catch (e) { return false; }
      });
      if (byHref) { byHref.click(); return true; }
      const byText = [...document.querySelectorAll('a,div,span,p,li,button')].find((el) => {
        const tx = (el.innerText || el.getAttribute('aria-label') || '').trim();
        return tx === '推荐';
      });
      if (!byText) return false;
      (byText.closest('a') || byText).click();
      return true;
    })()`).catch(() => false))
  }

  async function ensureRecommend() {
    let url = await currentUrl()
    if (isRecommendUrl(url)) return { ok: true, url }
    // 真机 /?recommend=1 常被重定向到 /jingxuan；带 from_nav=1 能留在推荐
    await navigate('https://www.douyin.com/?recommend=1&from_nav=1')
    url = await currentUrl()
    if (isRecommendUrl(url)) return { ok: true, url }
    // 仍卡精选：点侧栏「推荐」（href 含 recommend=1&from_nav=1）
    const clicked = await clickRecommendTab()
    if (clicked) await sleep(1500)
    url = await currentUrl()
    if (isRecommendUrl(url)) return { ok: true, url }
    return { ok: false, message: `打不开推荐页（可能卡在精选 / 登录）：${url}`, url }
  }

  /** 读页面可见文字，用来判定验证码 / 登录墙。 */
  async function pageText() {
    return String(await evalJs(`(document.body && (document.body.innerText||'')).slice(0,4000)`) || '')
  }

  /**
   * 闸门：以当前 pageText 为准。
   * caps.verify 只是缓存；页面已无验证文案时自动 clearVerify，避免登录轮询永久卡在 verification_required。
   * opts.ignoreCaps：登录路径可强制只看当前页（仍会同步 caps）。
   */
  async function checkGate(opts = {}) {
    const t = await pageText().catch(() => '')
    if (looksLikeVerify(t)) {
      markVerify(caps.reason || '页面要验证')
      return { ok: false, verify: true, reason: caps.reason || '页面要验证' }
    }
    // 验证墙已消失：清 sticky 标记（写操作 drv.paused 随之恢复；日级 pauseDay 仍由 duty 管）
    if (caps.verify || opts.ignoreCaps) clearVerify()
    if (/扫码登录|短信登录|密码登录|登录后免费畅享|立即登录/.test(t) && !/消息|私信|关注/.test(t)) {
      return { ok: false, needLogin: true, reason: '还没登录抖音' }
    }
    return { ok: true }
  }

  /** 从最近截获的 feed 里取还没看过的；不够就在页面上「下滑」再等一会儿。 */
  async function nextAwemes({ seen = new Set(), want = 1 } = {}) {
    // attach 后 Network 监听才挂上，旧页面 feed 为空：先回到推荐页灌一遍；仍空则 DOM 解析 aweme_id
    if (!feed.length) {
      try {
        await navigate('https://www.douyin.com/?recommend=1&from_nav=1')
        await h.sleep(3500)
        await evalJs(`document.querySelectorAll('video,audio').forEach(v=>{try{v.muted=true;v.volume=0}catch(e){}})`).catch(() => {})
      } catch (error) { /* ignore */ }
    }
    if (!feed.length) {
      try {
        const seeded = await evalJs(`(() => {
          const ids = new Set();
          const html = document.documentElement.innerHTML;
          for (const m of html.matchAll(/"aweme_id"\\s*:\\s*"(\\d{15,})"/g)) ids.add(m[1]);
          for (const m of html.matchAll(/\\/video\\/(\\d{15,})/g)) ids.add(m[1]);
          return [...ids].slice(0, 12).map(id => ({ aweme_id: id, desc: '', author: { nickname: '' }, statistics: {} }));
        })()`)
        if (Array.isArray(seeded) && seeded.length) {
          for (const raw of seeded) {
            const list = awemesFromResponse({ aweme_list: [raw] })
            for (const a of list) {
              if (!feed.some((x) => x.awemeId === a.awemeId)) feed.push(a)
            }
          }
        }
      } catch (error) { /* ignore */ }
    }
    const out = []
    for (let try_ = 0; try_ < 6 && out.length < want; try_++) {
      for (const a of feed) {
        if (seen.has(a.awemeId) || out.some((x) => x.awemeId === a.awemeId)) continue
        out.push(a)
        if (out.length >= want) break
      }
      if (out.length >= want) break
      // 模拟下滑：滚一下 + 方向键
      await evalJs(`window.scrollBy(0, Math.floor(window.innerHeight*0.85)); document.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}))`).catch(() => {})
      await h.sleep(1200 + Math.random() * 800)
    }
    return out
  }

  /** 当前正在播的 aweme_id：优先 URL，其次页面数据，再次最近 feed。 */
  async function activeAwemeId() {
    const fromUrl = await evalJs(`(() => { try { const u=new URL(location.href); return u.searchParams.get('modal_id')||(location.pathname.match(/\\/video\\/(\\d+)/)||[])[1]||'' } catch(e){ return '' } })()`).catch(() => '')
    if (fromUrl) return String(fromUrl)
    const fromDom = await evalJs(`(() => { const n=document.querySelector('[data-e2e="feed-active-video"] [data-e2e="video-unique-id"],[data-e2e="video-player"]'); const id=n && (n.getAttribute('data-video-id')||n.getAttribute('data-id')); if(id) return id; const m=(document.documentElement.innerHTML.match(/"aweme_id"\\s*:\\s*"(\\d{15,})"/)||[])[1]; return m||'' })()`).catch(() => '')
    if (fromDom) return String(fromDom)
    return feed.length ? feed[feed.length - 1].awemeId : ''
  }

  async function clickLike() {
    return Boolean(await evalJs(`(() => { const b=[...document.querySelectorAll('button,[role=button],div')].find(el => /点赞|喜欢/.test(el.getAttribute('aria-label')||'') || el.dataset?.e2e==='video-player-digg'); if(!b) return false; b.click(); return true })()`))
  }
  async function openComments() {
    return Boolean(await evalJs(`(() => { const b=[...document.querySelectorAll('button,[role=button],div')].find(el => /评论/.test(el.getAttribute('aria-label')||'') || el.dataset?.e2e==='feed-comment-icon'); if(!b) return false; b.click(); return true })()`))
  }
  async function typeAndSend(text) {
    const esc = JSON.stringify(String(text))
    return Boolean(await evalJs(`(() => { const t=${esc}; const box=document.querySelector('[contenteditable=true],textarea,input[type=text]'); if(!box) return false; box.focus(); if(box.isContentEditable){ box.textContent=t; box.dispatchEvent(new InputEvent('input',{bubbles:true})) } else { box.value=t; box.dispatchEvent(new Event('input',{bubbles:true})) } const send=[...document.querySelectorAll('button,[role=button]')].find(el => /发送|发布/.test(el.innerText||el.getAttribute('aria-label')||'')); if(send) send.click(); else box.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true})); return true })()`))
  }
  async function clickFollow() {
    return Boolean(await evalJs(`(() => { const b=[...document.querySelectorAll('button,[role=button]')].find(el => /关注/.test(el.innerText||'') && !/已关注|取消关注|互相关注/.test(el.innerText||'')); if(!b) return false; b.click(); return true })()`))
  }
  /** 消息中心：别人回我评论的列表。返回 [{id,name,text,awemeId,at}]。 */
  async function listCommentReplies() {
    await navigate('https://www.douyin.com/notice')
    await sleep(1200)
    // 尽量点到「评论」类 tab
    await evalJs(`(() => { const t=[...document.querySelectorAll('div,span,a,button')].find(el => /评论/.test((el.innerText||'').trim()) && (el.innerText||'').trim().length<=6); if(t) t.click() })()`).catch(() => {})
    await sleep(800)
    const raw = await evalJs(`(() => {
      try {
        const items = [...document.querySelectorAll('[class*=notice],[class*=message],[class*=comment],li,a')].slice(0,40);
        return items.map((el, i) => {
          const text = (el.innerText||'').slice(0,200);
          if (!/回复了你的评论|回复了你|回了你/.test(text) && !/评论/.test(text)) return null;
          const href = (el.closest('a')||el.querySelector('a')||el).href||'';
          const m = href.match(/video\/(\d{15,})/) || href.match(/modal_id=(\d{15,})/);
          const name = text.split(/\n|回复|：|:/)[0].slice(0,30);
          return { id: (m&&m[1]||'') + ':' + i + ':' + text.slice(0,40), name, text, awemeId: m&&m[1]||'', at: Date.now() };
        }).filter(Boolean).slice(0,15);
      } catch(e){ return []; }
    })()`).catch(() => [])
    return Array.isArray(raw) ? raw : []
  }
  async function resolveUser(input) {
    // input: {secUid} | {uniqueId} | {short} — 同时抠数字 uid（IM friend 查找要用）
    lastUserProfile = null
    if (input.secUid) {
      await navigate(`https://www.douyin.com/user/${input.secUid}`)
    } else if (input.short) {
      await navigate(input.short)
      await sleep(1500)
    } else if (input.uniqueId) {
      await navigate(`https://www.douyin.com/search/${encodeURIComponent(input.uniqueId)}?type=user`)
      await sleep(1500)
      await evalJs(`(() => { const a=[...document.querySelectorAll('a[href*="/user/"]')].find(x => /user\\/[A-Za-z0-9_-]{20,}/.test(x.href)); if(a) location.href=a.href })()`).catch(() => {})
      await sleep(1200)
    } else return { ok: false, message: '认不出这个抖音号 / 链接' }
    await sleep(800)
    const snap = await evalJs(`(() => {
      const href = location.href;
      let renderData = '';
      try { renderData = (document.getElementById('RENDER_DATA') || {}).textContent || ''; } catch (e) {}
      const html = (document.documentElement.innerHTML || '').slice(0, 600000);
      const name = (document.querySelector('h1,h2,[data-e2e="user-info"]') || {}).innerText || '';
      const img = (document.querySelector('img[src*="avatar"],img[class*=avatar]') || {}).src || '';
      return { href, html, renderData, nickname: name, avatar: img };
    })()`).catch(() => null)
    const scraped = extractOwnerProfile(snap || {})
    // 网络里的 profile/other 作补全（RENDER_DATA 偶发没有 uid）
    if ((!scraped.uid || !scraped.secUid) && lastUserProfile) {
      if (!scraped.secUid && lastUserProfile.secUid) scraped.secUid = lastUserProfile.secUid
      if (!scraped.uid && lastUserProfile.uid) scraped.uid = normalizeOwnerUid(lastUserProfile.uid)
      if (!scraped.nickname && lastUserProfile.nickname) scraped.nickname = lastUserProfile.nickname
      if (!scraped.avatar && lastUserProfile.avatar) scraped.avatar = lastUserProfile.avatar
    }
    scraped.uid = normalizeOwnerUid(scraped.uid)
    if (!scraped.secUid) return { ok: false, message: '打开主页后还是认不出 sec_uid，请改用主页链接' }
    return { ok: true, ...scraped }
  }

  async function selfInfo() {
    const info = await evalJs(`(() => { try { const m=document.documentElement.innerHTML.match(/"secUid"\\s*:\\s*"([A-Za-z0-9_-]{20,})"/)||document.documentElement.innerHTML.match(/"sec_uid"\\s*:\\s*"([A-Za-z0-9_-]{20,})"/); const n=document.documentElement.innerHTML.match(/"nickname"\\s*:\\s*"([^"]{1,40})"/); return { secUid: m&&m[1]||'', nickname: n&&n[1]||'' } } catch(e){ return { secUid:'', nickname:'' } } })()`).catch(() => ({ secUid: '', nickname: '' }))
    return info || { secUid: '', nickname: '' }
  }

  async function openEditProfile() {
    const self = await selfInfo()
    if (!self?.secUid) throw new Error('认不出自己的抖音主页')
    await navigate(`https://www.douyin.com/user/${self.secUid}`)
    await sleep(1200)
    const clicked = await evalJs(`(() => {
      const nodes = [...document.querySelectorAll('button,a,div,span')];
      const t = nodes.find(n => {
        const tx = (n.innerText || n.getAttribute('aria-label') || '').trim();
        return /^(编辑资料|编辑个人信息)$/.test(tx) || (n.dataset && n.dataset.e2e === 'user-info-edit');
      });
      if (!t) return false;
      t.click();
      return true;
    })()`)
    if (!clicked) throw new Error('找不到「编辑资料」入口')
    await sleep(900)
    return { ok: true, secUid: self.secUid }
  }

  async function clickSaveProfile() {
    const ok = await evalJs(`(() => {
      const b = [...document.querySelectorAll('button,[role=button],div,span')].find(el => {
        const tx = (el.innerText || el.getAttribute('aria-label') || '').trim();
        return /^(保存|完成|确定)$/.test(tx);
      });
      if (!b) return false;
      b.click();
      return true;
    })()`)
    if (!ok) throw new Error('找不到保存按钮')
    await sleep(1000)
  }

  async function readProfileFields() {
    return await evalJs(`(() => {
      const nickEl = document.querySelector('input[placeholder*="昵称"],input[name*=nick],input[name*=name]')
        || [...document.querySelectorAll('input')].find(i => /昵称/.test((i.getAttribute('aria-label')||'')+(i.placeholder||'')));
      const signEl = document.querySelector('textarea[placeholder*="签名"],textarea[name*=sign],textarea[name*=desc]')
        || [...document.querySelectorAll('textarea')].find(t => /签名|简介|介绍/.test((t.getAttribute('aria-label')||'')+(t.placeholder||'')))
        || document.querySelector('textarea');
      const nick = nickEl ? String(nickEl.value || nickEl.textContent || '').trim() : '';
      const sign = signEl ? String(signEl.value || signEl.textContent || '').trim() : '';
      return { nickname: nick, signature: sign };
    })()`).catch(() => ({ nickname: '', signature: '' })) || { nickname: '', signature: '' }
  }

  /** 改昵称：打开编辑资料 → 填昵称 → 保存 → 读回核对。 */
  async function editNickname(text) {
    const want = String(text || '').trim()
    if (!want) throw new Error('昵称不能是空的')
    await openEditProfile()
    const esc = JSON.stringify(want)
    const filled = await evalJs(`(() => {
      const t = ${esc};
      const el = document.querySelector('input[placeholder*="昵称"],input[name*=nick],input[name*=name]')
        || [...document.querySelectorAll('input')].find(i => /昵称/.test((i.getAttribute('aria-label')||'')+(i.placeholder||'')))
        || document.querySelector('input[type=text],input:not([type])');
      if (!el) return false;
      el.focus();
      el.value = t;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`)
    if (!filled) throw new Error('找不到昵称输入框')
    await clickSaveProfile()
    await openEditProfile().catch(() => {})
    const back = await readProfileFields()
    if (back.nickname && back.nickname !== want) throw new Error(`保存后昵称对不上：想改成「${want}」，读到「${back.nickname}」`)
    return { ok: true, nickname: want }
  }

  /** 改签名：打开编辑资料 → 填签名 → 保存 → 读回核对。 */
  async function editSignature(text) {
    const want = String(text || '').trim()
    if (!want) throw new Error('签名不能是空的')
    await openEditProfile()
    const esc = JSON.stringify(want)
    const filled = await evalJs(`(() => {
      const t = ${esc};
      const el = document.querySelector('textarea[placeholder*="签名"],textarea[name*=sign],textarea[name*=desc]')
        || [...document.querySelectorAll('textarea')].find(x => /签名|简介|介绍/.test((x.getAttribute('aria-label')||'')+(x.placeholder||'')))
        || document.querySelector('textarea,[contenteditable=true]');
      if (!el) return false;
      el.focus();
      if (el.isContentEditable) {
        el.textContent = t;
        el.dispatchEvent(new InputEvent('input', { bubbles: true }));
      } else {
        el.value = t;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
      return true;
    })()`)
    if (!filled) throw new Error('找不到签名输入框')
    await clickSaveProfile()
    await openEditProfile().catch(() => {})
    const back = await readProfileFields()
    if (back.signature && back.signature !== want) throw new Error(`保存后签名对不上：想改成「${want}」，读到「${back.signature}」`)
    return { ok: true, signature: want }
  }

  /** 换头像：打开编辑资料 → 点头像上传 → 设本地文件 → 保存。filePath 必须是本机可读图片。 */
  async function editAvatar(filePath) {
    const path = String(filePath || '').trim()
    if (!path) throw new Error('没有头像文件')
    await openEditProfile()
    // 尽量点到头像 / 更换头像
    await evalJs(`(() => {
      const b = [...document.querySelectorAll('button,a,div,span,img')].find(el => {
        const tx = (el.innerText || el.getAttribute('aria-label') || '').trim();
        return /更换头像|修改头像|上传头像|头像/.test(tx) && tx.length < 20;
      });
      if (b) b.click();
    })()`).catch(() => {})
    await sleep(600)
    const inputInfo = await evalJs(`(() => {
      const inp = document.querySelector('input[type=file][accept*="image"],input[type=file]');
      if (!inp) return null;
      if (!inp.id) inp.id = 'aurabot-dy-avatar-input';
      return { id: inp.id };
    })()`).catch(() => null)
    if (!inputInfo?.id) throw new Error('找不到头像上传控件')
    // CDP Dom.setFileInputFiles
    if (!session || session.closed) throw new Error('浏览器没连上')
    await session.send('DOM.enable').catch(() => {})
    const doc = await session.send('DOM.getDocument', { depth: 1 })
    const node = await session.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: `#${inputInfo.id}, input[type=file]` })
    if (!node?.nodeId) throw new Error('CDP 找不到 file input')
    await session.send('DOM.setFileInputFiles', { nodeId: node.nodeId, files: [path] })
    await sleep(1200)
    await clickSaveProfile()
    return { ok: true, path }
  }

  async function close() {
    try { offNet?.() } catch (error) {}
    try { session?.close() } catch (error) {}
    session = null
    if (child?.pid) try { process.kill(child.pid) } catch (error) {}
    child = null
  }

  return {
    launch, close, navigate, currentUrl, ensureRecommend, checkGate, nextAwemes, activeAwemeId,
    clickLike, openComments, typeAndSend, clickFollow, listCommentReplies,
    resolveUser, selfInfo, pageText, evalJs,
    editNickname, editSignature, editAvatar,
    startLoginQr, pollLoginQr, refreshLoginQr, captureLoginQr, moveOffscreen, minimizeWindow,
    /** 测 / 面板用：最近截到的视频 */
    recentFeed: () => feed.slice(),
    get paused() { return caps.verify },
    get pauseReason() { return caps.reason },
    markVerify,
    clearVerify,
  }
}

/** 测用假驱动：不启浏览器，按脚本吐视频 / 模拟点击。 */
export function createFakeDriver(script = {}) {
  const FAKE_BROWSER_QR = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
  const state = {
    url: 'https://www.douyin.com/?recommend=1',
    feed: script.feed || [],
    cursor: 0,
    verify: false,
    reason: '',
    needLogin: !!script.needLogin,
    liked: [], commented: [], followed: [], dmReplies: [],
    self: script.self || { secUid: 'self_sec', nickname: '肥鱼抖音' },
    signature: script.signature || '',
    avatarPath: '',
    owner: script.owner || { secUid: 'owner_sec', uid: 'owner_uid', nickname: '主人', avatar: 'https://x/a~tplv.jpg' },
    commentReplies: script.commentReplies || [],
    log: [],
    loginQr: {
      phase: script.needLogin ? 'idle' : 'logged_in',
      qrDataUrl: '',
      message: script.needLogin ? '' : ('已登录：' + (script.self?.nickname || '肥鱼抖音')),
      verifyHint: '',
      error: '',
    },
  }
  const clearVerify = () => { state.verify = false; state.reason = ''; state.pageText = null }
  const readPageText = () => {
    if (state.pageText != null) return String(state.pageText)
    return state.verify ? '请完成安全验证' : (state.needLogin ? '扫码登录' : '推荐 关注 消息')
  }
  const gate = async (opts = {}) => {
    // 与真驱动一致：以当前 pageText 为准；验证文案消失则清 sticky
    const t = readPageText()
    if (looksLikeVerify(t)) {
      if (!state.verify) { state.verify = true; state.reason = state.reason || '要验证' }
      return { ok: false, verify: true, reason: state.reason || '要验证' }
    }
    if (state.verify || opts.ignoreCaps) clearVerify()
    if (state.needLogin) return { ok: false, needLogin: true, reason: '还没登录抖音' }
    return { ok: true }
  }
  return {
    launch: async () => ({ ok: true }),
    close: async () => {},
    navigate: async (url) => {
      state.log.push(['nav', url])
      const s = String(url || '')
      const wantsRec = /[?&]recommend=1\b/.test(s)
      const hasFromNav = /[?&]from_nav=1\b/.test(s)
      // 真机：裸 recommend=1 常跳 /jingxuan；带 from_nav=1 通常可留在推荐
      if (script.stuckOnFeatured && wantsRec) {
        state.url = 'https://www.douyin.com/jingxuan'
        return
      }
      if (script.redirectRecommendToJingxuan && wantsRec) {
        if (!hasFromNav || script.fromNavStaysJingxuan) {
          state.url = 'https://www.douyin.com/jingxuan'
          return
        }
      }
      state.url = s
    },
    currentUrl: async () => state.url,
    ensureRecommend: async () => {
      // stuckOnFeatured：模拟 from_nav + 点推荐都失败
      if (script.stuckOnFeatured) {
        state.url = 'https://www.douyin.com/jingxuan'
        state.log.push(['nav', 'https://www.douyin.com/?recommend=1&from_nav=1'])
        state.log.push(['clickRecommendTab'])
        return { ok: false, message: `打不开推荐页（可能卡在精选 / 登录）：${state.url}`, url: state.url }
      }
      let url = state.url
      if (isRecommendUrl(url)) return { ok: true, url }
      // 与真驱动同序：先 from_nav，再点侧栏「推荐」
      const target = 'https://www.douyin.com/?recommend=1&from_nav=1'
      state.log.push(['nav', target])
      if (script.redirectRecommendToJingxuan && script.fromNavStaysJingxuan) {
        state.url = 'https://www.douyin.com/jingxuan'
      } else {
        state.url = target
      }
      url = state.url
      if (isRecommendUrl(url)) return { ok: true, url }
      state.log.push(['clickRecommendTab'])
      state.url = 'https://www.douyin.com/?recommend=1&from_nav=1'
      url = state.url
      if (isRecommendUrl(url)) return { ok: true, url }
      return { ok: false, message: `打不开推荐页（可能卡在精选 / 登录）：${url}`, url }
    },
    checkGate: gate,
    nextAwemes: async ({ seen = new Set(), want = 1 } = {}) => {
      const out = []
      while (out.length < want && state.cursor < state.feed.length) {
        const a = state.feed[state.cursor++]
        if (!seen.has(a.awemeId)) out.push(a)
      }
      return out
    },
    activeAwemeId: async () => {
      if (script.activeId) return script.activeId
      const last = state.feed[Math.max(0, state.cursor - 1)]
      return last?.awemeId || ''
    },
    clickLike: async () => { state.liked.push(await (async () => state.feed[Math.max(0, state.cursor - 1)]?.awemeId)()); return true },
    openComments: async () => true,
    typeAndSend: async (text) => { state.commented.push(text); return true },
    clickFollow: async () => { state.followed.push(state.feed[Math.max(0, state.cursor - 1)]?.authorSecUid); return true },
    listCommentReplies: async () => (state.commentReplies || []).slice(),
    resolveUser: async (input) => {
      if (script.resolveFail) return { ok: false, message: '认不出' }
      if (script.resolveNoUid) {
        return {
          ok: true,
          secUid: state.owner.secUid,
          uid: '',
          nickname: state.owner.nickname,
          avatar: state.owner.avatar,
        }
      }
      if (input.secUid === state.owner.secUid || input.uniqueId || input.short || input.secUid) {
        return {
          ok: true,
          secUid: state.owner.secUid,
          uid: normalizeOwnerUid(state.owner.uid) || String(state.owner.uid || ''),
          nickname: state.owner.nickname,
          avatar: state.owner.avatar,
        }
      }
      return { ok: false, message: '认不出这个抖音号 / 链接' }
    },
    selfInfo: async () => state.self,
    pageText: async () => readPageText(),
    evalJs: async () => null,
    recentFeed: () => state.feed.slice(),
    get paused() { return state.verify },
    get pauseReason() { return state.reason },
    markVerify: (why) => { state.verify = true; state.reason = why || '要验证' },
    clearVerify,
    editNickname: async (text) => {
      await gate()
      if (script.profileFail) throw new Error(script.profileFailMessage || '改昵称失败')
      if (state.verify) throw new Error(state.reason || '要验证')
      const want = String(text || '').trim()
      state.self = { ...state.self, nickname: want }
      state.log.push(['editNickname', want])
      return { ok: true, nickname: want }
    },
    editSignature: async (text) => {
      await gate()
      if (script.profileFail) throw new Error(script.profileFailMessage || '改签名失败')
      if (state.verify) throw new Error(state.reason || '要验证')
      const want = String(text || '').trim()
      state.signature = want
      state.log.push(['editSignature', want])
      return { ok: true, signature: want }
    },
    editAvatar: async (filePath) => {
      await gate()
      if (script.profileFail) throw new Error(script.profileFailMessage || '换头像失败')
      if (state.verify) throw new Error(state.reason || '要验证')
      const path = String(filePath || '').trim()
      if (!path) throw new Error('没有头像文件')
      state.avatarPath = path
      state.log.push(['editAvatar', path])
      return { ok: true, path }
    },
    async startLoginQr() {
      state.log.push(['startLoginQr'])
      const g = await gate({ ignoreCaps: true })
      if (g.ok && !script.forceLoginQr) {
        clearVerify()
        state.needLogin = false
        state.loginQr = {
          phase: 'logged_in',
          qrDataUrl: '',
          message: `已登录：${state.self.nickname || state.self.secUid || ''}`,
          verifyHint: '',
          error: '',
        }
        return {
          ok: true, started: false, loggedIn: true, phase: 'logged_in',
          qrDataUrl: '', message: state.loginQr.message, verifyHint: '', error: '',
          nickname: state.self.nickname || '', uid: '',
        }
      }
      if (g.verify) {
        state.loginQr = {
          phase: 'verification_required',
          qrDataUrl: '',
          message: '需要安全验证',
          verifyHint: g.reason || '页面要验证（滑块等）。请完成后再点刷新状态。',
          error: '',
        }
        return {
          ok: true, started: true, loggedIn: false, phase: 'verification_required',
          qrDataUrl: '', message: state.loginQr.message,
          verifyHint: state.loginQr.verifyHint, error: '', nickname: '', uid: '',
        }
      }
      if (!state.needLogin && !script.forceLoginQr) {
        // fallthrough safety
        state.needLogin = true
      }
      state.loginQr = {
        phase: 'waiting_scan',
        qrDataUrl: script.qrDataUrl || FAKE_BROWSER_QR,
        message: '请用抖音 App 扫码（浏览器已离屏，二维码在本面板）',
        verifyHint: '',
        error: '',
      }
      return {
        ok: true, started: true, loggedIn: false, phase: 'waiting_scan',
        qrDataUrl: state.loginQr.qrDataUrl, message: state.loginQr.message,
        verifyHint: '', error: '', nickname: '', uid: '',
      }
    },
    async pollLoginQr() {
      const g = await gate({ ignoreCaps: true })
      if (g.ok) {
        state.needLogin = false
        clearVerify()
        state.loginQr = {
          phase: 'logged_in',
          qrDataUrl: '',
          message: `已登录：${state.self.nickname || ''}`,
          verifyHint: '',
          error: '',
        }
        return {
          ok: true, started: false, loggedIn: true, phase: 'logged_in',
          qrDataUrl: '', message: state.loginQr.message, verifyHint: '', error: '',
          nickname: state.self.nickname || '', uid: '',
        }
      }
      if (g.verify) {
        state.loginQr.phase = 'verification_required'
        state.loginQr.message = '需要安全验证'
        state.loginQr.verifyHint = g.reason || state.reason || '页面要验证（滑块等）。请完成后再点刷新状态。'
        state.loginQr.qrDataUrl = ''
        return {
          ok: true, started: true, loggedIn: false, phase: 'verification_required',
          qrDataUrl: '', message: state.loginQr.message,
          verifyHint: state.loginQr.verifyHint, error: '', nickname: '', uid: '',
        }
      }
      // needLogin：保持 / 回到等待扫码
      if (state.loginQr.phase === 'idle' || state.loginQr.phase === 'logged_in' || state.loginQr.phase === 'verification_required') {
        state.loginQr.phase = 'waiting_scan'
        state.loginQr.qrDataUrl = state.loginQr.qrDataUrl || script.qrDataUrl || FAKE_BROWSER_QR
        state.loginQr.message = '请用抖音 App 扫码'
        state.loginQr.verifyHint = ''
      }
      return {
        ok: state.loginQr.phase !== 'error',
        started: state.loginQr.phase !== 'idle' && state.loginQr.phase !== 'logged_in',
        loggedIn: false,
        phase: state.loginQr.phase,
        qrDataUrl: state.loginQr.qrDataUrl || '',
        message: state.loginQr.message || '',
        verifyHint: state.loginQr.verifyHint || '',
        error: state.loginQr.error || '',
        nickname: '', uid: '',
      }
    },
    async refreshLoginQr() {
      return this.startLoginQr()
    },
    _advanceBrowserLogin(phase, extra = {}) {
      const p = String(phase || '')
      if (p === 'logged_in' || p === 'loggedIn') {
        state.needLogin = false
        state.verify = false
        state.loginQr = {
          phase: 'logged_in',
          qrDataUrl: '',
          message: `已登录：${state.self.nickname || ''}`,
          verifyHint: '',
          error: '',
        }
      } else if (p === 'expired') {
        state.loginQr.phase = 'expired'
        state.loginQr.qrDataUrl = ''
        state.loginQr.message = '二维码已过期，请点刷新'
      } else if (p === 'verification_required') {
        state.verify = true
        state.reason = extra.reason || '页面要验证'
        state.loginQr.phase = 'verification_required'
        state.loginQr.qrDataUrl = ''
        state.loginQr.message = '需要安全验证'
        state.loginQr.verifyHint = extra.verifyHint || state.reason
      } else if (p === 'waiting_scan') {
        state.needLogin = true
        state.loginQr.phase = 'waiting_scan'
        state.loginQr.qrDataUrl = script.qrDataUrl || FAKE_BROWSER_QR
        state.loginQr.message = '请用抖音 App 扫码'
      } else {
        state.loginQr.phase = p || 'idle'
      }
      return this.pollLoginQr()
    },
    /** 测用：看副作用 */
    _state: state,
  }
}
