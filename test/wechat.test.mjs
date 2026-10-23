import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WorkbenchRepository } from '../lib/storage/repository.js'
import { stateOf, setSettings, editRules, editTask, editTasks, readFresh } from './helpers.mjs'
import { Engine } from '../lib/engine.js'
import { WorkbenchApi } from '../lib/api.js'
import { ChannelRegistry } from '../lib/channels/registry.js'
import { createWechatChannel } from '../lib/channels/wechat/channel.js'
import { WechatBridge, WechatConnector, appendPending, chatAllowed, segmentDue, segmentVerdict, transcript } from '../lib/channels/wechat/reader.js'

const here = fileURLToPath(new URL('.', import.meta.url))
const minutesAgo = m => new Date(Date.now() - m * 60000).toISOString()
const wechatRule = { name: '微信客户答复', enabled: true, priority: 100, account: '', folder: 'INBOX', match: { from: '', subject: '', hasAttachments: false, mode: 'all' }, instructions: '根据对话起草简短的微信回复。', tools: [], output: 'reply', maxRetries: 0, sources: ['wechat'] }
const settings = (patch = {}) => ({ enabled: true, people: { mode: 'allow', list: ['wxid_li'] }, groups: { mode: 'allow', list: [], scope: 'mention' }, ...patch })

function fakeWechat() {
  const chats = [
    { id: 'wxid_li', name: '李明', kind: 'person' },
    { id: 'wxid_mom', name: '妈妈', kind: 'person' },
    { id: '111@chatroom', name: '华东交付群', kind: 'group' },
    { id: '222@chatroom', name: '家人群', kind: 'group' },
  ]
  const messages = { wxid_li: [{ seq: 5, at: minutesAgo(60), sender: 'wxid_li', senderName: '李明', self: false, type: '文本', text: '历史消息' }], wxid_mom: [], '111@chatroom': [], '222@chatroom': [] }
  const polled = [], historyCalls = [], chatCalls = []
  let chatGate
  const service = {
    async status() { return { ready: true, wxid: 'wxid_me', name: '赵晓强', library: 'test' } },
    async chats() { chatCalls.push(Date.now()); if (chatGate) await chatGate; return [...chats] },
    async search(q) { return chats.filter(chat => chat.name.includes(q)) },
    async latest(ids) { return Object.fromEntries(ids.map(id => [id, Math.max(0, ...(messages[id] || []).map(m => m.seq))])) },
    async poll(marks) { polled.push(Object.keys(marks)); return Object.fromEntries(Object.entries(marks).map(([id, seq]) => [id, (messages[id] || []).filter(m => m.seq > seq)])) },
    async history(chat, offset, limit) { historyCalls.push(chat); return { messages: (messages[chat] || []).slice(-limit), more: false } },
  }
  let seq = 100
  const say = (chat, text, extra = {}) => { chats.find(c => c.id === chat).lastAt = new Date(Date.now() + seq).toISOString(); messages[chat].push({ seq: ++seq, at: extra.at ?? minutesAgo(10), sender: extra.self ? 'wxid_me' : extra.sender ?? chat, senderName: extra.self ? '赵晓强' : extra.senderName ?? chats.find(c => c.id === chat).name, self: !!extra.self, type: '文本', text, ...(extra.mentionsMe ? { mentionsMe: true } : {}) }) }
  return { service, say, polled, historyCalls, chatCalls, messages, chats, gate(promise) { chatGate = promise } }
}

