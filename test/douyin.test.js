// 抖音：认号 / 主页链接、推荐页判定、假驱动刷一轮、日上限、试运行不计次、写操作总闸、主人私信（只认 sec_uid）、#4 相关回归。
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let util, duty, cdp, imMod, normalize, profilePermDefault, DOUYIN_PERM_KEYS, permOf

before(async () => {
  process.env.AURABOT_DATA_DIR = mkdtempSync(join(tmpdir(), 'aurabot-douyin-'))
  util = await import('../src/douyin/util.js')
  duty = await import('../src/douyin/duty.js')
  cdp = await import('../src/douyin/cdp.js')
  imMod = await import('../src/douyin/im.js')
  ;({ normalize } = await import('../src/core/config.js'))
  ;({ profilePermDefault, DOUYIN_PERM_KEYS, permOf } = await import('../src/chat/access.js'))
})

test('工具：认抖音号 / 主页链接 / 短链 / 视频链接', () => {
  assert.deepEqual(util.parseUserInput('https://www.douyin.com/user/MS4wLjABAAAAabcdefghijklmnopqrs'), { secUid: 'MS4wLjABAAAAabcdefghijklmnopqrs' })
  assert.deepEqual(util.parseUserInput('https://v.douyin.com/AbCdEf/'), { short: 'https://v.douyin.com/AbCdEf/' })
  assert.deepEqual(util.parseUserInput('@my.douyin_01'), { uniqueId: 'my.douyin_01' })
  assert.equal(util.parseUserInput(''), null)
  assert.deepEqual(util.findAwemeId('看这个 https://www.douyin.com/video/7123456789012345678'), { awemeId: '7123456789012345678' })
  assert.deepEqual(util.findAwemeId('https://v.douyin.com/xyz123/'), { short: 'https://v.douyin.com/xyz123/' })
  assert.ok(util.isRecommendUrl('https://www.douyin.com/?recommend=1'))
  assert.ok(util.isRecommendUrl('https://www.douyin.com/?recommend=1&from_nav=1'))
  assert.equal(util.isRecommendUrl('https://www.douyin.com/jingxuan'), false)
  assert.equal(util.isRecommendUrl('https://www.douyin.com/?tab=home'), false)
  assert.ok(util.sameAvatar('https://cdn/x/abc~tplv-xxx.jpeg', 'https://other/abc~c5_300x300.jpeg'))
  assert.equal(util.sameAvatar('https://cdn/a.jpg', 'https://cdn/b.jpg'), false)
  assert.ok(util.looksLikeVerify('请完成安全验证'))
  assert.ok(util.looksLimited('操作过于频繁，请稍后再试'))
})

test('配置：抖音总开关默认关；权限默认仅主人；写闸默认；改资料日上限；面板改不了 secUid', () => {
  const c = normalize({})
  assert.equal(c.douyin.enabled, false)
  assert.equal(c.douyin.caps.like, 30)
  assert.equal(c.douyin.caps.comment, 3)
  assert.equal(c.douyin.caps.sign, 2)
  assert.equal(c.douyin.caps.nickname, 2)
  assert.equal(c.douyin.caps.avatar, 1)
  assert.equal(c.douyin.perRun, 5)
  assert.equal(c.douyin.gate.maxWritesPerDay, 60)
  assert.equal(c.douyin.gate.minWriteGapSec, 20)
  assert.equal(c.douyin.gate.newAccountDays, 3)
  assert.equal(c.douyin.socialInterruptBrowse, true)
  for (const k of DOUYIN_PERM_KEYS) {
    assert.equal(profilePermDefault(k), 'owner')
    assert.equal(c.profilePerms[k], 'owner')
    assert.equal(permOf(c, k), 'owner')
  }
})

test('配置：mergeFromPanel 保留核对过的 secUid / uid', async () => {
  const { mergeFromPanel } = await import('../src/core/config.js')
  const cur = normalize({ douyin: { owner: { input: 'aaa', secUid: 'SEC1', uid: 'U1', nickname: '主人', avatar: 'http://a', confirmedInput: 'aaa' } } })
  const next = mergeFromPanel(cur, { douyin: { owner: { input: 'bbb', secUid: 'HACK', uid: 'HACKU', nickname: '假的', avatar: 'x', confirmedInput: 'HACK' } } })
  assert.equal(next.douyin.owner.input, 'bbb')
  assert.equal(next.douyin.owner.secUid, 'SEC1')
  assert.equal(next.douyin.owner.uid, 'U1')
  assert.equal(next.douyin.owner.nickname, '主人')
  assert.equal(next.douyin.owner.confirmedInput, 'aaa')
  assert.equal(util.ownerConfirmed(next), false)
})

test('配置：normalize 保留数字 uid', () => {
  const c = normalize({ douyin: { owner: { input: 'x', secUid: 'SEC', uid: '123456789', nickname: '主', avatar: '', confirmedInput: 'x' } } })
  assert.equal(c.douyin.owner.uid, '123456789')
  assert.equal(c.douyin.owner.secUid, 'SEC')
})

test('核对主人：resolveUser 带回的 uid 与 secUid 都写入 owner', async () => {
  let persisted = null
  const owner = { secUid: 'MS4wLjABAAAAabcdefghijklmnopqrs', uid: '9876543210', nickname: '核对昵称', avatar: 'https://x/o.jpg' }
  const drv = cdp.createFakeDriver({ owner })
  const im = imMod.createFakeImClient({ owner: { uid: owner.uid, secUid: owner.secUid } })
  const base = normalize({
    enabled: true, dryRun: false, ownerQQ: '10000001', ownerName: '主人',
    douyin: {
      enabled: true,
      owner: { input: 'owner_id', secUid: '', uid: '', nickname: '', avatar: '', confirmedInput: '' },
      caps: { like: 30, comment: 1, replyComment: 6, follow: 5, dm: 5, shareOwner: 3, dmReply: 20 },
      gate: { maxWritesPerDay: 60, minWriteGapSec: 0, newAccountDays: 3 },
    },
    profilePerms: Object.fromEntries(DOUYIN_PERM_KEYS.map((k) => [k, 'owner'])),
  })
  const getConfig = () => base
  getConfig._setOwner = (o) => {
    persisted = { ...o }
    Object.assign(base.douyin.owner, o)
  }
  const d = duty.createDouyin({
    getConfig,
    hub: { runSystemTurn: async () => ({ ok: true, text: '{}' }), chatOfSession: () => 'c' },
    memory: { recentEvents: () => [], addEvent: () => {}, add: () => {} },
    log: { info() {}, warn() {}, debug() {} },
    driver: drv,
    im,
    dataFile: join(process.env.AURABOT_DATA_DIR, `douyin-confirm-${Math.random().toString(16).slice(2)}.json`),
  })
  const r = await d.confirmOwner('https://www.douyin.com/user/MS4wLjABAAAAabcdefghijklmnopqrs')
  assert.equal(r.ok, true, r.message)
  assert.equal(r.secUid, owner.secUid)
  assert.equal(r.uid, owner.uid)
  assert.ok(persisted)
  assert.equal(persisted.uid, '9876543210')
  assert.equal(persisted.secUid, owner.secUid)
  assert.equal(persisted.confirmedInput, 'https://www.douyin.com/user/MS4wLjABAAAAabcdefghijklmnopqrs')
  assert.equal(base.douyin.owner.uid, '9876543210')
  assert.equal(util.ownerConfirmed(base), true)
})

test('核对主人：非数字 uid 不写入 owner.uid；数字 uid 持久化', async () => {
  let persisted = null
  const owner = { secUid: 'MS4wLjABAAAAabcdefghijklmnopqrs', uid: 'not-a-uid', nickname: 'x', avatar: '' }
  const drv = cdp.createFakeDriver({ owner })
  const base = normalize({
    enabled: true, dryRun: false, ownerQQ: '10000001', ownerName: '主人',
    douyin: {
      enabled: true,
      owner: { input: '', secUid: '', uid: '', nickname: '', avatar: '', confirmedInput: '' },
      caps: { like: 30, comment: 1, replyComment: 6, follow: 5, dm: 5, shareOwner: 3, dmReply: 20 },
      gate: { maxWritesPerDay: 60, minWriteGapSec: 0, newAccountDays: 3 },
    },
    profilePerms: Object.fromEntries(DOUYIN_PERM_KEYS.map((k) => [k, 'owner'])),
  })
  const getConfig = () => base
  getConfig._setOwner = (o) => { persisted = { ...o }; Object.assign(base.douyin.owner, o) }
  const d = duty.createDouyin({
    getConfig,
    hub: { runSystemTurn: async () => ({ ok: true, text: '{}' }), chatOfSession: () => 'c' },
    memory: { recentEvents: () => [], addEvent: () => {}, add: () => {} },
    log: { info() {}, warn() {}, debug() {} },
    driver: drv,
    dataFile: join(process.env.AURABOT_DATA_DIR, `douyin-uid-bad-${Math.random().toString(16).slice(2)}.json`),
  })
  const r = await d.confirmOwner('https://www.douyin.com/user/MS4wLjABAAAAabcdefghijklmnopqrs')
  assert.equal(r.ok, true)
  assert.equal(r.uid, '')
  assert.equal(persisted.uid, '')
  assert.equal(persisted.secUid, owner.secUid)

  // 数字 uid：假驱动改 owner 后再核对应写入
  drv._state.owner.uid = '9988776655'
  const r2 = await d.confirmOwner('https://www.douyin.com/user/MS4wLjABAAAAabcdefghijklmnopqrs')
  assert.equal(r2.uid, '9988776655')
  assert.equal(base.douyin.owner.uid, '9988776655')
})


