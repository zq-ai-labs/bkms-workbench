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
import { traceOf } from '../lib/trace.js'
import { WorkbenchError } from '../lib/types.js'
import { stateOf } from './helpers.mjs'

/** The record of a background AI run: taken from the run's events, kept with the task, shown only when switched on. */
test('a run is summarized from its session events: model text, tool calls with results and errors, tokens, outcome', () => {
  const text = value => ({ content: [{ type: 'text', text: value }, { type: 'reasoning', text: 'hidden' }] })
  const events = [
    { type: 'turn/start', time: 1000, data: { turn: 0 } },
    { type: 'assistant/message', time: 1100, data: { turn: 0, step: 0, message: text('先查订单。'), usage: { inputTokens: 900, outputTokens: 40 } } },
    { type: 'tool/call', time: 1200, data: { turn: 0, step: 0, callId: 'c1', name: 'order_lookup', arguments: '{"id":"SO-1"}' } },
    { type: 'tool/result', time: 1300, data: { turn: 0, step: 0, message: { toolCallId: 'c1', ...text('已发货') } } },
    { type: 'tool/call', time: 1400, data: { turn: 0, step: 1, callId: 'c2', name: 'read_document', arguments: '{"path":"x"}' } },
    { type: 'tool/result', time: 1500, data: { turn: 0, step: 1, message: { toolCallId: 'c2', isError: true, ...text('not found') }, error: { name: 'E', code: 'e', reason: '文件不存在' } } },
    { type: 'assistant/message', time: 1600, data: { turn: 0, step: 2, message: text('x'.repeat(2500)), usage: { inputTokens: 1000, outputTokens: 60 } } },
    { type: 'turn/end', time: 1700, data: { turn: 0, reason: { kind: 'completed' } } },
  ]
  const trace = traceOf(events, 's1', 1000, 4000)
  assert.equal(trace.sessionId, 's1'); assert.equal(trace.durationMs, 3000); assert.equal(trace.outcome, 'completed')
  assert.deepEqual(trace.tokens, { input: 1900, output: 100 })
  assert.deepEqual(trace.steps.slice(0, 3).map(step => [step.kind, step.name ?? step.text, step.output, step.error]), [['model', '先查订单。', undefined, undefined], ['tool', 'order_lookup', '已发货', undefined], ['tool', 'read_document', 'not found', '文件不存在']])
  assert.equal(trace.steps[1].input, '{"id":"SO-1"}')
  assert.ok(trace.steps[3].text.length < 2100 && trace.steps[3].text.endsWith('（500）'), 'long texts are cut')
  const many = Array.from({ length: 80 }, (_, index) => ({ type: 'tool/call', data: { callId: 'c' + index, name: 't', arguments: '{}' } }))
  const capped = traceOf([...many, { type: 'turn/end', data: { reason: { kind: 'error', error: { message: '超时' } } } }], 's2', 0, 1)
  assert.equal(capped.steps.length, 60); assert.equal(capped.truncated, true); assert.equal(capped.outcome, 'error: 超时')
})

