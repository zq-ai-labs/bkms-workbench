import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { Store } from '../lib/store.js'
import { Engine } from '../lib/engine.js'
import { WorkbenchApi } from '../lib/api.js'
import { validateRule, matches, chooseRule } from '../lib/rules.js'

const ruleInput = { name: '客户需求回复', enabled: true, priority: 100, account: '', folder: 'INBOX', match: { from: '', subject: '询价', hasAttachments: false, mode: 'all' }, instructions: '整理需求生成回复，不编造价格。', tools: [], output: 'reply', maxRetries: 1 }
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'bkms-workbench-'))
  const store = new Store(root), drafts = new Map()
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
  t.after(async () => { await engine.stop(); await rm(root, { recursive: true, force: true }) })
  return { root, store, email, engine, api, drafts, get sends() { return sends }, get runs() { return runs }, mail: value => { newMail = value }, output: value => { output = value } }
}
const mail = (uid = 11) => ({ uid, date: new Date().toISOString(), from: [{ address: 'buyer@example.test' }], subject: '产品询价', seen: true, hasAttachments: false })
test('preferences migrate old data, persist independently and do not invoke email or pause processing', async t => {
  const f = await fixture(t)
  const legacy = await f.store.read()
  delete legacy.settings.showWorkbench; delete legacy.settings.notifyNewTodo
  await writeFile(f.store.file, JSON.stringify(legacy))
  const migrated = await f.store.read()
  assert.equal(migrated.settings.showWorkbench, true)
  assert.equal(migrated.settings.notifyNewTodo, false)
  await f.api.action({ action: 'saveSettings', revision: migrated.configRevision, settings: { enabled: true, pollSeconds: 90 } })
  const enabled = await f.store.read()
  await f.api.action({ action: 'saveSettings', revision: enabled.configRevision, settings: { showWorkbench: false, notifyNewTodo: true } })
  const reloaded = await new Store(f.root).read()
  assert.deepEqual(reloaded.settings, { enabled: true, pollSeconds: 90, showWorkbench: false, notifyNewTodo: true })
  await assert.rejects(f.api.action({ action: 'saveSettings', revision: enabled.configRevision, settings: { showWorkbench: true } }), error => error.code === 'conflict')
  for (const settings of [{ showWorkbench: 'false' }, { notifyNewTodo: 1 }, { pollSeconds: 29 }, { pollSeconds: 3601 }, { unexpected: true }, []]) {
    await assert.rejects(f.api.action({ action: 'saveSettings', revision: reloaded.configRevision, settings }))
  }
  assert.deepEqual((await f.store.read()).settings, reloaded.settings)
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
async function prepare(f) {
  await f.api.action({ action: 'saveRule', revision: 1, rule: ruleInput })
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
  const f = await fixture(t), before = await f.store.read(), received = []
  const api = new WorkbenchApi(f.engine, async (input, signal) => { signal.throwIfAborted(); received.push(input); return { rule: validateRule({ ...ruleInput, account: input.account, folder: input.folder }), warnings: [] } })
  const candidate = await api.action({ action: 'generateRule', description: ' 回复询价邮件 ', account: 'sales', folder: 'INBOX' })
  assert.deepEqual(received, [{ description: '回复询价邮件', account: 'sales', folder: 'INBOX' }])
  assert.deepEqual(await f.store.read(), before); assert.equal(f.runs, 0); assert.equal(f.sends, 0)
  for (const values of [{ description: '' }, { description: 'x'.repeat(8001) }, { account: 'missing' }, { folder: '' }]) await assert.rejects(api.action({ action: 'generateRule', description: '回复询价', account: 'sales', folder: 'INBOX', ...values }))
  assert.equal(received.length, 1)
  await api.action({ action: 'generateRule', description: '仍然生成中文回复', account: 'sales', folder: 'INBOX', uiLanguage: 'en' })
  assert.deepEqual(received[1], { description: '仍然生成中文回复', account: 'sales', folder: 'INBOX', uiLanguage: 'en' })
  assert.deepEqual(await f.store.read(), before)
  await api.action({ action: 'saveRule', rule: candidate.rule, revision: before.configRevision })
  assert.equal((await f.store.read()).rules.length, 1)
  assert.equal((await f.store.read()).settings.enabled, false)
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
  assert.equal((await f.store.read()).rules.length, 0)
})

test('AI instruction refinement works without mail, returns a candidate only and recovers after failure', async t => {
  const f = await fixture(t), before = await f.store.read(), received = []
  f.email.accounts = () => { throw new Error('must not read mail') }
  let fail = false, result = { instructions: '  整理客户需求，生成中文回复草稿。  ' }
  const api = new WorkbenchApi(f.engine, undefined, async (input, signal) => { signal.throwIfAborted(); received.push(input); if (fail) throw new Error('mock model failure'); return result })
  const body = { action: 'optimizeInstructions', instructions: '  帮我整理客户需求，生成中文回复。  ' }
  assert.deepEqual(await api.action(body), { instructions: '整理客户需求，生成中文回复草稿。' })
  assert.deepEqual(received, [{ instructions: body.instructions.trim() }])
  assert.deepEqual(await f.store.read(), before); assert.equal(f.runs, 0); assert.equal(f.sends, 0)
  for (const instructions of ['', '1234', 'x'.repeat(16001), '12345\0', null]) await assert.rejects(api.action({ ...body, instructions }), /5–16000/)
  assert.equal(received.length, 1)
  await assert.rejects(f.api.action(body), error => error.code === 'assistant_unavailable')
  fail = true; await assert.rejects(api.action(body), /mock model failure/)
  fail = false; await api.action(body)
  for (const invalid of [{ instructions: '短' }, { instructions: '有效的处理要求', tools: ['email_send'] }, { instructions: '12345\0' }]) {
    result = invalid; await assert.rejects(api.action(body), /格式无效/)
  }
  assert.deepEqual(await f.store.read(), before)
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
  assert.equal((await f.store.read()).rules.length, 0)
})

test('store: concurrent writers retain changes, stale revision blocked and corruption preserved', async t => {
  const f = await fixture(t)
  await Promise.all(Array.from({ length: 8 }, (_, i) => f.store.mutate(state => { state.logs.push({ id: String(i), at: '', level: 'info', message: String(i) }) })))
  assert.equal((await f.store.read()).logs.length, 9)
  await f.api.action({ action: 'saveRule', rule: ruleInput, revision: 1 })
  await assert.rejects(f.api.action({ action: 'saveRule', rule: ruleInput, revision: 1 }), /配置已更新/)
  const second = new Store(f.root)
  await assert.rejects(second.ownWorker(), /已有工作台/)
  await writeFile(f.store.file, '{broken')
  await assert.rejects(f.store.read(), /原文件已保留/)
  assert.equal(await readFile(f.store.file, 'utf8'), '{broken')
})

test('end-to-end: baseline, already-read mail, dedup, draft edit, explicit send and no repeated send', async t => {
  const f = await fixture(t), task = await prepare(f)
  assert.equal(task.status, 'review'); assert.equal(task.draft.to, 'reply@example.test'); assert.equal(f.runs, 1)
  await f.engine.poll(); await f.engine.processNext(); assert.equal((await f.store.read()).tasks.length, 1); assert.equal(f.runs, 1)
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

test('send uncertainty prevents automatic retries; restart reconciles authoritative saved mail receipt', async t => {
  const f = await fixture(t), task = await prepare(f)
  f.email.drafts.send = async id => { f.drafts.get(id).state = 'uncertain'; return { draft: structuredClone(f.drafts.get(id)) } }
  await f.api.action({ action: 'send', id: task.id, revision: task.revision, draftRevision: task.draft.revision, planId: 'plan', confirmed: true })
  const uncertain = (await f.api.snapshot()).tasks[0]; assert.equal(uncertain.status, 'uncertain')
  await assert.rejects(f.api.action({ action: 'retry', id: task.id, revision: uncertain.revision }), /不允许/)
  f.drafts.get(task.draftId).state = 'sent'
  assert.equal((await f.api.snapshot()).tasks[0].status, 'sent')
})

test('mailbox generation mismatch preserves cursor and records actionable failure', async t => {
  const f = await fixture(t); await f.engine.poll(); const before = (await f.store.read()).cursors
  f.email.scan = async () => { throw new Error('邮箱 UIDVALIDITY 已改变，请确认后重建基线。') }
  await f.engine.poll()
  assert.deepEqual((await f.store.read()).cursors, before)
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

test('malformed persisted cursors and task paths are preserved and never admitted to a worker', async t => {
  const f = await fixture(t), valid = await f.store.read()
  const broken = { ...valid, cursors: { mailbox: { uidValidity: 1, lastUid: -1 } } }
  await writeFile(f.store.file, JSON.stringify(broken))
  await assert.rejects(f.store.read(), /原文件已保留/)
  assert.equal(JSON.parse(await readFile(f.store.file, 'utf8')).cursors.mailbox.lastUid, -1)
  await writeFile(f.store.file, JSON.stringify(valid))
  const task = await prepare(f), unsafe = await f.store.read()
  unsafe.tasks[0].id = '../../outside'
  await writeFile(f.store.file, JSON.stringify(unsafe))
  await assert.rejects(f.store.read(), /原文件已保留/)
  assert.equal(JSON.parse(await readFile(f.store.file, 'utf8')).tasks[0].id, '../../outside')
})

test('failed worker startup releases ownership while preserving the invalid data file', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bkms-start-failure-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = new Store(root)
  await writeFile(store.file, '{broken')
  const engine = new Engine(store, () => undefined, { available: () => false })
  await assert.rejects(engine.start(), /原文件已保留/)
  assert.equal(engine.health().running, false)
  const release = await new Store(root).ownWorker()
  await release()
  assert.equal(await readFile(store.file, 'utf8'), '{broken')
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
  await assert.rejects(new Store(f.root).ownWorker(), /已有工作台/)
  unblock(); await execution; await stopped
  const release = await new Store(f.root).ownWorker(); await release()
  assert.equal(f.drafts.size, 0)
  assert.equal((await f.store.read()).tasks[0].status, 'failed')
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
  await f.api.action({ action: 'resetBaseline', account: 'sales', folder: 'INBOX', confirmed: true })
  unblock(); await polling
  const state = await f.store.read()
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
  const mutate = f.store.mutate.bind(f.store)
  let failedOnce = false
  f.store.mutate = fn => mutate(state => {
    const result = fn(state)
    if (!failedOnce && state.tasks[0]?.status === 'review') { failedOnce = true; throw Error('synthetic crash after provider draft creation') }
    return result
  })
  await f.engine.processNext()
  const failed = (await f.store.read()).tasks[0]
  assert.equal(f.drafts.size, 1); assert.equal(failed.status, 'queued')
  // Force the configured retry due without changing the durable execution key.
  await f.store.mutate(state => { delete state.tasks[0].nextAttemptAt })
  await f.engine.processNext()
  assert.equal(f.drafts.size, 1); assert.equal(keys[0], keys[1])
  assert.equal((await f.store.read()).tasks[0].status, 'review')
})

test('retries preserve state and rule snapshot, respect due time, and stop at the configured limit', async t => {
  const f = await fixture(t)
  await f.api.action({ action: 'saveRule', revision: 1, rule: ruleInput })
  await f.engine.poll(); f.mail([mail()]); await f.engine.poll()
  let attempts = 0
  f.engine.agent.run = async () => { attempts++; throw Error('synthetic tool failure') }
  await f.engine.processNext()
  const pending = (await f.store.read()).tasks[0]
  assert.equal(pending.status, 'queued'); assert.equal(pending.attempts, 1); assert.ok(pending.nextAttemptAt)
  await f.engine.processNext(); assert.equal(attempts, 1)
  await f.store.mutate(state => { state.rules[0].instructions = 'Changed live rule'; delete state.tasks[0].nextAttemptAt })
  await f.engine.processNext()
  const failed = (await f.store.read()).tasks[0]
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
  assert.equal(drained, true); assert.equal((await f.store.read()).tasks[0].status, 'sent')
})

test('an unmatched mail can be loaded for manual review without running a rule or creating a draft', async t => {
  const f = await fixture(t)
  await f.engine.poll(); f.mail([mail()]); await f.engine.poll()
  const task = (await f.store.read()).tasks[0]
  assert.equal(task.status, 'unmatched'); assert.equal(task.body, '')
  const original = f.email.read
  f.email.read = async (...args) => ({ ...(await original(...args)), uidValidity: 123, attachments: [{ filename: '需求.pdf', size: 5, contentType: 'application/pdf', part: '2' }] })
  const loaded = await f.api.action({ action: 'loadMail', id: task.id, revision: task.revision })
  assert.equal(loaded.mailLoaded, true); assert.equal(loaded.status, 'unmatched')
  assert.match(loaded.body, /100 件产品/); assert.equal(loaded.attachments[0].filename, '需求.pdf')
  assert.equal(loaded.revision, task.revision + 1)
  assert.equal(f.runs, 0); assert.equal(f.drafts.size, 0); assert.equal(f.sends, 0)
})

test('manual original-mail loading rejects reassigned UIDs without overwriting the task', async t => {
  const f = await fixture(t)
  await f.engine.poll(); f.mail([mail()]); await f.engine.poll()
  const task = (await f.store.read()).tasks[0], original = f.email.read
  f.email.read = async (...args) => ({ ...(await original(...args)), uidValidity: 456, text: 'Different message after UID reset' })
  await assert.rejects(f.api.action({ action: 'loadMail', id: task.id, revision: task.revision }), error => error.code === 'email-cursor-reset' && error.status === 409)
  const retained = (await f.store.read()).tasks[0]
  assert.equal(retained.body, ''); assert.equal(retained.mailLoaded, undefined); assert.equal(retained.revision, task.revision)
})

test('source attachment downloads copy exact bytes into the task and use safe binary response headers', async t => {
  const f = await fixture(t)
  await f.engine.poll(); f.mail([mail()]); await f.engine.poll()
  const task = (await f.store.read()).tasks[0], original = f.email.read
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
  const store = new Store(join(home, 'data', 'bkms-workbench'))
  const taskId = randomUUID(), timestamp = new Date().toISOString()
  const draft = { id: 'synthetic-draft', revision: 1, account: 'sales', to: 'synthetic@example.test', cc: '', subject: 'Synthetic lifecycle', text: 'No real SMTP', attachments: [], state: 'draft' }
  let enteredSend
  const sendEntered = new Promise(resolve => { enteredSend = resolve }), sendHeld = new Promise(resolve => { unblockSend = resolve })
  email.drafts = {
    async get() { return structuredClone(draft) }, async list() { return [structuredClone(draft)] },
    async send() { enteredSend(); await sendHeld; draft.state = 'sent'; return { draft: structuredClone(draft) } },
  }
  await store.mutate(state => { state.tasks.push({ id: taskId, revision: 1, title: 'Synthetic lifecycle', subject: 'Synthetic lifecycle', account: 'sales', from: 'buyer@example.test', body: 'Test only', status: 'review', receivedAt: timestamp, updatedAt: timestamp, source: { account: 'sales', folder: 'INBOX', uid: 11, uidValidity: 123 }, attachments: [], history: [], attempts: 1, draftId: draft.id }) })
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
  assert.equal((await store.read()).tasks[0].status, 'sent')
  let release
  for (let i = 0; i < 40 && !release; i++) {
    try { release = await store.ownWorker() } catch { await new Promise(resolve => setTimeout(resolve, 25)) }
  }
  assert.ok(release, 'unloaded plugin must release its worker lease')
  await release()
})
