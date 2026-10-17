import { homedir } from 'node:os'
import { join } from 'node:path'
import { WorkbenchApi } from './api.js'
import { createAgentRunner, getCapabilities } from './agent.js'
import { Engine } from './engine.js'
import { Store } from './store.js'
import { createRuleAssistant } from './rule-assistant.js'
import { createInstructionOptimizer } from './instruction-optimizer.js'
import { createTriageRunner } from './triage.js'
import { createWriter } from './writer.js'
import type { EmailService } from './types.js'

export const name = 'bkms-workbench'
export const inject = ['connection']
export function apply(ctx: any): void {
  const home = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
  const store = new Store(join(home, 'data', 'bkms-workbench'))
  let email: EmailService | undefined
  ctx.inject(['emailWorkbench'], (mailCtx: any) => {
    email = mailCtx.emailWorkbench
    const restore = email?.suppressPopups?.()
    mailCtx.effect(() => () => { email = undefined; restore?.() }, 'bkms-workbench: mail provider')
  })
  const engine = new Engine(store, () => email, createAgentRunner(ctx, join(store.root, 'tasks')), () => getCapabilities(ctx), createTriageRunner(ctx), createWriter(ctx))
  const api = new WorkbenchApi(engine, createRuleAssistant(ctx), createInstructionOptimizer(ctx))
  const ready = engine.start()
  ready.catch((error: unknown) => ctx.logger?.error?.('bkms-workbench startup: %s', error instanceof Error ? error.message : 'failed'))
  ctx.effect(() => async () => {
    // Withdraw API admission first. A confirmed send already accepted must
    // persist its result before a replacement worker can acquire this home.
    await api.close()
    await ready.catch(() => {})
    await engine.stop()
  }, 'bkms-workbench: background worker')
  for (const path of ['/api/bkms-workbench', '/api/bkms-workbench/attachment']) ctx.connection.fetch.register({ path, methods: ['POST'], requestBody: 'buffered', fetch: async (request: Request) => {
    try { await ready } catch (error) { return new Response(JSON.stringify({ ok: false, error: engine.safe(error) }), { status: 503, headers: { 'content-type': 'application/json' } }) }
    return api.fetch(request)
  } })
}
