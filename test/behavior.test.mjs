import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkbenchRepository } from '../lib/storage/repository.js'
import { Engine } from '../lib/engine.js'
import { WorkbenchApi } from '../lib/api.js'

/**
 * Behaviour through the public surface only: `WorkbenchApi` actions and snapshots, and the engine's driving
 * methods (poll, process, send). Nothing here reads or writes storage directly, so these tests stay unchanged
 * when the storage is replaced (docs/DESIGN-CORE-CHANNELS.md, phase 0). `openStorage` is the only line that
 * knows how storage is created.
 */
const openStorage = root => new WorkbenchRepository(root)

const quoteRule = { name: '询价回复', enabled: true, priority: 100, account: '', folder: 'INBOX', match: { from: '', subject: '', hasAttachments: false, mode: 'all' }, instructions: '根据客户来信生成报价回复草稿。', tools: [], output: 'reply', maxRetries: 0 }
const wechatRule = { ...quoteRule, name: '微信客户答复', instructions: '根据对话起草简短的微信回复。', sources: ['wechat'] }
const minutesAgo = m => new Date(Date.now() - m * 60000).toISOString()

function fakeEmail() {
  const inbox = [], bodies = new Map(), drafts = new Map()
  let uid = 10, sends = 0
  const email = {
    version: 1,
    accounts: () => [{ id: 'sales', address: 'sales@example.test', inboxFolder: 'INBOX' }],
    async scan({ cursor }) {
      const last = Math.max(10, ...inbox.map(m => m.uid))
      if (!cursor) return { cursor: { uidValidity: 7, lastUid: last }, messages: [], firstRun: true, reset: false, hasMore: false }
      return { cursor: { uidValidity: 7, lastUid: Math.max(cursor.lastUid, last) }, messages: inbox.filter(m => m.uid > cursor.lastUid), firstRun: false, reset: false, hasMore: false }
    },
    async read(account, folder, id) { const mail = bodies.get(id); return { uid: id, text: mail.text, from: [{ address: mail.address }], replyTo: [], attachments: [], messageId: `m${id}@example.test`, references: '', uidValidity: 7 } },
    drafts: {
      async create(input) { const draft = { ...input, id: 'draft-' + drafts.size, revision: 1, state: 'draft', attachments: [] }; drafts.set(draft.id, draft); return structuredClone(draft) },
      async get(id) { return structuredClone(drafts.get(id)) },
      async list() { return [...drafts.values()].map(draft => structuredClone(draft)) },
      async update(id, revision, fields) { const draft = drafts.get(id); if (draft.revision !== revision) throw Object.assign(new Error('草稿已变化'), { code: 'conflict' }); Object.assign(draft, fields, { revision: revision + 1 }); return structuredClone(draft) },
      async preview(id, revision) { return { id: 'preview-' + revision, matching: { blocked: false, rows: [] }, draft: structuredClone(drafts.get(id)) } },
      async send(id, plan, confirmed) { assert.equal(confirmed, true); assert.equal(plan, 'preview-' + drafts.get(id).revision); sends++; drafts.get(id).state = 'sent'; return { draft: structuredClone(drafts.get(id)) } },
    },
  }
  const deliver = (subject, address, text) => { uid++; bodies.set(uid, { address, text }); inbox.push({ uid, date: new Date().toISOString(), from: [{ address }], subject, seen: false, hasAttachments: false }); return uid }
  return { email, deliver, get sends() { return sends } }
}

function fakeWechat() {
  const chats = [{ id: 'wxid_li', name: '李明', kind: 'person' }, { id: 'wxid_mom', name: '妈妈', kind: 'person' }]
  const messages = { wxid_li: [], wxid_mom: [] }
  let seq = 100
  const service = {
    async status() { return { ready: true, wxid: 'wxid_me', name: '我', library: 'test' } },
    async chats() { return chats.map(chat => ({ ...chat })) },
    async search(q) { return chats.filter(chat => chat.name.includes(q)) },
    async latest(ids) { return Object.fromEntries(ids.map(id => [id, Math.max(0, ...messages[id].map(m => m.seq))])) },
    async poll(marks) { return Object.fromEntries(Object.entries(marks).map(([id, from]) => [id, messages[id].filter(m => m.seq > from)])) },
    async history(chat, offset, limit) { return { messages: messages[chat].slice(-limit), more: false } },
  }
  const say = (chat, text) => { chats.find(c => c.id === chat).lastAt = new Date(Date.now() + seq).toISOString(); messages[chat].push({ seq: ++seq, at: minutesAgo(10), sender: chat, senderName: chats.find(c => c.id === chat).name, self: false, type: '文本', text }) }
  return { connector: { service: s => s?.enabled ? service : undefined, async clear() {} }, say }
}

