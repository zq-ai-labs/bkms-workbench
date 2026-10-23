import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkbenchRepository } from '../lib/storage/repository.js'
import { Engine } from '../lib/engine.js'
import { WorkbenchApi } from '../lib/api.js'
import { stateOf } from './helpers.mjs'

/** Exporting workflows and schemes from one workbench and importing them into another one. */
async function workbench(t) {
  const root = await mkdtemp(join(tmpdir(), 'bkms-portable-'))
  const store = new WorkbenchRepository(root), engine = new Engine(store, () => undefined, { available: () => false }), api = new WorkbenchApi(engine)
  await engine.start()
  t.after(async () => { await engine.stop(); await store.close(); await rm(root, { recursive: true, force: true, maxRetries: 5 }) })
  const revision = async () => (await stateOf(store)).configRevision
  return { store, api, revision }
}
const reply = { name: '客户询价', enabled: true, priority: 100, account: 'sales@a.example', folder: '其他文件夹/询价', match: { from: '@client.example', subject: '报价', hasAttachments: false, mode: 'all' }, instructions: '你好，我是{{user.name}}。根据询价起草报价回复。', tools: [], skills: ['quote-writer'], output: 'reply', maxRetries: 1, semantic: '客户的询价', autonomy: 'low_risk', matchMode: 'ai' }
const dispatch = { name: '分给华东', enabled: true, priority: 90, account: 'sales@a.example', folder: 'INBOX', match: { from: '', subject: '', hasAttachments: false, mode: 'all' }, instructions: '', tools: [], output: 'dispatch', dispatchFolder: '分派/华东', maxRetries: 0 }
const scheme = { name: '客服分类', enabled: true, account: 'sales@a.example', folder: '客服演示', guidance: '投诉优先。', categories: [{ name: '投诉', include: '表达不满。', action: 'move', folder: '客服演示/投诉' }, { name: '咨询', include: '询问产品。', action: 'label' }] }

test('export keeps the work and leaves out mailbox, folders, ids, on/off state and dispatch workflows', async t => {
  const a = await workbench(t)
  await a.api.action({ action: 'saveRule', revision: await a.revision(), rule: reply })
  await a.api.action({ action: 'saveRule', revision: await a.revision(), rule: dispatch })
  await a.api.action({ action: 'saveClassifier', revision: await a.revision(), classifier: scheme })
  const { file, skipped } = await a.api.action({ action: 'exportWorkflows' })
  assert.equal(file.format, 'bkms-workbench/workflows'); assert.equal(file.version, 1)
  assert.deepEqual(skipped, ['分给华东'])
  assert.equal(file.rules.length, 1)
  const [rule] = file.rules
  for (const key of ['id', 'account', 'folder', 'enabled', 'dispatchFolder', 'revision']) assert.ok(!(key in rule), key)
  assert.equal(rule.instructions, reply.instructions); assert.deepEqual(rule.match, reply.match); assert.deepEqual(rule.skills, ['quote-writer'])
  assert.equal(rule.autonomy, 'low_risk'); assert.equal(rule.semantic, '客户的询价')
  const [classifier] = file.classifiers
  for (const key of ['id', 'account', 'folder', 'enabled']) assert.ok(!(key in classifier), key)
  assert.equal(classifier.guidance, '投诉优先。')
  assert.ok(classifier.categories.every(category => !('id' in category) && !('folder' in category)))
  assert.deepEqual(classifier.categories.map(category => category.action), ['move', 'label', 'label'])
  assert.doesNotMatch(JSON.stringify(file), /sales@a\.example|其他文件夹|分派\/华东|客服演示\//)
})

test('import into another workbench: chosen mailbox and folder, all switched off, names kept unique, moves become labels', async t => {
  const a = await workbench(t), b = await workbench(t)
  await a.api.action({ action: 'saveRule', revision: await a.revision(), rule: reply })
  await a.api.action({ action: 'saveClassifier', revision: await a.revision(), classifier: scheme })
  const { file } = await a.api.action({ action: 'exportWorkflows' })
  // The other workbench already has a workflow with the same name.
  await b.api.action({ action: 'saveRule', revision: await b.revision(), rule: { ...reply, account: '', folder: 'INBOX' } })
  const result = await b.api.action({ action: 'importWorkflows', revision: await b.revision(), file: JSON.parse(JSON.stringify(file)), account: 'me@b.example', folder: '询价' })
  assert.equal(result.rules, 1); assert.equal(result.classifiers, 1)
  assert.deepEqual(result.renamed, [{ from: '客户询价', to: '客户询价（导入）' }])
  assert.deepEqual(result.relabeled, ['客服分类 / 投诉'])
  const state = await stateOf(b.store)
  const imported = state.rules.find(rule => rule.name === '客户询价（导入）')
  assert.equal(imported.enabled, false); assert.equal(imported.account, 'me@b.example'); assert.equal(imported.folder, '询价')
  assert.equal(imported.instructions, reply.instructions); assert.notEqual(imported.id, state.rules[0].id)
  const [classifier] = state.classifiers
  assert.equal(classifier.enabled, false); assert.equal(classifier.account, 'me@b.example'); assert.equal(classifier.folder, '询价')
  assert.ok(classifier.categories.every(category => category.action === 'label'))
  // Importing the same file again keeps names unique once more.
  const again = await b.api.action({ action: 'importWorkflows', revision: await b.revision(), file, account: '', folder: 'INBOX' })
  assert.deepEqual(again.renamed.map(item => item.to), ['客户询价（导入 2）', '客服分类（导入）'])
})

test('files that are not exports, from another version, empty or carrying unsafe content are refused', async t => {
  const b = await workbench(t)
  const run = file => b.api.action({ action: 'importWorkflows', revision: 1, file, account: '', folder: 'INBOX' })
  await assert.rejects(run({ rules: [] }), error => error.code === 'import-format')
  await assert.rejects(run({ format: 'bkms-workbench/workflows', version: 2, rules: [], classifiers: [] }), error => error.code === 'import-version')
  await assert.rejects(run({ format: 'bkms-workbench/workflows', version: 1, rules: [], classifiers: [] }), error => error.code === 'import-empty')
  const base = { format: 'bkms-workbench/workflows', version: 1, classifiers: [] }
  // Background workflows may only read and prepare: a sending tool in a shared file is refused like in the editor.
  await assert.rejects(run({ ...base, rules: [{ ...reply, tools: ['email_send'] }] }), /仅允许读取与查询工具/)
  await assert.rejects(run({ ...base, rules: [{ ...reply, instructions: '{{unknown.var}}' }] }), /变量/)
  await assert.rejects(run({ ...base, rules: [dispatch] }), /分派方案/)
  await assert.rejects(b.api.action({ action: 'importWorkflows', revision: 1, file: { ...base, rules: [reply] }, account: '', folder: '' }), /选择导入后使用的邮箱和文件夹/)
  assert.deepEqual((await stateOf(b.store)).rules, [], 'nothing is saved when an import fails')
})
