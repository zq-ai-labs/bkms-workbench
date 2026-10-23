import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { WorkbenchRepository } from '../lib/storage/repository.js'
import { stateOf, setSettings, editRules, editTask, editTasks, readFresh } from './helpers.mjs'
import { Engine } from '../lib/engine.js'
import { WorkbenchApi } from '../lib/api.js'
import { validateRule, matches, chooseRule } from '../lib/rules.js'

const ruleInput = { name: '客户需求回复', enabled: true, priority: 100, account: '', folder: 'INBOX', match: { from: '', subject: '询价', hasAttachments: false, mode: 'all' }, instructions: '整理需求生成回复，不编造价格。', tools: [], output: 'reply', maxRetries: 1 }
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'bkms-workbench-'))
  const store = new WorkbenchRepository(root), drafts = new Map()
  let newMail = [], sends = 0, runs = 0, output = { summary: '已整理客户需求。', subject: 'Re: 产品询价', text: '您好，已收到您的产品需求。' }
  const email = {
    version: 1, accounts: () => [{ id: 'sales', address: 'sales@example.test', inboxFolder: 'INBOX' }],
    async scan({ cursor }) { return { cursor: { uidValidity: 123, lastUid: cursor ? Math.max(cursor.lastUid, ...newMail.map(m => m.uid)) : 10 }, messages: cursor ? newMail.filter(m => m.uid > cursor.lastUid) : [], firstRun: !cursor, reset: false, hasMore: false } },
    async read(account, folder, uid) { return { account, folder, uid, text: '请提供 100 件产品的报价。', from: [{ address: 'buyer@example.test' }], replyTo: [{ address: 'reply@example.test' }], attachments: [], messageId: 'mail@example.test', references: '' } },
    drafts: {
      async create(input) { const draft = { ...input, id: 'draft-' + drafts.size, revision: 1, state: 'draft', attachments: [] }; drafts.set(draft.id, draft); return structuredClone(draft) },
      async get(id) { const draft = drafts.get(id); if (!draft) throw new Error('missing draft'); return structuredClone(draft) },
      async update(id, revision, fields) { const draft = drafts.get(id); assert.equal(draft.revision, revision); Object.assign(draft, fields, { revision: revision + 1 }); return structuredClone(draft) },
      async preview(id, revision) { assert.equal(drafts.get(id).revision, revision); return { id: 'preview-' + revision, draft: structuredClone(drafts.get(id)) } },
      async send(id, plan, confirmed) { assert.equal(confirmed, true); assert.equal(plan, 'preview-' + drafts.get(id).revision); sends++; drafts.get(id).state = 'sent'; return { draft: structuredClone(drafts.get(id)) } },
    },
  }
  const agent = { available: () => true, async run(task, rule, signal) { signal.throwIfAborted(); runs++; return { output, sessionId: 'session-fixture' } } }
  const engine = new Engine(store, () => email, agent), api = new WorkbenchApi(engine)
  await engine.start()
  t.after(async () => { await engine.stop(); await store.close(); await rm(root, { recursive: true, force: true }) })
  return { root, store, email, engine, api, drafts, get sends() { return sends }, get runs() { return runs }, mail: value => { newMail = value }, output: value => { output = value } }
}
const mail = (uid = 11) => ({ uid, date: new Date().toISOString(), from: [{ address: 'buyer@example.test' }], subject: '产品询价', seen: true, hasAttachments: false })
test('preferences have defaults, persist independently and do not invoke email or pause processing', async t => {
  const f = await fixture(t)
  const initial = await stateOf(f.store)
  assert.equal(initial.settings.showWorkbench, true)
  assert.equal(initial.settings.notifyNewTodo, false)
  await f.api.action({ action: 'saveSettings', revision: initial.configRevision, settings: { enabled: true, pollSeconds: 90 } })
  const enabled = await stateOf(f.store)
  await f.api.action({ action: 'saveSettings', revision: enabled.configRevision, settings: { showWorkbench: false, notifyNewTodo: true } })
  const reloaded = await readFresh(f.root)
  assert.deepEqual(reloaded.settings, { enabled: true, pollSeconds: 90, showWorkbench: false, notifyNewTodo: true })
  await assert.rejects(f.api.action({ action: 'saveSettings', revision: enabled.configRevision, settings: { showWorkbench: true } }), error => error.code === 'conflict')
  for (const settings of [{ showWorkbench: 'false' }, { notifyNewTodo: 1 }, { pollSeconds: 29 }, { pollSeconds: 3601 }, { unexpected: true }, []]) {
    await assert.rejects(f.api.action({ action: 'saveSettings', revision: reloaded.configRevision, settings }))
  }
  assert.deepEqual((await stateOf(f.store)).settings, reloaded.settings)
  f.email.accounts = () => { throw new Error('preferences must not access mail') }
  const lightweight = await f.api.action({ action: 'preferences' })
  assert.equal(lightweight.settings.showWorkbench, false)
  assert.deepEqual(lightweight.attention, [])
  assert.equal(f.sends, 0); assert.equal(f.runs, 0)
})

test('global reminder endpoint exposes only attention identities, without mail bodies or drafts', async t => {
  const f = await fixture(t), task = await prepare(f)
  f.email.drafts.get = () => { throw new Error('no drafts should load') }
  const result = await f.api.action({ action: 'preferences' })
  assert.deepEqual(result.attention, [{ id: task.id, status: 'review' }])
  assert.ok(result.stateRevision >= 1)
  assert.equal(JSON.stringify(result).includes('buyer@example.test'), false)
  assert.equal(JSON.stringify(result).includes('请提供'), false)
  await f.api.action({ action: 'ignore', id: task.id, revision: task.revision })
  assert.deepEqual((await f.api.action({ action: 'preferences' })).attention, [])
})
async function prepare(f, rule = ruleInput) {
  await f.api.action({ action: 'saveRule', revision: 1, rule })
  await f.engine.poll(); f.mail([mail()]); await f.engine.poll(); await f.engine.processNext()
  return (await f.api.snapshot()).tasks[0]
}

