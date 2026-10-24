import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { logFailures, runStructured } from '../lib/structured.js'
import { createAgentRunner, RESULT_TOOL } from '../lib/agent.js'
import { MAX_REJECTED_RESULTS, runFailure } from '../lib/run-failure.js'
import { WorkbenchError } from '../lib/types.js'

/**
 * A stand-in for the DSH Agent: `script` plays the model, submitting results through the registered tool, ending the
 * turn, or hanging until canceled. Events are recorded like DSH's, so the run record (src/trace.ts) can be checked.
 */
function fakeDsh(script) {
  const state = { events: [], canceled: undefined }
  const services = {
    agentDefaultModel: { currentSelection: () => ({ provider: 'fixture', model: 'fixture' }) },
    llm: { listProviders: () => [{ id: 'fixture' }] },
    tools: { schemas: () => [] },
    agents: {
      async create(options) {
        let tool, onResult, wake, idle, calls = 0
        const agentCtx = {
          tools: { restrict() {}, presentAs() {}, guard() {}, register(value) { if (!tool) tool = value } },
          on(name, fn) { if (name === 'tools/result') onResult = fn },
          systemPrompt: { section() {} },
        }
        options.setup(agentCtx)
        const end = (reason) => { if (!state.events.some(event => event.type === 'turn/end')) state.events.push({ type: 'turn/end', data: { reason } }) }
        const model = {
          async submit(args) {
            const callId = `c${++calls}`, exec = { name: tool.name, concludeTurn() {} }
            state.events.push({ type: 'tool/call', data: { callId, name: tool.name, arguments: JSON.stringify(args) } })
            let isError = false, text = '{"recorded":true}'
            try { await tool.execute(args, exec) } catch (error) { isError = true; text = error.message }
            state.events.push({ type: 'tool/result', data: { message: { toolCallId: callId, isError, content: [{ type: 'text', text }] } } })
            onResult(exec, { isError })
            await new Promise(resolve => setTimeout(resolve, 0)) // lets a queued cancel land, as between real steps
          },
          end,
          hang: () => new Promise(resolve => { wake = resolve }),
          canceled: () => state.canceled !== undefined,
        }
        const agent = {
          followup() { idle = Promise.resolve().then(() => script(model)) },
          whenIdle: () => idle,
          cancel(reason) { state.canceled = reason; end({ kind: 'aborted', reason }); wake?.() },
          session: { snapshotEvents: () => state.events },
        }
        return { agent, async dispose() {} }
      },
    },
  }
  return { ctx: { get: key => services[key] }, state }
}
// AbortSignal.timeout does not keep Node running; a test that waits only for it needs a timer that does.
const keepAlive = t => { const timer = setInterval(() => {}, 1000); t.after(() => clearInterval(timer)) }
const options = (signal = new AbortController().signal) => ({
  name: 'bkms_workbench_test', description: 'test', schema: { type: 'object' }, system: 'test', input: {}, signal,
  parse(args) { if (args.ok !== true) throw new WorkbenchError('结果无效。'); return { ok: true } },
})

test('a valid result is returned', async () => {
  const { ctx } = fakeDsh(async model => { await model.submit({ ok: true }); model.end({ kind: 'completed' }) })
  assert.deepEqual(await runStructured(ctx, options()), { ok: true })
})

test('a run that keeps submitting invalid results is stopped and says the result was invalid, with its record', async () => {
  const { ctx, state } = fakeDsh(async model => { while (!model.canceled()) await model.submit({ ok: false }) })
  const error = await runStructured(ctx, { ...options(), failure: { message: 'AI 未生成有效方案，请调整描述后重试，也可手动填写。', code: 'invalid_suggestion' } }).catch(error => error)
  assert.equal(error.code, 'invalid_suggestion')
  assert.match(state.canceled.reason, /too many invalid results/)
  assert.equal(error.trace.steps.filter(step => step.error).length, MAX_REJECTED_RESULTS)
  assert.equal(error.trace.steps[0].error, '结果无效。')
})

