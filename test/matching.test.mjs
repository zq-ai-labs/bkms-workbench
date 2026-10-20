import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../lib/store.js'
import { Engine } from '../lib/engine.js'
import { WorkbenchApi } from '../lib/api.js'
import { validateRule, decideAfterTriage } from '../lib/rules.js'
import { parseTriage, heuristicTriage } from '../lib/triage.js'
import { splitQuoted, historyForPrompt } from '../lib/quoted.js'
import { mailInput } from '../lib/agent.js'

const orderRule = { name: '订单处理', enabled: true, priority: 100, account: '', folder: 'INBOX', match: { from: '', subject: '', hasAttachments: false, mode: 'all' }, instructions: '处理客户下单、改单，生成确认回复。', tools: [], output: 'reply', maxRetries: 0, semantic: '客户正式下单或修改订单' }

/** Mail fixture with a scriptable triage: `verdict(input)` returns the AI result. */
async function fixture(t, { verdict, available = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'bkms-matching-'))
  const store = new Store(root), drafts = new Map(), mails = new Map(), seen = []
  let inbox = [], uid = 10
  const email = {
    version: 1, accounts: () => [{ id: 'sales', address: 'sales@example.test', inboxFolder: 'INBOX' }],
    async scan({ cursor }) { return { cursor: { uidValidity: 7, lastUid: cursor ? Math.max(cursor.lastUid, ...inbox.map(m => m.uid)) : 10 }, messages: cursor ? inbox.filter(m => m.uid > cursor.lastUid) : [], firstRun: !cursor, reset: false, hasMore: false } },
    async read(account, folder, id) { const mail = mails.get(id); return { uid: id, text: mail.text, from: [{ address: mail.address }], replyTo: [], attachments: [], messageId: `m${id}@example.test`, references: mail.references || '' } },
    drafts: {
      async create(input) { const draft = { ...input, id: 'draft-' + drafts.size, revision: 1, state: 'draft', attachments: [] }; drafts.set(draft.id, draft); return structuredClone(draft) },
      async get(id) { return structuredClone(drafts.get(id)) }, async list() { return [...drafts.values()] },
    },
  }
  const triage = { available: () => available, async run(input) { seen.push(structuredClone(input)); if (verdict === 'fail') throw new Error('model offline'); return { category: 'request', urgency: 'normal', reason: '客户来信。', nextStep: '', ruleId: '', ...verdict(input) } } }
  const agent = { available: () => true, async run() { return { output: { summary: '已整理。', subject: 'Re', text: '您好，已收到。' }, sessionId: 's' } } }
  const engine = new Engine(store, () => email, agent, undefined, triage), api = new WorkbenchApi(engine)
  await engine.start(); await engine.poll()
  t.after(async () => { await engine.stop(); await rm(root, { recursive: true, force: true }) })
  const deliver = async (subject, text, references = '') => { uid++; mails.set(uid, { address: 'buyer@example.test', text, references }); inbox = [...inbox, { uid, date: new Date().toISOString(), from: [{ address: 'buyer@example.test' }], subject, hasAttachments: false }]; await engine.poll() }
  const drain = async () => { for (let i = 0; i < 20 && (await store.read()).tasks.some(task => task.status === 'queued'); i++) await engine.processNext() }
  const task = async subject => (await api.snapshot()).tasks.find(item => item.subject === subject)
  const save = async rule => api.action({ action: 'saveRule', revision: (await store.read()).configRevision, rule })
  return { store, engine, api, deliver, drain, task, save, seen }
}