test('rules: stable priority, case-insensitive criteria, all/any and unsafe tool validation', () => {
  const rule = validateRule(ruleInput), input = { account: 'sales', folder: 'INBOX', from: 'BUYER@example.test', subject: '产品询价', hasAttachments: false }
  assert.equal(matches(rule, input), true)
  assert.equal(matches({ ...rule, account: 'other' }, input), false)
  assert.equal(matches({ ...rule, match: { ...rule.match, from: 'missing', mode: 'any' } }, input), true)
  assert.equal(matches({ ...rule, match: { ...rule.match, from: 'missing', mode: 'all' } }, input), false)
  assert.equal(chooseRule([rule, { ...rule, id: 'priority', priority: 101 }], input).id, 'priority')
  assert.throws(() => validateRule({ ...ruleInput, tools: ['email_send'] }), /仅允许/)
  assert.throws(() => validateRule({ ...ruleInput, instructions: '' }), /必填/)
})

test('mail folder picker validates accounts and lists real paths or common paths across mailboxes', async t => {
  const f = await fixture(t), calls = []
  f.email.accounts = () => [{ id: 'sales', address: 'sales@example.test', inboxFolder: 'INBOX' }, { id: 'support', address: 'support@example.test', inboxFolder: 'INBOX' }]
  f.email.folders = async (account, signal) => { calls.push(account); signal.throwIfAborted(); return { account, folders: [{ path: 'INBOX', name: 'INBOX' }, { path: account === 'sales' ? '客户/询价' : '服务', name: '自定义' }] } }
  assert.deepEqual((await f.api.action({ action: 'folders', account: 'sales' })).folders.map(folder => folder.path), ['INBOX', '客户/询价'])
  const common = await f.api.action({ action: 'folders', account: '' })
  assert.equal(common.common, true); assert.deepEqual(common.folders.map(folder => folder.path), ['INBOX'])
  assert.equal(common.defaultFolder, 'INBOX')
  await assert.rejects(f.api.action({ action: 'folders', account: 'missing' }), /已配置/)
  assert.deepEqual(calls, ['sales', 'sales', 'support'])
  delete f.email.folders
  await assert.rejects(f.api.action({ action: 'folders', account: 'sales' }), /更新配套邮件插件/)
})

test('AI candidate generation does not save or enable processing; normal reviewed save is still required', async t => {
  const f = await fixture(t), before = await stateOf(f.store), received = []
  const api = new WorkbenchApi(f.engine, async (input, signal) => { signal.throwIfAborted(); received.push(input); return { rule: validateRule({ ...ruleInput, account: input.account, folder: input.folder }), warnings: [] } })
  const candidate = await api.action({ action: 'generateRule', description: ' 回复询价邮件 ', account: 'sales', folder: 'INBOX' })
  assert.deepEqual(received, [{ description: '回复询价邮件', account: 'sales', folder: 'INBOX' }])
  assert.deepEqual(await stateOf(f.store), before); assert.equal(f.runs, 0); assert.equal(f.sends, 0)
  for (const values of [{ description: '' }, { description: 'x'.repeat(8001) }, { account: 'missing' }, { folder: '' }]) await assert.rejects(api.action({ action: 'generateRule', description: '回复询价', account: 'sales', folder: 'INBOX', ...values }))
  assert.equal(received.length, 1)
  await api.action({ action: 'generateRule', description: '仍然生成中文回复', account: 'sales', folder: 'INBOX', uiLanguage: 'en' })
  assert.deepEqual(received[1], { description: '仍然生成中文回复', account: 'sales', folder: 'INBOX', uiLanguage: 'en' })
  assert.deepEqual(await stateOf(f.store), before)
  await api.action({ action: 'saveRule', rule: candidate.rule, revision: before.configRevision })
  assert.equal((await stateOf(f.store)).rules.length, 1)
  assert.equal((await stateOf(f.store)).settings.enabled, false)
})

test('AI generation is bounded to one request and plugin shutdown cancels it before draining', async t => {
  const f = await fixture(t); let entered
  const started = new Promise(resolve => { entered = resolve })
  const api = new WorkbenchApi(f.engine, async (_input, signal) => { entered(); await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })) })
  const body = { action: 'generateRule', description: '整理新邮件', account: 'sales', folder: 'INBOX' }
  const running = api.action(body); await started
  await assert.rejects(api.action(body), error => error.code === 'busy')
  const failed = assert.rejects(running, /生成已取消/)
  await api.close(); await failed
  await assert.rejects(api.action(body), error => error.code === 'stopping')
  assert.equal((await stateOf(f.store)).rules.length, 0)
})

test('AI instruction refinement works without mail, returns a candidate only and recovers after failure', async t => {
  const f = await fixture(t), before = await stateOf(f.store), received = []
  f.email.accounts = () => { throw new Error('must not read mail') }
  let fail = false, result = { instructions: '  整理客户需求，生成中文回复草稿。  ' }
  const api = new WorkbenchApi(f.engine, undefined, async (input, signal) => { signal.throwIfAborted(); received.push(input); if (fail) throw new Error('mock model failure'); return result })
  const body = { action: 'optimizeInstructions', instructions: '  帮我整理客户需求，生成中文回复。  ' }
  assert.deepEqual(await api.action(body), { instructions: '整理客户需求，生成中文回复草稿。' })
  assert.deepEqual(received, [{ instructions: body.instructions.trim() }])
  assert.deepEqual(await stateOf(f.store), before); assert.equal(f.runs, 0); assert.equal(f.sends, 0)
  for (const instructions of ['', '1234', 'x'.repeat(16001), '12345\0', null]) await assert.rejects(api.action({ ...body, instructions }), /5–16000/)
  assert.equal(received.length, 1)
  await assert.rejects(f.api.action(body), error => error.code === 'assistant_unavailable')
  fail = true; await assert.rejects(api.action(body), /mock model failure/)
  fail = false; await api.action(body)
  for (const invalid of [{ instructions: '短' }, { instructions: '有效的处理要求', tools: ['email_send'] }, { instructions: '12345\0' }]) {
    result = invalid; await assert.rejects(api.action(body), /格式无效/)
  }
  assert.deepEqual(await stateOf(f.store), before)
})