async function fixture(t, { triage, agentOutput } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'bkms-wechat-'))
  const store = new WorkbenchRepository(root), fake = fakeWechat()
  let cleared = 0
  const connector = { service: s => s?.enabled ? fake.service : undefined, async clear() { cleared++ } }
  const runs = []
  const agent = { available: () => true, async run(task) { runs.push(task); return { output: structuredClone(agentOutput ?? { summary: '对方想今天拿到报价单。', text: '好的李总，今天下午发您。', checks: [{ item: '确认今天能出报价单', quote: '今天下午发您' }] }), sessionId: 's' } } }
  // No email provider at all: WeChat must work on its own.
  const channels = new ChannelRegistry(), channel = createWechatChannel(connector)
  channels.register(channel)
  const engine = new Engine(store, () => undefined, agent, undefined, triage, undefined, channels), api = new WorkbenchApi(engine)
  await engine.start()
  t.after(async () => { await engine.stop(); await store.close(); await rm(root, { recursive: true, force: true }) })
  // WeChat settings are saved under `settings.channels.wechat`.
  const configure = async ({ wechat, ...patch }) => { const state = await stateOf(store); return api.action({ action: 'saveSettings', revision: state.configRevision, settings: { enabled: true, ...patch, ...(wechat !== undefined ? { channels: { wechat } } : {}) } }) }
  const poll = () => engine.pollChannel(channel)
  /** The page's session-list request, with a signal of its own. */
  const chats = async signal => channel.actions.wechatChats({}, { settings: (await store.config()).settings.channels?.wechat, signal, log: async () => {} })
  const drain = async () => { for (let i = 0; i < 20 && (await stateOf(store)).tasks.some(task => task.status === 'queued'); i++) await engine.processNext() }
  return { root, store, engine, channel, api, fake, runs, configure, poll, chats, drain, get cleared() { return cleared } }
}
const tasks = async f => (await stateOf(f.store)).tasks

test('policy helpers: lists, segment timing and verdicts', () => {
  assert.equal(chatAllowed(settings(), 'wxid_li'), true)
  assert.equal(chatAllowed(settings(), 'wxid_mom'), false)
  assert.equal(chatAllowed(settings({ people: { mode: 'block', list: ['wxid_mom'] } }), 'wxid_x'), true)
  assert.equal(chatAllowed(settings({ people: { mode: 'block', list: ['wxid_mom'] } }), 'wxid_mom'), false)
  for (const id of ['gh_news', 'filehelper', '@placeholder_foldgroup']) assert.equal(chatAllowed(settings({ people: { mode: 'block', list: [] } }), id), false, id)
  assert.equal(chatAllowed({ ...settings(), enabled: false }, 'wxid_li'), false)
  const m = (seq, at, extra = {}) => ({ seq, at, sender: 'a', senderName: 'A', self: false, type: '文本', text: 't' + seq, ...extra })
  let p = appendPending(undefined, '群', true, [m(2, minutesAgo(1)), m(1, minutesAgo(2))], new Date().toISOString())
  p = appendPending(p, '群', true, [m(2, minutesAgo(1))], new Date().toISOString())
  assert.deepEqual(p.messages.map(x => x.seq), [1, 2], 'sorted and de-duplicated')
  assert.equal(segmentDue(p, Date.now(), 3), false)
  assert.equal(segmentDue(p, Date.now() + 3 * 60000, 3), true)
  assert.equal(segmentVerdict(p, 'mention'), 'not-mentioned')
  assert.equal(segmentVerdict(p, 'all'), 'task')
  assert.equal(segmentVerdict({ ...p, messages: [...p.messages, m(3, minutesAgo(0), { mentionsMe: true })] }, 'mention'), 'task')
  assert.equal(segmentVerdict({ ...p, messages: [...p.messages, m(4, minutesAgo(0), { self: true })] }, 'all'), 'answered')
  assert.equal(segmentVerdict({ ...p, messages: [m(5, minutesAgo(0), { self: true })] }, 'all'), 'no-others')
  assert.match(transcript([m(1, '2026-10-18T01:02:00Z'), m(2, '2026-10-18T01:03:00Z', { self: true, quote: { sender: 'A', text: '原话' } })]), /我：t2（引用 A：原话）/)
})

test('only allowed conversations are read; history outside the lists is refused', async t => {
  const f = await fixture(t)
  await f.configure({ wechat: settings() })
  await f.poll()
  assert.deepEqual(Object.keys((await stateOf(f.store)).wechat.watermarks), ['wxid_li'], 'baseline only for the allowed chat')
  f.fake.say('wxid_mom', '记得穿外套'); f.fake.say('wxid_li', '报价单能今天发吗？')
  await f.poll()
  assert.ok(f.fake.polled.every(ids => ids.every(id => id === 'wxid_li')), 'blocked chats are never polled')
  await assert.rejects(f.api.action({ action: 'wechatHistory', chat: 'wxid_mom' }), /不在允许读取/)
  await assert.rejects(f.api.action({ action: 'wechatHistory', chat: 'gh_news' }), /不在允许读取/)
  assert.equal((await f.api.action({ action: 'wechatHistory', chat: 'wxid_li' })).messages.at(-1).text, '报价单能今天发吗？')
  assert.deepEqual(f.fake.historyCalls, ['wxid_li'])
  // Block mode reads everyone except the blocked people; official accounts never.
  await f.configure({ wechat: settings({ people: { mode: 'block', list: ['wxid_mom'] } }) })
  f.channel.settings.changed()
  await f.poll()
  assert.deepEqual(Object.keys((await stateOf(f.store)).wechat.watermarks).sort(), ['wxid_li'], 'groups stay on their own (empty) allow list')
  await assert.rejects(f.api.action({ action: 'wechatHistory', chat: 'wxid_mom' }), /不在允许读取/)
})