test('decision table: confident AI applies, uncertain AI suggests, literal mode needs no AI, no verdict never guesses', () => {
  const ai = validateRule({ ...orderRule, id: 'order' }), literal = validateRule({ ...orderRule, id: 'folder', name: '简历', matchMode: 'literal', priority: 10 })
  assert.equal(decideAfterTriage([ai], 'request', { ruleId: 'order', confidence: 'high' }).rule.id, 'order')
  assert.deepEqual(Object.keys(decideAfterTriage([ai], 'request', { ruleId: 'order', confidence: 'medium', reason: 'x' })), ['suggestion'])
  assert.equal(decideAfterTriage([ai], 'request', { ruleId: 'order', confidence: 'low' }).suggestion.confidence, 'low')
  assert.equal(decideAfterTriage([ai, literal], 'request', { ruleId: '', confidence: 'low' }).rule.id, 'folder', 'literal-mode workflows take their literal matches')
  assert.equal(decideAfterTriage([ai, literal], 'request', { ruleId: 'order', confidence: 'high' }).rule.id, 'order', 'a confident AI pick wins')
  assert.equal(decideAfterTriage([ai, literal], 'request', { ruleId: 'order', confidence: 'medium' }).rule.id, 'folder', 'an uncertain pick does not override a literal-mode workflow')
  assert.equal(decideAfterTriage([ai, literal], 'request', undefined).rule.id, 'folder')
  assert.deepEqual(decideAfterTriage([ai], 'request', undefined), { needsAi: 1 })
  // Validation and legacy shape.
  assert.equal(validateRule({ ...orderRule, matchMode: 'ai' }).matchMode, undefined, 'the default is not persisted')
  assert.throws(() => validateRule({ ...orderRule, matchMode: 'always' }))
  // Parsing: a pick without confidence is uncertain; an unknown pick has none.
  assert.equal(parseTriage({ category: 'request', urgency: 'normal', reason: '', nextStep: '', ruleId: 'a' }, new Set(['a'])).confidence, 'medium')
  assert.equal(parseTriage({ category: 'request', urgency: 'normal', reason: '', nextStep: '', ruleId: 'zz', confidence: 'high' }, new Set(['a'])).confidence, 'low')
  assert.throws(() => parseTriage({ category: 'request', urgency: 'normal', reason: '', nextStep: '', ruleId: 'a', confidence: 'sure' }, new Set(['a'])))
})

test('a failed AI call no longer hands ordinary mail to a broad workflow (regression)', async t => {
  const f = await fixture(t, { verdict: 'fail' })
  await f.save(orderRule)
  await f.deliver('周五团建通知', '大家好，周五下午团建，请回复是否参加。')
  await f.drain()
  const task = await f.task('周五团建通知')
  assert.equal(task.status, 'unmatched'); assert.equal(task.ruleId, undefined); assert.equal(task.triage.by, 'heuristic')
  assert.match(task.history.at(-1).message, /需要 AI 判断/)
})

test('uncertain AI picks are suggested and wait for you; confirming learns a positive example and runs the workflow', async t => {
  const f = await fixture(t, { verdict: input => ({ ruleId: input.rules[0].id, confidence: 'medium', ruleReason: '像是下单，但没有数量。' }) })
  const rule = await f.save(orderRule)
  await f.deliver('关于上次的订单', '上次那个订单麻烦再确认一下。')
  await f.drain()
  let task = await f.task('关于上次的订单')
  assert.equal(task.status, 'unmatched'); assert.equal(task.ruleId, undefined)
  assert.deepEqual({ state: task.match.state, by: task.match.by, confidence: task.match.confidence, reason: task.match.reason, ruleName: task.match.ruleName }, { state: 'suggested', by: 'ai', confidence: 'medium', reason: '像是下单，但没有数量。', ruleName: '订单处理' })
  assert.equal(task.attention, true, 'a suggestion needs your decision')
  await f.api.action({ action: 'runRule', id: task.id, revision: task.revision, ruleId: rule.id })
  await f.drain()
  task = await f.task('关于上次的订单')
  assert.equal(task.status, 'review'); assert.equal(task.match.state, 'applied'); assert.equal(task.match.by, 'manual'); assert.match(task.match.reason, /确认了 AI 的建议/)
  const examples = (await f.api.snapshot()).ruleExamples[rule.id]
  assert.equal(examples.length, 1); assert.equal(examples[0].match, true); assert.match(examples[0].text, /关于上次的订单/)
  // Re-running the same workflow is not a new judgement.
  await f.api.action({ action: 'runRule', id: task.id, revision: task.revision, ruleId: rule.id }); await f.drain()
  assert.equal((await f.api.snapshot()).ruleExamples[rule.id].length, 1)
})

