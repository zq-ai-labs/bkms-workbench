import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkbenchRepository } from '../lib/storage/repository.js'
import { stateOf, setSettings, editRules, editTask, editTasks, readFresh } from './helpers.mjs'
import { Engine, autoSendDecision, cleanChecks } from '../lib/engine.js'
import { WorkbenchApi } from '../lib/api.js'
import { validateRule, decideAfterTriage } from '../lib/rules.js'
import { heuristicTriage, parseTriage } from '../lib/triage.js'
import { relations, topicMatches, briefData, briefTemplate } from '../lib/digest.js'
import { parseWriter } from '../lib/writer.js'

const quoteRule = { name: '业务来信报价处理', enabled: true, priority: 100, account: '', folder: 'INBOX', match: { from: '', subject: '', hasAttachments: false, mode: 'all' }, instructions: '根据客户来信生成报价回复草稿。', tools: [], output: 'reply', maxRetries: 0 }

async function fixture(t, { triage, writer, agentOutput } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'bkms-redesign-'))
  const store = new WorkbenchRepository(root), drafts = new Map()
  let inbox = [], sends = 0, runs = 0, previewBlocked = false, previewFails = false
  let output = agentOutput ?? { summary: '已整理客户需求。', subject: 'Re: 报价咨询', text: '您好，报价如下。' }
  const mails = new Map()
  const email = {
    version: 1, accounts: () => [{ id: 'sales', address: 'sales@example.test', inboxFolder: 'INBOX' }],
    async scan({ cursor }) { return { cursor: { uidValidity: 7, lastUid: cursor ? Math.max(cursor.lastUid, ...inbox.map(m => m.uid)) : 10 }, messages: cursor ? inbox.filter(m => m.uid > cursor.lastUid) : [], firstRun: !cursor, reset: false, hasMore: false } },
    async read(account, folder, uid) { const mail = mails.get(uid); return { uid, text: mail.text, from: [{ name: mail.name, address: mail.address }], replyTo: [], attachments: [], messageId: mail.messageId || `m${uid}@example.test`, references: mail.references || '' } },
    drafts: {
      async create(input) { const draft = { ...input, id: 'draft-' + drafts.size, revision: 1, state: 'draft', attachments: [] }; drafts.set(draft.id, draft); return structuredClone(draft) },
      async get(id) { return structuredClone(drafts.get(id)) },
      async list() { return [...drafts.values()].map(d => structuredClone(d)) },
      async update(id, revision, fields) { const draft = drafts.get(id); assert.equal(draft.revision, revision); Object.assign(draft, fields, { revision: revision + 1 }); return structuredClone(draft) },
      async preview(id, revision) { if (previewFails) throw new Error('preview unavailable'); assert.equal(drafts.get(id).revision, revision); return { id: 'preview-' + revision, matching: { blocked: previewBlocked, rows: [] }, draft: structuredClone(drafts.get(id)) } },
      async send(id, plan, confirmed) { assert.equal(confirmed, true); sends++; drafts.get(id).state = 'sent'; drafts.get(id).receipt = { accepted: [drafts.get(id).to], rejected: [], response: '250 OK' }; return { draft: structuredClone(drafts.get(id)) } },
    },
  }
  const agent = { available: () => true, async run(task, rule, signal) { signal.throwIfAborted(); runs++; return { output: structuredClone(output), sessionId: 's' } } }
  const engine = new Engine(store, () => email, agent, undefined, triage, writer), api = new WorkbenchApi(engine)
  await engine.start()
  t.after(async () => { await engine.stop(); await store.close(); await rm(root, { recursive: true, force: true }) })
  let uid = 10
  const deliver = async (subject, address, text, extra = {}) => { uid++; mails.set(uid, { name: extra.name || '', address, text, ...extra }); inbox = [...inbox, { uid, date: new Date(Date.now() - (100 - uid) * 1000).toISOString(), from: [{ name: extra.name || '', address }], subject, hasAttachments: false }]; await engine.poll(); return uid }
  const drain = async () => { for (let i = 0; i < 20 && (await stateOf(store)).tasks.some(t => t.status === 'queued'); i++) await engine.processNext() }
  await engine.poll()
  return { root, store, engine, api, email, drafts, deliver, drain, get sends() { return sends }, get runs() { return runs }, output: value => { output = value }, block: value => { previewBlocked = value }, failPreview: value => { previewFails = value } }
}
const taskBySubject = async (f, subject) => (await stateOf(f.store)).tasks.find(task => task.subject === subject)