const feed = [
  { awemeId: '1001', author: '阿猫', authorSecUid: 'sec_cat', desc: '猫砂盆测评', likes: 1000, comments: 10, tags: ['猫'] },
  { awemeId: '1002', author: '阿狗', authorSecUid: 'sec_dog', desc: '狗狗跑步', likes: 2000, comments: 20, tags: ['狗'] },
  { awemeId: '1003', author: '阿鸟', authorSecUid: 'sec_bird', desc: '鹦鹉说话', likes: 500, comments: 5, tags: [] },
]

function fakes({ decisions, cfgOver = {}, script = {}, dryRun = false, imScript = {} } = {}) {
  const events = []
  const facts = []
  const sent = []
  const drv = cdp.createFakeDriver({ feed: feed.map((x) => ({ ...x })), owner: script.owner || { secUid: 'owner_sec', uid: 'owner_uid', nickname: '主人', avatar: 'https://x/a~tplv.jpg' }, commentReplies: script.commentReplies || [], ...script })
  const im = imMod.createFakeImClient({
    loggedIn: imScript.loggedIn !== false && !imScript.needLogin,
    needLogin: !!imScript.needLogin,
    failSend: !!imScript.failSend,
    failMessage: imScript.failMessage,
    inbox: imScript.inbox || script.inbox || [],
    owner: { uid: 'owner_uid', secUid: 'owner_sec', nickname: '主人' },
    peers: imScript.peers || [{ uid: 'peer1', secUid: 'MS4wLjABAAAAabcdefghijklmnopqrs', nickname: '路人' }],
    ...imScript,
  })
  const turns = []
  const hub = {
    turns,
    runSystemTurn: async (name, title, prompt, opts) => {
      turns.push({ name, title, prompt, opts: opts || {} })
      if (prompt.includes('看完说说你的想法')) return JSON.stringify(decisions)
      if (prompt.includes('私信给你') || prompt.includes('发的私信')) return script.dmReplyText || '收到啦'
      if (prompt.includes('回你的评论')) return script.replyText || '哈哈是呀'
      return ''
    },
    sendText: async (chatId, text) => sent.push({ chatId, text }),
    logChat: () => {},
  }
  const memory = {
    list: () => [],
    recentEvents: () => [],
    addEvent: (e) => events.push(e.text),
    add: (m) => facts.push(m.text),
  }
  const base = normalize({
    enabled: true, dryRun, ownerQQ: '10000001', ownerName: '主人',
    douyin: {
      enabled: true, perRun: 2, maxWatchPerDay: 30, maxRunsPerDay: 3, intervalHours: 4,
      dwellMin: 8, dwellMax: 40,
      socialInterruptBrowse: true,
      caps: { like: 30, comment: 1, replyComment: 6, follow: 5, dm: 5, shareOwner: 3, dmReply: 20 },
      gate: { maxWritesPerDay: 60, minWriteGapSec: 0, newAccountDays: 3 },
      owner: { input: 'owner_id', secUid: 'owner_sec', uid: 'owner_uid', nickname: '主人', avatar: 'https://x/a', confirmedInput: 'owner_id' },
      ...cfgOver,
    },
    profilePerms: Object.fromEntries(DOUYIN_PERM_KEYS.map((k) => [k, 'owner'])),
  })
  if (cfgOver.gate) base.douyin.gate = { ...base.douyin.gate, ...cfgOver.gate }
  if (cfgOver.caps) base.douyin.caps = { ...base.douyin.caps, ...cfgOver.caps }
  if (cfgOver.owner) base.douyin.owner = { ...base.douyin.owner, ...cfgOver.owner }
  const dataFile = join(process.env.AURABOT_DATA_DIR, `douyin-${Math.random().toString(16).slice(2)}.json`)
  const d = duty.createDouyin({
    getConfig: () => base,
    hub, memory,
    log: { info() {}, warn() {}, debug() {} },
    driver: drv,
    im,
    dataFile,
  })
  return { d, drv, im, hub, events, facts, sent, cfg: base, dataFile }
}

test('刷一轮：看视频、按每天上限评论 / 点赞（关注不在刷流），记成她的经历', async () => {
  const { d, drv, events } = fakes({ decisions: [
    { i: 1, feeling: '猫砂好用', like: true, comment: '学到了', follow: true, share: '', remember: '有个猫砂测评' },
    { i: 2, feeling: '狗好快', like: true, comment: '跑得好快', follow: false, share: '', remember: '' },
  ] })
  const r = await d.run({ force: true })
  assert.equal(r.ok, true, r.message)
  assert.equal(r.watched, 2)
  assert.equal(drv._state.liked.filter(Boolean).length, 2)
  assert.equal(drv._state.commented.length, 1, '每天最多 1 条评论')
  assert.equal(drv._state.commented[0], '学到了')
  assert.equal(drv._state.followed.length, 0, '刷流不自动关注')
  assert.ok(events.some((e) => e.includes('在抖音看了') && e.includes('阿猫')))
  assert.equal(d.state().comment, 1)
  assert.equal(d.state().like, 2)
  const r2 = await d.run({ force: true })
  assert.equal(r2.ok, true)
  assert.equal(r2.watched, 1, '只剩第三条')
})

test('试运行：只记日志不真点，且不占真实日上限', async () => {
  const { d, drv, im } = fakes({ dryRun: true, decisions: [
    { i: 1, feeling: '好', like: true, comment: '评一下', follow: true, share: '给你看', remember: '' },
  ] })
  const r = await d.run({ force: true })
  assert.equal(r.ok, true)
  assert.equal(drv._state.liked.filter(Boolean).length, 0)
  assert.equal(drv._state.commented.length, 0)
  assert.equal(drv._state.followed.length, 0)
  assert.equal(im._state.shared.length, 0, '试运行不走 IM 分享')
  assert.equal(im._state.sent.length, 0)
  assert.equal(d.state().like, 0, '试运行不占 like 计数')
  assert.equal(d.state().comment, 0, '试运行不占 comment 计数')
  assert.equal(d.state().shareOwner, 0)
  assert.equal(d.state().writes, 0, '试运行不占写操作总闸')
})

test('分享给主人：要已核对 sec_uid；改了输入就不再认；走 IM shareWork', async () => {
  const { d, im } = fakes({ decisions: [
    { i: 1, feeling: '好玩', like: false, comment: '', follow: false, share: '主人看这个猫', remember: '' },
  ] })
  await d.run({ force: true })
  assert.equal(im._state.shared.length, 1)
  assert.equal(im._state.shared[0].secUid, 'owner_sec')
  assert.equal(im._state.shared[0].uid, 'owner_uid')
  assert.equal(im._state.shared[0].itemId, '1001')

  const { d: d2, im: im2 } = fakes({
    decisions: [{ i: 1, feeling: '好玩', like: false, comment: '', follow: false, share: '主人看', remember: '' }],
    cfgOver: { owner: { input: 'changed', secUid: 'owner_sec', uid: 'owner_uid', nickname: '主人', avatar: 'https://x/a', confirmedInput: 'owner_id' } },
  })
  await d2.run({ force: true })
  assert.equal(im2._state.shared.length, 0, '输入和核对时不一致 → 不分享')
})

test('回主人私信：只认 confirmed sec_uid；列表没身份就不开；超过 30 分钟不理', async () => {
  const now = Date.now()
  const { d, im } = fakes({
    decisions: [],
    imScript: { inbox: [
      { secUid: 'owner_sec', uid: 'owner_uid', nickname: '主人', text: '在干嘛', at: now },
      { secUid: 'other', uid: 'other_uid', nickname: '路人', text: '嗨', at: now },
    ] },
  })
  const r = await d.checkOwnerDms()
  assert.equal(r.replied, 1, r.message)
  assert.equal(im._state.sent.length, 1)
  assert.equal(im._state.sent[0].text, '收到啦')

  const { d: d2 } = fakes({
    decisions: [],
    imScript: { inbox: [{ secUid: '', uid: '', nickname: '？', text: '嗨', at: now }] },
  })
  const r2 = await d2.checkOwnerDms()
  assert.equal(r2.ok, false)
  assert.match(r2.message, /认不出/)

  const { d: d3, im: im3 } = fakes({
    decisions: [],
    imScript: { inbox: [{ secUid: 'owner_sec', uid: 'owner_uid', nickname: '主人', text: '很久以前', at: now - 40 * 60_000 }] },
  })
  const r3 = await d3.checkOwnerDms()
  assert.equal(r3.replied, 0, '超过 30 分钟的私信不理')
  assert.equal(im3._state.sent.length, 0)
})

