// 内置模块：B 站。别人发来链接时她能「看」视频（标题、简介、字幕、热评）；定时自己去刷、评论、回评论，看到好玩的分享给主人。

import { readFileSync } from 'node:fs'
import { createBili } from '../../bili/duty.js'
import { defineTool, str } from '../../tools/tools.js'

export default {
  id: 'bili',
  name: 'B站',
  version: '1.1.0',
  description: '看别人发的 B 站视频；定时自己刷、评论、回评论；抽帧看画面、把截图发出来（bili_watch / bili_comment / qq_send_shot）',
  tab: 'bili',
  files: ['bili/duty.js', 'bili/api.js', 'bili/vision.js', 'bili/shots.js'],
  setup(api) {
    const { hub } = api.core
    const bili = createBili({ getConfig: api.config, hub, memory: api.lazy('memory'), log: api.log, dsh: api.dsh })
    api.every(60_000, () => bili.tick(), '刷B站')

    // 看视频谁发的链接都能看，评论要主人开口
    api.tool(({ chat, sessionId }) => {
      if (!api.config().bili.enabled || chat.kind === 'system') return []
      return [
        defineTool({
          name: 'bili_watch',
          description: '打开一个 B 站视频看看：读标题、简介、字幕和热评，看完再跟大家聊。别人发来 B 站链接、BV 号或分享卡片时用。link 填链接或 BV 号。',
          properties: { link: str('B 站链接、b23.tv 短链或 BV 号') },
          required: ['link'],
          execute: async ({ link }) => bili.watch(String(link || '')),
        }),
        defineTool({
          name: 'bili_comment',
          description: '在一个 B 站视频下发评论（只有主人让你发的时候才用）。link 填链接或 BV 号，text 是评论内容。',
          properties: { link: str('B 站链接或 BV 号'), text: str('评论内容') },
          required: ['link', 'text'],
          execute: async ({ link, text }) => {
            if (!hub.turnHasOwner(sessionId)) return { ok: false, message: '只有主人能让我去发评论' }
            return bili.comment(String(link || ''), String(text || ''))
          },
        }),
        // 截图：刷 B 站看画面时截下来的那些帧，存在本机，随时能挑一张发出来
        defineTool({
          name: 'qq_send_shot',
          description: '把你在 B 站视频里截到的画面发到当前聊天。主人说「发张截图」「给我看看你刷到的」「刚才那个视频长啥样」这类话时用。query 填视频标题里的词或想看的内容，不填就挑最近的一张。',
          properties: { query: str('可选：视频标题关键词，或想看的内容') },
          required: [],
          execute: async ({ query }) => bili.sendShot({ chatId: chat.chatId, query: String(query || '') }),
        }),
        defineTool({
          name: 'qq_list_shots',
          description: '看看你手上还有哪些 B 站截图（来自哪个视频、第几秒）。挑截图之前可以先看一眼。',
          properties: { query: str('可选，按视频标题筛选') },
          required: [],
          execute: async ({ query }) => bili.listShots(String(query || '')),
        }),
      ]
    })

    api.route('/bili/state', async () => ({ ok: true, ...bili.state(), account: await bili.account() }))
    api.route('/bili/account', async () => bili.account(true))
    api.route('/bili/run', async () => bili.run({ force: true }))
    api.route('/bili/replies', async () => bili.checkReplies())
    // 截图库（面板里看全部、手动删）
    api.route('/bili/shots', async () => ({ ...bili.libraryShots(), limit: api.config().bili.shotLibrary }))
    api.route('/bili/shot/image', async (req, res) => {
      const p = bili.shotFileOf(api.core.http.query(req).file)
      if (!p) return api.core.http.send(res, 404, '')
      api.core.http.send(res, 200, readFileSync(p), 'image/jpeg')
    })
    api.route('/bili/shot/delete', async (req) => bili.deleteShot(String((await api.core.http.body(req)).file || '')))
    return bili
  },
}
