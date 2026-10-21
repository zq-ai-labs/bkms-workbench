/**
 * The workbench's built-in mail connection: one IMAP/SMTP pool for all configured accounts, the draft store, and
 * the `EmailService` the engine uses. It replaces the `emailWorkbench` service of the external dsh-email plugin.
 *
 * Nothing here registers chat tools. Other plugins get the narrower `WorkbenchMailApi` (see `external()`), which
 * can look up and read mail but cannot send it: every outgoing message goes through the workbench's review.
 */
import nodemailer from 'nodemailer'
import { join } from 'node:path'
import { MailAccounts, MailAccountError, type MailAccountInput, type MailAccountView } from './accounts.js'
import type { ResolvedEmailSettings } from './config.js'
import { DraftStore, DraftError } from './draft-store.js'
import { EmailDraftBackend } from './drafts.js'
import { EmailPool, messageOf, redactCredentials, smtpAuthOf } from './mail-client.js'
import type { EmailService } from '../types.js'

/** What other plugins (e.g. contract agents) may do with mail through the workbench. Read-only by design. */
export interface WorkbenchMailApi {
  readonly version: 1
  accounts(): Promise<{ id: string; address: string; isDefault: boolean }[]>
  search(input: { account?: string; query: string; folder?: string; limit?: number }, signal?: AbortSignal): Promise<unknown>
  read(input: { account: string; folder: string; uid: number }, signal?: AbortSignal): Promise<unknown>
}

/**
 * The engine-facing mail service over a pool and the draft backend.
 * Adapted from dsh-email src/workbench.ts (MIT); popup suppression is gone because there is no popup.
 */
export function createEmailWorkbenchService(runtime: { getEffectiveSettings?(): ResolvedEmailSettings; getPool(): EmailPool | any }, drafts: EmailDraftBackend): EmailService {
  return {
    version: 1,
    accounts() {
      try { return [...runtime.getEffectiveSettings!().accounts].map(([id, account]) => ({ id, address: account.user, inboxFolder: account.inboxFolder })) }
      catch { return [] }
    },
    scan: (input, signal) => runtime.getPool().scanChanges(input.account, input.folder ?? '', input.cursor, input.limit ?? 20, signal),
    async folders(account, signal) { const result = await runtime.getPool().folders(account, false, signal); return { ...result, folders: result.folders.filter((folder: { selectable?: boolean }) => folder.selectable !== false) } },
    read: (account, folder, uid, signal) => runtime.getPool().readForWorkbench(account, folder, uid, signal),
    downloadAttachment: (account, folder, uid, index, workspaceHint, signal, expectedUidValidity) => runtime.getPool().downloadAttachment(account, folder, uid, index, workspaceHint, signal, expectedUidValidity),
    drafts: {
      async list(signal) { return (await drafts.action({ action: 'list' }, signal) as { drafts: unknown[] }).drafts },
      create: (input, signal) => drafts.create(input, signal),
      async get(id: string, signal?: AbortSignal) {
        const draft = await drafts.store.get(id)
        if (draft.state === 'sending') await drafts.action({ action: 'list' }, signal)
        return drafts.action({ action: 'get', id }, signal)
      },
      update: (id, revision, fields, signal) => drafts.action({ ...fields, action: 'update', id, revision }, signal),
      preview: (id, revision, signal) => drafts.action({ action: 'preview', id, revision }, signal),
      resolveSend: (id, revision, outcome, confirmed, signal) => drafts.action({ action: 'resolveSend', id, revision, outcome, confirmed }, signal),
      async send(id, preview, confirmed, signal) {
        // Only the workbench's authenticated human-action route (or a reviewed auto-send) sets confirmed.
        if (confirmed !== true) throw new DraftError('请在工作台审核当前草稿并明确点击发送')
        const draft = await drafts.store.get(id)
        if (['sent', 'uncertain'].includes(draft.state)) return { draft: await drafts.action({ action: 'get', id }, signal) }
        return drafts.action({ action: 'send', id, preview, confirmed }, signal)
      },
    },
  }
}

function fingerprint(settings: ResolvedEmailSettings): string {
  return JSON.stringify({ accounts: [...settings.accounts.entries()], defaultAccount: settings.defaultAccount, downloadDir: settings.downloadDir, maxAttachmentBytes: settings.maxAttachmentBytes, idleTimeoutMs: settings.idleTimeoutMs })
}
const safe = (error: unknown, secrets: string[] = []): string => {
  let message = redactCredentials(messageOf(error, '操作失败，请稍后重试'))
  for (const secret of secrets) if (secret && secret.length >= 4) message = message.split(secret).join('[已隐藏]')
  return message.slice(0, 600)
}

export class MailService {
  readonly accounts: MailAccounts
  readonly drafts: EmailDraftBackend
  private settings?: ResolvedEmailSettings
  private settingsError?: string
  private pool?: EmailPool
  private poolKey = ''
  private closed = false
  /** True while the separate dsh-email plugin is also installed. */
  externalPlugin = false
  constructor(readonly root: string, private readonly createPool: (settings: ResolvedEmailSettings) => EmailPool = settings => new EmailPool(settings)) {
    this.accounts = new MailAccounts(root)
    this.drafts = new EmailDraftBackend({ getEffectiveSettings: () => this.effective(), getPool: () => this.getPool() }, { store: new DraftStore(root, 'drafts') })
  }