test('AI triage archives notifications even when a broad workflow matches literally, and routes real requests', async t => {
  const seen = []
  const triage = { available: () => true, async run(input) {
    seen.push(input)
    if (/通知|提醒/.test(input.mail.subject)) return { category: 'notification', urgency: 'low', reason: '服务故障恢复通知。', nextStep: '', ruleId: input.rules[0]?.id ?? '', confidence: 'high' }
    return { category: 'request', urgency: 'high', reason: '客户询价并要求今天回复。', nextStep: '确认报价并今天回复', ruleId: input.rules[0]?.id ?? '', confidence: 'high' }
  } }
  const f = await fixture(t, { triage })
  await f.api.action({ action: 'saveRule', revision: 1, rule: quoteRule })
  await f.deliver('关于 DeepSeek 服务恢复及补偿通知', 'support@sc.mail.deepseek.com', '服务已恢复，补偿将自动到账。')
  await f.deliver('报价咨询', 'zxqjava@163.com', '请提供 500 台 TH-100 的含税报价，今天回复。', { name: '赵晓强' })
  await f.drain()
  const notice = await taskBySubject(f, '关于 DeepSeek 服务恢复及补偿通知'), quote = await taskBySubject(f, '报价咨询')
  // The AI proposed the broad workflow for the notice, but default exclusions keep notifications out.
  assert.equal(notice.status, 'ignored'); assert.equal(notice.triage.archived, true); assert.equal(notice.triage.category, 'notification'); assert.equal(notice.draftId, undefined)
  assert.equal(quote.status, 'review'); assert.equal(quote.ruleName, '业务来信报价处理'); assert.equal(quote.triage.nextStep, '确认报价并今天回复'); assert.equal(quote.triage.urgency, 'high')
  assert.equal(f.runs, 1, 'only the request reaches the preparation agent')
  assert.equal(seen[0].rules.length, 1); assert.match(seen[0].mail.body, /补偿/)
  const snapshot = await f.api.snapshot()
  assert.equal(snapshot.activity.filter(item => item.kind === 'archive').length, 1)
  assert.equal(snapshot.tasks.find(task => task.id === quote.id).attention, true)
  assert.equal(snapshot.tasks.find(task => task.id === notice.id).attention, false)
})

test('restoring an AI-archived message stops archiving that sender; undo is recorded on the activity', async t => {
  const triage = { available: () => true, async run() { return { category: 'notification', urgency: 'low', reason: '系统通知。', nextStep: '', ruleId: '' } } }
  const f = await fixture(t, { triage })
  await f.deliver('域名到期提醒', 'system@notice.aliyun.com', '您的域名将到期。')
  await f.drain()
  const archived = (await f.api.snapshot()).activity.find(item => item.kind === 'archive')
  await f.api.action({ action: 'undoActivity', activityId: archived.id })
  const restored = await taskBySubject(f, '域名到期提醒')
  assert.equal(restored.status, 'unmatched'); assert.equal(restored.triage.archived, false)
  assert.ok((await f.api.snapshot()).activity.find(item => item.id === archived.id).undoneAt)
  await assert.rejects(f.api.action({ action: 'undoActivity', activityId: archived.id }), error => error.code === 'state')
  await f.deliver('域名续费通知', 'system@notice.aliyun.com', '续费提醒。')
  await f.drain()
  const second = await taskBySubject(f, '域名续费通知')
  assert.equal(second.status, 'unmatched'); assert.equal(second.triage.by, 'preference')
})

