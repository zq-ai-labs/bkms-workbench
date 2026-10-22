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
import { splitQuoted } from '../quoted.js'

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
    move: (account, folder, uid, target, signal, expectedUidValidity) => moveMessage(runtime.getPool(), account, folder, uid, target, signal, expectedUidValidity),
    window: (account, folder, since, signal) => mailWindow(runtime.getPool(), account, folder, since, signal),
    listRange: (account, folder, since, until, limit, signal) => listRange(runtime.getPool(), account, folder, since, until, limit, signal),
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

/** Same rule as mail-client's structureHasAttachment: any node with an attachment disposition. */
const hasAttachment = (node: any): boolean => !!node && typeof node === 'object' && (node.disposition === 'attachment' || (Array.isArray(node.childNodes) && node.childNodes.some(hasAttachment)))
const uidValidityOf = (client: any): number => client.mailbox === false || !client.mailbox ? 0 : Number(client.mailbox.uidValidity ?? 0)

/**
 * Move one message for a dispatch workflow. The target folder is created when missing (`分派/华东销售`; `/` is
 * converted to the server's hierarchy delimiter). Checks the source generation first, so a renumbered mailbox
 * never moves the wrong mail. Returns the new location so the original can still be shown afterwards.
 */
export async function moveMessage(pool: EmailPool, account: string, folder: string, uid: number, target: string, signal?: AbortSignal, expectedUidValidity?: number): Promise<{ folder: string; uid?: number; uidValidity?: number }> {
  return pool.withImap(account, folder, async (client: any) => {
    if (expectedUidValidity && uidValidityOf(client) !== expectedUidValidity) throw new MailAccountError('邮箱文件夹已重新编号，无法确认是同一封邮件；请核对后手动移动。', 'mail-moved')
    const found = await client.fetchOne(uid, { uid: true }, { uid: true })
    signal?.throwIfAborted()
    if (!found) throw new MailAccountError('原邮件已不在这个文件夹，可能已被移动或删除。', 'mail-missing')
    const list: { path: string; delimiter?: string }[] = await client.list()
    const delimiter = list.find(row => row.delimiter)?.delimiter || '/'
    const path = target.split('/').map(part => part.trim()).filter(Boolean).join(delimiter)
    if (!path) throw new MailAccountError('目标文件夹无效。')
    if (path === folder) throw new MailAccountError('邮件已在目标文件夹中。')
    if (!list.some(row => row.path === path)) { await client.mailboxCreate(path); signal?.throwIfAborted() }
    const moved = await client.messageMove(String(uid), path, { uid: true })
    signal?.throwIfAborted()
    if (!moved) throw new MailAccountError(`移动到「${target}」失败：服务器拒绝了操作。`)
    const newUid = moved.uidMap instanceof Map ? moved.uidMap.get(uid) : undefined
    return { folder: path, ...(typeof newUid === 'number' ? { uid: newUid } : {}), ...(moved.uidValidity ? { uidValidity: Number(moved.uidValidity) } : {}) }
  }, false, signal)
}

/** Messages in `folder` received at or after `since` (server receive time), and which of them were already answered. */
export async function mailWindow(pool: EmailPool, account: string, folder: string, since: Date, signal?: AbortSignal) {
  return pool.withImap(account, folder, async (client: any) => {
    const uidValidity = uidValidityOf(client)
    if (!uidValidity) throw new MailAccountError('邮箱服务器未返回 UIDVALIDITY，不能按时间处理历史邮件。')
    // SEARCH SINCE has day granularity (server time zone): ask a day early, then filter on the exact receive time.
    const day = new Date(since.getTime() - 86400000)
    const found = await client.search({ since: day }, { uid: true })
    signal?.throwIfAborted()
    const uids = (Array.isArray(found) ? found : []).sort((a: number, b: number) => a - b)
    const rows: { uid: number; at: number; answered: boolean }[] = []
    for (let start = 0; start < uids.length; start += 500) {
      const part = uids.slice(start, start + 500)
      for (const message of await client.fetchAll(part, { uid: true, internalDate: true, flags: true }, { uid: true })) {
        const at = message.internalDate ? new Date(message.internalDate).getTime() : NaN
        rows.push({ uid: message.uid, at, answered: message.flags?.has('\\Answered') === true })
      }
      signal?.throwIfAborted()
    }
    const inside = rows.filter(row => row.at >= since.getTime()).sort((a, b) => a.uid - b.uid)
    return { uidValidity, count: inside.length, ...(inside.length ? { firstUid: inside[0].uid, lastUid: inside.at(-1)!.uid } : {}), answered: inside.filter(row => row.answered).map(row => row.uid) }
  }, true, signal)
}

/** Read-only sample of mail received in [since, until) for a trial run: envelope plus a short excerpt of the new text. */
export async function listRange(pool: EmailPool, account: string, folder: string, since: Date, until: Date, limit: number, signal?: AbortSignal) {
  const picked = await pool.withImap(account, folder, async (client: any) => {
    const found = await client.search({ since: new Date(since.getTime() - 86400000), before: new Date(until.getTime() + 86400000) }, { uid: true })
    signal?.throwIfAborted()
    const uids = (Array.isArray(found) ? found : []).sort((a: number, b: number) => b - a)
    const out: { uid: number; from: string; subject: string; date: string; hasAttachments: boolean }[] = []
    for (let start = 0; start < uids.length && out.length < limit; start += 200) {
      for (const message of (await client.fetchAll(uids.slice(start, start + 200), { uid: true, envelope: true, internalDate: true, bodyStructure: true }, { uid: true })).sort((a: any, b: any) => b.uid - a.uid)) {
        const at = message.internalDate ? new Date(message.internalDate).getTime() : NaN
        if (!(at >= since.getTime() && at < until.getTime())) continue
        const sender = message.envelope?.from?.[0]
        out.push({ uid: message.uid, from: sender ? (sender.name ? `${sender.name} <${sender.address}>` : sender.address || '') : '', subject: message.envelope?.subject || '', date: new Date(at).toISOString(), hasAttachments: hasAttachment(message.bodyStructure) })
        if (out.length >= limit) break
      }
      signal?.throwIfAborted()
    }
    return out
  }, true, signal)
  const result = []
  for (const item of picked) {
    let excerpt = ''
    try { const read = await pool.readForWorkbench(account, folder, item.uid, signal); excerpt = splitQuoted(String(read.text || '')).latest.slice(0, 300) } catch { if (signal?.aborted) throw signal.reason }
    result.push({ ...item, excerpt })
  }
  return result
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