async function fixture(t, { triage, email = true, wechat = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'bkms-behavior-'))
  const mail = fakeEmail(), chat = fakeWechat(), received = []
  let output = { summary: '已整理客户需求。', subject: 'Re: 报价', text: '您好，报价如下。' }, failure
  const agent = { available: () => true, async run(task, rule, signal) { signal.throwIfAborted(); received.push(task); if (failure) throw new Error(failure); return { output: structuredClone(output), sessionId: 's' } } }
  const engine = new Engine(openStorage(root), () => email ? mail.email : undefined, agent, undefined, triage, undefined, wechat ? chat.connector : undefined)
  const api = new WorkbenchApi(engine)
  await engine.start()
  t.after(async () => { await engine.stop(); await rm(root, { recursive: true, force: true }) })
  const snapshot = () => api.snapshot()
  const task = async (pick = () => true) => (await snapshot()).tasks.find(pick)
  const drain = async () => { for (let i = 0; i < 20; i++) { if (!(await snapshot()).tasks.some(item => item.status === 'queued' && !item.nextAttemptAt)) return; await engine.processNext() } }
  const saveRule = async rule => { const { revision } = await snapshot(); return api.action({ action: 'saveRule', revision, rule }) }
  const saveSettings = async settings => { const { revision } = await snapshot(); return api.action({ action: 'saveSettings', revision, settings }) }
  /** Deliver one mail and receive it; the first poll only sets the baseline. */
  const receive = async (subject, address = 'buyer@example.test', text = '请报 100 件的价格。') => { await engine.poll(); mail.deliver(subject, address, text); await engine.poll() }
  return { api, engine, mail, chat, received, snapshot, task, drain, saveRule, saveSettings, receive, output: value => { output = value }, fail: value => { failure = value } }
}
const verdict = fn => ({ available: () => true, async run(input) { return { category: 'request', urgency: 'normal', reason: '客户来信。', nextStep: '', ruleId: '', ...fn(input) } } })
const rejectsWith = (promise, code) => assert.rejects(promise, error => error.code === code)

test('email: a new message becomes a reply draft waiting for review, exactly once', async t => {
  const f = await fixture(t)
  await f.saveRule(quoteRule)
  await f.receive('产品询价')
  await f.engine.poll()
  assert.equal((await f.snapshot()).tasks.length, 1, 'polling again does not duplicate the message')
  assert.equal((await f.task()).status, 'queued')
  await f.drain()
  const task = await f.task()
  assert.equal(task.status, 'review')
  assert.equal(task.ruleName, quoteRule.name)
  assert.equal(task.draft.text, '您好，报价如下。')
  assert.equal(task.draft.to, 'buyer@example.test')
  assert.equal(task.attention, true)
  assert.match(task.body, /100 件/)
  assert.equal('workspace' in task, false, 'internal paths stay on the server')
  assert.equal('rule' in task, false, 'the rule snapshot stays on the server')
  assert.equal(task.draft.sourceKey, undefined)
  assert.deepEqual((await f.api.action({ action: 'preferences' })).attention, [{ id: task.id, status: 'review' }])
})