test('without a model, heuristic triage still separates notices but never guesses an AI-mode workflow; literal-mode workflows still apply; triage off restores literal matching', async t => {
  const triage = { available: () => false, async run() { throw new Error('must not run') } }
  const f = await fixture(t, { triage })
  await f.api.action({ action: 'saveRule', revision: 1, rule: quoteRule })
  await f.deliver('2026年9月工资条', 'hr@example.test', '工资条详见附件。')
  await f.deliver('设备询价', 'buyer@example.test', '请问 200 套设备的报价？')
  await f.drain()
  assert.equal((await taskBySubject(f, '2026年9月工资条')).status, 'ignored')
  const guessed = await taskBySubject(f, '设备询价')
  assert.equal(guessed.status, 'unmatched', 'no AI verdict: the AI-mode workflow is not assigned by guesswork')
  assert.equal(guessed.triage.by, 'heuristic'); assert.equal(guessed.ruleId, undefined); assert.match(guessed.history.at(-1).message, /需要 AI 判断/)
  assert.equal(guessed.attention, undefined); assert.equal((await f.api.snapshot()).tasks.find(task => task.id === guessed.id).attention, true, 'a request waits for you')
  // A workflow explicitly set to literal matching keeps working without a model.
  const literalRule = await f.api.action({ action: 'saveRule', revision: (await stateOf(f.store)).configRevision, rule: { ...quoteRule, name: '简历归档', matchMode: 'literal', match: { ...quoteRule.match, subject: '简历' } } })
  assert.equal(literalRule.matchMode, 'literal')
  await f.deliver('前端简历 · 张三', 'cv@example.test', '请查收简历。')
  await f.drain()
  const resume = await taskBySubject(f, '前端简历 · 张三')
  assert.equal(resume.ruleName, '简历归档'); assert.equal(resume.match.by, 'literal'); assert.equal(resume.status, 'review')
  const state = await stateOf(f.store)
  await f.api.action({ action: 'saveSettings', revision: state.configRevision, settings: { triage: false } })
  await f.deliver('系统通知 · 维护窗口', 'noreply@example.test', '今晚维护。')
  const literal = await taskBySubject(f, '系统通知 · 维护窗口')
  assert.equal(literal.triage, undefined); assert.equal(literal.status, 'queued'); assert.equal(literal.ruleName, '业务来信报价处理')
})

test('heuristics and triage parsing are bounded and conservative', () => {
  assert.equal(heuristicTriage({ from: 'DeepSeek <support@sc.mail.deepseek.com>', subject: '关于 DeepSeek 服务恢复及补偿通知', body: '', hasAttachments: false }).category, 'notification')
  assert.equal(heuristicTriage({ from: '阿里云 <system@notice.aliyun.com>', subject: '阿里云域名到期提醒', body: '' }).category, 'notification')
  assert.equal(heuristicTriage({ from: 'shop@example.test', subject: '双十一限时优惠', body: '点击退订' }).category, 'marketing')
  assert.equal(heuristicTriage({ from: 'DeepSeek <support@sc.mail.deepseek.com>', subject: '关于 DeepSeek 服务恢复及补偿通知', body: '请查收补偿额度。' }).category, 'notification', 'role sender plus notice subject stays a notice')
  assert.equal(heuristicTriage({ from: 'noreply@github.com', subject: 'Review requested', body: 'Please review' }).category, 'notification')
  // Real requests are never archived on weak signals.
  assert.equal(heuristicTriage({ from: '赵晓强 <zxqjava@163.com>', subject: '500 台报价', body: '能否给个优惠价？限时活动下周结束。' }).category, 'request')
  assert.equal(heuristicTriage({ from: '采购部 <service@customer.example>', subject: '采购询价', body: '请报 200 台的价格。' }).category, 'request')
  assert.equal(heuristicTriage({ from: '财务 <ap@customer.example>', subject: 'Invoice 补开', body: '麻烦重新开一张发票。' }).category, 'request')
  assert.equal(heuristicTriage({ from: '赵晓强 <zxqjava@163.com>', subject: '报价咨询', body: '请提供含税总价，今天回复' }).urgency, 'high')
  assert.deepEqual(parseTriage({ category: 'request', urgency: 'normal', reason: 'x', nextStep: 'y', ruleId: 'not-a-candidate' }, new Set(['a'])).ruleId, '')
  assert.throws(() => parseTriage({ category: 'spam', urgency: 'normal', reason: '', nextStep: '', ruleId: '' }, new Set()))
  assert.throws(() => parseTriage({ category: 'request', urgency: 'normal', reason: '', nextStep: '', ruleId: '', send: true }, new Set()))
  const broad = validateRule({ ...quoteRule, id: 'broad' }), semantic = validateRule({ ...quoteRule, id: 'semantic', priority: 200, semantic: '客户询价' }), notices = validateRule({ ...quoteRule, id: 'notices', exclude: [] })
  const ai = (ruleId, confidence = 'high') => ({ ruleId, confidence, reason: '' })
  assert.deepEqual(decideAfterTriage([semantic, broad], 'request', ai('')), {}, 'AI decision is authoritative')
  assert.equal(decideAfterTriage([semantic, broad], 'request', ai('semantic')).rule.id, 'semantic')
  assert.deepEqual(decideAfterTriage([semantic, broad], 'request', undefined), { needsAi: 2 }, 'without an AI verdict nothing is assigned by guesswork')
  assert.equal(decideAfterTriage([broad], 'notification', ai('broad')).rule, undefined)
  assert.equal(decideAfterTriage([notices], 'notification', ai('notices')).rule.id, 'notices', 'an explicit empty exclusion accepts notifications')
})

