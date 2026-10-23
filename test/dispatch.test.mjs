import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkbenchRepository } from '../lib/storage/repository.js'
import { stateOf, setSettings, editRules, editTask, editTasks, readFresh } from './helpers.mjs'
import { Engine, autoSendDecision } from '../lib/engine.js'
import { WorkbenchApi } from '../lib/api.js'
import { validateRule } from '../lib/rules.js'

const base = { enabled: true, priority: 100, account: '', folder: 'INBOX', match: { from: '', subject: '', hasAttachments: false, mode: 'all' }, tools: [], maxRetries: 0 }
const dispatchRule = { ...base, name: '华东销售', output: 'dispatch', dispatchFolder: '分派/华东销售', instructions: '', semantic: '华东区客户的询价和订单', matchMode: 'literal' }

/** A mailbox with folders; scan/read/move/window/listRange behave like the built-in mail service. */
async function fixture(t, { verdict } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'bkms-dispatch-'))
  const store = new WorkbenchRepository(root), folders = { INBOX: [] }, moves = [], drafts = new Map()
  let runs = 0, nextUid = 100
  const mail = (uid, subject, extra = {}) => ({ uid, date: new Date(Date.UTC(2026, 9, 1 + uid % 20, 8)).toISOString(), from: [{ address: 'buyer@east.example' }], subject, seen: false, hasAttachments: false, ...extra })
  // Each folder has its own generation, as on a real server.
  const gen = folder => folder === 'INBOX' ? 7 : 9
  const email = {
    version: 1, accounts: () => [{ id: 'shared@corp.example', address: 'shared@corp.example', inboxFolder: 'INBOX' }],
    async scan({ folder, cursor }) {
      const list = (folders[folder] ??= []).slice().sort((a, b) => a.uid - b.uid), last = list.at(-1)?.uid ?? 0
      if (!cursor) return { cursor: { uidValidity: gen(folder), lastUid: last }, messages: [], firstRun: true, reset: false, hasMore: false }
      const fresh = list.filter(m => m.uid > cursor.lastUid)
      return { cursor: { uidValidity: gen(folder), lastUid: fresh.at(-1)?.uid ?? cursor.lastUid }, messages: fresh, firstRun: false, reset: false, hasMore: false }
    },
    async read(account, folder, uid) {
      const found = (folders[folder] ?? []).find(m => m.uid === uid)
      if (!found) throw new Error(`no mail ${folder}/${uid}`)
      return { uid, text: `${found.subject} 正文`, from: found.from, replyTo: [], attachments: [], messageId: `m${uid}@corp.example`, references: '', uidValidity: gen(folder) }
    },
    async move(account, folder, uid, target, signal, expected) {
      assert.equal(expected, gen(folder))
      const index = folders[folder].findIndex(m => m.uid === uid)
      if (index < 0) throw new Error('missing')
      const [moved] = folders[folder].splice(index, 1), newUid = nextUid++
      ;(folders[target] ??= []).push({ ...moved, uid: newUid })
      moves.push({ folder, uid, target })
      return { folder: target, uid: newUid, uidValidity: 9 }
    },
    async window(account, folder, since) {
      const inside = folders[folder].filter(m => Date.parse(m.date) >= since.getTime()).sort((a, b) => a.uid - b.uid)
      return { uidValidity: 7, count: inside.length, ...(inside.length ? { firstUid: inside[0].uid, lastUid: inside.at(-1).uid } : {}), answered: inside.filter(m => m.answered).map(m => m.uid) }
    },
    async listRange(account, folder, since, until, limit) {
      return folders[folder].filter(m => Date.parse(m.date) >= since.getTime() && Date.parse(m.date) < until.getTime()).sort((a, b) => b.uid - a.uid).slice(0, limit).map(m => ({ uid: m.uid, from: m.from[0].address, subject: m.subject, date: m.date, hasAttachments: false, excerpt: m.subject }))
    },
    drafts: {
      async create(input) { const draft = { ...input, id: 'd' + drafts.size, revision: 1, state: 'draft', attachments: [] }; drafts.set(draft.id, draft); return structuredClone(draft) },
      async get(id) { return structuredClone(drafts.get(id)) },
    },
  }
  const triage = verdict && { available: () => true, async run(input) { return { category: 'request', urgency: 'normal', reason: '客户来信。', nextStep: '', ruleId: '', ...verdict(input) } } }
  const agent = { available: () => true, async run() { runs++; return { output: { summary: '已整理。', subject: 'Re', text: '您好。' }, sessionId: 's' } } }
  const engine = new Engine(store, () => email, agent, undefined, triage), api = new WorkbenchApi(engine)
  await engine.start()
  t.after(async () => { await engine.stop(); await store.close(); await rm(root, { recursive: true, force: true }) })
  const drain = async () => { for (let i = 0; i < 30 && (await stateOf(store)).tasks.some(task => task.status === 'queued'); i++) await engine.processNext() }
  const save = async rule => api.action({ action: 'saveRule', revision: (await stateOf(store)).configRevision, rule })
  return { store, engine, api, folders, moves, mail, drain, save, get runs() { return runs } }
}

