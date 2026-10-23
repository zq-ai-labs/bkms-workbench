import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkbenchRepository } from '../lib/storage/repository.js'
import { Engine } from '../lib/engine.js'
import { WorkbenchApi } from '../lib/api.js'
import { ChannelRegistry } from '../lib/channels/registry.js'
import { CHANNEL_API_VERSION } from '../lib/channels/types.js'

/**
 * Behaviour through the public surface only: `WorkbenchApi` actions and snapshots, and the engine's driving
 * methods (poll, process, send). Nothing here reads or writes storage directly, so these tests stay unchanged
 * when the storage is replaced (docs/DESIGN-CORE-CHANNELS.md, phase 0). `openStorage` is the only line that
 * knows how storage is created.
 */
const openStorage = root => new WorkbenchRepository(root)

const quoteRule = { name: '询价回复', enabled: true, priority: 100, account: '', folder: 'INBOX', match: { from: '', subject: '', hasAttachments: false, mode: 'all' }, instructions: '根据客户来信生成报价回复草稿。', tools: [], output: 'reply', maxRetries: 0 }
const demoRule = { ...quoteRule, name: '演示渠道答复', instructions: '根据对话起草简短的回复。', sources: ['demo'] }
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

/**
 * A channel the way a channel plugin builds one: the core knows nothing about it beyond the channel contract. Messages
 * arrive per conversation; replies are copied by hand. Errors use a class of their own with an HTTP status.
 */
function demoChannel({ apiVersion = CHANNEL_API_VERSION } = {}) {
  const inbox = [], polls = []
  let closed = 0
  class DemoError extends Error { constructor(message, code, status) { super(message); this.code = code; this.status = status } }
  const channel = {
    apiVersion, kind: 'demo', label: { zh: '演示', en: 'Demo' }, capabilities: { reply: 'copy', archive: false }, readonlyCode: 'demo-readonly',
    text: { readonly: '演示渠道只读。', notClassified: '演示渠道不参与业务分类。', replyNotEditable: '只有待审核的演示事项可以修改建议回复。', replyReady: '已生成建议回复。', handled: '已在演示渠道中处理。', handledLog: '演示事项已处理。', created: count => `演示渠道新增 ${count} 个事项。` },
    systemEnglish: { '演示渠道只读。': 'The demo channel is read-only.' },
    settings: { defaults: () => ({ enabled: false }), validate(input) { if (typeof input?.enabled !== 'boolean') throw new DemoError('演示设置无效。', 'demo-settings', 400); return { enabled: input.enabled } }, enabled: value => value?.enabled === true },
    health: () => ({ ready: true, name: '演示账号' }),
    async poll(settings, saved) {
      polls.push(structuredClone(saved))
      const fresh = inbox.filter(item => item.seq > (saved.cursors[item.chat] ?? 0))
      if (!fresh.length) return undefined
      return { commit(current) {
        const cursors = { ...current.cursors }, items = []
        for (const item of fresh) if (item.seq > (cursors[item.chat] ?? 0)) { cursors[item.chat] = item.seq; items.push({ scope: item.chat, position: item.seq, title: `${item.from}：${item.text}`, from: item.from, subject: item.chat, body: item.text, receivedAt: new Date().toISOString(), data: { chat: item.chat } }) }
        return { state: { cursors, entries: current.entries }, items, logs: [] }
      } }
    },
    ai: { agentInput: task => ({ conversation: { chat: task.subject, transcript: task.body } }), writingGuide: '简短回复。', exampleLabel: task => '演示 ' + task.subject },
    actions: {
      async demoEcho(body, { settings }) { return { echo: body.value, enabled: settings?.enabled === true } },
      async demoForbidden() { throw new DemoError('不允许。', 'demo-forbidden', 403) },
    },
    snapshot: (settings, saved) => ({ watching: Object.keys(saved.cursors).length }),
    close() { closed++ },
  }
  let seq = 0
  return { channel, polls, say: (chat, from, text) => inbox.push({ chat, from, text, seq: ++seq }), get closed() { return closed } }
}

async function fixture(t, { triage, email = true, channel } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'bkms-behavior-'))
  const mail = fakeEmail(), received = []
  let output = { summary: '已整理客户需求。', subject: 'Re: 报价', text: '您好，报价如下。' }, failure
  const agent = { available: () => true, async run(task, rule, signal) { signal.throwIfAborted(); received.push(task); if (failure) throw new Error(failure); return { output: structuredClone(output), sessionId: 's' } } }
  const channels = new ChannelRegistry()
  const unregister = channel ? channels.register(channel) : undefined
  const engine = new Engine(openStorage(root), () => email ? mail.email : undefined, agent, undefined, triage, undefined, channels)
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
  return { api, engine, mail, channels, unregister, received, snapshot, task, drain, saveRule, saveSettings, receive, output: value => { output = value }, fail: value => { failure = value } }
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