test('history before enabling is not processed; a quiet segment becomes one task without any email provider', async t => {
  const f = await fixture(t)
  await f.api.action({ action: 'saveRule', revision: 1, rule: wechatRule })
  await f.configure({ wechat: settings() })
  await f.poll()
  assert.equal((await tasks(f)).length, 0, 'baseline only')
  f.fake.say('wxid_li', '赵经理，报价单能今天发吗？')
  f.fake.say('wxid_li', '我们下午要内部过一下', { at: minutesAgo(9) })
  await f.poll()
  const [task] = await tasks(f)
  assert.equal(task.source.kind, 'wechat'); assert.equal(task.account, 'wechat'); assert.equal(task.source.folder, 'wxid_li')
  assert.equal(task.channelData.messages.length, 2, 'two messages, one task'); assert.equal(task.title, '李明：我们下午要内部过一下')
  assert.match(task.body, /李明：赵经理，报价单能今天发吗？/)
  assert.equal(task.status, 'queued'); assert.equal(task.ruleName, '微信客户答复')
  await f.drain()
  const done = (await tasks(f))[0]
  assert.equal(done.status, 'review'); assert.equal(done.reply.text, '好的李总，今天下午发您。'); assert.equal(done.draftId, undefined, 'no email draft')
  assert.deepEqual(done.checks, [{ item: '确认今天能出报价单', quote: '今天下午发您' }])
  assert.equal(f.runs[0].source.kind, 'wechat')
  // A second poll does not create the same segment again.
  await f.poll(); assert.equal((await tasks(f)).length, 1)
})

test('a segment waits for the conversation to go quiet', async t => {
  const f = await fixture(t)
  await f.configure({ wechat: settings({ quietMinutes: 3 }) })
  await f.poll()
  f.fake.say('wxid_li', '在吗', { at: new Date().toISOString() })
  await f.poll()
  let state = await stateOf(f.store)
  assert.equal(state.tasks.length, 0); assert.equal(state.wechat.pending.wxid_li.messages.length, 1)
  await f.store.write(async tx => { const st = await tx.channelState('wechat'); st.entries.wxid_li.lastAt = minutesAgo(4); st.entries.wxid_li.firstAt = minutesAgo(4); await tx.setChannelState('wechat', st) })
  await f.poll()
  state = await stateOf(f.store)
  assert.equal(state.tasks.length, 1); assert.deepEqual(state.wechat.pending, {})
  assert.equal(state.tasks[0].status, 'unmatched', 'no WeChat workflow yet')
})

test('groups: only segments that mention you, unless the group scope is all; answered segments are dropped', async t => {
  const f = await fixture(t)
  await f.configure({ wechat: settings({ groups: { mode: 'allow', list: ['111@chatroom'], scope: 'mention' } }) })
  await f.poll()
  f.fake.say('111@chatroom', '今天华东线的车都排满了', { sender: 'wxid_qian', senderName: '钱多多' })
  await f.poll()
  assert.equal((await tasks(f)).length, 0, 'chatter without a mention is dropped')
  f.fake.say('111@chatroom', '车约好了', { sender: 'wxid_qian', senderName: '钱多多' })
  f.fake.say('111@chatroom', '@赵晓强 200 台能加急吗', { sender: 'wxid_wang', senderName: '王工', mentionsMe: true })
  await f.poll()
  let [task] = await tasks(f)
  assert.equal(task.channelData.group, true); assert.equal(task.channelData.mentioned, true); assert.equal(task.subject, '华东交付群')
  assert.match(task.body, /王工（@我）：@赵晓强 200 台能加急吗/); assert.match(task.body, /钱多多：车约好了/, 'context before the mention is kept')
  // Already answered in WeChat: nothing to do.
  f.fake.say('wxid_li', '能今天发吗？'); f.fake.say('wxid_li', '可以，下午发', { self: true })
  await f.configure({ wechat: settings({ groups: { mode: 'allow', list: ['111@chatroom'], scope: 'all' } }) })
  await f.poll(); await f.poll()
  assert.equal((await tasks(f)).length, 1)
  f.fake.say('111@chatroom', '周五前能到吗', { sender: 'wxid_qian', senderName: '钱多多' })
  await f.poll()
  assert.equal((await tasks(f)).length, 2, 'scope all handles unmentioned group messages')
})

