import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkbenchRepository } from '../lib/storage/repository.js'
import { stateOf, setSettings, editRules, editTask, editTasks, readFresh } from './helpers.mjs'
import { Engine } from '../lib/engine.js'
import { WorkbenchApi } from '../lib/api.js'
import { validateClassifier, decideCategory, parseBusiness } from '../lib/classify.js'
import { parseTriage, triageSchema } from '../lib/triage.js'
import { needsAttention } from '../lib/digest.js'

const scheme = {
  name: '客服邮件分类', enabled: true, account: '', folder: 'INBOX', guidance: '同时有投诉和其他诉求时归投诉。',
  categories: [
    { name: '投诉', include: '表达不满、要求赔偿或道歉。', exclude: '只是询问进度，语气平和。', action: 'move', folder: '客服/投诉' },
    { name: '查询', include: '查订单、物流、发票的进度。', action: 'label' },
  ],
}
const replyRule = { name: '查询回复', enabled: true, priority: 100, account: '', folder: 'INBOX', match: { from: '', subject: '', hasAttachments: false, mode: 'all' }, instructions: '查询订单后回复。', tools: [], output: 'reply', maxRetries: 0, matchMode: 'literal' }

/** A mailbox, a triage model whose business verdict each test sets, and a writer for trial runs. */
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'bkms-classify-'))
  const store = new WorkbenchRepository(root), folders = { INBOX: [] }, moves = [], drafts = new Map(), seen = []
  let nextUid = 500, verdict = () => ({}), category = () => 'request', runs = 0
  const email = {
    version: 1, accounts: () => [{ id: 'service@corp.example', address: 'service@corp.example', inboxFolder: 'INBOX' }],
    async scan({ folder, cursor }) {
      const list = (folders[folder] ??= []).slice().sort((a, b) => a.uid - b.uid), last = list.at(-1)?.uid ?? 0
      if (!cursor) return { cursor: { uidValidity: 7, lastUid: last }, messages: [], firstRun: true, reset: false, hasMore: false }
      const fresh = list.filter(m => m.uid > cursor.lastUid)
      return { cursor: { uidValidity: 7, lastUid: fresh.at(-1)?.uid ?? cursor.lastUid }, messages: fresh, firstRun: false, reset: false, hasMore: false }
    },
    async read(account, folder, uid) {
      const found = (folders[folder] ?? []).find(m => m.uid === uid)
      if (!found) throw new Error(`no mail ${folder}/${uid}`)
      return { uid, text: found.text, from: found.from, replyTo: [], attachments: [], messageId: `m${uid}@corp.example`, references: '', uidValidity: 7 }
    },
    async move(account, folder, uid, target) {
      const index = folders[folder].findIndex(m => m.uid === uid)
      if (index < 0) throw new Error('missing')
      const [moved] = folders[folder].splice(index, 1), newUid = nextUid++
      ;(folders[target] ??= []).push({ ...moved, uid: newUid })
      moves.push({ folder, uid, target })
      return { folder: target, uid: newUid, uidValidity: 7 }
    },
    drafts: {
      async create(input) { const draft = { ...input, id: 'd' + drafts.size, revision: 1, state: 'draft', attachments: [] }; drafts.set(draft.id, draft); return structuredClone(draft) },
      async get(id) { return structuredClone(drafts.get(id)) },
    },
  }
  const triage = { available: () => true, async run(input) { seen.push(input); return { category: category(input), urgency: 'normal', reason: '客户来信。', nextStep: '', ruleId: '', ...(input.classifier ? { business: { categoryId: '', confidence: 'low', reason: '', alternatives: [], ...verdict(input) } } : {}) } } }
  const writer = { available: () => true, async run(kind, data) { assert.equal(kind, 'classify'); const [complaint, query] = data.classifier.categories; return { results: data.mails.map(mail => ({ id: mail.id, categoryId: /延误|差评/.test(mail.subject) ? complaint.id : query.id, confidence: /报价/.test(mail.subject) ? 'medium' : 'high', reason: '依据主题。' })) } } }
  const agent = { available: () => true, async run() { runs++; return { output: { summary: '已整理。', subject: 'Re', text: '您好。' }, sessionId: 's' } } }
  const engine = new Engine(store, () => email, agent, undefined, triage, writer), api = new WorkbenchApi(engine)
  await engine.start()
  await setSettings(store, { triage: true })
  t.after(async () => { await engine.stop(); await store.close(); await rm(root, { recursive: true, force: true, maxRetries: 5 }) })
  let uid = 10
  const arrive = async (subject, text = subject) => { folders.INBOX.push({ uid: ++uid, date: new Date().toISOString(), from: [{ address: 'buyer@client.example' }], subject, text, seen: false, hasAttachments: false }); await engine.poll(); for (let i = 0; i < 20 && (await stateOf(store)).tasks.some(task => ['queued'].includes(task.status)); i++) await engine.processNext() }
  const saveScheme = async (input = scheme) => api.action({ action: 'saveClassifier', revision: (await stateOf(store)).configRevision, classifier: input })
  const byName = (saved, name) => saved.categories.find(item => item.name === name)
  return { store, engine, api, folders, moves, seen, arrive, saveScheme, byName, set verdict(fn) { verdict = fn }, set category(fn) { category = fn }, get runs() { return runs } }
}

