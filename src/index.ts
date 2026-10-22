import { homedir } from 'node:os'
import { join } from 'node:path'
import { WorkbenchApi } from './api.js'
import { createAgentRunner, getCapabilities } from './agent.js'
import { Engine } from './engine.js'
import { WorkbenchRepository } from './storage/repository.js'
import { createRuleAssistant } from './rule-assistant.js'
import { createInstructionOptimizer } from './instruction-optimizer.js'
import { createTriageRunner } from './triage.js'
import { createWriter } from './writer.js'
import { WechatConnector } from './wechat.js'
import { MailService } from './mail/service.js'
import { EMAIL_DRAFT_ROUTE } from './mail/drafts.js'

export const name = 'bkms-workbench'
export const inject = ['connection']
export function apply(ctx: any): void {
  const home = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
  // One SQLite database for the workbench, opened on first use (docs/DESIGN-CORE-CHANNELS.md D1, D8).
  const store = new WorkbenchRepository(join(home, 'data', 'bkms-workbench'))
  // Mail is built in: accounts, IMAP/SMTP connections and drafts live in the workbench data folder.
  const mail = new MailService(join(store.root, 'mail'))
  const email = mail.service()
  // The separate dsh-email plugin is no longer needed; when it is still installed, say so (two connections, popups and chat mail tools).
  ctx.inject(['emailWorkbench'], (mailCtx: any) => {
    mail.externalPlugin = true
    mailCtx.effect(() => () => { mail.externalPlugin = false }, 'bkms-workbench: dsh-email detection')
  })
  // Read-only mail access for other plugins (e.g. contract agents). Sending stays in the workbench review.
  if (typeof ctx.provide === 'function') ctx.provide('workbenchMail', mail.external())
  // WeChat is read through a local read-only bridge process, started only when enabled in settings.
  const wechat = new WechatConnector(join(store.root, 'wechat-cache'))
  const engine = new Engine(store, () => mail.configured() ? email : undefined, createAgentRunner(ctx, join(store.root, 'tasks')), () => getCapabilities(ctx), createTriageRunner(ctx), createWriter(ctx), wechat)
  const api = new WorkbenchApi(engine, createRuleAssistant(ctx), createInstructionOptimizer(ctx), mail)
  // Drafts written by the old dsh-email plugin are copied in once, so earlier tasks keep their draft.
  const legacyDrafts = mail.importLegacyDrafts(join(home, 'data', 'dsh-email', 'drafts-v1.json')).then(count => { if (count) ctx.logger?.info?.('bkms-workbench: imported %d drafts from dsh-email', count) }, () => {})
  const ready = legacyDrafts.then(() => mail.reload()).then(() => engine.start())
  ready.catch((error: unknown) => ctx.logger?.error?.('bkms-workbench startup: %s', error instanceof Error ? error.message : 'failed'))
  ctx.effect(() => async () => {
    // Withdraw API admission first. A confirmed send already accepted must
    // persist its result before a replacement worker can acquire this home.
    await api.close()
    await ready.catch(() => {})
    await engine.stop()
    mail.close()
    wechat.close()
  }, 'bkms-workbench: background worker')
  const draftRoute = (request: Request) => ready.then(() => mail.drafts.fetch(request), error => new Response(JSON.stringify({ ok: false, error: { code: 'unavailable', message: engine.safe(error) } }), { status: 503, headers: { 'content-type': 'application/json' } }))
  // Draft attachments: upload from the review panel, download from the send preview.
  ctx.connection.fetch.register({ path: EMAIL_DRAFT_ROUTE, methods: ['POST', 'GET'], requestBody: 'buffered', fetch: draftRoute })
  ctx.connection.fetch.register({ path: EMAIL_DRAFT_ROUTE + '/upload', methods: ['POST'], requestBody: 'streaming', fetch: draftRoute })
  for (const path of ['/api/bkms-workbench', '/api/bkms-workbench/attachment']) ctx.connection.fetch.register({ path, methods: ['POST'], requestBody: 'buffered', fetch: async (request: Request) => {
    try { await ready } catch (error) { return new Response(JSON.stringify({ ok: false, error: engine.safe(error) }), { status: 503, headers: { 'content-type': 'application/json' } }) }
    return api.fetch(request)
  } })
}