test('triage sees the chat as WeChat and never archives it; email-only actions are refused; reply edit and mark handled', async t => {
  const seen = []
  const triage = { available: () => true, async run(input) { seen.push(input); return { category: 'notification', urgency: 'low', reason: '像是通知。', nextStep: '', ruleId: '' } } }
  const f = await fixture(t, { triage })
  await f.configure({ wechat: settings() })
  await f.poll()
  f.fake.say('wxid_li', '[链接] 行业报告')
  await f.poll(); await f.drain()
  let [task] = await tasks(f)
  assert.equal(seen[0].mail.channel, 'wechat')
  assert.equal(task.status, 'unmatched', 'not archived'); assert.ok(!task.triage.archived)
  // An email-only workflow does not receive WeChat segments.
  const emailRule = { ...wechatRule, name: '仅邮件', sources: undefined }
  await f.api.action({ action: 'saveRule', revision: (await stateOf(f.store)).configRevision, rule: emailRule })
  const trial = await f.api.action({ action: 'trialRule', rule: emailRule })
  assert.equal(trial.items[0].matched, false)
  const saved = await f.api.action({ action: 'saveRule', revision: (await stateOf(f.store)).configRevision, rule: wechatRule })
  await f.api.action({ action: 'runRule', id: task.id, revision: task.revision, ruleId: saved.id })
  await f.drain()
  task = (await tasks(f))[0]
  assert.equal(task.status, 'review')
  for (const action of ['saveDraft', 'previewSend', 'send', 'loadMail']) await assert.rejects(f.api.action({ action, id: task.id, revision: task.revision, confirmed: true }), /微信消息只读/)
  task = await f.api.action({ action: 'saveReply', id: task.id, revision: task.revision, replyRevision: task.reply.revision, text: '好的，下午三点前发您。' })
  assert.equal(task.reply.text, '好的，下午三点前发您。'); assert.equal(task.reply.revision, 2)
  task = await f.api.action({ action: 'markHandled', id: task.id, revision: task.revision })
  assert.equal(task.status, 'completed'); assert.match(task.history.at(-1).message, /已在微信中处理/)
})

test('removing a chat from the list forgets its progress; adding it back starts from new messages', async t => {
  const f = await fixture(t)
  await f.configure({ wechat: settings({ quietMinutes: 30 }) })
  await f.poll()
  f.fake.say('wxid_li', '第一句', { at: new Date().toISOString() })
  await f.poll()
  assert.ok((await stateOf(f.store)).wechat.pending.wxid_li)
  await f.configure({ wechat: settings({ people: { mode: 'allow', list: [] } }) })
  f.channel.settings.changed(); await f.poll()
  assert.deepEqual((await stateOf(f.store)).wechat, { watermarks: {}, pending: {} })
  f.fake.say('wxid_li', '你不在时说的话')
  await f.configure({ wechat: settings() })
  f.channel.settings.changed(); await f.poll(); await f.poll()
  assert.equal((await tasks(f)).length, 0, 're-added chat does not replay the gap')
})

test('unchanged conversations are not queried between sweeps', async t => {
  const f = await fixture(t)
  await f.configure({ wechat: settings({ people: { mode: 'block', list: [] } }) })
  f.fake.say('wxid_li', '旧消息'); f.fake.say('wxid_mom', '旧消息')
  await f.poll(); await f.poll()
  f.fake.polled.length = 0
  await f.poll()
  assert.deepEqual(f.fake.polled, [], 'nothing changed, nothing polled')
  await new Promise(resolve => setTimeout(resolve, 4100))
  f.fake.say('wxid_mom', '记得穿外套')
  await f.poll()
  assert.deepEqual(f.fake.polled, [['wxid_mom']], 'only the conversation that moved')
})