test('dispatch workflows: validated, need a different target folder, email only, readable by older builds', () => {
  const rule = validateRule(dispatchRule)
  assert.equal(rule.output, 'dispatch'); assert.equal(rule.dispatchFolder, '分派/华东销售')
  assert.match(rule.instructions, /分派\/华东销售/, 'older builds require instructions, so one is filled in')
  assert.deepEqual(rule.tools, []); assert.equal(rule.autonomy, undefined)
  assert.equal(validateRule({ ...dispatchRule, dispatchFolder: '/分派/华东销售/' }).dispatchFolder, '分派/华东销售')
  assert.throws(() => validateRule({ ...dispatchRule, dispatchFolder: '' }), /目标文件夹/)
  assert.throws(() => validateRule({ ...dispatchRule, dispatchFolder: 'inbox' }), /不能和方案读取的文件夹相同/)
  assert.throws(() => validateRule({ ...dispatchRule, sources: ['email', 'wechat'] }), /只适用于邮件/)
  assert.equal(validateRule({ ...dispatchRule, tools: ['read_document'], autonomy: 'auto' }).tools.length, 0)
  // Ordinary workflows still require instructions.
  assert.throws(() => validateRule({ ...base, name: '回复', output: 'reply', instructions: '' }))
})

test('a matched mail is moved to the team folder without running the agent; the original stays readable', async t => {
  const f = await fixture(t, { verdict: input => ({ ruleId: input.rules[0]?.id ?? '', confidence: 'high', ruleReason: '华东客户询价' }) })
  await f.save({ ...dispatchRule, matchMode: undefined })
  await f.engine.poll()
  f.folders.INBOX.push(f.mail(11, '询价 TH-100'))
  await f.engine.poll(); await f.drain()
  assert.deepEqual(f.moves, [{ folder: 'INBOX', uid: 11, target: '分派/华东销售' }])
  assert.equal(f.runs, 0, 'no agent run for a dispatch')
  const state = await stateOf(f.store), task = state.tasks[0]
  assert.equal(task.status, 'completed'); assert.deepEqual({ ...task.dispatch, at: undefined }, { folder: '分派/华东销售', uid: 100, uidValidity: 9, at: undefined })
  assert.equal(state.activity.at(-1).kind, 'dispatch'); assert.equal(state.activity.at(-1).detail, '分派/华东销售')
  // The original is read from its new place.
  const read = await f.engine.readOriginal(task, new AbortController().signal)
  assert.equal(read.uid, 100)
  // A team that watches the target folder (here the same workbench) picks the mail up as new mail.
  await f.save({ ...base, name: '华东销售回复', folder: '分派/华东销售', output: 'reply', instructions: '生成报价回复。', matchMode: 'literal' })
  await f.engine.poll()
  f.folders['分派/华东销售'].push(f.mail(101, '再次询价'))
  await f.engine.poll(); await f.drain()
  assert.ok((await stateOf(f.store)).tasks.some(item => item.source.folder === '分派/华东销售' && item.status === 'review'))
})