test('email: reviewing, previewing and sending a draft, with revision checks', async t => {
  const f = await fixture(t)
  await f.saveRule(quoteRule)
  await f.receive('产品询价'); await f.drain()
  const before = await f.task()
  const saved = await f.api.action({ action: 'saveDraft', id: before.id, revision: before.revision, draftRevision: before.draft.revision, draft: { to: before.draft.to, cc: '', subject: before.draft.subject, text: '您好，100 件单价 20 元。' } })
  assert.equal(saved.revision, 2)
  const edited = await f.task()
  assert.ok(edited.revision > before.revision)
  assert.equal(edited.draft.text, '您好，100 件单价 20 元。')
  await rejectsWith(f.api.action({ action: 'previewSend', id: edited.id, revision: before.revision, draftRevision: saved.revision }), 'conflict')
  const plan = await f.api.action({ action: 'previewSend', id: edited.id, revision: edited.revision, draftRevision: saved.revision })
  await assert.rejects(f.api.action({ action: 'send', id: edited.id, revision: edited.revision, draftRevision: saved.revision, planId: plan.id }), 'sending needs an explicit confirmation')
  assert.equal(f.mail.sends, 0)
  await f.api.action({ action: 'send', id: edited.id, revision: edited.revision, draftRevision: saved.revision, planId: plan.id, confirmed: true })
  const sent = await f.task()
  assert.equal(sent.status, 'sent')
  assert.equal(sent.attention, false)
  assert.equal(f.mail.sends, 1)
  await rejectsWith(f.api.action({ action: 'ignore', id: sent.id, revision: sent.revision }), 'invalid')
})

test('configuration: stale revisions conflict and unknown tasks are missing', async t => {
  const f = await fixture(t)
  const { revision } = await f.snapshot()
  const rule = await f.saveRule(quoteRule)
  await rejectsWith(f.api.action({ action: 'saveSettings', revision, settings: { pollSeconds: 90 } }), 'conflict')
  await rejectsWith(f.api.action({ action: 'saveRule', revision, rule: { ...quoteRule, name: '改名' } }), 'conflict')
  await f.saveSettings({ pollSeconds: 90 })
  assert.equal((await f.snapshot()).settings.pollSeconds, 90)
  await assert.rejects(f.saveSettings({ pollSeconds: 10 }))
  await assert.rejects(f.saveSettings({ unexpected: true }))
  await rejectsWith(f.api.action({ action: 'ignore', id: '00000000-0000-4000-8000-000000000000', revision: 1 }), 'missing')
  const current = await f.snapshot()
  assert.equal(current.rules.length, 1)
  await f.api.action({ action: 'deleteRule', revision: current.revision, id: rule.id })
  assert.equal((await f.snapshot()).rules.length, 0)
})

test('failures: a failed preparation can be retried and supplemented', async t => {
  const f = await fixture(t)
  await f.saveRule(quoteRule)
  f.fail('模型服务不可用')
  await f.receive('产品询价'); await f.drain()
  const failed = await f.task()
  assert.equal(failed.status, 'failed')
  assert.match(failed.error, /模型服务不可用/)
  assert.equal(failed.attention, true)
  f.fail(undefined)
  await f.api.action({ action: 'supplement', id: failed.id, revision: failed.revision, text: '单价按 20 元报。' })
  assert.equal((await f.task()).status, 'queued')
  await f.drain()
  const done = await f.task()
  assert.equal(done.status, 'review')
  assert.equal(f.received.at(-1).supplement, '单价按 20 元报。')
  await f.api.action({ action: 'retry', id: done.id, revision: done.revision })
  await f.drain()
  assert.equal(f.received.length, 3)
  const again = await f.task()
  await f.api.action({ action: 'ignore', id: again.id, revision: again.revision })
  assert.equal((await f.task()).status, 'ignored')
})

test('triage: notices are archived, restoring one keeps that sender from being archived again', async t => {
  const f = await fixture(t, { triage: verdict(input => input.mail.subject.includes('账单') ? { category: 'notification', reason: '系统账单通知。' } : {}) })
  await f.saveRule(quoteRule)
  await f.receive('十月账单', 'billing@service.test', '本月账单已出。')
  await f.drain()
  const archived = await f.task()
  assert.equal(archived.status, 'ignored')
  assert.equal(archived.triage.archived, true)
  const entry = (await f.snapshot()).activity.find(item => item.kind === 'archive')
  assert.equal(entry.taskId, archived.id)
  await f.api.action({ action: 'undoActivity', activityId: entry.id })
  const restored = await f.task(item => item.id === archived.id)
  assert.equal(restored.status, 'unmatched')
  assert.equal(restored.triage.archived, false)
  await f.receive('十一月账单', 'billing@service.test', '本月账单已出。')
  await f.drain()
  const next = await f.task(item => item.subject === '十一月账单')
  assert.notEqual(next.status, 'ignored', 'a restored sender is not archived again')
  assert.equal(next.triage.by, 'preference')
})