test('AI instruction refinement shares generation lock and is canceled and drained on shutdown', async t => {
  const f = await fixture(t); let entered
  const started = new Promise(resolve => { entered = resolve })
  const api = new WorkbenchApi(f.engine, async () => { throw new Error('must not generate') }, async (_input, signal) => {
    entered(); await new Promise((resolve, reject) => { if (signal.aborted) reject(signal.reason); else signal.addEventListener('abort', () => reject(signal.reason), { once: true }) })
  })
  const body = { action: 'optimizeInstructions', instructions: '整理客户需求并生成中文回复。' }
  const running = api.action(body); await started
  await assert.rejects(api.action(body), error => error.code === 'busy')
  await assert.rejects(api.action({ action: 'generateRule', description: '整理需求', account: 'sales', folder: 'INBOX' }), error => error.code === 'busy')
  const failed = assert.rejects(running, /已取消/)
  await api.close(); await failed
  await assert.rejects(api.action(body), error => error.code === 'stopping')
  assert.equal((await stateOf(f.store)).rules.length, 0)
})

test('store: concurrent writers retain changes, stale revision blocked and one worker per folder', async t => {
  const f = await fixture(t)
  await Promise.all(Array.from({ length: 8 }, (_, i) => f.store.write(tx => tx.log(String(i)))))
  assert.equal((await stateOf(f.store)).logs.length, 9)
  await f.api.action({ action: 'saveRule', rule: ruleInput, revision: 1 })
  await assert.rejects(f.api.action({ action: 'saveRule', rule: ruleInput, revision: 1 }), /配置已更新/)
  const second = new WorkbenchRepository(f.root)
  await assert.rejects(second.ownWorker(), /已有工作台/)
})

test('store: a corrupt database file is reported and preserved, never replaced', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bkms-corrupt-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(join(root, 'workbench.sqlite'), '{broken')
  const repo = new WorkbenchRepository(root)
  await assert.rejects(repo.config(), error => error.code === 'storage' && /无法打开/.test(error.message))
  await repo.close()
  assert.equal(await readFile(join(root, 'workbench.sqlite'), 'utf8'), '{broken')
})

test('end-to-end: baseline, already-read mail, dedup, draft edit, explicit send and no repeated send', async t => {
  const f = await fixture(t), task = await prepare(f)
  assert.equal(task.status, 'review'); assert.equal(task.draft.to, 'reply@example.test'); assert.equal(f.runs, 1)
  await f.engine.poll(); await f.engine.processNext(); assert.equal((await stateOf(f.store)).tasks.length, 1); assert.equal(f.runs, 1)
  await f.api.action({ action: 'saveDraft', id: task.id, revision: task.revision, draftRevision: task.draft.revision, draft: { to: task.draft.to, cc: '', subject: '人工审核主题', text: '人工审核正文' } })
  const edited = (await f.api.snapshot()).tasks[0]
  const preview = await f.api.action({ action: 'previewSend', id: task.id, revision: edited.revision, draftRevision: edited.draft.revision })
  await assert.rejects(f.api.action({ action: 'send', id: task.id, revision: edited.revision, draftRevision: edited.draft.revision, planId: preview.id }), /明确确认/)
  await f.api.action({ action: 'send', id: task.id, revision: edited.revision, draftRevision: edited.draft.revision, planId: preview.id, confirmed: true })
  assert.equal(f.sends, 1); assert.equal((await f.api.snapshot()).tasks[0].status, 'sent')
  await assert.rejects(f.api.action({ action: 'send', id: task.id, revision: edited.revision, draftRevision: edited.draft.revision, planId: preview.id, confirmed: true }), /已更新/)
  assert.equal(f.sends, 1)
})

test('needs-info can continue; regenerate creates a new draft preserving human edits', async t => {
  const f = await fixture(t); f.output({ summary: '缺少报价', needsInfo: '请补充价格。' })
  const task = await prepare(f); assert.equal(task.status, 'needs_info'); assert.equal(task.draftId, undefined)
  await f.api.action({ action: 'supplement', id: task.id, revision: task.revision, text: '单价 100 元。' })
  f.output({ summary: '报价齐全', text: '单价 100 元。' }); await f.engine.processNext()
  const ready = (await f.api.snapshot()).tasks[0], old = structuredClone(ready.draft)
  await f.api.action({ action: 'retry', id: task.id, revision: ready.revision }); await f.engine.processNext()
  const next = (await f.api.snapshot()).tasks[0]
  assert.notEqual(next.draftId, old.id); assert.equal((await f.email.drafts.get(old.id)).text, old.text)
})

test('reports keep nonblocking information gaps while attachment blockers require action', async t => {
  const f = await fixture(t)
  f.output({ summary: '已根据可读取资料完成分析。', informationGaps: '项目日期未提供，待人工核实。' })
  const report = await prepare(f, { ...ruleInput, output: 'report' })
  assert.equal(report.status, 'completed')
  assert.equal(report.outputKind, 'report')
  assert.equal(report.informationGaps, '项目日期未提供，待人工核实。')
  assert.equal(report.error, undefined)
  assert.equal(f.drafts.size, 0)
  f.output({ summary: '附件未能解析。', needsInfo: 'PDF 缺少可读取文字层。', needsInfoKind: 'attachments' })
  await f.api.action({ action: 'retry', id: report.id, revision: report.revision })
  await f.engine.processNext()
  const blocked = (await f.api.snapshot()).tasks[0]
  assert.equal(blocked.status, 'needs_info')
  assert.equal(blocked.needsInfoKind, 'attachments')
  assert.equal(blocked.informationGaps, undefined)
  assert.equal(f.sends, 0)
})