test('回主人私信：连续 3 条后若主人没新话就停', async () => {
  const now = Date.now()
  const inbox = [
    { secUid: 'owner_sec', uid: 'owner_uid', nickname: '主人', text: '一', at: now },
    { secUid: 'owner_sec', uid: 'owner_uid', nickname: '主人', text: '二', at: now },
    { secUid: 'owner_sec', uid: 'owner_uid', nickname: '主人', text: '三', at: now },
    { secUid: 'owner_sec', uid: 'owner_uid', nickname: '主人', text: '四', at: now },
  ]
  const { d } = fakes({ decisions: [], imScript: { inbox } })
  const r = await d.checkOwnerDms()
  assert.equal(r.replied, 3, '最多连回 3 条')
  assert.equal(d.state().dmReply, 3)
})

test('推荐页：裸 recommend=1 跳 jingxuan 后 from_nav / 点推荐可恢复', async () => {
  const drv = cdp.createFakeDriver({ redirectRecommendToJingxuan: true })
  await drv.navigate('https://www.douyin.com/?recommend=1')
  assert.equal(await drv.currentUrl(), 'https://www.douyin.com/jingxuan')
  assert.equal(util.isRecommendUrl(await drv.currentUrl()), false)

  const ok = await drv.ensureRecommend()
  assert.equal(ok.ok, true, ok.message)
  assert.ok(util.isRecommendUrl(ok.url))
  assert.match(ok.url, /from_nav=1/)
  assert.ok(drv._state.log.some((x) => x[0] === 'nav' && String(x[1]).includes('from_nav=1')))
})

test('推荐页：from_nav 仍 jingxuan 时点侧栏推荐可恢复', async () => {
  const drv = cdp.createFakeDriver({ redirectRecommendToJingxuan: true, fromNavStaysJingxuan: true })
  await drv.navigate('https://www.douyin.com/?recommend=1')
  assert.match(await drv.currentUrl(), /jingxuan/)
  const ok = await drv.ensureRecommend()
  assert.equal(ok.ok, true, ok.message)
  assert.ok(util.isRecommendUrl(ok.url))
  assert.ok(drv._state.log.some((x) => x[0] === 'clickRecommendTab'))
})

test('extractOwnerProfile：RENDER_DATA URL 编码与 html 均可抠出数字 uid', () => {
  const sec = 'MS4wLjABAAAAabcdefghijklmnopqrs'
  const payload = {
    app: { user: { userInfo: { secUid: sec, uid: '135990228302301', nickname: '主人号' } } },
  }
  const encoded = encodeURIComponent(JSON.stringify(payload))
  const fromRender = util.extractOwnerProfile({
    href: `https://www.douyin.com/user/${sec}`,
    renderData: encoded,
  })
  assert.equal(fromRender.secUid, sec)
  assert.equal(fromRender.uid, '135990228302301')

  const html = `noise "secUid":"${sec}" pad uid%22%3A%2211223344556677 more`
  const fromHtml = util.extractOwnerProfile({ href: `https://www.douyin.com/user/${sec}`, html })
  assert.equal(fromHtml.uid, '11223344556677')
  assert.equal(util.normalizeOwnerUid('abc'), '')
  assert.equal(util.normalizeOwnerUid('12345'), '12345')
})

test('extractOwnerProfile：不吃浏览器登录态整页 uid（须 secUid 匹配或窗口内）', () => {
  const sec = 'MS4wLjABAAAAabcdefghijklmnopqrs'
  // 整页靠前有登录态 uid，但没有匹配 secUid 的节点 / 窗口 → 不应认成主人 uid
  const htmlFar = `"uid":"7675288911115453489" noise nowhere near target`
  const far = util.extractOwnerProfile({ href: `https://www.douyin.com/user/${sec}`, html: htmlFar })
  assert.equal(far.secUid, sec)
  assert.equal(far.uid, '', '远离 secUid 的整页 uid 不能当主人')

  // 同节点带匹配 secUid 才认
  const payload = {
    app: { user: { userInfo: { secUid: sec, uid: '33533115713', nickname: '_Future' } } },
    self: { user: { userInfo: { secUid: 'OTHERSECUIDOTHERSECUIDXX', uid: '7675288911115453489', nickname: 'Next_Future' } } },
  }
  const fromRender = util.extractOwnerProfile({
    href: `https://www.douyin.com/user/${sec}`,
    renderData: encodeURIComponent(JSON.stringify(payload)),
  })
  assert.equal(fromRender.uid, '33533115713', '只认 secUid 匹配节点上的 uid')
})

test('#4 卡在精选：ensureRecommend 失败则本轮不刷', async () => {
  const { d } = fakes({ decisions: [], script: { stuckOnFeatured: true } })
  const r = await d.run({ force: true })
  assert.equal(r.ok, false)
  assert.match(r.message, /推荐页|精选/)
  assert.equal(d.state().lastSkipReason.includes('推荐') || d.state().lastSkipReason.includes('精选'), true)
})

test('#4 计数立刻落盘：每个视频看完 watched 就 +1', async () => {
  const { d, dataFile } = fakes({ decisions: [
    { i: 1, feeling: '1', like: false, comment: '', follow: false, share: '', remember: '' },
    { i: 2, feeling: '2', like: false, comment: '', follow: false, share: '', remember: '' },
  ] })
  await d.run({ force: true })
  const { readFileSync } = await import('node:fs')
  const saved = JSON.parse(readFileSync(dataFile, 'utf8'))
  assert.equal(saved.watched, 2)
  assert.ok(saved.seen.includes('1001') && saved.seen.includes('1002'))
  assert.ok(saved.history.some((h) => h.kind === 'watch'))
})

test('#4 定时：nextDueAt 落盘；未到点 tick 不跑', async () => {
  const { d, cfg } = fakes({ decisions: [
    { i: 1, feeling: '好', like: false, comment: '', follow: false, share: '', remember: '' },
  ] })
  const r = await d.run({ force: false })
  assert.equal(r.ok, true)
  const st = d.state()
  assert.ok(st.nextDueAt > Date.now(), '下次应在未来')
  const runsBefore = st.runs
  cfg.enabled = true
  cfg.douyin.enabled = true
  await d.tick()
  assert.equal(d.state().runs, runsBefore, '没到点不该再跑')
})

test('风控：验证码时暂停全部写操作并只通知主人一次', async () => {
  const { d, drv, sent } = fakes({ decisions: [
    { i: 1, feeling: '好', like: true, comment: '', follow: false, share: '', remember: '' },
  ] })
  const orig = drv.clickLike
  drv.clickLike = async () => { drv.markVerify('页面要验证'); throw new Error('请完成安全验证') }
  await d.run({ force: true })
  assert.ok(d.state().pauseReason)
  assert.ok(sent.some((x) => /验证|限制/.test(x.text)))
  // 再触发一次不应重复通知
  const n = sent.length
  drv.clickLike = orig
  await d.run({ force: true })
  assert.ok(d.state().pauseReason)
  assert.equal(sent.length, n, '验证码只通知一次')
})

test('权限 off：browse 关掉后自动刷拒绝', async () => {
  const { d, cfg } = fakes({ decisions: [] })
  cfg.profilePerms.douyinBrowse = 'off'
  const r = await d.run({ force: false })
  assert.equal(r.ok, false)
  assert.match(r.message, /权限|关掉/)
})

test('主动私信：每人每天最多 1 条；日上限仍生效', async () => {
  const { d, im } = fakes({ decisions: [], cfgOver: { caps: { like: 0, comment: 0, replyComment: 0, follow: 0, dm: 5, shareOwner: 0, dmReply: 0 } } })
  const a = await d.dmTo('https://www.douyin.com/user/MS4wLjABAAAAabcdefghijklmnopqrs', '你好呀')
  assert.equal(a.ok, true, a.message)
  const b = await d.dmTo('https://www.douyin.com/user/MS4wLjABAAAAabcdefghijklmnopqrs', '第二句')
  assert.equal(b.ok, false)
  assert.match(b.message, /每人每天|已经给这个人/)
  assert.equal(im._state.sent.length, 1)
  assert.equal(im._state.sent[0].text, '你好呀')
})

test('关注工具：刷流不关注，douyin_follow 才关注', async () => {
  const { d, drv } = fakes({ decisions: [] })
  const r = await d.followUser('https://www.douyin.com/user/MS4wLjABAAAAabcdefghijklmnopqrs')
  assert.equal(r.ok, true, r.message)
  assert.equal(d.state().follow, 1)
  assert.ok(drv._state.followed.length >= 1 || drv._state.log.some((x) => x[0] === 'nav'))
})