function chat() {
  return {
    apiVersion: CHANNEL_API_VERSION, kind: 'demo', label: { zh: '演示', en: 'Demo' }, capabilities: { reply: 'copy', archive: false }, readonlyCode: 'demo-readonly',
    text: { readonly: '只读。', notClassified: '不分类。', replyNotEditable: '不可改。', replyReady: '已生成建议回复。', handled: '已处理。', handledLog: '已处理。', created: count => `新增 ${count} 个事项。` },
    settings: { defaults: () => ({ enabled: true }), validate: value => value, enabled: value => value?.enabled === true },
    health: () => ({ ready: true }),
    pending: [{ scope: 'c', position: 1, title: '问题', from: '客户', subject: '会话', body: '能发货吗？', receivedAt: new Date().toISOString() }],
    async poll() { const items = this.pending.splice(0); return items.length ? { commit: saved => ({ state: saved, items, logs: [] }) } : undefined },
    ai: { agentInput: task => ({ conversation: task.body }), writingGuide: '简短。', exampleLabel: () => '演示' },
  }
}
async function fixture(t, agent, triage) {
  const root = await mkdtemp(join(tmpdir(), 'bkms-trace-'))
  const store = new WorkbenchRepository(root), channels = new ChannelRegistry(), channel = chat()
  channels.register(channel)
  const engine = new Engine(store, () => undefined, agent, undefined, triage, undefined, channels), api = new WorkbenchApi(engine)
  await engine.start()
  t.after(async () => { await engine.stop(); await store.close(); await rm(root, { recursive: true, force: true, maxRetries: 5 }) })
  const rule = { name: '答复', enabled: true, priority: 100, account: '', folder: 'INBOX', match: { from: '', subject: '', hasAttachments: false, mode: 'all' }, instructions: '答复。', tools: [], output: 'reply', maxRetries: 0, sources: ['demo'], matchMode: 'literal' }
  await api.action({ action: 'saveRule', revision: (await stateOf(store)).configRevision, rule })
  await api.action({ action: 'saveSettings', revision: (await stateOf(store)).configRevision, settings: { channels: { demo: { enabled: true } } } })
  await engine.pollChannel(channel)
  for (let i = 0; i < 3; i++) await engine.processNext()
  const showTrace = async value => api.action({ action: 'saveSettings', revision: (await stateOf(store)).configRevision, settings: { showTrace: value } })
  return { store, api, showTrace }
}
const record = { sessionId: 'bkms-workbench-x', startedAt: new Date().toISOString(), durationMs: 1200, outcome: 'completed', steps: [{ kind: 'tool', name: 'order_lookup', input: '{}', output: '已发货' }] }

test('the record is kept with the task and reaches the page only when "show AI runs" is on', async t => {
  const f = await fixture(t, { available: () => true, async run() { return { output: { summary: '已答复。', text: '可以发货。' }, sessionId: record.sessionId, trace: record } } })
  const [task] = (await stateOf(f.store)).tasks
  assert.equal(task.status, 'review'); assert.deepEqual(task.trace, record)
  assert.equal((await f.api.snapshot()).tasks[0].trace, undefined, 'hidden by default')
  await f.showTrace(true)
  assert.deepEqual((await f.api.snapshot()).tasks[0].trace, record)
  await assert.rejects(f.api.action({ action: 'saveSettings', revision: (await stateOf(f.store)).configRevision, settings: { showTrace: 'yes' } }), /布尔值/)
})

test('a failed run keeps its record too', async t => {
  const f = await fixture(t, { available: () => true, async run() { throw Object.assign(new Error('DSH 处理未完成：超时'), { trace: { ...record, outcome: 'error: 超时' } }) } })
  const [task] = (await stateOf(f.store)).tasks
  assert.equal(task.status, 'failed'); assert.equal(task.trace.outcome, 'error: 超时')
})

test('a failed AI triage keeps its record on the item and falls back to the rules', async t => {
  const triaged = { ...record, sessionId: 'bkms-workbench-bkms_workbench_triage-x', outcome: 'aborted', steps: [{ kind: 'tool', name: 'bkms_workbench_triage', input: '{}', error: '分拣结果无效。' }] }
  const triage = { available: () => true, async run() { throw Object.assign(new WorkbenchError('AI 未返回有效结果，请稍后重试。', 'invalid_output', 503), { trace: triaged }) } }
  const f = await fixture(t, { available: () => true, async run() { throw new Error('preparation failed without a record') } }, triage)
  const [task] = (await stateOf(f.store)).tasks
  assert.equal(task.trace.sessionId, triaged.sessionId)
  assert.ok((await stateOf(f.store)).logs.some(log => log.message === 'AI 分拣失败，已改用规则判断：AI 未返回有效结果，请稍后重试。'))
})