test('latest workflow reprocessing is explicit, revision checked, and preserves results and supplements', async t => {
  const f = await fixture(t)
  f.output({ summary: '原分析结果', needsInfo: '需要补充资料。' })
  const task = await prepare(f)
  await f.api.action({ action: 'supplement', id: task.id, revision: task.revision, text: '第一份补充资料' })
  await f.engine.processNext()
  let snapshot = await f.api.snapshot(), current = snapshot.tasks[0]
  const originalRule = snapshot.rules[0]
  const saved = await f.api.action({ action: 'saveRule', rule: { ...originalRule, tools: ['read_document'], instructions: '读取文档后生成分析报告。', output: 'report' }, revision: snapshot.revision })
  assert.equal(saved.revision, snapshot.revision + 1, 'save returns the committed configuration revision')
  snapshot = await f.api.snapshot()
  assert.equal(snapshot.tasks[0].ruleUpdated, true)
  assert.equal(snapshot.tasks[0].outputKind, 'reply')
  await assert.rejects(f.api.action({ action: 'runRule', id: current.id, revision: current.revision, ruleId: saved.id, ruleRevision: snapshot.revision - 1 }), /配置已更新/)
  const unchanged = await stateOf(f.store)
  assert.deepEqual(unchanged.tasks[0].rule.tools, [])
  await f.api.action({ action: 'runRule', id: current.id, revision: current.revision, ruleId: saved.id, ruleRevision: snapshot.revision, text: '第二份补充资料' })
  let queued = (await stateOf(f.store)).tasks[0]
  assert.deepEqual(queued.rule.tools, ['read_document'])
  assert.equal(queued.supplement, '第一份补充资料\n\n第二份补充资料')
  assert(queued.history.some(event => event.message.includes('原分析结果')))
  f.output({ summary: '已读取资料，生成完整报告。', informationGaps: '普通待确认项' })
  await f.engine.processNext()
  current = (await f.api.snapshot()).tasks[0]
  assert.equal(current.status, 'completed')
  assert.equal(current.ruleUpdated, false)
  assert.equal(current.outputKind, 'report')
  await assert.rejects(f.api.action({ action: 'supplement', id: current.id, revision: current.revision, text: 'x'.repeat(16000) }), /累计补充信息/)
  assert.equal((await stateOf(f.store)).tasks[0].supplement, queued.supplement)
  assert.equal(f.sends, 0)
})

test('send uncertainty prevents automatic retries; restart reconciles authoritative saved mail receipt', async t => {
  const f = await fixture(t), task = await prepare(f)
  f.email.drafts.send = async id => { f.drafts.get(id).state = 'uncertain'; return { draft: structuredClone(f.drafts.get(id)) } }
  await f.api.action({ action: 'send', id: task.id, revision: task.revision, draftRevision: task.draft.revision, planId: 'plan', confirmed: true })
  const uncertain = (await f.api.snapshot()).tasks[0]; assert.equal(uncertain.status, 'uncertain')
  assert.equal((await f.api.snapshot()).tasks[0].revision, uncertain.revision, 'polling an unchanged uncertain result must not invalidate confirmation')
  await assert.rejects(f.api.action({ action: 'retry', id: task.id, revision: uncertain.revision }), /不允许/)
  f.drafts.get(task.draftId).state = 'sent'
  assert.equal((await f.api.snapshot()).tasks[0].status, 'sent')
})

test('uncertain sends require explicit verification and exact revisions; recovery never sends', async t => {
  for (const outcome of ['sent', 'not_sent']) {
    const f = await fixture(t), task = await prepare(f)
    f.email.drafts.send = async id => { Object.assign(f.drafts.get(id), { state: 'uncertain', error: 'synthetic connect timeout' }); return { draft: structuredClone(f.drafts.get(id)) } }
    await f.api.action({ action: 'send', id: task.id, revision: task.revision, draftRevision: task.draft.revision, planId: 'plan', confirmed: true })
    const pending = (await f.api.snapshot()).tasks[0]
    const body = { action: 'resolveSend', id: task.id, revision: pending.revision, draftRevision: pending.draft.revision, outcome, confirmed: true }
    assert.equal(pending.canResolveSend, false)
    await assert.rejects(f.api.action(body), e => e.status === 503)
    let resolutions = 0
    f.email.drafts.resolveSend = async (id, revision, decision, confirmed) => {
      const draft = f.drafts.get(id); assert.equal(draft.revision, revision); assert.equal(confirmed, true); resolutions++
      Object.assign(draft, { state: decision === 'sent' ? 'sent' : 'draft', revision: revision + 1, sendChecks: [{ at: new Date().toISOString(), outcome: decision }] }); delete draft.error
      return structuredClone(draft)
    }
    assert.equal((await f.api.snapshot()).tasks[0].canResolveSend, true)
    await assert.rejects(f.api.action({ ...body, confirmed: false }))
    await assert.rejects(f.api.action({ ...body, outcome: 'guess' }))
    await assert.rejects(f.api.action({ ...body, draftRevision: 99 }), e => e.status === 409)
    await assert.rejects(f.api.action({ ...body, revision: 999 }), e => e.status === 409)
    assert.equal(resolutions, 0)
    await f.api.action(body)
    const result = (await f.api.snapshot()).tasks[0]
    assert.equal(result.status, outcome === 'sent' ? 'sent' : 'review'); assert.equal(result.error, undefined)
    assert.equal(result.draftId, task.draftId); assert.equal(result.draft.text, task.draft.text)
    assert.equal(result.draft.receipt, undefined); assert(result.history.some(h => h.message.includes('用户核对邮箱')))
    await assert.rejects(f.api.action(body)); assert.equal(resolutions, 1); assert.equal(f.sends, 0)
    // If the email backend committed but the task write was interrupted, the next snapshot recovers it.
    await editTask(f.store, 0, task => { task.status = 'uncertain' })
    assert.equal((await f.api.snapshot()).tasks[0].status, result.status)
  }
})