test('settings validation, status in the snapshot and clearing the local cache', async t => {
  const f = await fixture(t)
  await assert.rejects(f.configure({ wechat: settings({ people: { mode: 'allow', list: ['111@chatroom'] } }) }), /人员名单里不能放群聊/)
  await assert.rejects(f.configure({ wechat: settings({ groups: { mode: 'allow', list: ['wxid_li'], scope: 'mention' } }) }), /群聊名单里只能放群聊/)
  await assert.rejects(f.configure({ wechat: { ...settings(), extra: 1 } }), /微信设置无效/)
  await assert.rejects(f.configure({ wechat: settings({ quietMinutes: 0 }) }), /微信设置无效/)
  await assert.rejects(f.api.action({ action: 'wechatChats' }), /开启微信读取/)
  await f.configure({ wechat: settings({ names: { wxid_li: '李明' } }) })
  assert.equal((await f.api.action({ action: 'wechatStatus' })).name, '赵晓强')
  assert.equal((await f.api.action({ action: 'wechatChats' })).length, 4)
  assert.equal((await f.api.action({ action: 'wechatSearch', q: '李' }))[0].id, 'wxid_li')
  await f.poll()
  const snapshot = await f.api.snapshot()
  assert.deepEqual(snapshot.sources.find(source => source.kind === 'wechat'), { kind: 'wechat', connected: true, detail: '赵晓强' })
  assert.equal(snapshot.channels.wechat.watching, 1); assert.equal(snapshot.channels.wechat.settings.groups.scope, 'mention')
  await assert.rejects(f.api.action({ action: 'clearWechatCache' }), /确认/)
  await f.api.action({ action: 'clearWechatCache', confirmed: true }); assert.equal(f.cleared, 1)
})

test('the session list is answered from memory; one bridge query at a time; stale lists refresh in the background', async t => {
  const f = await fixture(t)
  await f.configure({ wechat: settings() })
  f.channel.settings.changed()
  f.fake.chatCalls.length = 0
  // Concurrent first requests share one bridge query.
  let open; f.fake.gate(new Promise(resolve => { open = resolve }))
  const first = Promise.all([f.api.action({ action: 'wechatChats' }), f.api.action({ action: 'wechatChats' })])
  await new Promise(resolve => setTimeout(resolve, 20))
  open(); f.fake.gate(undefined)
  const [a, b] = await first
  assert.equal(a.length, 4); assert.deepEqual(a, b)
  assert.equal(f.fake.chatCalls.length, 1, 'one query for both callers')
  // Fresh: answered from memory, the bridge is not asked.
  f.fake.chats[0] = { ...f.fake.chats[0], name: '李明（新）' }
  assert.equal((await f.api.action({ action: 'wechatChats' }))[0].name, '李明')
  assert.equal(f.fake.chatCalls.length, 1)
  // Older than a minute: the old list comes back at once and a refresh starts behind it.
  const start = Date.now()
  t.mock.method(Date, 'now', () => start + 61000)
  assert.equal((await f.api.action({ action: 'wechatChats' }))[0].name, '李明', 'stale list returned without waiting')
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(f.fake.chatCalls.length, 2)
  Date.now.mock.restore()
  assert.equal((await f.api.action({ action: 'wechatChats' }))[0].name, '李明（新）', 'refreshed list is used next time')
  // A page that goes away stops waiting without cancelling the shared query.
  f.channel.settings.changed()
  f.fake.gate(new Promise(resolve => { open = resolve }))
  const controller = new AbortController()
  const waiting = f.chats(controller.signal)
  const other = f.api.action({ action: 'wechatChats' })
  await new Promise(resolve => setTimeout(resolve, 20))
  controller.abort(new Error('页面已离开'))
  await assert.rejects(waiting, /页面已离开/)
  open(); f.fake.gate(undefined)
  assert.equal((await other).length, 4)
  // Lists changed while a query was in flight: its answer is not kept as the cache.
  f.channel.settings.changed()
  f.fake.gate(new Promise(resolve => { open = resolve }))
  const before = f.api.action({ action: 'wechatChats' })
  await new Promise(resolve => setTimeout(resolve, 20))
  f.channel.settings.changed()
  open(); f.fake.gate(undefined)
  await before
  const calls = f.fake.chatCalls.length
  await f.api.action({ action: 'wechatChats' })
  assert.equal(f.fake.chatCalls.length, calls + 1, 'old answer dropped after the lists changed')
})