  /** Load accounts; call once at start and after every account change. */
  async reload(): Promise<void> {
    try { this.settings = await this.accounts.settings(join(this.root, 'downloads')); this.settingsError = undefined }
    catch (error) {
      this.settings = undefined
      // No account yet is a normal state, not an error to show.
      this.settingsError = error instanceof MailAccountError && error.code === 'mail-not-configured' ? undefined : error instanceof MailAccountError ? error.message : safe(error)
    }
    // Recipient rules change without reconnecting: the draft backend reads them from the settings at preview/send time.
    if (!this.settings || fingerprint(this.settings) !== this.poolKey) { this.pool?.dispose(); this.pool = undefined; this.poolKey = '' }
  }
  private effective(): ResolvedEmailSettings {
    if (this.closed) throw new Error('工作台已停止，不能继续使用邮箱连接。')
    if (!this.settings) throw new MailAccountError(this.settingsError || '请先在工作台设置中添加邮箱账号', 'mail-not-configured')
    return this.settings
  }
  private getPool(): EmailPool {
    const settings = this.effective(), key = fingerprint(settings)
    if (!this.pool || key !== this.poolKey) { this.pool?.dispose(); this.pool = this.createPool(settings); this.pool.startIdleSweep(); this.poolKey = key }
    return this.pool
  }
  configured(): boolean { return !!this.settings?.accounts.size }
  status(): { configured: boolean; error?: string } { return { configured: this.configured(), ...(this.settingsError ? { error: this.settingsError } : {}) } }
  close(): void { this.closed = true; this.pool?.dispose(); this.pool = undefined }

  /** The engine's mail provider; same contract the dsh-email `emailWorkbench` service offered (version 1). */
  service(): EmailService { return createEmailWorkbenchService({ getEffectiveSettings: () => this.effective(), getPool: () => this.getPool() }, this.drafts) }

  async views(): Promise<{ revision: number; accounts: MailAccountView[] }> { return this.accounts.views() }
  async saveAccount(input: MailAccountInput, revision: number): Promise<void> { await this.accounts.save(input, revision); await this.reload() }
  async removeAccount(id: string, revision: number): Promise<void> { await this.accounts.remove(id, revision); await this.reload() }
  async setDefault(id: string, revision: number): Promise<void> { await this.accounts.setDefault(id, revision); await this.reload() }

  /**
   * Log in to IMAP and SMTP with an unsaved edit (a blank password reuses the stored one), so a wrong 授权码 or
   * server is caught before saving. Nothing is read or sent.
   */
  async test(input: MailAccountInput, signal?: AbortSignal): Promise<{ imap: { ok: boolean; host: string; error?: string }; smtp: { ok: boolean; host: string; error?: string } }> {
    const doc = await this.accounts.read()
    const existing = typeof input?.id === 'string' ? doc.accounts.find(account => account.id === input.id) : undefined
    const account = this.accounts.normalize(input, existing)
    const settings = MailAccounts.resolve([account]), config = settings.accounts.get(account.id)!
    const secrets = [config.password, config.authPassword]
    const imap = { ok: false, host: `${config.imap.host}:${config.imap.port}` } as { ok: boolean; host: string; error?: string }
    const smtp = { ok: false, host: `${config.smtp.host}:${config.smtp.port}` } as { ok: boolean; host: string; error?: string }
    const pool = this.createPool(settings)
    try { await pool.withImap(account.id, null, async () => 'connected', false, signal); imap.ok = true }
    catch (error) { const raw = safe(error, secrets); imap.error = /command failed|authentication|login|auth/i.test(raw) ? `登录失败，请检查邮箱地址和授权码（${raw}）` : raw }
    finally { pool.dispose() }
    signal?.throwIfAborted()
    const transport = nodemailer.createTransport({ host: config.smtp.host, port: config.smtp.port, secure: config.smtp.secure, auth: smtpAuthOf(config, undefined), connectionTimeout: 20000, greetingTimeout: 10000, socketTimeout: 20000 })
    try { await transport.verify(); smtp.ok = true }
    catch (error) { const raw = safe(error, secrets); smtp.error = /auth|login|535|534/i.test(raw) ? `发信登录失败，请检查授权码和 SMTP 服务器（${raw}）` : raw }
    finally { transport.close() }
    return { imap, smtp }
  }

  /** Narrow, read-only mail access for other plugins. Sending is deliberately absent. */
  external(): WorkbenchMailApi {
    return {
      version: 1,
      accounts: async () => (await this.accounts.views()).accounts.map(account => ({ id: account.id, address: account.user, isDefault: account.isDefault })),
      search: (input, signal) => {
        if (!input || typeof input.query !== 'string' || !input.query.trim() || input.query.length > 500) throw new MailAccountError('请提供 1–500 字的搜索内容')
        return this.getPool().search(input.account, input.query.trim(), input.folder ?? '', Math.min(Math.max(Number(input.limit) || 10, 1), 50), 0, undefined, undefined, signal)
      },
      read: (input, signal) => {
        if (!input || typeof input.account !== 'string' || typeof input.folder !== 'string' || !Number.isSafeInteger(input.uid) || input.uid < 1) throw new MailAccountError('需要 account、folder 和 uid')
        return this.getPool().readForWorkbench(input.account, input.folder, input.uid, signal)
      },
    }
  }
}