test('a definite pre-connect failure returns to review without repeated SMTP submission', async t => {
  const f = await fixture(t), task = await prepare(f)
  f.email.drafts.send = async id => { Object.assign(f.drafts.get(id), { state: 'draft', sendFailure: 'not_submitted', error: 'connection refused' }); return { draft: structuredClone(f.drafts.get(id)) } }
  await f.api.action({ action: 'send', id: task.id, revision: task.revision, draftRevision: task.draft.revision, planId: 'plan', confirmed: true })
  const result = (await f.api.snapshot()).tasks[0]
  assert.equal(result.status, 'review'); assert.equal(result.draftId, task.draftId); assert.match(result.error, /connection refused/)
  await editTask(f.store, 0, task => { task.status = 'uncertain' })
  assert.equal((await f.api.snapshot()).tasks[0].status, 'review'); assert.equal(f.sends, 0)
})

test('mailbox generation mismatch preserves cursor and records actionable failure', async t => {
  const f = await fixture(t); await f.engine.poll(); const before = (await stateOf(f.store)).cursors
  f.email.scan = async () => { throw new Error('邮箱 UIDVALIDITY 已改变，请确认后重建基线。') }
  await f.engine.poll()
  assert.deepEqual((await stateOf(f.store)).cursors, before)
  assert.match(f.engine.health().error, /UIDVALIDITY/)
})

test('HTTP: custom-header, origin, bounded body and format validation', async t => {
  const f = await fixture(t), url = 'http://127.0.0.1/api/bkms-workbench'
  const headers = { 'content-type': 'application/json', 'x-bkms-workbench': '1' }
  const send = (body, extra = {}) => f.api.fetch(new Request(url, { method: 'POST', headers: { ...headers, ...extra }, body }))
  assert.equal((await send('{"action":"snapshot"}')).status, 200)
  assert.equal((await send('{}', { origin: 'https://outside.test' })).status, 403)
  assert.equal((await send('{}', { 'sec-fetch-site': 'cross-site' })).status, 403)
  assert.equal((await send('{}', { 'x-bkms-workbench': '' })).status, 403)
  assert.equal((await send('x'.repeat(256 * 1024 + 1))).status, 413)
  assert.equal((await send('{broken')).status, 400)
})

test('snapshot reads provider drafts once and reports a draft storage failure without hiding tasks', async t => {
  const f = await fixture(t), task = await prepare(f)
  let lists = 0
  f.email.drafts.list = async () => { lists++; return [...f.drafts.values()].map(draft => structuredClone(draft)) }
  f.email.drafts.get = async () => { throw Error('per-task draft reads should not run') }
  const snapshot = await f.api.snapshot()
  assert.equal(lists, 1); assert.equal(snapshot.tasks[0].draft.id, task.draftId)
  f.email.drafts.list = async () => { throw Error('synthetic draft storage unavailable') }
  const failed = await f.api.snapshot()
  assert.equal(failed.tasks.length, 1); assert.equal(failed.tasks[0].draft, undefined)
  assert.match(failed.health.error, /draft storage unavailable/)
})

test('a database written by a newer workbench is refused, left as it was and never given a worker', async t => {
  const f = await fixture(t)
  await prepare(f)
  await f.engine.stop()
  // A newer build ran a migration this build does not know.
  const { DatabaseSync } = await import('node:sqlite')
  const raw = new DatabaseSync(join(f.root, 'workbench.sqlite'))
  raw.prepare("insert into zq_migrations (name, timestamp) values ('9999-future', ?)").run(new Date().toISOString())
  const before = raw.prepare('select count(*) as n from tasks').get().n
  raw.close()
  const engine = new Engine(new WorkbenchRepository(f.root), () => undefined, { available: () => false })
  await assert.rejects(engine.start(), error => error.code === 'storage-newer')
  assert.equal(engine.health().running, false)
  const release = await new WorkbenchRepository(f.root).ownWorker(); await release()
  const check = new DatabaseSync(join(f.root, 'workbench.sqlite'))
  assert.equal(check.prepare('select count(*) as n from tasks').get().n, before)
  check.close()
})

test('failed worker startup releases ownership while preserving the invalid data file', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bkms-start-failure-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = new WorkbenchRepository(root)
  await writeFile(join(root, 'workbench.sqlite'), '{broken')
  const engine = new Engine(store, () => undefined, { available: () => false })
  await assert.rejects(engine.start(), /无法打开/)
  assert.equal(engine.health().running, false)
  const release = await new WorkbenchRepository(root).ownWorker()
  await release()
  assert.equal(await readFile(join(root, 'workbench.sqlite'), 'utf8'), '{broken')
})

test('worker stop retains ownership until an in-flight preparation actually settles', async t => {
  const f = await fixture(t)
  await f.api.action({ action: 'saveRule', revision: 1, rule: ruleInput })
  await f.engine.poll(); f.mail([mail()]); await f.engine.poll()
  let unblock, entered
  const ready = new Promise(resolve => { entered = resolve })
  const held = new Promise(resolve => { unblock = resolve })
  f.engine.agent.run = async () => { entered(); await held; return { output: { summary: 'Late result', text: 'Must not produce a draft' } } }
  const execution = f.engine.processNext()
  await ready
  const stopped = f.engine.stop()
  await assert.rejects(new WorkbenchRepository(f.root).ownWorker(), /已有工作台/)
  unblock(); await execution; await stopped
  const release = await new WorkbenchRepository(f.root).ownWorker(); await release()
  assert.equal(f.drafts.size, 0)
  assert.equal((await stateOf(f.store)).tasks[0].status, 'failed')
})

