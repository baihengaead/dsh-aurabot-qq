// 看画面：从 B 站 DASH 流里按时间点抽几帧，交给视觉模型描述画面。
//
// 只依赖 ffmpeg —— 直接对着 CDN 地址做 HTTP range 抽帧，不下载整段视频（一帧 1~3 秒，几十 KB）。
// 任何一环不满足（没开开关 / 没 ffmpeg / 没 cid / 流地址取不到 / 模型不支持图片）都返回 ''，
// 不影响原来「标题 + 简介 + 字幕 + 热评」的文本流程。

import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { UA } from './api.js'
import { askModel } from '../core/llm.js'
import { findFfmpeg } from '../core/img.js'

// ffmpeg 的查找已经抽到 core/img.js（生图那边也要用），这里保留导出，老的引用不受影响
export { findFfmpeg }

/** 抽帧时间点（秒）：跳过开头结尾各 5%，中间均匀铺开。 */
export function frameTimes(durationSec, count) {
  const d = Number(durationSec) || 0
  if (!(d > 0)) return []
  const n = Math.max(1, Math.min(12, Math.round(Number(count) || 6)))
  const out = []
  for (let i = 0; i < n; i++) {
    const p = n === 1 ? 0.5 : 0.05 + (0.9 * i) / (n - 1)
    out.push(Math.min(Math.max(0, Math.round(d * p)), Math.max(0, Math.floor(d) - 1)))
  }
  return [...new Set(out)]
}

/** 挑一路流来抽帧：优先 H.264（兼容性最好）、短边不低于 480、带宽最低的那路。 */
export function pickVideoStream(list = []) {
  const ok = (list || []).filter((v) => v && v.baseUrl)
  if (!ok.length) return null
  const avc = ok.filter((v) => /^avc/i.test(String(v.codecs || '')))
  const pool = avc.length ? avc : ok
  const decent = pool.filter((v) => Math.min(Number(v.width) || 0, Number(v.height) || 0) >= 480)
  return (decent.length ? decent : pool).slice().sort((a, b) => (a.bandwidth || 0) - (b.bandwidth || 0))[0] || null
}

/** 从流里抽一帧（JPEG）。失败返回 null，不抛。 */
export function grabFrame(ffmpeg, url, at, { width = 512, timeoutMs = 45000 } = {}) {
  return new Promise((resolve) => {
    let settled = false
    const finish = (v) => { if (!settled) { settled = true; resolve(v) } }
    let proc
    try {
      proc = spawn(ffmpeg, [
        '-hide_banner', '-loglevel', 'error', '-nostdin',
        // B 站 CDN 要 Referer，否则 403
        '-headers', `Referer: https://www.bilibili.com/\r\nUser-Agent: ${UA}\r\n`,
        '-ss', String(at), '-i', url,
        '-frames:v', '1', '-an', '-vf', `scale=${width}:-2`,
        '-q:v', '3', '-f', 'image2', '-c:v', 'mjpeg', 'pipe:1',
      ], { windowsHide: true })
    } catch (error) {
      return finish(null)
    }
    const out = []
    const timer = setTimeout(() => { try { proc.kill() } catch (error) {} finish(null) }, timeoutMs)
    proc.stdout.on('data', (d) => out.push(d))
    proc.stderr.on('data', () => {}) // 只用来占位，别让管道堵住
    proc.on('error', () => { clearTimeout(timer); finish(null) })
    proc.on('close', () => {
      clearTimeout(timer)
      const buf = Buffer.concat(out)
      finish(buf.length > 500 && buf[0] === 0xff && buf[1] === 0xd8 ? buf : null)
    })
  })
}

const SYSTEM = '你在看一个视频的若干张截图。只写画面上确实能看到的东西：场景、人物、物体、动作、画面里的文字 / 字幕条 / 贴纸。不要猜剧情，不要编造没出现的内容，不要发表感想。用 3~6 句中文写。'

/** 把几帧交给视觉模型，换一段画面描述。 */
export async function describeFrames(dsh, { info, frames, cfg }) {
  const images = frames.map((f) => ({ data: f.toString('base64'), mediaType: 'image/jpeg' }))
  const text = await askModel(dsh, {
    cfg,
    system: SYSTEM,
    text: `这些截图来自视频《${info.title}》（UP主 ${info.author || '?'}，时长 ${Math.round(Number(info.duration) || 0)} 秒），按时间先后排列，大致分布在全片 5%~95% 的位置。\n把它们当成「我看到了什么」如实记下来。`,
    images,
    maxTokens: 700,
    temperature: 0.3,
  })
  return String(text || '').trim()
}

/** 面板用：开关 + ffmpeg 找到了没。 */
export function visionState(biliCfg) {
  const ffmpeg = findFfmpeg(biliCfg && biliCfg.ffmpegPath)
  return { enabled: Boolean(biliCfg && biliCfg.vision), ffmpeg, ready: Boolean(biliCfg && biliCfg.vision && ffmpeg) }
}

/**
 * 看画面主流程：取流 → 抽帧 → 视觉描述。
 * 返回 { text, frames }：text 是画面描述（不可用时为空串），frames 是 [{sec, buf}] 抽到的帧
 * （调用方可以存下来当截图用；关掉看画面时两个都为空）。
 */
export async function lookWithVision({ dsh, api, info, getConfig, log, maxFrames = 8 }) {
  const empty = { text: '', frames: [] }
  const full = getConfig()
  const c = (full && full.bili) || {}
  if (!c.vision || !dsh || !api || typeof api.playurl !== 'function') return empty
  if (!info || !info.cid) return empty
  const ffmpeg = findFfmpeg(c.ffmpegPath)
  if (!ffmpeg) {
    log?.debug('看画面跳过：没找到 ffmpeg')
    return empty
  }
  const pu = await api.playurl({ bvid: info.bvid, aid: info.aid, cid: info.cid })
  const stream = pickVideoStream(pu && pu.video)
  if (!stream) {
    log?.debug('看画面跳过：拿不到可抽帧的流地址')
    return empty
  }
  const times = frameTimes(info.duration, c.visionFrames).slice(0, maxFrames)
  const frames = []
  for (const t of times) {
    const buf = await grabFrame(ffmpeg, stream.baseUrl, t)
    if (buf) frames.push({ sec: t, buf })
  }
  if (!frames.length) {
    log?.debug('看画面跳过：一帧都没抽出来')
    return empty
  }
  const text = await describeFrames(dsh, { info, frames: frames.map((f) => f.buf), cfg: full })
  return { text, frames }
}