test('回评论：走 listCommentReplies，不是只读 _state.commentReplies', async () => {
  const { d, drv } = fakes({
    decisions: [],
    script: { commentReplies: [{ id: 'r1', name: '路人甲', text: '哈哈哈', awemeId: '1001' }] },
  })
  // 确认假驱动暴露的是方法
  assert.equal(typeof drv.listCommentReplies, 'function')
  const r = await d.checkCommentReplies()
  assert.equal(r.replied, 1)
  assert.ok(drv._state.commented.includes('哈哈是呀'))
})

test('写操作总闸：总次数上限；连续失败 3 次禁用该 op', async () => {
  const { d, drv } = fakes({
    decisions: [],
    cfgOver: { caps: { like: 30, comment: 0, replyComment: 0, follow: 0, dm: 0, shareOwner: 0, dmReply: 0 }, gate: { maxWritesPerDay: 2, minWriteGapSec: 0, newAccountDays: 0 } },
  })
  // 用 likeVideo 两次占满总闸
  drv._state.feed = feed.map((x) => ({ ...x }))
  // like via run
  const { d: d2, drv: drv2 } = fakes({
    decisions: [
      { i: 1, feeling: 'a', like: true, comment: '', follow: false, share: '', remember: '' },
      { i: 2, feeling: 'b', like: true, comment: '', follow: false, share: '', remember: '' },
    ],
    cfgOver: { perRun: 2, caps: { like: 30, comment: 0, replyComment: 0, follow: 0, dm: 0, shareOwner: 0, dmReply: 0 }, gate: { maxWritesPerDay: 1, minWriteGapSec: 0, newAccountDays: 0 } },
  })
  await d2.run({ force: true })
  assert.equal(d2.state().like, 1, '总闸 1 时第二条点赞不该成功')
  assert.equal(d2.state().writes, 1)

  // 连续失败禁用
  let fails = 0
  const { d: d3, drv: drv3 } = fakes({
    decisions: [{ i: 1, feeling: 'x', like: true, comment: '', follow: false, share: '', remember: '' }],
    cfgOver: { perRun: 1, gate: { maxWritesPerDay: 60, minWriteGapSec: 0, newAccountDays: 0 } },
  })
  drv3.clickLike = async () => { fails++; throw new Error('点赞按钮丢了') }
  // 需要多轮触发 3 次失败：每轮 perRun=1，feed 重置不了 cursor——换 followUser
  const { d: d4, drv: drv4 } = fakes({ decisions: [], cfgOver: { gate: { minWriteGapSec: 0, newAccountDays: 0 } } })
  drv4.clickFollow = async () => { throw new Error('找不到关注按钮') }
  for (let i = 0; i < 3; i++) {
    const rr = await d4.followUser('https://www.douyin.com/user/MS4wLjABAAAAabcdefghijklmnopqrs')
    assert.equal(rr.ok, false)
  }
  const r4 = await d4.followUser('https://www.douyin.com/user/MS4wLjABAAAAabcdefghijklmnopqrs')
  assert.equal(r4.ok, false)
  assert.match(r4.message, /连续失败|停了/)
})

test('写操作间隔：minWriteGapSec 内第二次写被拒', async () => {
  let t = 1_700_000_000_000
  const events = []
  const sent = []
  const drv = cdp.createFakeDriver({ feed: feed.map((x) => ({ ...x })) })
  const base = normalize({
    enabled: true, dryRun: false, ownerQQ: '10000001', ownerName: '主人',
    douyin: {
      enabled: true, perRun: 1, maxWatchPerDay: 30, maxRunsPerDay: 3, intervalHours: 4,
      dwellMin: 8, dwellMax: 40,
      caps: { like: 30, comment: 0, replyComment: 0, follow: 5, dm: 0, shareOwner: 0, dmReply: 0 },
      gate: { maxWritesPerDay: 60, minWriteGapSec: 20, newAccountDays: 0 },
      owner: { input: 'owner_id', secUid: 'owner_sec', nickname: '主人', avatar: 'https://x/a', confirmedInput: 'owner_id' },
    },
    profilePerms: Object.fromEntries(DOUYIN_PERM_KEYS.map((k) => [k, 'owner'])),
  })
  const dataFile = join(process.env.AURABOT_DATA_DIR, `douyin-gap-${Math.random().toString(16).slice(2)}.json`)
  const d = duty.createDouyin({
    getConfig: () => base,
    hub: { runSystemTurn: async () => '', sendText: async (c, t) => sent.push({ c, t }), logChat() {} },
    memory: { list: () => [], recentEvents: () => [], addEvent: (e) => events.push(e.text), add() {} },
    log: { info() {}, warn() {}, debug() {} },
    driver: drv,
    dataFile,
    now: () => t,
  })
  const a = await d.followUser('https://www.douyin.com/user/MS4wLjABAAAAabcdefghijklmnopqrs')
  assert.equal(a.ok, true, a.message)
  t += 5_000 // 只过 5 秒
  const b = await d.followUser('https://www.douyin.com/user/MS4wLjABAAAAzzzzzzzzzzzzzzzzz')
  assert.equal(b.ok, false)
  assert.match(b.message, /再等|写太勤/)
  t += 20_000
  const c = await d.followUser('https://www.douyin.com/user/MS4wLjABAAAAzzzzzzzzzzzzzzzzz')
  assert.equal(c.ok, true, c.message)
})

test('feed 整理：广告 / 直播丢掉', () => {
  assert.equal(util.normalizeAweme({ aweme_id: '1', is_ads: true }), null)
  assert.equal(util.normalizeAweme({ aweme_id: '2', cell_room: {} }), null)
  const v = util.normalizeAweme({ aweme_id: '3', desc: 'hi', author: { nickname: 'x', sec_uid: 's' }, statistics: { digg_count: 9 } })
  assert.equal(v.awemeId, '3')
  assert.equal(v.likes, 9)
  assert.deepEqual(util.awemesFromResponse({ aweme_list: [{ aweme_id: '3', desc: 'hi', author: {}, statistics: {} }] }).map((x) => x.awemeId), ['3'])
})

test('过滤器：昵称 / 签名拒链接、手机、广告、超长', () => {
  assert.equal(util.filterNickname('肥鱼').ok, true)
  assert.equal(util.filterNickname('').ok, false)
  assert.equal(util.filterNickname('https://x.com').ok, false)
  assert.equal(util.filterNickname('加微信领券').ok, false)
  assert.equal(util.filterNickname('1'.repeat(21)).ok, false)
  assert.equal(util.filterSignature('今天心情好').ok, true)
  assert.equal(util.filterSignature('加v私聊').ok, false)
  assert.equal(util.filterSignature('a'.repeat(101)).ok, false)
})

test('头像来源：last / http / 白名单本地；域外本地拒', () => {
  const root = process.env.AURABOT_DATA_DIR
  const inside = join(root, 'pic.png')
  assert.equal(util.resolveAvatarSource('last', '').ok, false)
  assert.equal(util.resolveAvatarSource('last', 'https://cdn/a.jpg').url, 'https://cdn/a.jpg')
  assert.equal(util.resolveAvatarSource('https://cdn/b.png', '').url, 'https://cdn/b.png')
  assert.equal(util.resolveAvatarSource(inside, '', [root]).path, inside)
  assert.equal(util.resolveAvatarSource('/tmp/evil.png', '', [root]).ok, false)
  const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  assert.equal(util.sniffImageType(png), 'image/png')
})

test('改签名 / 昵称：过写闸、日上限、同日重复拒、试运行不计次', async () => {
  const { d, drv, events, cfg } = fakes({
    decisions: [],
    cfgOver: { caps: { like: 0, comment: 0, replyComment: 0, follow: 0, dm: 0, shareOwner: 0, dmReply: 0, sign: 2, nickname: 2, avatar: 1 }, gate: { maxWritesPerDay: 60, minWriteGapSec: 0, newAccountDays: 0 } },
  })
  const a = await d.setSign('今天开心')
  assert.equal(a.ok, true, a.message)
  assert.equal(drv._state.signature, '今天开心')
  assert.ok(events.some((t) => t.includes('签名')))
  const dup = await d.setSign('今天开心')
  assert.equal(dup.ok, false)
  assert.match(dup.message, /已经改成/)
  const b = await d.setSign('换一句')
  assert.equal(b.ok, true, b.message)
  const c = await d.setSign('第三句')
  assert.equal(c.ok, false)
  assert.match(c.message, /用完|次数/)

  const n1 = await d.setNickname('小肥鱼')
  assert.equal(n1.ok, true, n1.message)
  assert.equal(drv._state.self.nickname, '小肥鱼')
  const n2 = await d.setNickname('小肥鱼')
  assert.equal(n2.ok, false)
  const n3 = await d.setNickname('大肥鱼')
  assert.equal(n3.ok, true, n3.message)
  const n4 = await d.setNickname('超肥鱼')
  assert.equal(n4.ok, false)

  // dryRun 不计次
  const { d: d2, drv: drv2 } = fakes({
    decisions: [], dryRun: true,
    cfgOver: { caps: { sign: 1, nickname: 1, avatar: 1, like: 0, comment: 0, replyComment: 0, follow: 0, dm: 0, shareOwner: 0, dmReply: 0 }, gate: { maxWritesPerDay: 60, minWriteGapSec: 0, newAccountDays: 0 } },
  })
  const dry = await d2.setSign('试运行签名')
  assert.equal(dry.ok, true)
  assert.match(dry.message, /试运行/)
  assert.equal(drv2._state.signature, '')
  const st = d2.state()
  assert.equal(st.sign, 0)
})