test('an explicit baseline reset wins against an older in-flight poll without importing skipped mail', async t => {
  const f = await fixture(t)
  await f.engine.poll()
  let unblock, entered
  const ready = new Promise(resolve => { entered = resolve }), held = new Promise(resolve => { unblock = resolve })
  const initial = f.email.scan
  f.email.scan = async input => {
    if (!input.cursor) return { cursor: { uidValidity: 123, lastUid: 99 }, messages: [], firstRun: true, reset: false, hasMore: false }
    entered(); await held
    return { cursor: { uidValidity: 123, lastUid: 11 }, messages: [mail()], firstRun: false, reset: false, hasMore: false }
  }
  const polling = f.engine.poll(); await ready
  await assert.rejects(f.api.action({ action: 'resetBaseline', account: 'sales', folder: 'INBOX', confirmed: true, revision: 999 }), /配置已更新/)
  const mailSettings = await f.api.action({ action: 'mailSettings' })
  assert.equal('tasks' in mailSettings, false)
  assert.equal('rules' in mailSettings, false)
  assert.equal(mailSettings.accounts[0].id, 'sales')
  await f.api.action({ action: 'resetBaseline', account: 'sales', folder: 'INBOX', confirmed: true, revision: mailSettings.revision })
  unblock(); await polling
  const state = await stateOf(f.store)
  assert.equal(state.cursors[JSON.stringify(['sales', 'INBOX'])].lastUid, 99)
  assert.equal(state.tasks.length, 0)
  f.email.scan = initial
})

test('a draft created before task persistence is recovered with the same preparation key', async t => {
  const f = await fixture(t)
  await f.api.action({ action: 'saveRule', revision: 1, rule: ruleInput })
  await f.engine.poll(); f.mail([mail()]); await f.engine.poll()
  const create = f.email.drafts.create
  const keys = []
  f.email.drafts.create = async input => {
    keys.push(input.sourceKey)
    const found = [...f.drafts.values()].find(draft => draft.sourceKey === input.sourceKey)
    return found ? structuredClone(found) : create(input)
  }
  // The first save that would make the task reviewable fails, as if the process died right after the draft was created.
  const updateTask = f.store.updateTask.bind(f.store)
  let failedOnce = false
  f.store.updateTask = (id, revision, change) => updateTask(id, revision, async (task, tx) => {
    const result = await change(task, tx)
    if (!failedOnce && task.status === 'review') { failedOnce = true; throw Error('synthetic crash after provider draft creation') }
    return result
  })
  await f.engine.processNext()
  const failed = (await stateOf(f.store)).tasks[0]
  assert.equal(f.drafts.size, 1); assert.equal(failed.status, 'queued')
  // Force the configured retry due without changing the durable execution key.
  await editTask(f.store, 0, task => { delete task.nextAttemptAt })
  await f.engine.processNext()
  assert.equal(f.drafts.size, 1); assert.equal(keys[0], keys[1])
  assert.equal((await stateOf(f.store)).tasks[0].status, 'review')
})

test('retries preserve state and rule snapshot, respect due time, and stop at the configured limit', async t => {
  const f = await fixture(t)
  await f.api.action({ action: 'saveRule', revision: 1, rule: ruleInput })
  await f.engine.poll(); f.mail([mail()]); await f.engine.poll()
  let attempts = 0
  f.engine.agent.run = async () => { attempts++; throw Error('synthetic tool failure') }
  await f.engine.processNext()
  const pending = (await stateOf(f.store)).tasks[0]
  assert.equal(pending.status, 'queued'); assert.equal(pending.attempts, 1); assert.ok(pending.nextAttemptAt)
  await f.engine.processNext(); assert.equal(attempts, 1)
  await editRules(f.store, rules => { rules[0].instructions = 'Changed live rule' }); await editTask(f.store, 0, task => { delete task.nextAttemptAt })
  await f.engine.processNext()
  const failed = (await stateOf(f.store)).tasks[0]
  assert.equal(failed.status, 'failed'); assert.equal(failed.attempts, 2)
  assert.equal(failed.rule.instructions, ruleInput.instructions)
  await f.engine.processNext(); assert.equal(attempts, 2)
})

test('API shutdown rejects new admission and drains an accepted send across provider detachment', async t => {
  const f = await fixture(t), task = await prepare(f)
  let entered, unblock
  const ready = new Promise(resolve => { entered = resolve }), held = new Promise(resolve => { unblock = resolve })
  f.email.drafts.send = async id => { entered(); await held; f.drafts.get(id).state = 'sent'; return { draft: structuredClone(f.drafts.get(id)) } }
  const sending = f.api.action({ action: 'send', id: task.id, revision: task.revision, draftRevision: task.draft.revision, planId: 'synthetic-preview', confirmed: true })
  await ready
  let drained = false
  const closing = f.api.close().then(() => { drained = true })
  f.engine.email = () => { throw Error('provider detached') }
  await assert.rejects(f.api.action({ action: 'snapshot' }), /正在停止/)
  const rejected = await f.api.fetch(new Request('http://127.0.0.1/api/bkms-workbench', { method: 'POST', headers: { 'content-type': 'application/json', 'x-bkms-workbench': '1' }, body: '{"action":"snapshot"}' }))
  assert.equal(rejected.status, 503); assert.equal(drained, false)
  unblock(); await sending; await closing
  assert.equal(drained, true); assert.equal((await stateOf(f.store)).tasks[0].status, 'sent')
})