test('processing history from a chosen time: preview, cap, answered mail skipped, never sent automatically', async t => {
  const f = await fixture(t)
  await f.save({ ...base, name: '回复', output: 'reply', instructions: '生成回复。', matchMode: 'literal', autonomy: 'auto' })
  f.folders.INBOX.push(f.mail(3, '很早的邮件'), f.mail(5, '询价 A'), f.mail(6, '已回复的询价', { answered: true }), f.mail(7, '询价 B'))
  await f.engine.poll()
  assert.equal((await stateOf(f.store)).tasks.length, 0, 'baseline from now')
  const since = new Date(Date.UTC(2026, 9, 6)).toISOString(), revision = (await stateOf(f.store)).configRevision
  assert.deepEqual(await f.api.action({ action: 'baselineWindow', account: 'shared@corp.example', folder: 'INBOX', since }), { count: 3, answered: 1, limit: 200 })
  await assert.rejects(f.api.action({ action: 'resetBaseline', account: 'shared@corp.example', folder: 'INBOX', since, revision }), /明确确认/)
  await assert.rejects(f.api.action({ action: 'baselineWindow', account: 'shared@corp.example', folder: 'INBOX', since: new Date(Date.now() + 86400000).toISOString() }), /不能晚于现在/)
  await f.api.action({ action: 'resetBaseline', account: 'shared@corp.example', folder: 'INBOX', since, revision, confirmed: true })
  f.folders.INBOX.push(f.mail(8, '新邮件'))
  await f.engine.poll(); await f.drain()
  const state = await stateOf(f.store), bySubject = Object.fromEntries(state.tasks.map(task => [task.subject, task]))
  assert.deepEqual(Object.keys(bySubject).sort(), ['新邮件', '询价 A', '询价 B'].sort(), 'the answered one is skipped, the early one is outside the range')
  assert.equal(bySubject['询价 A'].backfill, true); assert.equal(bySubject['新邮件'].backfill, undefined)
  assert.equal(bySubject['询价 A'].autoSend, undefined, 'history is never sent automatically')
  assert.ok(bySubject['新邮件'].autoSend, 'new mail keeps the workflow autonomy')
  assert.equal(state.backfills, undefined, 'the range is finished')
  assert.equal(autoSendDecision({ ...base, output: 'reply', autonomy: 'auto' }, { backfill: true, replyTo: 'a@b.example' }, { summary: '', text: 'ok' }, [], {}).ok, false)
  // Including answered mail, and the cap.
  await f.api.action({ action: 'resetBaseline', account: 'shared@corp.example', folder: 'INBOX', since, revision: (await stateOf(f.store)).configRevision, confirmed: true, includeAnswered: true })
  assert.deepEqual((await stateOf(f.store)).backfills['["shared@corp.example","INBOX"]'].skip, [])
  for (let uid = 20; uid < 222; uid++) f.folders.INBOX.push(f.mail(uid, `批量 ${uid}`, { date: new Date().toISOString() }))
  await assert.rejects(f.api.action({ action: 'resetBaseline', account: 'shared@corp.example', folder: 'INBOX', since, revision: (await stateOf(f.store)).configRevision, confirmed: true }), /一次最多处理 200 封/)
})