test('换头像：MIME 嗅探、日上限 1、验证码 pauseAll', async () => {
  const root = process.env.AURABOT_DATA_DIR
  const pngPath = join(root, 'avatar-ok.png')
  const { writeFileSync } = await import('node:fs')
  writeFileSync(pngPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2, 3]))
  const { d, drv } = fakes({
    decisions: [],
    cfgOver: { caps: { avatar: 1, sign: 0, nickname: 0, like: 0, comment: 0, replyComment: 0, follow: 0, dm: 0, shareOwner: 0, dmReply: 0 }, gate: { maxWritesPerDay: 60, minWriteGapSec: 0, newAccountDays: 0 } },
  })
  const a = await d.setAvatar(pngPath)
  assert.equal(a.ok, true, a.message)
  assert.equal(drv._state.avatarPath, pngPath)
  const b = await d.setAvatar(pngPath)
  assert.equal(b.ok, false)
  assert.match(b.message, /用完|次数/)

  const bad = join(root, 'not-img.bin')
  writeFileSync(bad, Buffer.from('hello'))
  const { d: d3 } = fakes({
    decisions: [],
    cfgOver: { caps: { avatar: 1, like: 0, comment: 0, replyComment: 0, follow: 0, dm: 0, shareOwner: 0, dmReply: 0 }, gate: { maxWritesPerDay: 60, minWriteGapSec: 0, newAccountDays: 0 } },
  })
  const rBad = await d3.setAvatar(bad)
  assert.equal(rBad.ok, false)
  assert.match(rBad.message, /图片/)

  const { d: d4, drv: drv4, sent } = fakes({
    decisions: [],
    script: { profileFail: true, profileFailMessage: '请完成安全验证' },
    cfgOver: { caps: { avatar: 1, like: 0, comment: 0, replyComment: 0, follow: 0, dm: 0, shareOwner: 0, dmReply: 0 }, gate: { maxWritesPerDay: 60, minWriteGapSec: 0, newAccountDays: 0 } },
  })
  const rV = await d4.setAvatar(pngPath)
  assert.equal(rV.ok, false)
  assert.ok(d4.state().pauseReason)
  assert.equal(sent.length, 1)
})


test('IM：未登录时 douyin_dm / share / 回主人私信明确提示，不静默失败', async () => {
  const { d } = fakes({ decisions: [], imScript: { needLogin: true } })
  const a = await d.dmTo('https://www.douyin.com/user/MS4wLjABAAAAabcdefghijklmnopqrs', '你好')
  assert.equal(a.ok, false)
  assert.match(a.message, /IM|登录/)
  const b = await d.shareToOwner('https://www.douyin.com/video/1001', '看')
  assert.equal(b.ok, false)
  assert.match(b.message, /IM|登录/)
  const c = await d.checkOwnerDms()
  assert.equal(c.ok, false)
  assert.match(c.message, /IM|登录/)
})

test('IM：dryRun 私信不计次、不真发', async () => {
  const { d, im } = fakes({
    decisions: [], dryRun: true,
    cfgOver: { caps: { dm: 5, like: 0, comment: 0, replyComment: 0, follow: 0, shareOwner: 0, dmReply: 0 } },
  })
  const a = await d.dmTo('https://www.douyin.com/user/MS4wLjABAAAAabcdefghijklmnopqrs', '试运行私信')
  assert.equal(a.ok, true)
  assert.match(a.message, /试运行/)
  assert.equal(im._state.sent.length, 0)
  assert.equal(d.state().dm, 0)
  assert.equal(d.state().writes, 0)
})

test('IM：主人未核对拒绝分享', async () => {
  const { d, im } = fakes({
    decisions: [],
    cfgOver: { owner: { input: 'x', secUid: '', uid: '', nickname: '', avatar: '', confirmedInput: '' } },
  })
  const r = await d.shareToOwner('https://www.douyin.com/video/1001', '看这个')
  assert.equal(r.ok, false)
  assert.match(r.message, /核对/)
  assert.equal(im._state.shared.length, 0)
})

test('IM：回执失败计入 failStreak', async () => {
  const { d, im } = fakes({
    decisions: [],
    imScript: { failSend: true, failMessage: '发送失败：无回执' },
    cfgOver: { caps: { dm: 5, like: 0, comment: 0, replyComment: 0, follow: 0, shareOwner: 0, dmReply: 0 }, gate: { maxWritesPerDay: 60, minWriteGapSec: 0, newAccountDays: 0 } },
  })
  const target = 'https://www.douyin.com/user/MS4wLjABAAAAabcdefghijklmnopqrs'
  for (let i = 0; i < 3; i++) {
    const r = await d.dmTo(target, 'hi' + i)
    assert.equal(r.ok, false, r.message)
    assert.match(r.message, /回执|失败/)
  }
  assert.equal(d.state().disabledOps.dm, true)
  assert.equal(im._state.sent.length, 0)
})

test('IM：socialBusy 打断刷流并写入 lastSkipReason', async () => {
  const events = []
  const sent = []
  const drv = cdp.createFakeDriver({ feed: feed.map((x) => ({ ...x })) })
  const im = imMod.createFakeImClient({ owner: { uid: 'owner_uid', secUid: 'owner_sec' } })
  const base = normalize({
    enabled: true, dryRun: false, ownerQQ: '10000001', ownerName: '主人',
    douyin: {
      enabled: true, perRun: 2, maxWatchPerDay: 30, maxRunsPerDay: 3, intervalHours: 4,
      dwellMin: 8, dwellMax: 40, socialInterruptBrowse: true,
      caps: { like: 0, comment: 0, replyComment: 0, follow: 0, dm: 5, shareOwner: 0, dmReply: 0 },
      gate: { maxWritesPerDay: 60, minWriteGapSec: 0, newAccountDays: 0 },
      owner: { input: 'owner_id', secUid: 'owner_sec', uid: 'owner_uid', nickname: '主人', avatar: 'https://x/a', confirmedInput: 'owner_id' },
    },
    profilePerms: Object.fromEntries(DOUYIN_PERM_KEYS.map((k) => [k, 'owner'])),
  })
  const dataFile = join(process.env.AURABOT_DATA_DIR, `douyin-busy-${Math.random().toString(16).slice(2)}.json`)
  const d = duty.createDouyin({
    getConfig: () => base,
    hub: {
      runSystemTurn: async (_n, _t, prompt) => {
        if (prompt.includes('看完说说你的想法')) {
          d._setSocialBusy(true)
          return JSON.stringify([
            { i: 1, feeling: 'a', like: false, comment: '', follow: false, share: '', remember: '' },
            { i: 2, feeling: 'b', like: false, comment: '', follow: false, share: '', remember: '' },
          ])
        }
        return ''
      },
      sendText: async (c, t) => sent.push({ c, t }),
      logChat() {},
    },
    memory: { list: () => [], recentEvents: () => [], addEvent: (e) => events.push(e.text), add() {} },
    log: { info() {}, warn() {}, debug() {} },
    driver: drv,
    im,
    dataFile,
  })
  const r = await d.run({ force: true })
  assert.equal(r.ok, false)
  assert.equal(r.interrupted, true)
  assert.match(r.message, /社交优先|打断/)
  assert.match(d.state().lastSkipReason, /社交优先|打断/)
})

test('配置：socialInterruptBrowse 默认开，可关', () => {
  const c = normalize({})
  assert.equal(c.douyin.socialInterruptBrowse, true)
  const c2 = normalize({ douyin: { socialInterruptBrowse: false } })
  assert.equal(c2.douyin.socialInterruptBrowse, false)
})

