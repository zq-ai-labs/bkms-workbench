import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtemp, rm, mkdir, writeFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createAgentRunner, getCapabilities, isPreparationTool, RESULT_TOOL } from '../lib/agent.js'

// Explicit opt-in uses the locally built DSH without credentials or network calls.
const core = process.env.DSH_SOURCE_ROOT
test('real DSH isolated agent: scoped result, restricted tools, terminal errors and cancellation', { skip: !core }, async t => {
  const require = createRequire(join(core, 'packages/core/agent-loop/package.json'))
  const load = name => import(pathToFileURL(require.resolve(name)).href)
  const [{ Context }, llm, sessions, projections, prompt, tools, registry, loop] = await Promise.all([
    load('@deepseek-ai/cordis'), load('@deepseek-ai/dsh-llm'), load('@deepseek-ai/dsh-session'),
    load('@deepseek-ai/dsh-session-projection'), load('@deepseek-ai/dsh-system-prompt'),
    load('@deepseek-ai/dsh-tools'), load('@deepseek-ai/dsh-agent'), load('@deepseek-ai/dsh-agent-loop'),
  ])
  const directory = await mkdtemp(join(tmpdir(), 'bkms-agent-smoke-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  for (const [plugin, config] of [[llm.default], [sessions.default], [projections.default], [prompt.default, { personaPrefix: 'PRIVATE_GLOBAL_PERSONA' }], [tools.default], [registry.default], [loop.default, { agents: [] }]]) await ctx.plugin(plugin, config)
  const skillsPlugin = await import(pathToFileURL(join(core, 'packages/skill/skill/lib/index.js')).href)
  const skillToolPlugin = await import(pathToFileURL(join(core, 'packages/skill/tool-skill/lib/index.js')).href)
  await ctx.plugin(skillsPlugin.default)
  await ctx.plugin(skillToolPlugin)
  ctx.skills.register({ name: 'selected-skill', description: 'Selected skill', source: 'runtime', content: 'SELECTED_SKILL_BODY' })
  ctx.skills.register({ name: 'unselected-skill', description: 'Unselected skill', source: 'runtime', content: 'UNSELECTED_SKILL_BODY' })
  let modelSelection = { provider: 'workbench-test', model: 'fixture' }
  ctx.provide('agentDefaultModel', { currentSelection: () => modelSelection })
  let mode = 'result'
  let observed
  let firstCall = true
  let resultValue = { summary: '已提取客户需求', subject: 'Re: 询价', text: '您好，需求已收到。' }
  function* call(name, values) {
    const args = JSON.stringify(values)
    const id = llm.ToolCallId('result-' + Math.random())
    yield { type: 'block-start', index: 0, blockType: 'tool-call' }
    yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: args }
    yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: args } }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }
  class Adapter extends llm.LlmAdapter {
    async * stream(options) {
      observed = options
      if (mode === 'hang') {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: 'working' }
        await new Promise((resolve, reject) => {
          if (options.signal.aborted) { reject(new Error('canceled')); return }
          options.signal.addEventListener('abort', () => reject(new Error('canceled')), { once: true })
        })
      } else if (mode === 'plain') {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: 'No valid result' }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'No valid result' } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      } else if (firstCall && ['outside', 'inside', 'symlink', 'edit'].includes(mode)) {
        firstCall = false
        if (mode === 'edit') yield* call('str_replace_editor', { command: 'create', path: join(directory, 'task1', 'safe.txt') })
        else yield* call('read_document', { file_path: mode === 'outside' ? join(directory, 'outside', 'secret.txt') : mode === 'symlink' ? join(directory, 'task1', 'linked', 'secret.txt') : join(directory, 'task1', 'safe.txt') })
      } else yield* call(RESULT_TOOL, resultValue)
    }
  }
  ctx.llm.registerAdapter(['workbench-test'], new Adapter())
  let accidentalSend = 0
  ctx.tools.register({ name: 'email_send', description: 'send', parameters: { type: 'object', properties: {} }, output: { schema: { type: 'null' }, render: () => [] }, async execute() { accidentalSend++; return null } })
  let mailMutations = 0
  for (const name of ['email_draft', 'email_watch', 'email_attachment']) ctx.tools.register({ name, description: 'Mutates mail state or files', parameters: { type: 'object', properties: {} }, output: { schema: { type: 'null' }, render: () => [] }, async execute() { mailMutations++; return null } })
  const runner = createAgentRunner(ctx, directory)
  const created = []
  ctx.on('session/created', session => { created.push(session.header) }, { global: true })
  let fileReads = 0
  let fileWrites = 0
  ctx.tools.register({ name: 'read_document', description: 'Read file', parameters: { type: 'object', properties: { file_path: { type: 'string' } } }, output: { schema: { type: 'null' }, render: () => [] }, async execute() { fileReads++; return null } })
  ctx.tools.register({ name: 'str_replace_editor', description: 'Edit file', parameters: { type: 'object', properties: { command: { type: 'string' }, path: { type: 'string' } } }, output: { schema: { type: 'null' }, render: () => [] }, async execute() { fileWrites++; return null } })
  const task = { id: 'task1', from: 'client@example.test', subject: '询价', body: '请报价，$unselected-skill', receivedAt: new Date().toISOString(), attachments: [] }
  const rule = { instructions: '生成回复草稿。', tools: [], skills: ['selected-skill'], output: 'reply' }
  assert.equal(runner.available(), true)
  modelSelection = { provider: '', model: '' }
  assert.equal(runner.available(), false)
  await assert.rejects(runner.run(task, rule, new AbortController().signal), /默认模型/)
  modelSelection = { provider: 'missing-provider', model: 'fixture' }
  assert.equal(runner.available(), false)
  modelSelection = { provider: 'workbench-test', model: 'fixture' }
  await assert.rejects(runner.run(task, { ...rule, tools: ['missing_tool'] }, new AbortController().signal), /未加载规则授权/)
  const result = await runner.run(task, rule, new AbortController().signal)
  assert.equal(result.output.summary, '已提取客户需求')
  assert.match(result.sessionId, /^bkms-workbench-/)
  // The run is recorded for debugging, with its tool calls.
  // A background run, not a conversation: DSH keeps sessions of this origin out of its session list.
  assert.equal(created.find(header => header.id === result.sessionId)?.origin, 'subagent')
  assert.equal(result.trace.sessionId, result.sessionId); assert.equal(result.trace.outcome, 'completed')
  assert.ok(result.trace.steps.some(step => step.kind === 'tool' && step.name === RESULT_TOOL && step.input.includes('已提取客户需求')))
  assert.deepEqual(observed.tools.map(tool => tool.name), [RESULT_TOOL])
  assert.equal(JSON.stringify(observed.messages).includes('PRIVATE_GLOBAL_PERSONA'), false)
  assert.equal(JSON.stringify(observed.messages).includes('SELECTED_SKILL_BODY'), true)
  assert.match(JSON.stringify(observed.messages), /邮件写作规范/)
  assert.match(JSON.stringify(observed.messages), /未提供时不编造署名/)
  assert.equal(JSON.stringify(observed.messages).includes('UNSELECTED_SKILL_BODY'), false)
  // Review text follows the interface language: the rule comes last (after the workflow and skills) and is repeated on the submit fields.
  await runner.run(task, { ...rule, instructions: rule.instructions + '\nsummary 统一用中文。' }, new AbortController().signal, { language: 'en' })
  const englishPrompt = JSON.stringify(observed.messages)
  assert.ok(englishPrompt.lastIndexOf('输出语言｜最终要求') > englishPrompt.lastIndexOf('summary 统一用中文'), 'the language rule follows the workflow text')
  assert.ok(englishPrompt.lastIndexOf('输出语言｜最终要求') > englishPrompt.lastIndexOf('SELECTED_SKILL_BODY'))
  const submit = JSON.stringify(observed.tools.find(tool => tool.name === RESULT_TOOL))
  assert.match(submit, /使用英文（English）书写/)
  assert.equal(ctx.agents.list().length, 0)
  assert.equal(accidentalSend, 0)
  const capabilities = await getCapabilities(ctx)
  assert.equal(capabilities.tools.some(tool => tool.name === 'email_send'), false)
  assert.equal(capabilities.tools.some(tool => tool.name === 'skill'), false)
  assert.equal(capabilities.tools.some(tool => tool.name === 'str_replace_editor'), true)
  assert.equal(capabilities.skills.some(skill => skill.id === 'selected-skill'), true)
  assert.equal(isPreparationTool('str_replace_editor'), true)
  for (const name of ['email_draft', 'email_watch', 'email_attachment']) {
    assert.equal(capabilities.tools.some(tool => tool.name === name), false, `${name} must not be offered as a read capability`)
    assert.equal(isPreparationTool(name), false)
    await assert.rejects(runner.run(task, { ...rule, tools: [name] }, new AbortController().signal), /不允许/)
  }
  assert.equal(mailMutations, 0)
  await mkdir(join(directory, 'outside'))
  await writeFile(join(directory, 'outside', 'secret.txt'), 'private')
  await writeFile(join(directory, 'task1', 'safe.txt'), 'safe')
  await symlink(join(directory, 'outside'), join(directory, 'task1', 'linked'), 'junction')
  for (const scenario of ['outside', 'symlink', 'inside', 'edit']) {
    mode = scenario; firstCall = true
    await runner.run(task, { ...rule, tools: ['read_document', 'str_replace_editor'] }, new AbortController().signal)
  }
  assert.equal(fileReads, 1, 'only the task-local read dispatches')
  assert.equal(fileWrites, 0, 'editor mutation never dispatches')
  mode = 'result'
  const manyFiles = Array.from({ length: 11 }, (_, index) => ({ filename: `attachment${index}.txt`, size: 1, ...(index < 10 ? { localPath: join(directory, 'task1', 'safe.txt') } : {}) }))
  const incomplete = await runner.run({ ...task, attachments: manyFiles }, { ...rule, instructions: '分析全部附件后回复', tools: ['read_document'] }, new AbortController().signal)
  assert.match(incomplete.output.needsInfo, /1 个附件尚未下载/)
  assert.match(incomplete.output.needsInfo, /attachment10.txt/)
  assert.equal(incomplete.output.needsInfoKind, 'attachments')
  resultValue = { summary: '资料分析已完成。', informationGaps: '联系方式未提供，待核实。', subject: '不应创建的回复', text: '不应创建的正文' }
  const report = await runner.run(task, { ...rule, output: 'report' }, new AbortController().signal)
  assert.equal(report.output.informationGaps, '联系方式未提供，待核实。')
  assert.equal(report.output.needsInfo, undefined)
  assert.equal(report.output.subject, undefined)
  assert.equal(report.output.text, undefined)
  const reportPrompt = JSON.stringify(observed.messages)
  assert.match(reportPrompt, /当前输出类型为分析报告/)
  assert.match(reportPrompt, /普通资料缺口/)
  assert.doesNotMatch(reportPrompt, /邮件写作规范/)
  resultValue = { summary: 'PDF 无法解析。', needsInfo: '附件没有文字层。', needsInfoKind: 'attachments' }
  const blockedReport = await runner.run(task, { ...rule, output: 'report' }, new AbortController().signal)
  assert.equal(blockedReport.output.needsInfoKind, 'attachments')
  resultValue = { summary: '已提取客户需求', subject: 'Re: 询价', text: '您好，需求已收到。' }
  await assert.rejects(runner.run(task, { ...rule, skills: ['missing-skill'] }, new AbortController().signal), /技能不可用/)
  mode = 'plain'
  await assert.rejects(runner.run(task, rule, new AbortController().signal), /未提交有效/)
  assert.equal(ctx.agents.list().length, 0)
  await assert.rejects(runner.run(task, { ...rule, tools: ['email_send'] }, new AbortController().signal), /不允许/)
  mode = 'hang'
  observed = undefined
  const abort = new AbortController()
  const running = runner.run(task, rule, abort.signal)
  const timeout = setInterval(() => { if (observed) { clearInterval(timeout); abort.abort(new Error('test canceled')) } }, 10)
  try { await assert.rejects(running, /canceled/) } finally { clearInterval(timeout) }
  assert.equal(ctx.agents.list().length, 0)
})