test('matching: an uncertain suggestion is confirmed or rejected, and both are learned', async t => {
  let ruleId = ''
  const f = await fixture(t, { triage: verdict(() => ({ ruleId, confidence: 'medium', ruleReason: '像是询价。' })) })
  ruleId = (await f.saveRule(quoteRule)).id
  await f.receive('请教一下')
  await f.drain()
  const suggested = await f.task()
  assert.equal(suggested.status, 'unmatched')
  assert.equal(suggested.match.state, 'suggested')
  assert.equal(suggested.match.ruleId, ruleId)
  assert.equal(suggested.attention, true)
  await f.api.action({ action: 'runRule', id: suggested.id, revision: suggested.revision, ruleId })
  let examples = (await f.snapshot()).ruleExamples[ruleId]
  assert.deepEqual(examples.map(example => example.match), [true])
  await f.drain()
  const prepared = await f.task()
  assert.equal(prepared.status, 'review')
  assert.equal(prepared.match.by, 'manual')
  await f.api.action({ action: 'rejectRule', id: prepared.id, revision: prepared.revision })
  const rejected = await f.task()
  assert.equal(rejected.status, 'unmatched')
  assert.equal(rejected.match.state, 'rejected')
  examples = (await f.snapshot()).ruleExamples[ruleId]
  assert.deepEqual(examples.map(example => example.match), [false], 'a newer verdict on the same message replaces the older one')
  await f.api.action({ action: 'deleteExample', ruleId, exampleId: examples[0].id })
  assert.deepEqual((await f.snapshot()).ruleExamples[ruleId] ?? [], [])
})

test('autonomy: an automatic reply is scheduled and can be withdrawn; that contact then stays manual', async t => {
  const f = await fixture(t)
  await f.saveRule({ ...quoteRule, autonomy: 'auto' })
  await f.receive('确认收到')
  await f.drain()
  const scheduled = await f.task()
  assert.equal(scheduled.status, 'review')
  assert.ok(Date.parse(scheduled.autoSend.at) > Date.now(), 'sent only after the withdrawal window')
  assert.equal(scheduled.autoSend.canceledAt, undefined)
  assert.ok((await f.snapshot()).activity.some(item => item.kind === 'auto_send_scheduled' && item.taskId === scheduled.id))
  await f.engine.sendDue()
  assert.equal(f.mail.sends, 0, 'nothing is sent inside the window')
  await f.api.action({ action: 'cancelAutoSend', id: scheduled.id, revision: scheduled.revision })
  const withdrawn = await f.task()
  assert.ok(withdrawn.autoSend.canceledAt)
  assert.ok((await f.snapshot()).activity.some(item => item.kind === 'auto_send_canceled' && item.taskId === scheduled.id))
  await f.receive('再次确认')
  await f.drain()
  const next = await f.task(item => item.subject === '再次确认')
  assert.equal(next.status, 'review')
  assert.equal(next.autoSend, undefined, 'replies to a contact you withdrew from stay manual')
})

test('digest: topics, reports and the daily brief', async t => {
  const f = await fixture(t)
  await f.saveRule(quoteRule)
  await f.receive('产品询价'); await f.drain()
  const topic = await f.api.action({ action: 'saveTopic', topic: { name: '华东客户', kind: 'customer', keywords: ['询价'], senders: [], schedule: 'none' } })
  assert.equal((await f.snapshot()).topics[0].count, 1)
  await f.api.action({ action: 'refreshTopic', id: topic.id })
  assert.equal((await f.snapshot()).topics[0].summary.by, 'template')
  const brief = await f.api.action({ action: 'generateBrief' })
  assert.ok(brief.text)
  assert.equal((await f.snapshot()).brief.text, brief.text)
  const report = await f.api.action({ action: 'generateReport', kind: 'weekly' })
  assert.equal(report.by, 'template')
  await f.api.action({ action: 'saveReport', id: report.id, title: '本周小结', text: '已完成询价回复。' })
  assert.equal((await f.snapshot()).reports[0].title, '本周小结')
  await f.api.action({ action: 'deleteReport', id: report.id })
  assert.equal((await f.snapshot()).reports.length, 0)
  await f.api.action({ action: 'deleteTopic', id: topic.id })
  assert.equal((await f.snapshot()).topics.length, 0)
})