test('IM 登录：startQrLogin 只返回 started+QR，不算已登录；扫码→确认→落盘', async () => {
  const im = imMod.createFakeImClient({ needLogin: true, qrDataUrl: 'data:image/png;base64,aW1xcg==' })
  const start = await im.startQrLogin()
  assert.equal(start.ok, true)
  assert.equal(start.started, true)
  assert.equal(start.loggedIn, false, 'started 绝不能当已登录')
  assert.equal(start.phase, 'waiting_scan')
  assert.ok(start.qrDataUrl.startsWith('data:image/'))
  assert.equal(im.status().loggedIn, false)

  let st = im.getLoginStatus()
  assert.equal(st.phase, 'waiting_scan')
  assert.equal(st.loggedIn, false)

  im._advanceLogin('scanned')
  st = im.getLoginStatus()
  assert.equal(st.phase, 'scanned')
  assert.match(st.message, /扫码|确认/)
  assert.equal(st.loggedIn, false)

  im._advanceLogin('confirmed', { nickname: '扫码用户' })
  st = im.getLoginStatus()
  assert.equal(st.loggedIn, false)

  im._advanceLogin('logged_in', { nickname: '扫码用户', uid: 'u_qr' })
  st = im.getLoginStatus()
  assert.equal(st.loggedIn, true)
  assert.equal(st.phase, 'logged_in')
  assert.equal(im.status().loggedIn, true)
  assert.equal(im.status().uid, 'u_qr')
  assert.match(st.message, /已登录/)
})

test('IM 登录：过期与失败态；短信验证在状态里明确提示', async () => {
  const im = imMod.createFakeImClient({ needLogin: true })
  await im.startQrLogin()
  im._advanceLogin('expired')
  let st = im.getLoginStatus()
  assert.equal(st.phase, 'expired')
  assert.equal(st.loggedIn, false)
  assert.equal(st.qrDataUrl, '')
  assert.match(st.message, /过期/)

  const refreshed = await im.refreshQrLogin()
  assert.equal(refreshed.phase, 'waiting_scan')
  assert.ok(refreshed.qrDataUrl)

  im._advanceLogin('sms_required', { verifyHint: '请输入短信验证码（138****）' })
  st = im.getLoginStatus()
  assert.equal(st.phase, 'sms_required')
  assert.match(st.verifyHint, /短信/)
  assert.equal(st.loggedIn, false)

  const sms = await im.submitLoginSms('123456')
  assert.equal(sms.loggedIn, true)
  assert.equal(sms.phase, 'logged_in')
  assert.equal(im.status().loggedIn, true)

  const im2 = imMod.createFakeImClient({ needLogin: true })
  await im2.startQrLogin()
  im2._advanceLogin('verification_required', { verifyHint: '需要滑块验证' })
  st = im2.getLoginStatus()
  assert.equal(st.phase, 'verification_required')
  assert.match(st.verifyHint, /滑块/)
  assert.equal(st.loggedIn, false)

  const im3 = imMod.createFakeImClient({ needLogin: true, loginFail: true, loginFailMessage: '假失败' })
  const fail = await im3.startQrLogin()
  assert.equal(fail.ok, false)
  assert.equal(fail.loggedIn, false)
  assert.equal(fail.phase, 'error')
})

test('IM 登录：duty.startImLogin / imLoginStatus 不把 started 当成功登录', async () => {
  const { d, im } = fakes({ decisions: [], imScript: { needLogin: true } })
  const start = await d.startImLogin()
  assert.equal(start.ok, true)
  assert.equal(start.started, true)
  assert.equal(start.loggedIn, false)
  assert.equal(start.phase, 'waiting_scan')
  assert.ok(start.qrDataUrl)
  assert.equal((await d.imStatus()).loggedIn, false)

  im._advanceLogin('scanned')
  const mid = await d.imLoginStatus()
  assert.equal(mid.phase, 'scanned')
  assert.equal(mid.loggedIn, false)

  im._advanceLogin('logged_in')
  const done = await d.imLoginStatus()
  assert.equal(done.loggedIn, true)
  assert.equal(done.phase, 'logged_in')
  assert.equal((await d.imStatus()).loggedIn, true)
})

test('浏览器登录：假驱动返回面板 QR；轮询 isLogin；过期可刷新；验证在状态提示', async () => {
  const drv = cdp.createFakeDriver({ needLogin: true, qrDataUrl: 'data:image/png;base64,YnJxdXI=' })
  const start = await drv.startLoginQr()
  assert.equal(start.ok, true)
  assert.equal(start.started, true)
  assert.equal(start.loggedIn, false)
  assert.equal(start.phase, 'waiting_scan')
  assert.ok(start.qrDataUrl.startsWith('data:image/'))

  let poll = await drv.pollLoginQr()
  assert.equal(poll.loggedIn, false)
  assert.equal(poll.phase, 'waiting_scan')

  await drv._advanceBrowserLogin('expired')
  poll = await drv.pollLoginQr()
  assert.equal(poll.phase, 'expired')
  assert.equal(poll.loggedIn, false)

  const refreshed = await drv.refreshLoginQr()
  assert.equal(refreshed.phase, 'waiting_scan')
  assert.ok(refreshed.qrDataUrl)

  await drv._advanceBrowserLogin('verification_required', { verifyHint: '需要滑块验证' })
  poll = await drv.pollLoginQr()
  assert.equal(poll.phase, 'verification_required')
  assert.match(poll.verifyHint || '', /滑块|验证/)
  assert.equal(poll.loggedIn, false)

  await drv._advanceBrowserLogin('logged_in')
  poll = await drv.pollLoginQr()
  assert.equal(poll.loggedIn, true)
  assert.equal(poll.phase, 'logged_in')
  const gate = await drv.checkGate()
  assert.equal(gate.ok, true)
})

test('浏览器登录：markVerify 后页面恢复 / clearVerify，poll 不再卡 verification_required', async () => {
  const drv = cdp.createFakeDriver({ needLogin: true, qrDataUrl: 'data:image/png;base64,YnJxdXI=' })
  await drv.startLoginQr()
  drv.markVerify('页面要验证')
  assert.equal(drv.paused, true)
  let poll = await drv.pollLoginQr()
  assert.equal(poll.phase, 'verification_required')
  assert.equal(poll.loggedIn, false)

  // 显式 clear：仍未登录 → 回到扫码，不再卡 verify
  drv.clearVerify()
  poll = await drv.pollLoginQr()
  assert.equal(poll.phase, 'waiting_scan')
  assert.equal(drv.paused, false)

  // 再撞验证墙，然后「页面文案已无验证」→ checkGate 自动 clear
  drv.markVerify('滑块')
  assert.equal((await drv.checkGate()).verify, true)
  drv._state.pageText = '推荐 关注 消息'
  drv._state.needLogin = false
  const auto = await drv.checkGate()
  assert.equal(auto.ok, true)
  assert.equal(drv.paused, false)

  poll = await drv.pollLoginQr()
  assert.equal(poll.loggedIn, true)
  assert.equal(poll.phase, 'logged_in')
})

test('浏览器登录：duty.startBrowserLogin / browserLoginStatus 成功仅在 isLogin', async () => {
  const { d, drv } = fakes({ decisions: [], script: { needLogin: true } })
  const start = await d.startBrowserLogin()
  assert.equal(start.ok, true)
  assert.equal(start.started, true)
  assert.equal(start.loggedIn, false)
  assert.equal(start.phase, 'waiting_scan')
  assert.ok(start.qrDataUrl)

  const mid = await d.browserLoginStatus()
  assert.equal(mid.loggedIn, false)

  await drv._advanceBrowserLogin('logged_in')
  const done = await d.browserLoginStatus()
  assert.equal(done.loggedIn, true)
  assert.equal(done.phase, 'logged_in')
  const acct = await d.account(true)
  assert.equal(acct.isLogin, true)
})


// —— Edge 重启后 attach / 清占用再开 ——
test('CDP：readDevToolsActivePort 读第一行端口', () => {
  const dir = mkdtempSync(join(tmpdir(), 'edge-port-'))
  writeFileSync(join(dir, 'DevToolsActivePort'), '59900\n/devtools/browser/abc\n')
  assert.equal(cdp.readDevToolsActivePort(dir), 59900)
  assert.equal(cdp.readDevToolsActivePort(join(dir, 'nope')), 0)
  writeFileSync(join(dir, 'DevToolsActivePort'), 'not-a-port\n')
  assert.equal(cdp.readDevToolsActivePort(dir), 0)
})

test('CDP：resolveLaunchTarget 已有端口可连 → attach', async () => {
  const probed = []
  const r = await cdp.resolveLaunchTarget('/tmp/edge-profile-x', {
    readPort: () => 59900,
    probe: async (p) => { probed.push(p); return p === 59900 ? { Browser: 'Edge', webSocketDebuggerUrl: 'ws://127.0.0.1:59900/devtools/browser/x' } : null },
    findProcs: () => [{ pid: 4242, port: 59900 }],
  })
  assert.equal(r.mode, 'attach')
  assert.equal(r.port, 59900)
  assert.deepEqual(probed, [59900])
})