test('a channel from another plugin: items queue, the reply is copied by hand, mail actions are refused', async t => {
  const demo = demoChannel()
  const f = await fixture(t, { email: false, channel: demo.channel })
  await f.saveRule(demoRule)
  await rejectsWith(f.saveSettings({ channels: { demo: { enabled: 'yes' } } }), 'demo-settings')
  await rejectsWith(f.saveSettings({ channels: { other: { enabled: true } } }), 'channel-unavailable')
  await f.saveSettings({ channels: { demo: { enabled: true } } })
  demo.say('chat-1', '李明', '报价单今天能发吗？')
  assert.equal(await f.engine.pollChannel(demo.channel), 1)
  assert.equal(await f.engine.pollChannel(demo.channel), 0, 'the saved cursor keeps an item from being queued twice')
  let snapshot = await f.snapshot()
  assert.deepEqual(snapshot.channelInfo, [{ kind: 'demo', label: { zh: '演示', en: 'Demo' }, reply: 'copy', enabled: true, systemEnglish: { '演示渠道只读。': 'The demo channel is read-only.' } }])
  assert.deepEqual(snapshot.channels.demo, { watching: 1 })
  assert.deepEqual(snapshot.sources.find(source => source.kind === 'demo'), { kind: 'demo', connected: true, detail: '演示账号' })
  assert.equal(snapshot.tasks[0].source.kind, 'demo'); assert.deepEqual(snapshot.tasks[0].channelData, { chat: 'chat-1' })
  await f.drain()
  const task = await f.task()
  assert.equal(task.status, 'review'); assert.deepEqual(task.reply, { text: '您好，报价如下。', revision: 1 })
  assert.equal(f.received[0].source.kind, 'demo')
  await rejectsWith(f.api.action({ action: 'saveDraft', id: task.id, revision: task.revision, draftRevision: 1, draft: {} }), 'demo-readonly')
  await rejectsWith(f.api.action({ action: 'send', id: task.id, revision: task.revision, draftRevision: 1, planId: 'x', confirmed: true }), 'demo-readonly')
  await f.api.action({ action: 'saveReply', id: task.id, revision: task.revision, replyRevision: task.reply.revision, text: '好的，下午发您。' })
  const edited = await f.task()
  assert.deepEqual(edited.reply, { text: '好的，下午发您。', revision: 2 })
  await rejectsWith(f.api.action({ action: 'saveReply', id: edited.id, revision: edited.revision, replyRevision: 1, text: '旧版本' }), 'conflict')
  // Channel actions get the channel's own saved settings.
  assert.deepEqual(await f.api.action({ action: 'demoEcho', value: 7 }), { echo: 7, enabled: true })
  await f.api.action({ action: 'markHandled', id: edited.id, revision: edited.revision })
  const done = await f.task()
  assert.equal(done.status, 'completed'); assert.match(done.history.at(-1).message, /已在演示渠道中处理/)
})

test('an error from a channel keeps its HTTP status and code, whatever its class', async t => {
  const demo = demoChannel()
  const f = await fixture(t, { email: false, channel: demo.channel })
  const response = await f.api.fetch(new Request('http://127.0.0.1/api/bkms-workbench', { method: 'POST', headers: { 'content-type': 'application/json', 'x-bkms-workbench': '1' }, body: JSON.stringify({ action: 'demoForbidden' }) }))
  assert.equal(response.status, 403)
  assert.equal((await response.json()).code, 'demo-forbidden')
})

test('an uninstalled channel: its items stay visible and read-only; a channel for another version asks for an upgrade', async t => {
  const demo = demoChannel()
  const f = await fixture(t, { email: false, channel: demo.channel })
  await f.saveRule(demoRule)
  await f.saveSettings({ channels: { demo: { enabled: true } } })
  demo.say('chat-1', '李明', '在吗？')
  await f.engine.pollChannel(demo.channel)
  f.unregister()
  assert.equal(demo.closed, 1, 'removing the channel closes it')
  const snapshot = await f.snapshot()
  assert.deepEqual(snapshot.channelInfo, [])
  assert.equal(snapshot.tasks.length, 1, 'items from the channel are kept')
  await f.drain()
  const task = await f.task()
  assert.equal(task.status, 'queued', 'not processed without its channel')
  await rejectsWith(f.api.action({ action: 'saveDraft', id: task.id, revision: task.revision, draftRevision: 1, draft: {} }), 'channel-unavailable')
  await rejectsWith(f.api.action({ action: 'demoEcho' }), 'invalid')
  await rejectsWith(f.saveSettings({ channels: { demo: { enabled: false } } }), 'channel-unavailable')
  // Version mismatch: the channel is refused and the page is told which side to upgrade (D10).
  const remove = f.channels.register(demoChannel({ apiVersion: CHANNEL_API_VERSION + 1 }).channel)
  assert.deepEqual((await f.snapshot()).rejectedChannels, [{ kind: 'demo', label: { zh: '演示', en: 'Demo' }, upgrade: 'workbench' }])
  assert.deepEqual((await f.api.action({ action: 'preferences' })).rejectedChannels, [{ kind: 'demo', label: { zh: '演示', en: 'Demo' }, upgrade: 'workbench' }])
  remove()
  f.channels.register(demoChannel({ apiVersion: CHANNEL_API_VERSION - 1 }).channel)
  assert.equal((await f.snapshot()).rejectedChannels[0].upgrade, 'channel')
})