test('schemes are validated; the "none of these" category is added and always last', () => {
  const saved = validateClassifier(scheme)
  assert.deepEqual(saved.categories.map(item => item.name), ['投诉', '查询', '其他'])
  assert.equal(saved.categories.at(-1).fallback, true); assert.equal(saved.categories[0].folder, '客服/投诉')
  assert.equal(validateClassifier({ ...scheme, categories: [{ name: '其他', fallback: true, action: 'label' }, ...scheme.categories] }).categories.at(-1).name, '其他')
  assert.throws(() => validateClassifier({ ...scheme, categories: [scheme.categories[0], { ...scheme.categories[1], name: '投诉' }] }), /重复/)
  assert.throws(() => validateClassifier({ ...scheme, categories: [{ ...scheme.categories[0], folder: '' }] }), /目标文件夹/)
  assert.throws(() => validateClassifier({ ...scheme, categories: [{ ...scheme.categories[0], folder: 'inbox' }] }), /不能是方案读取的文件夹/)
  assert.throws(() => validateClassifier({ ...scheme, categories: [{ name: '查询', include: '', action: 'label' }] }), /属于本类/)
  assert.throws(() => validateClassifier({ ...scheme, categories: [] }), /至少需要一个业务分类/)
})

test('the triage model gets a business category field only for a classified folder, and unknown ids are no answer', () => {
  assert.equal(triageSchema(false).properties.business, undefined)
  assert.ok(triageSchema(true).required.includes('business'))
  const base = { category: 'request', urgency: 'normal', reason: '', nextStep: '', ruleId: '' }
  assert.throws(() => parseTriage({ ...base, business: {} }, new Set()), /未知字段/, 'business without a scheme')
  assert.throws(() => parseTriage(base, new Set(), new Set(['a'])), /缺少业务分类/)
  assert.deepEqual(parseTriage({ ...base, business: { categoryId: 'zzz', confidence: 'high', reason: '猜的', alternatives: ['a', 'zzz'] } }, new Set(), new Set(['a'])).business, { categoryId: '', confidence: 'low', reason: '猜的', alternatives: ['a'] })
  const saved = validateClassifier(scheme), [complaint, query] = saved.categories
  assert.equal(decideCategory(saved, parseBusiness({ categoryId: complaint.id, confidence: 'high', reason: '' }, new Set([complaint.id]))).category.id, complaint.id)
  assert.deepEqual(decideCategory(saved, { categoryId: complaint.id, confidence: 'medium', reason: '', alternatives: [query.id] }), { candidates: [complaint.id, query.id] })
  assert.deepEqual(decideCategory(saved, undefined), { candidates: [] })
})

test('a confident category is applied: a move moves the mail, a label lets the workflows run as before', async t => {
  const f = await fixture(t)
  const saved = await f.saveScheme(), complaint = f.byName(saved, '投诉'), query = f.byName(saved, '查询')
  await f.api.action({ action: 'saveRule', revision: (await stateOf(f.store)).configRevision, rule: replyRule })
  await f.engine.poll()
  f.verdict = input => /延误/.test(input.mail.subject) ? { categoryId: complaint.id, confidence: 'high', reason: '订单延误，表达不满。' } : { categoryId: query.id, confidence: 'high', reason: '询问物流。' }
  await f.arrive('订单延误一周还没人联系我')
  await f.arrive('请问 SO-20931 到哪了')
  assert.equal(f.seen[0].classifier.categories.length, 3); assert.equal(f.seen[0].classifier.guidance, scheme.guidance)
  const [moved, labeled] = (await stateOf(f.store)).tasks
  assert.equal(moved.classification.categoryName, '投诉'); assert.equal(moved.classification.state, 'applied')
  assert.equal(moved.status, 'completed'); assert.deepEqual(f.moves, [{ folder: 'INBOX', uid: 11, target: '客服/投诉' }])
  assert.equal(moved.ruleId, undefined, 'a moved mail does not reach the workflows of its old folder')
  assert.equal(labeled.classification.categoryName, '查询'); assert.equal(labeled.status, 'review', 'a label keeps the workflow running')
  assert.equal(f.runs, 1)
})

