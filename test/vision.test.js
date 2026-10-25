// 抽帧 + 视觉（B 站「看画面」）的纯逻辑测试。不联网、不调 ffmpeg。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { frameTimes, pickVideoStream, findFfmpeg, visionState } from '../src/bili/vision.js'
import { digestOf } from '../src/bili/duty.js'

test('frameTimes：跳过首尾 5%，均匀铺开，不重复', () => {
  const t = frameTimes(600, 6)
  assert.equal(t.length, 6)
  assert.deepEqual(t, [...t].sort((a, b) => a - b), '按时间升序')
  assert.equal(t[0], 30, '第一帧在 5%')
  assert.equal(t.at(-1), 570, '最后一帧在 95%')
  assert.equal(new Set(t).size, t.length, '没有重复')
})

test('frameTimes：片长为 0 时不给点；至少给一帧', () => {
  assert.deepEqual(frameTimes(0, 6), [])
  assert.deepEqual(frameTimes(-5, 6), [])
  assert.equal(frameTimes(1, 6).length, 1, '1 秒的片子聚成一个点后去重')
  assert.equal(frameTimes(2, 1).length, 1, '只要一帧就取中间')
})

test('frameTimes：帧数被夹在 1~12', () => {
  assert.equal(frameTimes(3600, 100).length, 12)
  assert.equal(frameTimes(3600, 0).length, 6, '给 0 用默认 6 帧')
})

test('pickVideoStream：优先 H.264、不低于 480、取带宽最低的那路', () => {
  const list = [
    { width: 1920, height: 1080, codecs: 'avc1.640028', bandwidth: 3_000_000, baseUrl: 'a' },
    { width: 852, height: 480, codecs: 'avc1.640033', bandwidth: 800_000, baseUrl: 'b' },
    { width: 640, height: 360, codecs: 'avc1.640033', bandwidth: 400_000, baseUrl: 'c' },
    { width: 1280, height: 720, codecs: 'hvc1.1.6.L120.90', bandwidth: 500_000, baseUrl: 'd' },
  ]
  assert.equal(pickVideoStream(list).baseUrl, 'b', '720p 的 HEVC 带宽更低但优先 H.264 + ≥480')
  assert.equal(pickVideoStream([{ width: 1920, codecs: 'hvc1', bandwidth: 9, baseUrl: 'only' }]).baseUrl, 'only', '没有 H.264 就退回任意一路')
  assert.equal(pickVideoStream([]), null)
  assert.equal(pickVideoStream([{ width: 640 }]), null, '没有 baseUrl 的跳过')
})

test('findFfmpeg：配置的路径优先，都找不到返回空串', () => {
  assert.equal(findFfmpeg('', { pathEnv: '', exists: () => false }), '')
  const fake = join('C:\\tools', 'ffmpeg.exe')
  assert.equal(findFfmpeg(fake, { exists: (p) => p === fake }), fake, '配置里填的直接用')
  const exe = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
  const dir = join('D:\\bin')
  const inPath = join(dir, exe)
  assert.equal(findFfmpeg('', { pathEnv: dir, exists: (p) => p === inPath }), inPath, '从 PATH 里找')
})

test('visionState：开关和 ffmpeg 都就绪才算 ready', () => {
  assert.equal(visionState({}).enabled, false, '默认没开')
  assert.equal(visionState({ vision: false, ffmpegPath: '' }).ready, false, '开关关着就不 ready')
  const st = visionState({ vision: true, ffmpegPath: '' })
  assert.equal(st.enabled, true)
  assert.equal(st.ready, Boolean(st.ffmpeg), 'ready 只取决于本机有没有 ffmpeg')
  assert.equal(visionState({ vision: true, ffmpegPath: 'C:\\definitely\\not\\here\\ffmpeg.exe' }).ready, Boolean(st.ffmpeg), '填了不存在的路径就当没填')
})

test('digestOf：开了画面就写进 digest，没字幕时不再说"只能看标题"', () => {
  const v = { title: '一碗米饭', author: '小井', play: 699462, bvid: 'BV1QWbw6iEXE' }

  const noVision = digestOf(v, {})
  assert.match(noVision, /没有字幕，只能看标题、简介和评论/)

  const withVision = digestOf(v, { vision: '画面里是两只手举着炸好的鸡翅。' })
  assert.match(withVision, /画面（抽帧）：画面里是两只手举着炸好的鸡翅。/)
  assert.match(withVision, /没有字幕，只看了画面/, '有画面就别再说只能看标题')
  assert.ok(!withVision.includes('只能看标题、简介和评论'))

  const both = digestOf(v, { subtitle: '第一种烤肠芝士饭团', vision: '一口锅里在煮米饭。' })
  assert.match(both, /字幕（节选）：第一种烤肠芝士饭团/)
  assert.match(both, /画面（抽帧）：一口锅里在煮米饭。/)
  assert.ok(both.indexOf('字幕（节选）') < both.indexOf('画面（抽帧）'), '字幕在前、画面在后')
})

test('digestOf：画面描述过长时截断，别把上下文撑爆', () => {
  const v = { title: 'T', author: 'A', bvid: 'BV1' }
  const long = '啊'.repeat(2000)
  const d = digestOf(v, { vision: long })
  assert.ok(d.includes('画面（抽帧）：'), '有画面这一行')
  assert.ok(d.length < 1200, '总长度被压住了，实际 ' + d.length)
})
