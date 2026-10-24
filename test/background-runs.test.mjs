import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAgentRunner } from '../lib/agent.js'
import { createTriageRunner } from '../lib/triage.js'
import { createWriter } from '../lib/writer.js'
import { createRuleAssistant } from '../lib/rule-assistant.js'
import { createInstructionOptimizer } from '../lib/instruction-optimizer.js'

/**
 * Every background model call is a DSH session of origin 'subagent', which DSH keeps out of its session list;
 * without it each run adds an untitled session under "Ungrouped". A stand-in `agents.create` records what each
 * caller passes and stops there, so no model or real DSH is needed.
 */
test('every background model call creates its session with origin subagent', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'bkms-background-')); t.after(() => rm(directory, { recursive: true, force: true }))
  const created = [], stop = new Error('stop after create')
  const services = {
    agentDefaultModel: { currentSelection: () => ({ provider: 'fixture', model: 'fixture' }) },
    llm: { listProviders: () => [{ id: 'fixture' }] },
    tools: { schemas: () => [] },
    agents: { async create(options) { created.push(options); throw stop } },
  }
  const ctx = { get: key => services[key] }
  const signal = new AbortController().signal
  const calls = {
    agent: () => createAgentRunner(ctx, directory).run({ id: 'task1', attachments: [] }, { id: 'r1', name: '询价', tools: [], instructions: '回复询价', match: {} }, signal),
    triage: () => createTriageRunner(ctx).run({ rules: [], mail: { subject: '询价', body: '请报价' } }, signal),
    writer: () => createWriter(ctx).run('brief', { uiLanguage: 'zh', items: [] }, signal),
    rule: () => createRuleAssistant(ctx)({ description: '询价邮件生成回复', account: 'sales', folder: 'INBOX' }, signal),
    instructions: () => createInstructionOptimizer(ctx)({ instructions: '整理客户需求并回复。' }, signal),
  }
  for (const [name, call] of Object.entries(calls)) {
    created.length = 0
    await assert.rejects(call(), error => error === stop, name)
    assert.equal(created.length, 1, name)
    assert.equal(created[0].meta?.origin, 'subagent', `${name} must create its session with origin 'subagent'`)
    assert.match(created[0].sessionId, /^bkms-workbench-/, name)
  }
})