test('trial run over a time range reads history from the mailbox and changes nothing', async t => {
  const f = await fixture(t)
  f.folders.INBOX.push(f.mail(5, '询价 A'), f.mail(6, '发票'), f.mail(7, '询价 B'))
  const before = JSON.stringify(await stateOf(f.store))
  const result = await f.api.action({ action: 'trialRule', rule: { ...dispatchRule, match: { ...dispatchRule.match, subject: '询价' } }, range: { since: new Date(Date.UTC(2026, 9, 1)).toISOString() } })
  assert.equal(result.total, 3)
  assert.deepEqual(result.items.filter(item => item.matched).map(item => item.subject), ['询价 B', '询价 A'])
  assert.match(result.note, /不会建立事项、移动或发送/)
  assert.equal(JSON.stringify(await stateOf(f.store)), before); assert.equal(f.moves.length, 0)
  await assert.rejects(f.api.action({ action: 'trialRule', rule: dispatchRule, range: { since: new Date(Date.UTC(2026, 9, 9)).toISOString(), until: new Date(Date.UTC(2026, 9, 8)).toISOString() } }), /结束时间/)
})

test('a wrong dispatch is corrected by choosing another team: the mail moves on from where it is', async t => {
  const f = await fixture(t)
  await f.save(dispatchRule)
  await f.save({ ...dispatchRule, name: '华南销售', dispatchFolder: '分派/华南销售', priority: 10, matchMode: 'ai' })
  await f.engine.poll()
  f.folders.INBOX.push(f.mail(11, '询价 TH-100'))
  await f.engine.poll(); await f.drain()
  let task = (await stateOf(f.store)).tasks[0]
  assert.equal(task.dispatch.folder, '分派/华东销售')
  task = await f.api.action({ action: 'rejectRule', id: task.id, revision: task.revision })
  assert.equal(task.status, 'unmatched'); assert.equal(task.dispatch.folder, '分派/华东销售', 'the mail stays put until another team is chosen')
  assert.equal((await stateOf(f.store)).ruleExamples[task.match.ruleId].at(-1).match, false, 'the correction is learned')
  const south = (await stateOf(f.store)).rules.find(rule => rule.name === '华南销售')
  await f.api.action({ action: 'runRule', id: task.id, revision: task.revision, ruleId: south.id }); await f.drain()
  assert.deepEqual(f.moves.map(m => [m.folder, m.target]), [['INBOX', '分派/华东销售'], ['分派/华东销售', '分派/华南销售']])
  task = (await stateOf(f.store)).tasks[0]
  assert.equal(task.status, 'completed'); assert.equal(task.dispatch.folder, '分派/华南销售')
  // Reprocessing with the same team does not move it again.
  await f.api.action({ action: 'runRule', id: task.id, revision: task.revision, ruleId: south.id }); await f.drain()
  assert.equal(f.moves.length, 2)
})

test('a start time with no mail since then is a baseline from now, never a replay of the whole folder', async t => {
  const f = await fixture(t)
  // A folder the workbench has never read: no cursor yet, only old mail.
  f.folders.Archive = []
  for (let uid = 1; uid <= 50; uid++) f.folders.Archive.push(f.mail(uid, `旧邮件 ${uid}`))
  const since = new Date(Date.now() - 3600000).toISOString(), key = '["shared@corp.example","Archive"]'
  // A range still pending from an earlier choice is dropped too.
  await f.store.write(tx => tx.setBackfill(key, { uidValidity: 7, untilUid: 30, skip: [], since, at: since }))
  const cursor = await f.api.action({ action: 'resetBaseline', account: 'shared@corp.example', folder: 'Archive', since, revision: (await stateOf(f.store)).configRevision, confirmed: true })
  assert.deepEqual(cursor, { uidValidity: 9, lastUid: 50 })
  assert.equal((await stateOf(f.store)).backfills, undefined)
  await f.save({ ...base, name: '归档回复', folder: 'Archive', output: 'reply', instructions: '生成回复。', matchMode: 'literal', autonomy: 'auto' })
  await f.engine.poll()
  assert.equal((await stateOf(f.store)).tasks.length, 0, 'old mail stays out')
  f.folders.Archive.push(f.mail(51, '新邮件'))
  await f.engine.poll()
  assert.deepEqual((await stateOf(f.store)).tasks.map(task => task.subject), ['新邮件'])
})