test('workflow fields validate and legacy workflows keep their exact persisted shape', () => {
  const legacy = validateRule({ ...quoteRule, id: 'legacy' })
  assert.deepEqual(Object.keys(legacy).sort(), ['account', 'enabled', 'folder', 'id', 'instructions', 'match', 'maxRetries', 'name', 'output', 'priority', 'skills', 'tools'].sort())
  const draftOnly = validateRule({ ...quoteRule, id: 'x', autonomy: 'draft', sources: ['email'], semantic: '' })
  assert.equal(draftOnly.autonomy, undefined); assert.equal(draftOnly.sources, undefined); assert.equal(draftOnly.semantic, undefined)
  const full = validateRule({ ...quoteRule, id: 'y', autonomy: 'low_risk', sources: ['email', 'feishu'], semantic: '客户的报价请求', exclude: ['notification'] })
  assert.equal(full.autonomy, 'low_risk'); assert.deepEqual(full.sources, ['email', 'feishu']); assert.deepEqual(full.exclude, ['notification'])
  assert.equal(validateRule({ ...quoteRule, output: 'report', autonomy: 'auto' }).autonomy, undefined, 'reports never send')
  for (const bad of [{ autonomy: 'yolo' }, { exclude: ['spam'] }, { sources: [] }, { sources: ['Fax!'] }, { sources: [7] }, { semantic: 'x'.repeat(1001) }]) assert.throws(() => validateRule({ ...quoteRule, ...bad }))
})

test('low-risk automatic replies wait for the withdrawal window, then send once through preview', async t => {
  const triage = { available: () => true, async run(input) { return { category: 'reply_needed', urgency: 'normal', reason: '对方请求确认收到。', nextStep: '', ruleId: input.rules[0]?.id ?? '', confidence: 'high' } } }
  const f = await fixture(t, { triage, agentOutput: { summary: '简单确认。', subject: 'Re: 资料已发', text: '收到，谢谢！下午看完给你反馈。', lowRisk: true } })
  await f.api.action({ action: 'saveRule', revision: 1, rule: { ...quoteRule, name: '简单确认', autonomy: 'low_risk' } })
  await f.deliver('资料已发', 'zhanglei@example.test', '资料发你邮箱了，收到回个话。')
  await f.drain()
  let task = await taskBySubject(f, '资料已发')
  assert.equal(task.status, 'review'); assert.ok(task.autoSend); assert.equal(task.autoSend.autonomy, 'low_risk')
  assert.ok(Date.parse(task.autoSend.at) - Date.now() > 29 * 60000, 'default 30 minute window')
  await f.engine.sendDue(); assert.equal(f.sends, 0, 'nothing is sent inside the window')
  await f.store.updateTask(task.id, undefined, item => { item.autoSend.at = new Date(Date.now() - 1000).toISOString() })
  await f.engine.sendDue(); await f.engine.sendDue()
  task = await taskBySubject(f, '资料已发')
  assert.equal(task.status, 'sent'); assert.equal(f.sends, 1)
  const kinds = (await f.api.snapshot()).activity.map(item => item.kind)
  assert.ok(kinds.includes('auto_send_scheduled') && kinds.includes('auto_sent'))
})

