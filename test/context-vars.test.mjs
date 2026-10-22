import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkbenchRepository } from '../lib/storage/repository.js'
import { stateOf, setSettings, editRules, editTask, editTasks, readFresh } from './helpers.mjs'
import { Engine } from '../lib/engine.js'
import { WorkbenchApi } from '../lib/api.js'
import { renderVariables, runtimeContext, unknownVariables, validateProfile, variableValues } from '../lib/context-vars.js'

const profile = { name: '赵晓强', department: '客户服务部', role: '客服主管', timezone: 'Asia/Shanghai' }
const at = new Date('2026-10-22T07:30:00Z')

test('variable values come from your profile and the time in your zone; empty fields say so', () => {
  const values = variableValues(profile, 'service@corp.example', at)
  assert.equal(values['user.name'], '赵晓强'); assert.equal(values['user.department'], '客户服务部')
  assert.equal(values.now, '2026-10-22 15:30'); assert.equal(values.today, '2026-10-22（星期四）'); assert.equal(values.timezone, 'Asia/Shanghai')
  assert.equal(values['user.phone'], '[未设置：user.phone]', 'a missing value is visible, so the AI does not invent one')
  assert.equal(variableValues({ timezone: 'America/New_York' }, '', at).now, '2026-10-22 03:30')
  assert.equal(variableValues(profile, '', at, 'en').today, '2026-10-22 (Thu)')
  assert.equal(renderVariables('以{{ user.department }}的名义回复，落款{{user.name}}；{{unknown}} 原样保留。', values), '以客户服务部的名义回复，落款赵晓强；{{unknown}} 原样保留。')
  assert.deepEqual(unknownVariables('{{user.name}} {{user.nmae}} {{ today }} {{x}}'), ['user.nmae', 'x'])
  const context = runtimeContext(values, profile)
  assert.match(context, /现在是 2026-10-22 15:30/); assert.match(context, /部门 客户服务部/); assert.match(context, /具体日期/)
})

test('the profile is validated: no unknown fields, no line breaks, a real time zone', () => {
  assert.deepEqual(validateProfile({ name: ' 赵晓强 ', phone: '' }), { name: '赵晓强' })
  assert.throws(() => validateProfile({ password: 'x' }), /我的资料无效/)
  assert.throws(() => validateProfile({ name: 'a\nb' }), /换行/)
  assert.throws(() => validateProfile({ timezone: 'Mars/Olympus' }), /时区无效/)
  assert.deepEqual(validateProfile({ signature: '赵晓强\n客户服务部' }), { signature: '赵晓强\n客户服务部' }, 'a signature may span lines')
})

test('workflows with unknown variables are refused on save; the AI gets the filled-in context', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bkms-vars-'))
  const store = new WorkbenchRepository(root), seen = { agent: [], triage: [] }, folders = { INBOX: [] }
  const email = {
    version: 1, accounts: () => [{ id: 'service@corp.example', address: 'service@corp.example', inboxFolder: 'INBOX' }],
    async scan({ cursor }) { const last = folders.INBOX.at(-1)?.uid ?? 0; return cursor ? { cursor: { uidValidity: 7, lastUid: last }, messages: folders.INBOX.filter(m => m.uid > cursor.lastUid), firstRun: false, reset: false, hasMore: false } : { cursor: { uidValidity: 7, lastUid: last }, messages: [], firstRun: true, reset: false, hasMore: false } },
    async read(account, folder, uid) { return { uid, text: '请明天前回复报价。', from: [{ address: 'buyer@client.example' }], replyTo: [], attachments: [], messageId: `m${uid}`, references: '', uidValidity: 7 } },
    drafts: { async create(input) { return { ...input, id: 'd1', revision: 1, state: 'draft', attachments: [] } }, async get() { return { id: 'd1', revision: 1, state: 'draft', attachments: [] } } },
  }
  const triage = { available: () => true, async run(input) { seen.triage.push(input); return { category: 'request', urgency: 'normal', reason: '询价。', nextStep: '', ruleId: input.rules[0]?.id ?? '', confidence: 'high' } } }
  const agent = { available: () => true, async run(task, rule, signal, options) { seen.agent.push(options); return { output: { summary: '已整理。', subject: 'Re', text: '您好。' }, sessionId: 's' } } }
  const engine = new Engine(store, () => email, agent, undefined, triage), api = new WorkbenchApi(engine)
  await engine.start()
  t.after(async () => { await engine.stop(); await store.close(); await rm(root, { recursive: true, force: true, maxRetries: 5 }) })
  const rule = { name: '询价回复', enabled: true, priority: 100, account: '', folder: 'INBOX', match: { from: '', subject: '', hasAttachments: false, mode: 'all' }, tools: [], output: 'reply', maxRetries: 0, matchMode: 'literal' }
  const revision = async () => (await stateOf(store)).configRevision
  await assert.rejects(api.action({ action: 'saveRule', revision: await revision(), rule: { ...rule, instructions: '落款 {{user.nmae}}。' } }), /不认识的变量：\{\{user\.nmae\}\}/)
  await api.action({ action: 'saveRule', revision: await revision(), rule: { ...rule, instructions: '以{{user.department}}的名义回复，落款{{user.name}}。' } })
  await assert.rejects(api.action({ action: 'saveSettings', revision: await revision(), settings: { profile: { apiKey: 'x' } } }), /我的资料无效/)
  await api.action({ action: 'saveSettings', revision: await revision(), settings: { profile, triage: true } })
  assert.deepEqual((await api.snapshot()).settings.profile, profile)
  await engine.poll()
  folders.INBOX.push({ uid: 11, date: new Date().toISOString(), from: [{ address: 'buyer@client.example' }], subject: '询价', seen: false, hasAttachments: false })
  await engine.poll()
  for (let i = 0; i < 10 && (await stateOf(store)).tasks.some(task => task.status === 'queued'); i++) await engine.processNext()
  assert.equal(seen.triage[0].context.department, '客户服务部'); assert.match(seen.triage[0].context.now, /^\d{4}-\d\d-\d\d \d\d:\d\d$/)
  const options = seen.agent[0]
  assert.equal(options.context.values['user.name'], '赵晓强'); assert.equal(options.context.values.mailbox, 'service@corp.example')
  assert.match(options.context.text, /工作台用户：姓名 赵晓强/)
  assert.equal(renderVariables((await stateOf(store)).rules[0].instructions, options.context.values), '以客户服务部的名义回复，落款赵晓强。')
})