test('an unsure category waits for you; nothing runs until you choose, and your choice is learned', async t => {
  const f = await fixture(t)
  const saved = await f.saveScheme(), complaint = f.byName(saved, '投诉'), query = f.byName(saved, '查询')
  await f.api.action({ action: 'saveRule', revision: (await stateOf(f.store)).configRevision, rule: replyRule })
  await f.engine.poll()
  f.verdict = () => ({ categoryId: query.id, confidence: 'medium', reason: '像在问价格，也提到和上次不一样。', alternatives: [complaint.id] })
  await f.arrive('关于上次报价，我们有些疑问')
  let task = (await stateOf(f.store)).tasks[0]
  assert.equal(task.status, 'unmatched'); assert.equal(task.classification.state, 'pending')
  assert.deepEqual(task.classification.candidates, [query.id, complaint.id])
  assert.equal(needsAttention(task), true)
  assert.equal(f.runs, 0, 'the literal workflow is only offered while the category is open')
  assert.equal(task.match.state, 'suggested')
  // You decide it is a complaint: moved now, remembered as an example.
  await f.api.action({ action: 'classify', id: task.id, revision: task.revision, categoryId: complaint.id })
  let state = await stateOf(f.store); task = state.tasks[0]
  assert.equal(task.classification.categoryName, '投诉'); assert.equal(task.classification.by, 'manual')
  assert.equal(task.status, 'completed'); assert.equal(f.moves.length, 1)
  assert.deepEqual(state.categoryExamples[complaint.id].map(example => example.match), [true])
  // Corrected later: the wrong category gets a counter-example; the mail stays where it is.
  await f.api.action({ action: 'classify', id: task.id, revision: task.revision, categoryId: query.id })
  state = await stateOf(f.store); task = state.tasks[0]
  assert.equal(task.classification.categoryName, '查询')
  assert.deepEqual(state.categoryExamples[complaint.id].map(example => example.match), [true, false])
  assert.match(task.history.at(-1).message, /仍在「客服\/投诉」/)
  // The next triage sees the learned examples.
  await f.arrive('又一封邮件')
  assert.equal(f.seen.at(-1).classifier.categories.find(item => item.id === complaint.id).examples.length, 2)
})

test('notifications are archived as before unless the scheme classifies them too', async t => {
  const f = await fixture(t)
  const saved = await f.saveScheme(), query = f.byName(saved, '查询')
  await f.engine.poll()
  f.category = () => 'notification'
  f.verdict = () => ({ categoryId: query.id, confidence: 'high', reason: '' })
  await f.arrive('您的账单已出')
  let task = (await stateOf(f.store)).tasks[0]
  assert.equal(task.status, 'ignored'); assert.equal(task.classification, undefined)
  await f.saveScheme({ ...saved, includeNotices: true })
  await f.arrive('您的账单又出了')
  task = (await stateOf(f.store)).tasks[1]
  assert.equal(task.classification.categoryName, '查询')
})

test('one folder, one enabled scheme; deleting a scheme keeps the categories already given', async t => {
  const f = await fixture(t)
  const saved = await f.saveScheme()
  await assert.rejects(f.saveScheme({ ...scheme, name: '第二套' }), /已在处理这个文件夹/)
  await f.saveScheme({ ...scheme, name: '第二套', enabled: false })
  const state = await stateOf(f.store)
  assert.equal(state.classifiers.length, 2)
  await f.api.action({ action: 'deleteClassifier', id: saved.id, revision: state.configRevision })
  assert.deepEqual((await stateOf(f.store)).classifiers.map(item => item.name), ['第二套'])
})

test('a trial run shows the category each message would get and changes nothing', async t => {
  const f = await fixture(t)
  await f.engine.poll()
  f.verdict = () => ({})
  await f.arrive('订单延误了'); await f.arrive('关于报价的疑问')
  const before = JSON.stringify(await stateOf(f.store))
  const result = await f.api.action({ action: 'trialClassifier', classifier: scheme })
  assert.equal(result.total, 2)
  const bySubject = Object.fromEntries(result.items.map(item => [item.subject, item]))
  assert.ok(bySubject['订单延误了'].categoryId, 'confident: would be applied')
  assert.equal(bySubject['关于报价的疑问'].categoryId, '', 'unsure: would wait for you'); assert.ok(bySubject['关于报价的疑问'].likely)
  assert.equal(JSON.stringify(await stateOf(f.store)), before); assert.equal(f.moves.length, 0)
})