test('withdrawing an automatic reply keeps future replies to that contact manual; edits and blocks cancel too', async t => {
  const triage = { available: () => true, async run(input) { return { category: 'reply_needed', urgency: 'normal', reason: '', nextStep: '', ruleId: input.rules[0]?.id ?? '', confidence: 'high' } } }
  const f = await fixture(t, { triage, agentOutput: { summary: '确认。', subject: 'Re', text: '收到，谢谢。', lowRisk: true } })
  await f.api.action({ action: 'saveRule', revision: 1, rule: { ...quoteRule, autonomy: 'auto' } })
  await f.deliver('第一封', 'a@example.test', '请确认。')
  await f.drain()
  let task = await taskBySubject(f, '第一封')
  const entry = (await f.api.snapshot()).activity.find(item => item.kind === 'auto_send_scheduled')
  await f.api.action({ action: 'undoActivity', activityId: entry.id })
  task = await taskBySubject(f, '第一封')
  assert.ok(task.autoSend.canceledAt); assert.equal(task.status, 'review')
  await f.store.updateTask(task.id, undefined, item => { item.autoSend.at = new Date(0).toISOString() })
  await f.engine.sendDue(); assert.equal(f.sends, 0)
  await f.deliver('第二封', 'a@example.test', '再确认一下。')
  await f.drain()
  const second = await taskBySubject(f, '第二封')
  assert.equal(second.autoSend, undefined); assert.match(second.history.at(-1).message, /撤回/)
  // Saving an edited draft takes the task over from automation.
  await f.deliver('第三封', 'b@example.test', '请确认。')
  await f.drain()
  let third = await taskBySubject(f, '第三封')
  assert.ok(third.autoSend && !third.autoSend.canceledAt)
  const draft = f.drafts.get(third.draftId)
  await f.api.action({ action: 'saveDraft', id: third.id, revision: third.revision, draftRevision: draft.revision, draft: { to: draft.to, cc: '', subject: draft.subject, text: '我改过了。' } })
  third = await taskBySubject(f, '第三封'); assert.ok(third.autoSend.canceledAt)
  // A recipient-policy block cancels instead of sending.
  await f.deliver('第四封', 'c@example.test', '请确认。')
  await f.drain()
  const fourth = await taskBySubject(f, '第四封')
  f.block(true)
  await f.store.updateTask(fourth.id, undefined, item => { item.autoSend.at = new Date(Date.now() - 1000).toISOString() })
  await f.engine.sendDue()
  assert.equal(f.sends, 0); assert.ok((await taskBySubject(f, '第四封')).autoSend.canceledAt)
  assert.ok((await f.api.snapshot()).activity.some(item => item.kind === 'auto_send_blocked'))
})