test('“not this workflow” undoes a confident assignment, records a counter-example and AI sees it next time', async t => {
  const f = await fixture(t, { verdict: input => ({ ruleId: input.rules[0]?.id ?? '', confidence: 'high', ruleReason: '提到订单。' }) })
  const rule = await f.save(orderRule)
  await f.deliver('发票抬头变更', '订单的发票抬头需要改一下。')
  await f.drain()
  let task = await f.task('发票抬头变更')
  assert.equal(task.status, 'review'); assert.equal(task.match.by, 'ai'); assert.equal(task.match.confidence, 'high'); assert.equal(task.match.reason, '提到订单。')
  task = await f.api.action({ action: 'rejectRule', id: task.id, revision: task.revision })
  assert.equal(task.status, 'unmatched'); assert.equal(task.ruleId, undefined); assert.equal(task.summary, undefined); assert.equal(task.match.state, 'rejected')
  assert.match(task.history.at(-1).message, /不属于方案「订单处理」/)
  assert.match(task.history.at(-2).message, /更改方案前的结果/)
  const examples = (await f.api.snapshot()).ruleExamples[rule.id]
  assert.deepEqual(examples.map(example => example.match), [false])
  await f.deliver('发票抬头再改', '另一笔订单的发票抬头也要改。')
  await f.drain()
  const prompt = f.seen.at(-1).rules[0]
  assert.equal(prompt.examples.length, 1); assert.equal(prompt.examples[0].match, false); assert.match(prompt.examples[0].text, /发票抬头变更/)
  assert.ok(!('id' in prompt.examples[0]) && !('taskId' in prompt.examples[0]), 'only the verdict and summary reach the model')
  // Rejecting again on the same task replaces, not duplicates; deleting an example and the workflow cleans up.
  await assert.rejects(f.api.action({ action: 'rejectRule', id: task.id, revision: task.revision }), /还没有方案|状态/)
  await f.api.action({ action: 'deleteExample', ruleId: rule.id, exampleId: examples[0].id })
  assert.deepEqual((await f.api.snapshot()).ruleExamples[rule.id], [])
  await assert.rejects(f.api.action({ action: 'deleteExample', ruleId: rule.id, exampleId: 'nope' }), /例子不存在/)
  await f.api.action({ action: 'deleteRule', id: rule.id, revision: (await f.store.read()).configRevision })
  assert.equal((await f.api.snapshot()).ruleExamples[rule.id], undefined)
})

test('declining a suggestion records a counter-example without touching drafts', async t => {
  const f = await fixture(t, { verdict: input => ({ ruleId: input.rules[0].id, confidence: 'low' }) })
  const rule = await f.save(orderRule)
  await f.deliver('你好', '最近怎么样？')
  await f.drain()
  let task = await f.task('你好')
  assert.equal(task.match.state, 'suggested'); assert.equal(task.match.confidence, 'low')
  task = await f.api.action({ action: 'rejectRule', id: task.id, revision: task.revision })
  assert.equal(task.match.state, 'rejected'); assert.equal(task.draftId, undefined)
  assert.equal((await f.api.snapshot()).ruleExamples[rule.id][0].match, false)
  assert.equal((await f.api.snapshot()).tasks.find(item => item.id === task.id).attention, true, 'a declined request still waits until you pick another workflow or ignore it')
})

test('trial runs: AI-mode workflows without a model take nothing; literal-mode workflows take literal matches', async t => {
  const f = await fixture(t, { verdict: () => ({}) })
  await f.deliver('下单 200 台', '确认下单。')
  await f.drain()
  const aiTrial = await f.api.action({ action: 'trialRule', rule: orderRule })
  assert.equal(aiTrial.by, 'rules'); assert.equal(aiTrial.items[0].matched, false); assert.match(aiTrial.items[0].reason, /需要 AI 判断/)
  const literalTrial = await f.api.action({ action: 'trialRule', rule: { ...orderRule, matchMode: 'literal' } })
  assert.equal(literalTrial.items[0].matched, true)
})