test('CDP：resolveLaunchTarget 无文件端口但进程带 remote-debugging → attach', async () => {
  const r = await cdp.resolveLaunchTarget('/data/edge-profile', {
    readPort: () => 0,
    probe: async (p) => (p === 60111 ? { Browser: 'Edge' } : null),
    findProcs: () => [{ pid: 77, port: 60111 }],
  })
  assert.equal(r.mode, 'attach')
  assert.equal(r.port, 60111)
  assert.equal(r.pid, 77)
})

test('CDP：resolveLaunchTarget 占用但端口连不上 → spawn + killPids', async () => {
  const r = await cdp.resolveLaunchTarget('/data/edge-profile', {
    readPort: () => 59900,
    probe: async () => null,
    findProcs: () => [{ pid: 101, port: 59900 }, { pid: 102, port: 0 }],
  })
  assert.equal(r.mode, 'spawn')
  assert.deepEqual(r.killPids, [101, 102])
})

test('CDP：findBrowserProcessesForProfile 从 ps 输出解析本 profile', () => {
  const profile = '/home/u/data/edge-profile'
  const psOut = [
    '  1 /sbin/init',
    ` 4242 /opt/msedge --user-data-dir=${profile} --remote-debugging-port=59900 https://www.douyin.com`,
    ' 4243 /opt/msedge --type=renderer',
    ` 9999 /usr/bin/google-chrome --user-data-dir=/other/profile --remote-debugging-port=9222`,
  ].join('\n')
  const procs = cdp.findBrowserProcessesForProfile(profile, {
    platform: 'linux',
    execFile: () => psOut,
  })
  assert.equal(procs.length, 1)
  assert.equal(procs[0].pid, 4242)
  assert.equal(procs[0].port, 59900)
})

test('CDP：killBrowserProcessesForProfile 只杀匹配 pid', () => {
  const killed = []
  const out = cdp.killBrowserProcessesForProfile('/p', {
    find: () => [{ pid: 11, port: 1 }, { pid: 22, port: 0 }],
    kill: (pid, sig) => { killed.push([pid, sig]) },
  })
  assert.deepEqual(out, [11, 22])
  assert.deepEqual(killed, [[11, 'SIGTERM'], [22, 'SIGTERM']])
})

/** 极简假 WebSocket：open 后 send 立即回空 result，够 attachPage 的 enable 命令。 */
function FakeWs(url) {
  this.url = url
  this.listeners = {}
  queueMicrotask(() => {
    for (const fn of this.listeners.open || []) fn()
  })
}
FakeWs.prototype.addEventListener = function (ev, fn) {
  ;(this.listeners[ev] ||= []).push(fn)
}
FakeWs.prototype.send = function (raw) {
  let msg
  try { msg = JSON.parse(raw) } catch { return }
  if (msg.id == null) return
  queueMicrotask(() => {
    for (const fn of this.listeners.message || []) {
      fn({ data: JSON.stringify({ id: msg.id, result: {} }) })
    }
  })
}
FakeWs.prototype.close = function () {}

test('CDP launch：已有调试端口可连 → attach，不 spawn', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'edge-attach-'))
  writeFileSync(join(dir, 'DevToolsActivePort'), '59900\n/devtools/browser/x\n')
  const spawns = []
  const drv = cdp.createBrowserDriver({
    profileDir: dir,
    browserPath: '/fake/msedge',
    minimize: false,
    wsFactory: FakeWs,
    hooks: {
      findBrowser: () => '/fake/msedge',
      freePort: async () => 60123,
      spawn: (...a) => { spawns.push(a); return { pid: 1, unref() {} } },
      getJson: async (url) => {
        if (url.includes('/json/version')) {
          return { Browser: 'Edge', webSocketDebuggerUrl: 'ws://127.0.0.1:59900/devtools/browser/x' }
        }
        if (url.includes('/json/list')) {
          return [{ type: 'page', webSocketDebuggerUrl: 'ws://127.0.0.1:59900/devtools/page/1' }]
        }
        throw new Error('unexpected ' + url)
      },
      findBrowserProcessesForProfile: () => [{ pid: 4242, port: 59900 }],
      sleep: async () => {},
    },
  })
  const r = await drv.launch()
  assert.equal(r.ok, true)
  assert.equal(r.attached, true)
  assert.equal(r.port, 59900)
  assert.equal(spawns.length, 0)
  drv.close()
})

test('CDP launch：占用且端口起不来 → 清本 profile 旧进程再 spawn', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'edge-clear-'))
  writeFileSync(join(dir, 'DevToolsActivePort'), '59900\n/devtools/browser/x\n')
  const spawns = []
  const kills = []
  let versionOk = false
  const drv = cdp.createBrowserDriver({
    profileDir: dir,
    browserPath: '/fake/msedge',
    minimize: false,
    wsFactory: FakeWs,
    hooks: {
      findBrowser: () => '/fake/msedge',
      freePort: async () => 60123,
      spawn: (bin, args) => {
        spawns.push({ bin, args })
        versionOk = true
        return { pid: 555, unref() {} }
      },
      getJson: async (url) => {
        if (url.includes(':59900/')) throw new Error('fetch failed')
        if (url.includes('/json/version')) {
          if (!versionOk) throw new Error('fetch failed')
          return { Browser: 'Edge', webSocketDebuggerUrl: 'ws://127.0.0.1:60123/devtools/browser/x' }
        }
        if (url.includes('/json/list')) {
          return [{ type: 'page', webSocketDebuggerUrl: 'ws://127.0.0.1:60123/devtools/page/1' }]
        }
        throw new Error('unexpected ' + url)
      },
      findBrowserProcessesForProfile: () => [{ pid: 4242, port: 59900 }],
      killPid: (pid, sig) => { kills.push([pid, sig]) },
      sleep: async () => {},
      probeDebugPort: async () => null,
    },
  })
  const r = await drv.launch()
  assert.equal(r.ok, true)
  assert.equal(r.attached, false)
  assert.equal(r.port, 60123)
  assert.ok(kills.some(([pid]) => pid === 4242), '应结束占用本 profile 的旧进程')
  assert.equal(spawns.length, 1)
  assert.ok(spawns[0].args.some((a) => a.includes('--user-data-dir=' + dir)))
  assert.ok(spawns[0].args.some((a) => a === '--remote-debugging-port=60123'))
  drv.close()
})

test('CDP launch：spawn 后端口仍起不来 → 文案含 profile 与 port', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'edge-fail-'))
  const drv = cdp.createBrowserDriver({
    profileDir: dir,
    browserPath: '/fake/msedge',
    minimize: false,
    hooks: {
      findBrowser: () => '/fake/msedge',
      freePort: async () => 60123,
      spawn: () => ({ pid: 1, unref() {} }),
      getJson: async () => { throw new Error('fetch failed') },
      findBrowserProcessesForProfile: () => [{ pid: 9, port: 59900 }],
      killPid: () => {},
      sleep: async () => {},
      resolveLaunchTarget: async () => ({ mode: 'spawn', killPids: [9] }),
      probeDebugPort: async () => null,
    },
  })
  const r = await drv.launch()
  assert.equal(r.ok, false)
  assert.match(r.message, /资料目录被占用|调试端口没起来/)
  assert.match(r.message, /profile=/)
  assert.match(r.message, /port=60123/)
  assert.match(r.message, /fetch failed/)
})