test('scheduled automatic sends re-check the workflow, go stale, and fall back to review on errors', async t => {
  const triage = { available: () => true, async run(input) { return { category: 'reply_needed', urgency: 'normal', reason: '', nextStep: '', ruleId: input.rules[0]?.id ?? '', confidence: 'high' } } }
  const f = await fixture(t, { triage, agentOutput: { summary: '确认。', subject: 'Re', text: '收到，谢谢。', lowRisk: true } })
  await f.api.action({ action: 'saveRule', revision: 1, rule: { ...quoteRule, autonomy: 'auto' } })
  const due = async subject => { const task = await taskBySubject(f, subject); await f.store.updateTask(task.id, undefined, item => { item.autoSend.at = new Date(Date.now() - 1000).toISOString() }) }
  // Lowering the workflow to draft-only stops a send that was already scheduled.
  await f.deliver('改为仅起草', 'a@example.test', '请确认。'); await f.drain()
  const config = await f.api.snapshot()
  await f.api.action({ action: 'saveRule', revision: config.revision, rule: { ...config.rules[0], autonomy: 'draft' } })
  await due('改为仅起草'); await f.engine.sendDue()
  let task = await taskBySubject(f, '改为仅起草')
  assert.equal(f.sends, 0); assert.ok(task.autoSend.canceledAt); assert.equal(task.status, 'review')
  const again = await f.api.snapshot()
  await f.api.action({ action: 'saveRule', revision: again.revision, rule: { ...again.rules[0], autonomy: 'auto' } })
  // A send far past its announced time is not delivered late.
  await f.deliver('很久以前', 'b@example.test', '请确认。'); await f.drain()
  task = await taskBySubject(f, '很久以前')
  await f.store.updateTask(task.id, undefined, item => { item.autoSend.at = new Date(Date.now() - 3 * 3600000).toISOString() })
  await f.engine.sendDue()
  assert.equal(f.sends, 0); assert.ok((await taskBySubject(f, '很久以前')).autoSend.canceledAt)
  // An error before submission hands the reply to a person rather than retrying forever.
  await f.deliver('预览出错', 'c@example.test', '请确认。'); await f.drain()
  await due('预览出错'); f.failPreview(true); await f.engine.sendDue(); f.failPreview(false)
  task = await taskBySubject(f, '预览出错')
  assert.equal(f.sends, 0); assert.equal(task.status, 'review'); assert.ok(task.autoSend.canceledAt)
  await f.engine.sendDue(); assert.equal(f.sends, 0)
})

test('automatic sending is bounded by deterministic guards regardless of the model', () => {
  const rule = validateRule({ ...quoteRule, autonomy: 'low_risk' }), task = { replyTo: 'a@example.test' }
  const ok = { summary: 's', text: '收到，谢谢。', lowRisk: true }
  assert.deepEqual(autoSendDecision(rule, task, ok, [], {}), { ok: true })
  assert.equal(autoSendDecision(validateRule(quoteRule), task, ok, [], {}).ok, false)
  for (const [output, checks, prefs, to] of [
    [{ ...ok, lowRisk: false }, [], {}], [{ ...ok, text: '详见 https://evil.example' }, [], {}], [{ ...ok, text: '抄给 boss@example.test' }, [], {}],
    [{ ...ok, informationGaps: '价格待定' }, [], {}], [ok, [{ item: '核对交期' }], {}], [ok, [], { 'a@example.test': { neverAutoSend: true } }], [ok, [], {}, 'a@example.test, b@example.test'],
    [{ ...ok, text: '好'.repeat(900) }, [], {}],
  ]) assert.equal(autoSendDecision(rule, { replyTo: to ?? task.replyTo }, output, checks, prefs).ok, false, JSON.stringify(output))
  assert.equal(autoSendDecision(validateRule({ ...quoteRule, autonomy: 'auto' }), task, { ...ok, lowRisk: false, text: '好'.repeat(900) }, [], {}).ok, true)
  assert.deepEqual(cleanChecks([{ item: '核对交期', quote: '7 个工作日' }, { item: '确认数量', quote: '1000 台' }, { item: '  ' }], '收到款项后 7 个工作日内发货'), [{ item: '核对交期', quote: '7 个工作日' }, { item: '确认数量' }])
})

test('checks from the agent are anchored to draft text and summarized as information gaps', async t => {
  const triage = { available: () => true, async run(input) { return { category: 'request', urgency: 'normal', reason: '', nextStep: '', ruleId: input.rules[0].id, confidence: 'high' } } }
  const f = await fixture(t, { triage, agentOutput: { summary: '正式报价。', subject: 'Re: 报价', text: '含税总价 ¥64,000，收到款项后 7 个工作日内发货。', checks: [{ item: '客户未指定到货日', quote: '7 个工作日内发货' }, { item: '收货地址未提供', quote: '不存在的原文' }] } })
  await f.api.action({ action: 'saveRule', revision: 1, rule: quoteRule })
  await f.deliver('报价', 'buyer@example.test', '请报价。')
  await f.drain()
  const task = await taskBySubject(f, '报价')
  assert.deepEqual(task.checks, [{ item: '客户未指定到货日', quote: '7 个工作日内发货' }, { item: '收货地址未提供' }])
  assert.equal(task.informationGaps, '1. 客户未指定到货日\n2. 收货地址未提供')
})

