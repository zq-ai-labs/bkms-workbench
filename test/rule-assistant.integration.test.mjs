import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRuleAssistant, RULE_RESULT_TOOL } from '../lib/rule-assistant.js'
import { createInstructionOptimizer, INSTRUCTION_RESULT_TOOL } from '../lib/instruction-optimizer.js'

const core = process.env.DSH_SOURCE_ROOT
test('real DSH rule assistant: candidate only, available capability validation, no external execution and cancellation', { skip: !core }, async t => {
  const require = createRequire(join(core, 'packages/core/agent-loop/package.json'))
  const load = name => import(pathToFileURL(require.resolve(name)).href)
  const [{ Context }, llm, sessions, projections, prompt, tools, registry, loop] = await Promise.all([
    load('@deepseek-ai/cordis'), load('@deepseek-ai/dsh-llm'), load('@deepseek-ai/dsh-session'), load('@deepseek-ai/dsh-session-projection'),
    load('@deepseek-ai/dsh-system-prompt'), load('@deepseek-ai/dsh-tools'), load('@deepseek-ai/dsh-agent'), load('@deepseek-ai/dsh-agent-loop'),
  ])
  const ctx = new Context(); t.after(() => ctx.fiber.dispose())
  for (const [plugin, config] of [[llm.default], [sessions.default], [projections.default], [prompt.default, { personaPrefix: 'PRIVATE_GLOBAL_PERSONA' }], [tools.default], [registry.default], [loop.default, { agents: [] }]]) await ctx.plugin(plugin, config)
  let selection = { provider: 'rule-test', model: 'fixture' }
  ctx.provide('agentDefaultModel', { currentSelection: () => selection })
  let executed = 0, observed, scenario = 'valid', iteration = 0, resultTool = RULE_RESULT_TOOL, instructionMode = false
  ctx.tools.register({ name: 'email_send', description: 'send', parameters: { type: 'object', properties: {} }, output: { schema: { type: 'null' }, render: () => [] }, async execute() { executed++; return null } })
  ctx.tools.register({ name: 'read_document', description: 'Read document', parameters: { type: 'object', properties: {} }, output: { schema: { type: 'null' }, render: () => [] }, async execute() { executed++; return null } })
  const candidate = { name: '询价回复', from: '', subject: '询价', hasAttachments: false, mode: 'all', instructions: '整理需求并生成中文回复草稿，缺少信息时请人工补充。', output: 'reply', tools: [], skills: [], warnings: [] }
  function* call(args) {
    const id = llm.ToolCallId('rule-' + Math.random()), text = JSON.stringify(args)
    yield { type: 'block-start', index: 0, blockType: 'tool-call' }
    yield { type: 'tool-call-delta', index: 0, id, name: resultTool, argumentsDelta: text }
    yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: resultTool, arguments: text } }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }
  class Adapter extends llm.LlmAdapter {
    async *stream(options) {
      observed = options
      if (scenario === 'hang') {
        await new Promise((resolve, reject) => { if (options.signal.aborted) reject(new Error('canceled')); else options.signal.addEventListener('abort', () => reject(new Error('canceled')), { once: true }) })
      } else if (scenario === 'plain' || iteration++ > 0) {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: 'No candidate' }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'No candidate' } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      } else if (instructionMode) yield* call(scenario === 'extra' ? { instructions: '整理需求并生成中文回复草稿。', tools: ['email_send'] } : { instructions: scenario === 'short' ? '短' : scenario === 'nul' ? '处理要求\0无效' : '1. 整理客户需求。\n2. 生成中文回复草稿；缺少价格与交期时列为待确认事项。' })
      else yield* call({ ...candidate, ...(scenario === 'missing-tool' ? { tools: ['missing_query'] } : scenario === 'unsafe' ? { tools: ['email_send'] } : scenario === 'missing-skill' ? { skills: ['nonexistent'] } : scenario === 'broad' ? { subject: '' } : scenario === 'attachments' ? { instructions: '阅读附件并生成报告', output: 'report' } : {}) })
    }
  }
  ctx.llm.registerAdapter(['rule-test'], new Adapter())
  const assistant = createRuleAssistant(ctx), input = { description: '收到主题包含询价的邮件，生成回复。', account: 'sales', folder: '客户/询价' }
  const generate = async mode => { scenario = mode; iteration = 0; return assistant(input, new AbortController().signal) }
  const result = await generate('valid')
  assert.equal(result.rule.id, ''); assert.equal(result.rule.account, 'sales'); assert.equal(result.rule.folder, input.folder)
  assert.equal(result.rule.priority, 100); assert.equal(result.rule.maxRetries, 1); assert.equal(result.rule.enabled, true)
  assert.equal(result.rule.match.subject, '询价'); assert.deepEqual(result.warnings, [])
  assert.deepEqual(observed.tools.map(tool => tool.name), [RULE_RESULT_TOOL])
  assert.doesNotMatch(JSON.stringify(observed.messages), /PRIVATE_GLOBAL_PERSONA/)
  assert.match(JSON.stringify(observed.messages), /不能进行正文、语义、日期/)
  assert.match(JSON.stringify(observed.messages), /发送始终由用户确认/)
  assert.equal(executed, 0); assert.equal(ctx.agents.list().length, 0)
  input.uiLanguage = 'en'
  await generate('valid')
  assert.match(JSON.stringify(observed.messages), /英文：name和warnings使用英文/)
  assert.match(JSON.stringify(observed.messages), /from\/subject保留用户提供的字面筛选值，不翻译/)
  delete input.uiLanguage
  for (const mode of ['unsafe', 'missing-tool', 'missing-skill', 'plain']) await assert.rejects(generate(mode), /未生成有效方案/)
  assert.equal(executed, 0)
  assert.match((await generate('broad')).warnings.join('\n'), /全部新邮件/)
  assert.match((await generate('attachments')).warnings.join('\n'), /未选择读取工具/)
  selection = { provider: '', model: '' }
  await assert.rejects(generate('valid'), /默认模型/)
  selection = { provider: 'rule-test', model: 'fixture' }
  scenario = 'hang'; iteration = 0; observed = undefined
  const controller = new AbortController(), running = assistant(input, controller.signal)
  const timer = setInterval(() => { if (observed) { clearInterval(timer); controller.abort(new Error('canceled')) } }, 10)
  try { await assert.rejects(running, /canceled/) } finally { clearInterval(timer) }
  assert.equal(ctx.agents.list().length, 0)
  instructionMode = true; resultTool = INSTRUCTION_RESULT_TOOL
  const optimizer = createInstructionOptimizer(ctx), instructions = '帮我整理客户需求，然后中文回复，价格交期没有的话列出来我确认。'
  const refine = mode => { scenario = mode; iteration = 0; return optimizer({ instructions }, new AbortController().signal) }
  const optimized = await refine('valid')
  assert.deepEqual(Object.keys(optimized), ['instructions'])
  assert.match(optimized.instructions, /待确认事项/)
  assert.deepEqual(observed.tools.map(tool => tool.name), [INSTRUCTION_RESULT_TOOL])
  assert.doesNotMatch(JSON.stringify(observed.messages), /PRIVATE_GLOBAL_PERSONA/)
  assert.match(JSON.stringify(observed.messages), /不能编造业务事实/)
  assert.match(JSON.stringify(observed.messages), /不因界面语言自动翻译/)
  assert.match(JSON.stringify(observed.messages), /待编辑资料/)
  assert.ok(JSON.stringify(observed.messages).includes(instructions))
  for (const mode of ['extra', 'short', 'nul', 'plain']) await assert.rejects(refine(mode), /未生成有效的处理要求/)
  resultTool = 'email_send'
  await assert.rejects(refine('valid'), /未生成有效的处理要求/)
  resultTool = INSTRUCTION_RESULT_TOOL
  assert.equal(executed, 0)
  selection = { provider: '', model: '' }
  await assert.rejects(refine('valid'), /默认模型/)
  selection = { provider: 'rule-test', model: 'fixture' }
  scenario = 'hang'; iteration = 0; observed = undefined
  const cancelOptimization = new AbortController(), optimizing = optimizer({ instructions }, cancelOptimization.signal)
  const cancelTimer = setInterval(() => { if (observed) { clearInterval(cancelTimer); cancelOptimization.abort(new Error('refinement canceled')) } }, 10)
  try { await assert.rejects(optimizing, /refinement canceled/) } finally { clearInterval(cancelTimer) }
  assert.equal(ctx.agents.list().length, 0)
})
