// 图片小工具：找 ffmpeg、把图缩小（生图的结果要回传给模型时用，太大的图不能直接塞进上下文）。

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const EXE = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'

/** ffmpeg 在哪：配置里填的 > PATH 里的 > 几个常见安装位置。找不到返回 ''。 */
export function findFfmpeg(configured = '', { pathEnv = process.env.PATH || '', exists = existsSync } = {}) {
  const sep = process.platform === 'win32' ? ';' : ':'
  const cands = []
  const own = String(configured || '').trim()
  if (own) cands.push(own)
  for (const d of String(pathEnv).split(sep)) if (d && d.trim()) cands.push(join(d.trim(), EXE))
  if (process.platform === 'win32') cands.push('C:\\ffmpeg\\bin\\ffmpeg.exe', 'C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe')
  else cands.push('/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/opt/homebrew/bin/ffmpeg')
  for (const c of cands) { try { if (exists(c)) return c } catch (error) {} }
  return ''
}

/**
 * 把图缩到 maxSide 以内，输出 JPEG（走 stdin/stdout，不落临时文件）。
 * 失败 / 没 ffmpeg 返回 null，不抛。
 */
export function shrinkImage(buf, maxSide, ffmpeg, { timeoutMs = 30000 } = {}) {
  if (!ffmpeg) return Promise.resolve(null)
  return new Promise((resolve) => {
    let settled = false
    const finish = (v) => { if (!settled) { settled = true; resolve(v) } }
    let proc
    try {
      proc = spawn(ffmpeg, [
        '-hide_banner', '-loglevel', 'error', '-nostdin',
        '-i', 'pipe:0',
        '-vf', `scale='min(${maxSide},iw)':-2`,
        '-q:v', '4', '-f', 'image2', '-c:v', 'mjpeg', 'pipe:1',
      ], { windowsHide: true })
    } catch (error) {
      return finish(null)
    }
    const out = []
    const timer = setTimeout(() => { try { proc.kill() } catch (error) {} ; finish(null) }, timeoutMs)
    proc.stdout.on('data', (d) => out.push(d))
    proc.stderr.on('data', () => {}) // 占位，别让管道堵住
    proc.on('error', () => { clearTimeout(timer); finish(null) })
    proc.on('close', () => { clearTimeout(timer); const b = Buffer.concat(out); finish(b.length ? b : null) })
    try { proc.stdin.end(buf) } catch (error) { finish(null) }
  })
}