test('quoted history is split from the new text for common mail clients', () => {
  const cases = [
    ['QQ', '好的，就按这个价格，下 200 台。\n\n------------------ 原始邮件 ------------------\n发件人: "赵晓强"<zxq@netinfosz.com>;\n发送时间: 2026年10月18日(星期六) 上午10:31\n收件人: "张三"<zs@example.com>;\n主题: 回复：报价咨询\n\n含税单价 ¥128/台。\n\n------------------ 原始邮件 ------------------\n发件人: "张三"<zs@example.com>;\n发送时间: 2026年10月17日\n主题: 报价咨询\n\n请报 200 台的价格。', '好的，就按这个价格，下 200 台。', ['含税单价 ¥128/台。', '请报 200 台的价格。']],
    ['Outlook 中文', '收到，谢谢！\n\n________________________________\n发件人: 赵晓强 <zxq@netinfosz.com>\n发送时间: 2026年10月18日 10:31\n收件人: 李明\n主题: RE: 报价\n\n报价如下', '收到，谢谢！', ['报价如下']],
    ['Outlook English', 'Thanks.\n\nFrom: Zhao <z@x>\nSent: Saturday, October 18, 2026 10:31 AM\nTo: Li\nSubject: RE: Quote\n\nPrice is 128.', 'Thanks.', ['Price is 128.']],
    ['Outlook old', 'OK\n\n-----Original Message-----\nFrom: Zhao\nSent: today\n\nPrice is 128.', 'OK', ['Price is 128.']],
    ['Gmail', 'Ship next week.\n\nOn Sat, Oct 18, 2026 at 10:31 AM Zhao <z@x>\nwrote:\n\n> Price is 128.\n> Valid 7 days.', 'Ship next week.', ['Price is 128.\nValid 7 days.']],
    ['Gmail 中文', '可以。\n\n赵晓强 <z@x> 于2026年10月18日周六 10:31写道：\n\n> 报价 ¥128/台', '可以。', ['报价 ¥128/台']],
    ['网易', '好的\n\n在 2026-10-18 10:31:00，"赵晓强" <z@x> 写道：\n报价 ¥128/台', '好的', ['报价 ¥128/台']],
    ['plain quote', '同意。\n\n> 报价 128\n> 有效期 7 天', '同意。', ['报价 128\n有效期 7 天']],
  ]
  for (const [name, text, latest, parts] of cases) {
    const split = splitQuoted(text)
    assert.equal(split.latest, latest, name); assert.deepEqual(split.history.map(part => part.text), parts, name)
  }
  // Conservative: no separator, interleaved inline quoting, or nothing above the separator keeps everything as new text.
  for (const text of ['你好，请报价。\n谢谢', '我看了：\n> 报价 128\n同意\n> 7 天\n可以下单', '-----Original Message-----\nFrom: a\nSent: b\n\nhello']) assert.deepEqual(splitQuoted(text), { latest: text, history: [] })
  const history = historyForPrompt(splitQuoted(cases[0][1]).history, 60)
  assert.ok(history.startsWith('【往来 1｜发件人'), history); assert.ok(history.length <= 60)
})

test('triage classifies by the new text, reads the quote as context, and knows the thread\'s previous workflow', async t => {
  const f = await fixture(t, { verdict: input => ({ ruleId: input.rules[0]?.id ?? '', confidence: 'high' }) })
  const rule = await f.save(orderRule)
  await f.deliver('下单', '请按报价下 200 台。')
  await f.drain()
  const first = await f.task('下单')
  await f.deliver('RE: 下单', '数量改成 300 台。\n\n------------------ 原始邮件 ------------------\n发件人: buyer\n发送时间: 昨天\n\n请按报价下 200 台。', `<${first.messageId}>`)
  await f.drain()
  const input = f.seen.at(-1)
  assert.equal(input.mail.body, '数量改成 300 台。'); assert.match(input.mail.quotedHistory, /【往来 1｜发件人: buyer · 发送时间: 昨天】\n请按报价下 200 台。/)
  assert.deepEqual(input.thread, { previousRule: { id: rule.id, name: '订单处理' } })
  // The agent gets the same split.
  const task = (await f.store.read()).tasks.find(item => item.subject === 'RE: 下单')
  const mail = mailInput(task)
  assert.equal(mail.body, '数量改成 300 台。'); assert.match(mail.quotedHistory, /请按报价下 200 台/)
  // Without a model, a bare “thanks” under a quoted request is not mistaken for a new request.
  const thanks = '收到，谢谢！\n\nOn Sat, Oct 18, 2026 Zhao <z@x> wrote:\n> 请确认报价'
  assert.equal(heuristicTriage({ from: 'b@x', subject: 'RE: 资料', body: thanks }).category, 'request', 'unsplit, the quoted ask looks new')
  assert.equal(heuristicTriage({ from: 'b@x', subject: 'RE: 资料', body: splitQuoted(thanks).latest }).category, 'other')
})

test('optional pages can be hidden from navigation; only known pages are accepted', async t => {
  const f = await fixture(t, { verdict: () => ({}) })
  const revision = (await f.store.read()).configRevision
  const saved = await f.api.action({ action: 'saveSettings', revision, settings: { hiddenViews: ['today', 'meetings', 'today'] } })
  assert.deepEqual(saved.hiddenViews, ['today', 'meetings'])
  for (const bad of [['plans'], 'today', ['decide']]) await assert.rejects(f.api.action({ action: 'saveSettings', revision: (await f.store.read()).configRevision, settings: { hiddenViews: bad } }), /页签设置无效/)
  assert.deepEqual((await f.api.action({ action: 'preferences' })).settings.hiddenViews, ['today', 'meetings'])
})