test('CDP：Windows 扫进程走 -EncodedCommand，能解析 msedge+remote-debugging-port', () => {
  const profile = '/home/u/data/edge-profile'
  const script = cdp.buildWindowsBrowserScanScript(profile)
  // 整段脚本，Where-Object 块不被 join(' ') 拆坏；含 -replace 反斜杠规则
  assert.match(script, /\$ProgressPreference='SilentlyContinue'/)
  assert.match(script, /\$want = '/)
  assert.match(script, /Where-Object \{[\s\S]*-and[\s\S]*Contains\(\$want\)[\s\S]*\}/)
  assert.ok(!script.includes('Get-CimInstance Win32_Process | Where-Object {  $_.Name'), '不应是单行空格拼接')
  const encoded = cdp.encodePowerShellEncodedCommand(script)
  assert.equal(Buffer.from(encoded, 'base64').toString('utf16le'), script)

  const wantNorm = cdp.normalizeProfilePath(profile)
  // 模拟 WMI 输出：反斜杠路径 + remote-debugging-port
  const winLine = `4242\tC:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe --user-data-dir=${profile.replace(/\//g, '\\\\')} --remote-debugging-port=59900 about:blank`
  const parsed = cdp.parseBrowserProcessScanLine(winLine, profile)
  assert.ok(parsed)
  assert.equal(parsed.pid, 4242)
  assert.equal(parsed.port, 59900)

  let sawEncoded = false
  const procs = cdp.findBrowserProcessesForProfile(profile, {
    platform: 'win32',
    execFile: (bin, args) => {
      assert.equal(bin, 'powershell.exe')
      assert.ok(args.includes('-EncodedCommand'), '必须用 -EncodedCommand，禁止手拼 -Command')
      assert.ok(!args.includes('-Command'))
      const i = args.indexOf('-EncodedCommand')
      const dec = Buffer.from(args[i + 1], 'base64').toString('utf16le')
      assert.equal(dec, script)
      assert.ok(dec.includes(wantNorm.replace(/'/g, "''")) || dec.toLowerCase().includes('edge-profile'))
      sawEncoded = true
      return winLine + '\r\n9999\tC:\\chrome.exe --user-data-dir=C:\\other --remote-debugging-port=9222\r\n'
    },
  })
  assert.equal(sawEncoded, true)
  assert.equal(procs.length, 1)
  assert.equal(procs[0].pid, 4242)
  assert.equal(procs[0].port, 59900)
})

test('CDP：ensureDevToolsActivePort 缺失时自写 port+path', () => {
  const dir = mkdtempSync(join(tmpdir(), 'edge-dtap-'))
  assert.equal(cdp.readDevToolsActivePort(dir), 0)
  assert.equal(cdp.ensureDevToolsActivePort(dir, 60123), true)
  assert.equal(cdp.readDevToolsActivePort(dir), 60123)
  const body = readFileSync(join(dir, 'DevToolsActivePort'), 'utf8')
  assert.match(body, /^60123\n\/devtools\//)
  // 已是同端口 → 不再写
  assert.equal(cdp.ensureDevToolsActivePort(dir, 60123), false)
})

test('CDP launch：spawn 成功且无 DevToolsActivePort 时自写，供重启 attach', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'edge-write-port-'))
  assert.equal(cdp.readDevToolsActivePort(dir), 0)
  let versionOk = false
  const drv = cdp.createBrowserDriver({
    profileDir: dir,
    browserPath: '/fake/msedge',
    minimize: false,
    wsFactory: FakeWs,
    hooks: {
      findBrowser: () => '/fake/msedge',
      freePort: async () => 60123,
      spawn: () => { versionOk = true; return { pid: 555, unref() {} } },
      getJson: async (url) => {
        if (url.includes('/json/version')) {
          if (!versionOk) throw new Error('fetch failed')
          return { Browser: 'Edge', webSocketDebuggerUrl: 'ws://127.0.0.1:60123/devtools/browser/x' }
        }
        if (url.includes('/json/list')) {
          return [{ type: 'page', webSocketDebuggerUrl: 'ws://127.0.0.1:60123/devtools/page/1' }]
        }
        throw new Error('unexpected ' + url)
      },
      findBrowserProcessesForProfile: () => [],
      sleep: async () => {},
      resolveLaunchTarget: async () => ({ mode: 'spawn', killPids: [] }),
      probeDebugPort: async () => null,
    },
  })
  const r = await drv.launch()
  assert.equal(r.ok, true)
  assert.equal(r.attached, false)
  assert.equal(r.port, 60123)
  assert.equal(cdp.readDevToolsActivePort(dir), 60123, 'spawn 后应自写 DevToolsActivePort')
  drv.close()
})


test('shareBias：默认 proactive；normalize 认 stingy/normal；刷流 prompt 带对应倾向', async () => {
  assert.equal(normalize({}).douyin.shareBias, 'proactive')
  assert.equal(normalize({ douyin: { shareBias: 'stingy' } }).douyin.shareBias, 'stingy')
  assert.equal(normalize({ douyin: { shareBias: 'normal' } }).douyin.shareBias, 'normal')
  assert.equal(normalize({ douyin: { shareBias: 'off' } }).douyin.shareBias, 'stingy')
  assert.equal(normalize({ douyin: { shareBias: 'weird' } }).douyin.shareBias, 'proactive')
  assert.equal(normalize({}).douyin.caps.shareOwner, 5)

  const proactive = fakes({
    decisions: [{ i: 1, feeling: '好看', like: false, comment: '', share: '', remember: '' }],
    cfgOver: { shareBias: 'proactive', perRun: 1 },
  })
  await proactive.d.run({ force: true })
  const pTurn = proactive.hub.turns.find((x) => x.prompt.includes('看完说说你的想法'))
  assert.ok(pTurn)
  assert.match(pTurn.prompt, /分享要积极/)

  const stingy = fakes({
    decisions: [{ i: 1, feeling: '好看', like: false, comment: '', share: '', remember: '' }],
    cfgOver: { shareBias: 'stingy', perRun: 1 },
  })
  await stingy.d.run({ force: true })
  const sTurn = stingy.hub.turns.find((x) => x.prompt.includes('看完说说你的想法'))
  assert.ok(sTurn)
  assert.match(sTurn.prompt, /一定会喜欢再写 share/)
  assert.ok(!sTurn.prompt.includes('分享要积极'))
})

test('抖音 IM 私信：假 inbox → hub.runSystemTurn(douyin-im, noTools) → IM 发出，不是 silent log-only', async () => {
  const now = Date.now()
  const { d, im, hub } = fakes({
    decisions: [],
    imScript: { inbox: [
      { secUid: 'owner_sec', uid: 'owner_uid', nickname: '主人', text: '在干嘛', at: now },
    ] },
  })
  const r = await d.checkOwnerDms()
  assert.equal(r.replied, 1, r.message)
  assert.equal(im._state.sent.length, 1)
  assert.equal(im._state.sent[0].text, '收到啦')
  const imTurn = hub.turns.find((x) => x.name === 'douyin-im')
  assert.ok(imTurn, '应走 douyin-im 会话')
  assert.equal(imTurn.opts.noTools, true, '私信轮关工具')
  assert.match(imTurn.title, /私信/)
  assert.match(imTurn.prompt, /在干嘛/)
})

test('CDP nextAwemes：attach 后 feed 空 → 重导航 recommend+from_nav 并用 DOM 种子 aweme_id', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'edge-refill-'))
  writeFileSync(join(dir, 'DevToolsActivePort'), '59900\n/devtools/browser/x\n')
  const navigates = []
  const muted = []
  function RefillWs(url) {
    this.url = url
    this.listeners = {}
    queueMicrotask(() => { for (const fn of this.listeners.open || []) fn() })
  }
  RefillWs.prototype.addEventListener = function (ev, fn) {
    ;(this.listeners[ev] ||= []).push(fn)
  }
  RefillWs.prototype.send = function (raw) {
    let msg
    try { msg = JSON.parse(raw) } catch { return }
    if (msg.id == null) return
    let result = {}
    if (msg.method === 'Page.setMuted') muted.push(msg.params)
    if (msg.method === 'Page.navigate') navigates.push(msg.params?.url || '')
    if (msg.method === 'Runtime.evaluate') {
      const expr = String(msg.params?.expression || '')
      if (expr.includes('matchAll') && expr.includes('aweme_id')) {
        result = { result: { value: [
          { aweme_id: '7123456789012345678', desc: '', author: { nickname: '' }, statistics: {} },
          { aweme_id: '7123456789012345679', desc: '', author: { nickname: '' }, statistics: {} },
        ] } }
      } else {
        result = { result: { value: expr.includes('location.href') ? 'https://www.douyin.com/?recommend=1&from_nav=1' : undefined } }
      }
    }
    queueMicrotask(() => {
      for (const fn of this.listeners.message || []) {
        fn({ data: JSON.stringify({ id: msg.id, result }) })
      }
    })
  }
  RefillWs.prototype.close = function () {}

  const drv = cdp.createBrowserDriver({
    profileDir: dir,
    browserPath: '/fake/msedge',
    minimize: false,
    wsFactory: RefillWs,
    hooks: {
      findBrowser: () => '/fake/msedge',
      freePort: async () => 60123,
      spawn: (...a) => { throw new Error('should attach, not spawn: ' + a) },
      getJson: async (url) => {
        if (url.includes('/json/version')) {
          return { Browser: 'Edge', webSocketDebuggerUrl: 'ws://127.0.0.1:59900/devtools/browser/x' }
        }
        if (url.includes('/json/list')) {
          return [{ type: 'page', webSocketDebuggerUrl: 'ws://127.0.0.1:59900/devtools/page/1' }]
        }
        throw new Error('unexpected ' + url)
      },
      findBrowserProcessesForProfile: () => [{ pid: 4242, port: 59900 }],
      sleep: async () => {},
    },
  })
  const launched = await drv.launch()
  assert.equal(launched.ok, true)
  assert.equal(launched.attached, true)
  assert.ok(muted.some((m) => m && m.muted === true), 'attach 应 Page.setMuted')
  assert.equal(drv.recentFeed().length, 0, '刚 attach 时 feed 仍空')

  const list = await drv.nextAwemes({ seen: new Set(), want: 2 })
  assert.ok(navigates.some((u) => /recommend=1/.test(u) && /from_nav=1/.test(u)), '空 feed 应重导航推荐页: ' + navigates.join(','))
  assert.equal(list.length, 2)
  assert.equal(list[0].awemeId, '7123456789012345678')
  assert.ok(drv.recentFeed().length >= 2, 'DOM 种子应写入 feed')
  drv.close()
})