test('previews: testing and trying a workflow change nothing', async t => {
  const f = await fixture(t)
  await f.saveRule(quoteRule)
  await f.receive('产品询价'); await f.drain()
  const before = await f.snapshot(), task = before.tasks[0]
  assert.equal((await f.api.action({ action: 'testRule', rule: { ...quoteRule, match: { ...quoteRule.match, subject: '询价' } }, taskId: task.id })).matched, true)
  assert.equal((await f.api.action({ action: 'testRule', rule: { ...quoteRule, match: { ...quoteRule.match, subject: '投诉' } }, taskId: task.id })).matched, false)
  const trial = await f.api.action({ action: 'trialRule', rule: { ...quoteRule, matchMode: 'literal' } })
  assert.equal(trial.items.find(item => item.id === task.id).matched, true)
  const after = await f.snapshot()
  assert.equal(after.tasks.length, before.tasks.length)
  assert.equal(after.tasks[0].revision, task.revision)
  assert.equal(f.received.length, 1)
  assert.equal(f.mail.sends, 0)
})

test('baseline: rebuilding it needs confirmation and skips mail already in the folder', async t => {
  const f = await fixture(t)
  await f.saveRule(quoteRule)
  await f.engine.poll()
  f.mail.deliver('旧邮件', 'buyer@example.test', '之前的邮件。')
  const { revision } = await f.snapshot()
  await assert.rejects(f.api.action({ action: 'resetBaseline', revision, account: 'sales', folder: 'INBOX' }))
  await f.api.action({ action: 'resetBaseline', revision, account: 'sales', folder: 'INBOX', confirmed: true })
  await f.engine.poll()
  assert.equal((await f.snapshot()).tasks.length, 0)
  f.mail.deliver('新邮件', 'buyer@example.test', '新的询价。')
  await f.engine.poll()
  assert.deepEqual((await f.snapshot()).tasks.map(task => task.subject), ['新邮件'])
})

test('wechat: a conversation segment gets a suggested reply; it is read-only and copied by hand', async t => {
  const f = await fixture(t, { email: false, wechat: true })
  await f.saveRule(wechatRule)
  await f.saveSettings({ wechat: { enabled: true, people: { mode: 'allow', list: ['wxid_li'] }, groups: { mode: 'allow', list: [], scope: 'mention' } } })
  await f.engine.pollWechat()
  f.chat.say('wxid_li', '报价单今天能发吗？')
  f.chat.say('wxid_mom', '晚上回家吃饭吗？')
  await f.engine.pollWechat()
  const tasks = (await f.snapshot()).tasks
  assert.equal(tasks.length, 1, 'only allowed conversations are read')
  assert.equal(tasks[0].wechat.chatName, '李明')
  await f.drain()
  const task = await f.task()
  assert.equal(task.status, 'review')
  assert.equal(task.wechat.reply, '您好，报价如下。')
  await rejectsWith(f.api.action({ action: 'saveDraft', id: task.id, revision: task.revision, draftRevision: 1, draft: {} }), 'wechat-readonly')
  await rejectsWith(f.api.action({ action: 'send', id: task.id, revision: task.revision, draftRevision: 1, planId: 'x', confirmed: true }), 'wechat-readonly')
  await f.api.action({ action: 'saveReply', id: task.id, revision: task.revision, replyRevision: task.wechat.replyRevision, text: '好的，下午发您。' })
  const edited = await f.task()
  assert.equal(edited.wechat.reply, '好的，下午发您。')
  await rejectsWith(f.api.action({ action: 'saveReply', id: edited.id, revision: edited.revision, replyRevision: task.wechat.replyRevision, text: '旧版本' }), 'conflict')
  await rejectsWith(f.api.action({ action: 'wechatHistory', chat: 'wxid_mom' }), 'wechat-blocked')
  assert.equal((await f.api.action({ action: 'wechatHistory', chat: 'wxid_li' })).messages.length, 1)
  await f.api.action({ action: 'markHandled', id: edited.id, revision: edited.revision })
  assert.equal((await f.task()).status, 'completed')
})