test('a run past its time limit is canceled and reported as a timeout', async t => {
  keepAlive(t)
  const { ctx, state } = fakeDsh(model => model.hang())
  const error = await runStructured(ctx, { ...options(), timeoutMs: 20 }).catch(error => error)
  assert.equal(error.code, 'model_timeout'); assert.equal(error.message, 'AI 处理超时，请稍后重试。')
  assert.ok(state.canceled, 'the agent is canceled')
  // A time limit set by the caller is reported the same way.
  const caller = await runStructured(fakeDsh(model => model.hang()).ctx, options(AbortSignal.timeout(20))).catch(error => error)
  assert.equal(caller.code, 'model_timeout')
})

test('model service failures are told by kind, without the provider text, which stays in the run record', async () => {
  const failing = (reason) => fakeDsh(async model => model.end(reason)).ctx
  const auth = await runStructured(failing({ kind: 'error', error: { code: 'INVALID_CREDENTIAL', message: 'key sk-secret rejected' } }), options()).catch(error => error)
  assert.equal(auth.code, 'model_auth'); assert.doesNotMatch(auth.message, /sk-secret/); assert.match(auth.trace.outcome, /sk-secret/)
  assert.equal((await runStructured(failing({ kind: 'error', error: { code: 'SERVER', message: 'x' } }), options()).catch(error => error)).code, 'model_error')
  assert.equal((await runStructured(failing({ kind: 'max-tokens' }), options()).catch(error => error)).code, 'model_truncated')
  assert.equal((await runStructured(failing({ kind: 'completed' }), options()).catch(error => error)).code, 'invalid_output')
  const quota = runFailure([{ type: 'turn/end', data: { reason: { kind: 'error', error: { code: 'ACCOUNT_QUOTA' } } } }], new AbortController().signal, { message: 'x', code: 'x' })
  assert.equal(quota.code, 'model_quota')
})

test('a run canceled by the user ends with the user\'s reason and no record', async () => {
  const controller = new AbortController(), { ctx } = fakeDsh(model => model.hang())
  const running = runStructured(ctx, options(controller.signal))
  setTimeout(() => controller.abort(new Error('user stopped')), 10)
  const error = await running.catch(error => error)
  assert.equal(error.message, 'user stopped'); assert.equal(error.trace, undefined)
})

test('the preparation agent is stopped after repeated invalid results and reports timeouts', async t => {
  keepAlive(t)
  const directory = await mkdtemp(join(tmpdir(), 'bkms-run-failure-')); t.after(() => rm(directory, { recursive: true, force: true }))
  const task = { id: 'task1', attachments: [] }, rule = { id: 'r1', name: '报告', tools: [], instructions: '分析', output: 'report', match: {} }
  const looping = fakeDsh(async model => { while (!model.canceled()) await model.submit({}) })
  const error = await createAgentRunner(looping.ctx, directory).run(task, rule, new AbortController().signal).catch(error => error)
  assert.equal(error.code, 'invalid_output')
  assert.match(looping.state.canceled.reason, /too many invalid results/)
  assert.equal(error.trace.steps.filter(step => step.name === RESULT_TOOL && step.error).length, MAX_REJECTED_RESULTS)
  const slow = fakeDsh(model => model.hang())
  const timeout = await createAgentRunner(slow.ctx, directory).run(task, rule, AbortSignal.timeout(20)).catch(error => error)
  assert.equal(timeout.code, 'model_timeout'); assert.ok(timeout.trace)
})

test('a failed run that belongs to no item leaves one log line on how it ended, without model text', async () => {
  const lines = []
  const trace = { sessionId: 's', startedAt: new Date(0).toISOString(), durationMs: 2500, outcome: 'error: provider said key sk-secret', tokens: { input: 900, output: 40 }, steps: [{ kind: 'model', text: '模型的原始输出' }, { kind: 'tool', name: 'x', error: '方案匹配条件无效。' }] }
  const failing = logFailures(async () => { throw Object.assign(new WorkbenchError('模型服务出错，请稍后重试。', 'model_error', 502), { trace }) }, async line => { lines.push(line) })
  await assert.rejects(failing(), /模型服务出错/)
  assert.deepEqual(lines, ['AI 运行未成功：模型服务出错，请稍后重试。（2.5s · end error · rejected 1: 方案匹配条件无效。 · tokens 900/40）'])
  // No record (canceled, or failed before the model ran): nothing to log.
  await assert.rejects(logFailures(async () => { throw new WorkbenchError('请先在 DSH 中配置默认模型。') }, async line => { lines.push(line) })())
  assert.equal(lines.length, 1)
})