test('daily brief, weekly report and topic summaries use AI when available and templates otherwise', async t => {
  const calls = []
  const writer = { ready: false, available() { return this.ready }, async run(kind, data) {
    calls.push([kind, data])
    if (kind === 'brief') return { text: 'AI 简报。' }
    if (kind === 'weekly') return { title: '第 42 周周报', text: '## 本周完成\n- 报价' }
    if (kind === 'topic') return { text: '报价中。', level: 'attention', risks: ['预算偏低'], todos: ['确认折扣'] }
  } }
  const f = await fixture(t, { writer })
  await f.deliver('启明演示 报价咨询', 'liming@qiming.example', '请报价。')
  let brief = await f.api.action({ action: 'generateBrief', uiLanguage: 'zh' })
  assert.equal(brief.by, 'template'); assert.match(brief.text, /需要你决策|没有需要你决策/)
  writer.ready = true
  brief = await f.api.action({ action: 'generateBrief', uiLanguage: 'en' })
  assert.equal(brief.text, 'AI 简报。'); assert.equal(calls[0][1].uiLanguage, 'en'); assert.equal(JSON.stringify(calls[0][1]).includes('请报价。'), false, 'no mail bodies in brief input')
  const weekly = await f.api.action({ action: 'generateReport', kind: 'weekly' })
  assert.equal(weekly.title, '第 42 周周报'); assert.equal(weekly.by, 'ai')
  await f.api.action({ action: 'saveReport', id: weekly.id, title: '我的周报', text: '改过' })
  const topic = await f.api.action({ action: 'saveTopic', topic: { name: '客户 · 启明演示', kind: 'customer', keywords: ['启明'], senders: ['@qiming.example'], schedule: 'weekly' } })
  const refreshed = await f.api.action({ action: 'refreshTopic', id: topic.id })
  assert.equal(refreshed.topic.summary.level, 'attention'); assert.equal(refreshed.matched, 1)
  await f.api.action({ action: 'generateReport', kind: 'topic', topicId: topic.id })
  const snapshot = await f.api.snapshot()
  assert.equal(snapshot.topics[0].count, 1); assert.equal(snapshot.reports.length, 2); assert.equal(snapshot.reports.find(report => report.kind === 'weekly').title, '我的周报')
  assert.ok(snapshot.tasks[0].topicIds.includes(topic.id))
  assert.equal(snapshot.brief.text, 'AI 简报。')
  for (const bad of [{ name: '' }, { name: 'x', kind: 'customer', keywords: [], senders: [] }, { name: 'x', kind: 'alien', keywords: ['a'] }]) await assert.rejects(f.api.action({ action: 'saveTopic', topic: bad }))
  await f.api.action({ action: 'deleteTopic', id: topic.id })
  assert.equal((await f.api.snapshot()).topics.length, 0)
})

test('trial runs preview matches on recent mail without processing, using AI only for literal candidates', async t => {
  const triage = { available: () => true, async run(input) { return /通知/.test(input.mail.subject) ? { category: 'notification', urgency: 'low', reason: '', nextStep: '', ruleId: '' } : { category: 'request', urgency: 'normal', reason: '', nextStep: '', ruleId: '' } } }
  const judged = []
  const writer = { available: () => true, async run(kind, data) { judged.push(data); return { matches: data.mails.map(mail => ({ id: mail.id, matched: /询价/.test(mail.subject), reason: /询价/.test(mail.subject) ? '客户询价。' : '不是询价。' })) } } }
  const f = await fixture(t, { triage, writer })
  await f.deliver('服务通知', 'noreply@example.test', '维护')
  await f.deliver('设备询价', 'buyer@example.test', '报价？')
  await f.deliver('午饭吃什么', 'friend@example.test', '中午一起？')
  await f.drain()
  const runsBefore = f.runs
  const result = await f.api.action({ action: 'trialRule', rule: { ...quoteRule, semantic: '客户询价' } })
  assert.equal(result.by, 'ai'); assert.equal(result.total, 3)
  assert.deepEqual(result.items.filter(item => item.matched).map(item => item.subject), ['设备询价'])
  assert.equal(result.items.find(item => item.subject === '服务通知').reason, '属于方案排除的信息类别。')
  assert.equal(judged[0].mails.length, 2, 'excluded mail never reaches the model')
  assert.equal(f.runs, runsBefore)
})