test('an unmatched mail can be loaded for manual review without running a rule or creating a draft', async t => {
  const f = await fixture(t)
  await f.engine.poll(); f.mail([mail()]); await f.engine.poll()
  const task = (await stateOf(f.store)).tasks[0]
  assert.equal(task.status, 'unmatched'); assert.equal(task.body, '')
  const original = f.email.read
  f.email.read = async (...args) => ({ ...(await original(...args)), uidValidity: 123, attachments: [{ filename: '需求.pdf', size: 5, contentType: 'application/pdf', part: '2' }] })
  const loaded = await f.api.action({ action: 'loadMail', id: task.id, revision: task.revision })
  assert.equal(loaded.mailLoaded, true); assert.equal(loaded.status, 'unmatched')
  assert.match(loaded.body, /100 件产品/); assert.equal(loaded.attachments[0].filename, '需求.pdf')
  assert.equal(loaded.revision, task.revision + 1)
  assert.equal(f.runs, 0); assert.equal(f.drafts.size, 0); assert.equal(f.sends, 0)
})

test('original-mail metadata persists on manual and automated reads without replacing the agent plain text', async t => {
  const f = await fixture(t), original = f.email.read
  const display = { bodyHtml: '<table><tr><td>Synthetic rich mail</td></tr></table>', to: [{ name: 'Service', address: 'sales@example.test' }], cc: [{ address: 'copy@example.test' }], date: '2026-10-15T05:35:00.000Z', size: 123456 }
  f.email.read = async (...args) => ({ ...(await original(...args)), ...display })
  const processed = await prepare(f)
  assert.equal(processed.bodyHtml, display.bodyHtml); assert.match(processed.body, /100 件产品/)
  assert.equal(processed.to, 'Service <sales@example.test>'); assert.equal(processed.cc, 'copy@example.test')
  assert.equal(processed.mailDate, display.date); assert.equal(processed.mailSize, display.size)
  const loaded = await f.api.action({ action: 'loadMail', id: processed.id, revision: processed.revision })
  assert.equal(loaded.bodyHtml, display.bodyHtml); assert.equal(loaded.replyTo, 'reply@example.test')
  // Re-reading a mail without HTML clears stale presentation data, retaining plain-text readability.
  f.email.read = original
  const plain = await f.api.action({ action: 'loadMail', id: loaded.id, revision: loaded.revision })
  assert.equal(plain.bodyHtml, undefined); assert.equal(plain.to, '')
  const stored = await readFresh(f.root)
  assert.equal(stored.tasks[0].bodyHtml, undefined); assert.equal(f.runs, 1); assert.equal(f.sends, 0)
})

test('manual original-mail loading rejects reassigned UIDs without overwriting the task', async t => {
  const f = await fixture(t)
  await f.engine.poll(); f.mail([mail()]); await f.engine.poll()
  const task = (await stateOf(f.store)).tasks[0], original = f.email.read
  f.email.read = async (...args) => ({ ...(await original(...args)), uidValidity: 456, text: 'Different message after UID reset' })
  await assert.rejects(f.api.action({ action: 'loadMail', id: task.id, revision: task.revision }), error => error.code === 'email-cursor-reset' && error.status === 409)
  const retained = (await stateOf(f.store)).tasks[0]
  assert.equal(retained.body, ''); assert.equal(retained.mailLoaded, undefined); assert.equal(retained.revision, task.revision)
})