const python = ['python3', 'python'].find(cmd => spawnSync(cmd, ['--version']).status === 0)
test('bridge unit tests (Python)', { skip: !python && 'Python not available' }, () => {
  const result = spawnSync(python, ['-m', 'unittest', 'wechat/test_bridge.py', 'wechat/test_wxread.py'], { cwd: join(here, '..'), encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
})

test('without a fixture the bridge uses the built-in reader and needs no wechatauto install', { skip: !python && 'Python not available' }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'bkms-wechat-builtin-'))
  // An empty PYTHONPATH and no upstream flag: the bridge must not try to import wechatauto.
  const bridge = new WechatBridge({ python, workdir: join(root, 'cache') })
  t.after(async () => { bridge.close(); await rm(root, { recursive: true, force: true }) })
  const status = await bridge.status()
  assert.equal(status.ready, false, 'no WeChat on this machine')
  assert.doesNotMatch(status.error, /No module named/, status.error)
  if (process.platform !== 'win32') assert.match(status.error, /只支持 Windows/)
})

test('end to end through the real bridge process with a fixture database', { skip: !python && 'Python not available' }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'bkms-wechat-bridge-'))
  const fixtureFile = join(here, 'fixtures', 'wechat.json')
  const bridge = new WechatBridge({ python, workdir: join(root, 'cache'), args: ['--fixture', fixtureFile] })
  // Hooks run in the order they were added, so everything is closed first: Windows cannot delete an open database.
  const closers = []
  t.after(async () => { for (const close of closers.reverse()) await close(); bridge.close(); await rm(root, { recursive: true, force: true }) })
  assert.deepEqual(await bridge.status(), { ready: true, protocol: 1, wxid: 'wxid_me', name: '赵晓强', library: 'fixture' })
  const chats = await bridge.chats()
  assert.deepEqual(chats.map(c => c.id), ['wxid_liming', '111@chatroom', 'wxid_mom', '222@chatroom'], 'official and system accounts are not listed')
  assert.ok(chats.every(c => !('summary' in c)), 'no message previews leave the bridge')
  const polled = await bridge.poll({ '111@chatroom': 0 })
  assert.equal(polled['111@chatroom'][1].mentionsMe, true); assert.equal(polled['111@chatroom'][0].senderName, '钱多多')
  // Through the engine, with the connector starting the same bridge.
  const store = new WorkbenchRepository(join(root, 'data'))
  const connector = new WechatConnector(join(root, 'cache'), ['--fixture', fixtureFile])
  const channels = new ChannelRegistry(), channel = createWechatChannel({ service: s => connector.service({ ...s, python }), clear: () => connector.clear() })
  channels.register(channel)
  const engine = new Engine(store, () => undefined, { available: () => false }, undefined, undefined, undefined, channels)
  await engine.start()
  closers.push(async () => { await engine.stop(); await store.close(); connector.close() })
  await setSettings(store, { enabled: true, channels: { wechat: { enabled: true, people: { mode: 'allow', list: ['wxid_liming'] }, groups: { mode: 'allow', list: [], scope: 'mention' } } } })
  await engine.pollChannel(channel)
  assert.equal((await stateOf(store)).wechat.watermarks.wxid_liming, 4000)
  const service = connector.service({ enabled: true, python, people: { mode: 'allow', list: [] }, groups: { mode: 'allow', list: [], scope: 'mention' } })
  await service.call('fixture_append', { chat: 'wxid_liming', row: { local_id: 9, sort_seq: 9000, type: '文本', sender_username: 'wxid_liming', create_time: Math.floor(Date.now() / 1000) - 600, content: '报价单今天能发吗？' } })
  await engine.pollChannel(channel)
  const [task] = (await stateOf(store)).tasks
  assert.equal(task.channelData.chatName, '李明 · 启明演示'); assert.match(task.body, /李明 · 启明演示：报价单今天能发吗？/)
  assert.equal(engine.health().channels.wechat.ready, true)
})