test('thread relations rely on message references; same-subject mail is only a suggestion', () => {
  const task = (id, extra) => ({ id, subject: '报价咨询', from: 'a <a@x.test>', receivedAt: new Date().toISOString(), body: '', ...extra })
  const links = relations([task('1', { messageId: '<m1@x>' }), task('2', { references: '<m1@x>', subject: 'Re: 报价咨询' }), task('3', {})])
  assert.deepEqual(links.get('1').related, ['2']); assert.deepEqual(links.get('2').related, ['1'])
  assert.deepEqual(links.get('3').possible.sort(), ['1', '2'])
  assert.equal(topicMatches({ keywords: [], senders: ['@x.test'] }, task('4', {})), true)
  assert.equal(topicMatches({ keywords: ['启明'], senders: [] }, task('5', { body: '启明演示公司' })), true)
  assert.match(briefTemplate(briefData({ tasks: [], activity: [] }), false), /没有需要你决策/)
  assert.throws(() => parseWriter('topic', { text: 'x', level: 'panic', risks: [], todos: [] }))
})

test('settings accept new keys within bounds, and a workbench with nothing saved shows the defaults', async t => {
  const f = await fixture(t)
  let state = await stateOf(f.store)
  await f.api.action({ action: 'saveSettings', revision: state.configRevision, settings: { undoMinutes: 15, briefTime: '07:30', weeklyDay: 1, weeklyTime: '09:00', briefEnabled: false, triage: true } })
  state = await stateOf(f.store)
  assert.equal(state.settings.undoMinutes, 15); assert.equal(state.settings.briefTime, '07:30')
  for (const settings of [{ undoMinutes: 0 }, { briefTime: '25:00' }, { weeklyDay: 7 }, { triage: 'yes' }, { meetingBriefMinutes: 1 }]) await assert.rejects(f.api.action({ action: 'saveSettings', revision: state.configRevision, settings }))
  const fresh = await fixture(t)
  const loaded = await stateOf(fresh.store)
  assert.deepEqual(loaded.activity, []); assert.deepEqual(loaded.topics, [])
  const snapshot = await fresh.api.snapshot()
  assert.equal(snapshot.defaults.undoMinutes, 30); assert.equal(snapshot.defaults.triage, true); assert.deepEqual(snapshot.activity, [])
  assert.equal(snapshot.sources.find(source => source.kind === 'feishu').connected, false)
})

test('a message whose triage failed can be retried and is triaged again', async t => {
  let fail = true
  const triage = { available: () => true, async run() { if (fail) throw new Error('model offline'); return { category: 'request', urgency: 'normal', reason: '', nextStep: '', ruleId: '' } } }
  const f = await fixture(t, { triage })
  f.email.read = async () => { if (fail) throw new Error('IMAP timeout'); return { text: '请回复', from: [{ address: 'x@example.test' }], replyTo: [], attachments: [], messageId: 'm@x', references: '' } }
  await f.deliver('询问', 'x@example.test', '请回复')
  for (let i = 0; i < 4; i++) { await editTasks(f.store, task => { delete task.nextAttemptAt }); await f.engine.processNext() }
  let task = await taskBySubject(f, '询问')
  assert.equal(task.status, 'failed'); assert.equal(task.triage.state, 'pending'); assert.equal(task.attempts, 3)
  fail = false
  await f.api.action({ action: 'retry', id: task.id, revision: task.revision })
  await f.drain()
  task = await taskBySubject(f, '询问')
  assert.equal(task.status, 'unmatched'); assert.equal(task.triage.state, 'done')
})