test('source attachment downloads copy exact bytes into the task and use safe binary response headers', async t => {
  const f = await fixture(t)
  await f.engine.poll(); f.mail([mail()]); await f.engine.poll()
  const task = (await stateOf(f.store)).tasks[0], original = f.email.read
  const bytes = Buffer.from([0, 255, 4, 13, 10, 42]), filename = '订单 "附件"\r\n.pdf'
  const source = join(f.root, 'shared-download.bin')
  await writeFile(source, bytes)
  f.email.read = async (...args) => ({ ...(await original(...args)), uidValidity: 123, attachments: [{ filename, size: bytes.length, contentType: 'application/pdf', part: '2' }] })
  const loaded = await f.api.action({ action: 'loadMail', id: task.id, revision: task.revision })
  let downloads = 0
  f.email.downloadAttachment = async (account, folder, uid, index, workspace) => {
    downloads++
    assert.equal(account, 'sales'); assert.equal(folder, 'INBOX'); assert.equal(uid, 11); assert.equal(index, 0)
    assert.equal(workspace, join(f.root, 'tasks', task.id))
    return { path: source, filename }
  }
  const request = index => f.api.fetch(new Request('http://dsh.internal/api/bkms-workbench/attachment', { method: 'POST', headers: { 'content-type': 'application/json', 'x-bkms-workbench': '1', host: '127.0.0.1:9186', origin: 'http://127.0.0.1:9186', 'sec-fetch-site': 'same-origin' }, body: JSON.stringify({ id: task.id, revision: loaded.revision, index }) }))
  const response = await request(0)
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'application/octet-stream')
  assert.equal(response.headers.get('content-disposition'), "attachment; filename*=UTF-8''" + encodeURIComponent(filename))
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff'); assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes)
  const copies = await readdir(join(f.root, 'tasks', task.id))
  assert.equal(copies.length, 1); assert.equal(/[\r\n"/\\]/.test(copies[0]), false)
  assert.deepEqual(await readFile(join(f.root, 'tasks', task.id, copies[0])), bytes)
  assert.deepEqual(await readFile(source), bytes)
  for (const index of [-1, 1, '0', null]) { const rejected = await request(index); assert.equal(rejected.status, 400); assert.match((await rejected.json()).error, /附件索引无效/) }
  assert.equal(downloads, 1)
  f.email.read = async (...args) => ({ ...(await original(...args)), uidValidity: 456 })
  assert.equal((await request(0)).status, 409)
  assert.equal(downloads, 1, 'generation mismatch must fail before downloading')
})

const dshRoot = process.env.DSH_SOURCE_ROOT
test('real DSH lifecycle: authenticated carrier, provider leases and route/worker cleanup', { skip: !dshRoot }, async t => {
  const require = createRequire(join(dshRoot, 'packages/client/connection/package.json'))
  const [{ Context }, connectionPlugin, workbench] = await Promise.all([
    import(pathToFileURL(require.resolve('@deepseek-ai/cordis')).href),
    import(pathToFileURL(join(dshRoot, 'packages/client/connection/lib/index.js')).href),
    import('../lib/index.js'),
  ])
  const home = await mkdtemp(join(tmpdir(), 'bkms-lifecycle-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const ctx = new Context(), routes = []
  let record, leases = 0, unblockSend
  ctx.provide('credentials', {
    async readRecord() { return record },
    async modifyRecord(_key, fn) { const changed = await fn(record); if (changed !== undefined) record = changed; return record },
  })
  ctx.provide('webServer', { port: 0, register(route) { routes.push(route); return () => { const index = routes.indexOf(route); if (index >= 0) routes.splice(index, 1) } } })
  const connectionFiber = ctx.plugin(connectionPlugin); await connectionFiber.await()
  const email = { version: 1, accounts: () => [], suppressPopups() { leases++; let live = true; return () => { if (live) { live = false; leases-- } } } }
  let providerFiber = ctx.plugin(scope => scope.provide('emailWorkbench', email)); await providerFiber.await()
  let workbenchFiber = ctx.plugin(workbench); await workbenchFiber.await()
  const server = createServer((request, response) => {
    const route = routes.find(item => item.path === '/api')
    if (!route) { response.writeHead(404); response.end(); return }
    Promise.resolve(route.handler(request, response)).catch(() => { response.writeHead(500); response.end() })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const authority = '127.0.0.1:' + server.address().port, base = 'http://' + authority
  t.after(async () => {
    unblockSend?.()
    if (workbenchFiber) await workbenchFiber.dispose()
    if (providerFiber) await providerFiber.dispose()
    await connectionFiber.dispose(); await ctx.fiber.dispose()
    await new Promise(resolve => server.close(resolve))
    if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous
    await rm(home, { recursive: true, force: true })
  })
  const request = (cookie, extra = {}, body = { action: 'snapshot' }) => fetch(base + '/api/bkms-workbench', { method: 'POST', headers: { 'content-type': 'application/json', 'x-bkms-workbench': '1', ...(cookie ? { cookie } : {}), ...extra }, body: JSON.stringify(body) })
  assert.equal((await request()).status, 401)
  const token = new URL(ctx.connection.authenticatedUrl(base)), exchanged = {}
  ctx.connection.authorizeIndex({ method: 'GET', url: token.pathname + token.search, headers: { host: authority } }, { writeHead(status, headers) { exchanged.status = status; exchanged.headers = headers }, end() {} })
  const cookie = exchanged.headers['set-cookie'].split(';')[0]
  const authenticated = await request(cookie, { origin: base, 'sec-fetch-site': 'same-origin' })
  assert.equal(authenticated.status, 200)
  assert.equal((await authenticated.json()).value.health.email, true)
  assert.equal(leases, 1)
  assert.equal((await request(cookie, { origin: 'https://outside.test' })).status, 403)
  await providerFiber.dispose(); providerFiber = undefined
  assert.equal(leases, 0)
  assert.equal((await (await request(cookie)).json()).value.health.email, false)
  providerFiber = ctx.plugin(scope => scope.provide('emailWorkbench', email)); await providerFiber.await()
  assert.equal(leases, 1)
  const store = new WorkbenchRepository(join(home, 'data', 'bkms-workbench'))
  const taskId = randomUUID(), timestamp = new Date().toISOString()
  const draft = { id: 'synthetic-draft', revision: 1, account: 'sales', to: 'synthetic@example.test', cc: '', subject: 'Synthetic lifecycle', text: 'No real SMTP', attachments: [], state: 'draft' }
  let enteredSend
  const sendEntered = new Promise(resolve => { enteredSend = resolve }), sendHeld = new Promise(resolve => { unblockSend = resolve })
  email.drafts = {
    async get() { return structuredClone(draft) }, async list() { return [structuredClone(draft)] },
    async send() { enteredSend(); await sendHeld; draft.state = 'sent'; return { draft: structuredClone(draft) } },
  }
  await store.write(tx => tx.insertTask({ id: taskId, revision: 1, title: 'Synthetic lifecycle', subject: 'Synthetic lifecycle', account: 'sales', from: 'buyer@example.test', body: 'Test only', status: 'review', receivedAt: timestamp, updatedAt: timestamp, source: { account: 'sales', folder: 'INBOX', uid: 11, uidValidity: 123 }, attachments: [], history: [], attempts: 1, draftId: draft.id }))
  const sending = request(cookie, { origin: base, 'sec-fetch-site': 'same-origin' }, { action: 'send', id: taskId, revision: 1, draftRevision: 1, planId: 'synthetic-preview', confirmed: true })
  await sendEntered
  let disposed = false
  const disposal = workbenchFiber.dispose().then(() => { disposed = true })
  await new Promise(resolve => setTimeout(resolve, 25))
  assert.equal(disposed, false)
  await assert.rejects(store.ownWorker(), /已有工作台/)
  unblockSend(); assert.equal((await sending).status, 200)
  await disposal; workbenchFiber = undefined
  assert.equal(leases, 0)
  assert.equal((await request(cookie)).status, 404)
  assert.equal((await stateOf(store)).tasks[0].status, 'sent')
  let release
  for (let i = 0; i < 40 && !release; i++) {
    try { release = await store.ownWorker() } catch { await new Promise(resolve => setTimeout(resolve, 25)) }
  }
  assert.ok(release, 'unloaded plugin must release its worker lease')
  await release()
})
