/**
 * Mailbox accounts owned by the workbench (replaces dsh-email's settings namespace).
 *
 * Stored in `<data>/mail/accounts.json` (mode 0600), separate from the workbench state document: the state is sent to the
 * page, the passwords never are. The page sees `MailAccountView`, which only says whether a password is set.
 *
 * Authentication is an explicit field so OAuth2 (Outlook / Microsoft 365) can be added later without a new format:
 * `auth: 'password'` (授权码 / app password) is the only kind accepted today.
 */
import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { canonicalAddress, canonicalDomain, serializeRecipientPolicies, type RecipientPolicy } from './recipient-policy.js'
import { PROVIDER_PRESETS, resolveEmailSettings, type AccountConfig, type ResolvedEmailSettings } from './config.js'

export type MailAuth = 'password'
export interface Endpoint { host: string; port: number; secure: boolean }
export interface MailAccount {
  /** Lower-cased address; also the account id used by tasks, rules and cursors. */
  id: string
  provider: string
  user: string
  auth: MailAuth
  password: string
  senderName?: string
  /** Login when it differs from the address (aliases, relays). */
  authUser?: string
  imap?: Endpoint
  smtp?: Endpoint
  inboxFolder?: string
  /** Addresses or domains shown as trusted in the send preview. */
  trusted?: string[]
  /** Addresses or domains the workbench refuses to send to. */
  blocked?: string[]
}
interface Document { version: 1; revision: number; defaultAccount?: string; accounts: MailAccount[] }
export interface MailAccountView extends Omit<MailAccount, 'password'> { hasPassword: boolean; isDefault: boolean }
export interface MailAccountInput {
  id?: string
  provider?: unknown; user?: unknown; password?: unknown; senderName?: unknown; authUser?: unknown
  imap?: unknown; smtp?: unknown; inboxFolder?: unknown; trusted?: unknown; blocked?: unknown
}

export class MailAccountError extends Error { constructor(message: string, readonly code = 'mail-account-invalid') { super(message) } }

/** Built-in providers offered on the account page; `custom` means the IMAP/SMTP servers are entered by hand. */
/** Tencent Exmail (企业微信邮箱) first: it is the default for company mailboxes. */
export const MAIL_PROVIDERS = ['exmail', 'qq', '163', '126', 'aliyun', 'gmail', 'icloud', 'sina', 'custom'] as const
/** Tencent Exmail (企业微信邮箱) is common for company mailboxes but not an upstream preset. */
const EXTRA_PRESETS: Record<string, { imap: Endpoint; smtp: Endpoint }> = {
  exmail: { imap: { host: 'imap.exmail.qq.com', port: 993, secure: true }, smtp: { host: 'smtp.exmail.qq.com', port: 465, secure: true } },
}
export function presetOf(provider: string): { imap: Endpoint; smtp: Endpoint } | undefined { return EXTRA_PRESETS[provider] ?? PROVIDER_PRESETS[provider] }

const text = (value: unknown, label: string, max = 320): string => {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string' || value.length > max || /[\r\n\u0000]/.test(value)) throw new MailAccountError(`${label}无效`)
  return value.trim()
}
function endpoint(value: unknown, label: string): Endpoint | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'object' || Array.isArray(value)) throw new MailAccountError(`${label}无效`)
  const raw = value as Record<string, unknown>, host = text(raw.host, label + '服务器', 253), port = Number(raw.port)
  if (!host) return undefined
  if (!/^[a-zA-Z0-9.-]+$/.test(host)) throw new MailAccountError(`${label}服务器地址无效`)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new MailAccountError(`${label}端口应为 1–65535`)
  return { host, port, secure: raw.secure !== false }
}
/** One address or domain per entry; `@` decides which. Returns canonical, de-duplicated entries. */
function recipients(value: unknown, label: string): string[] | undefined {
  if (value === undefined || value === null) return undefined
  const list = typeof value === 'string' ? value.split(/[\s,;，；]+/) : value
  if (!Array.isArray(list) || list.length > 200 || list.some(item => typeof item !== 'string')) throw new MailAccountError(`${label}最多 200 项`)
  const out: string[] = []
  for (const raw of list as string[]) {
    const item = raw.trim().replace(/^@/, '')
    if (!item) continue
    let canonical: string
    try { canonical = item.includes('@') ? canonicalAddress(item) : canonicalDomain(item) } catch { throw new MailAccountError(`${label}中有无效的地址或域名：${item}`) }
    if (!out.includes(canonical)) out.push(canonical)
  }
  return out.length ? out : undefined
}
const policy = (account: MailAccount): RecipientPolicy | undefined => {
  if (!account.trusted?.length && !account.blocked?.length) return undefined
  const split = (list: string[] = []) => ({ addresses: list.filter(item => item.includes('@')), domains: list.filter(item => !item.includes('@')) })
  const allow = split(account.trusted), deny = split(account.blocked)
  return { skipApproval: false, addresses: allow.addresses, domains: allow.domains, denyAddresses: deny.addresses, denyDomains: deny.domains }
}

export class MailAccounts {
  readonly file: string
  private cache?: Document
  private queue: Promise<unknown> = Promise.resolve()
  constructor(readonly root: string) { this.file = join(root, 'accounts.json') }

  async read(): Promise<Document> {
    if (this.cache) return this.cache
    let raw: string
    try { raw = await readFile(this.file, 'utf8') } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return (this.cache = { version: 1, revision: 0, accounts: [] }); throw error }
    const doc = JSON.parse(raw) as Document
    if (!doc || doc.version !== 1 || !Array.isArray(doc.accounts) || !Number.isSafeInteger(doc.revision)) throw new MailAccountError('邮箱账号文件已损坏，请在设置中重新添加账号', 'mail-accounts-corrupt')
    return (this.cache = doc)
  }
  private async write(doc: Document): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    const temporary = join(this.root, `.accounts-${randomUUID()}.json`)
    const handle = await open(temporary, 'wx', 0o600)
    try { await handle.writeFile(JSON.stringify(doc, null, 2)); await handle.sync() } finally { await handle.close() }
    try { await rename(temporary, this.file) } catch (error) { await unlink(temporary).catch(() => {}); throw error }
    this.cache = doc
  }
  /** Serialise writers inside this process; the workbench worker lock already excludes other processes. */
  private mutate<T>(change: (doc: Document) => T, expected?: number): Promise<T> {
    const run = this.queue.then(async () => {
      const current = await this.read()
      if (expected !== undefined && expected !== current.revision) throw new MailAccountError('邮箱账号已在别处修改，请刷新后重试', 'mail-account-conflict')
      const next: Document = structuredClone(current)
      const result = change(next)
      next.revision++
      await this.write(next)
      return result
    })
    this.queue = run.catch(() => undefined)
    return run
  }

  async views(): Promise<{ revision: number; accounts: MailAccountView[] }> {
    const doc = await this.read(), fallback = this.defaultOf(doc)
    return { revision: doc.revision, accounts: doc.accounts.map(({ password, ...account }) => ({ ...account, hasPassword: !!password, isDefault: account.id === fallback })) }
  }
  private defaultOf(doc: Document): string | undefined { return doc.accounts.some(account => account.id === doc.defaultAccount) ? doc.defaultAccount : doc.accounts[0]?.id }

  /** Validate an edit. A blank password keeps the stored one, so the page never needs to hold it. */
  normalize(input: MailAccountInput, existing?: MailAccount): MailAccount {
    if (!input || typeof input !== 'object') throw new MailAccountError('账号内容无效')
    const provider = text(input.provider, '邮箱服务商', 40) || 'custom'
    if (!(MAIL_PROVIDERS as readonly string[]).includes(provider)) throw new MailAccountError('暂不支持该邮箱服务商；Outlook / Microsoft 365 需要 OAuth2 登录，将在后续版本支持')
    let user: string
    try { user = canonicalAddress(text(input.user, '邮箱地址')) } catch { throw new MailAccountError('请填写完整邮箱地址，如 name@example.com') }
    const id = user.toLowerCase()
    if (existing && existing.id !== id) throw new MailAccountError('邮箱地址不能修改；请删除后重新添加')
    const password = text(input.password, '授权码', 512) || existing?.password || ''
    if (!password) throw new MailAccountError('请填写授权码（邮箱设置中开启 IMAP/SMTP 后生成的专用密码）')
    const imap = endpoint(input.imap, 'IMAP '), smtp = endpoint(input.smtp, 'SMTP ')
    if (provider === 'custom' && (!imap || !smtp)) throw new MailAccountError('自定义邮箱需要填写 IMAP 和 SMTP 服务器')
    const account: MailAccount = { id, provider, user, auth: 'password', password }
    const senderName = text(input.senderName, '发件人名称', 120), authUser = text(input.authUser, '登录名', 320), inboxFolder = text(input.inboxFolder, '收件箱文件夹', 200)
    if (senderName) account.senderName = senderName
    if (authUser && authUser.toLowerCase() !== id) account.authUser = authUser
    if (imap) account.imap = imap
    if (smtp) account.smtp = smtp
    if (inboxFolder && inboxFolder !== 'INBOX') account.inboxFolder = inboxFolder
    // Omitted lists keep what is stored; an explicit empty value clears them.
    const trusted = input.trusted === undefined ? existing?.trusted : recipients(input.trusted, '可信收件人')
    const blocked = input.blocked === undefined ? existing?.blocked : recipients(input.blocked, '禁止发送')
    if (trusted) account.trusted = trusted
    if (blocked) account.blocked = blocked
    return account
  }

  async save(input: MailAccountInput, revision: number): Promise<MailAccountView[]> {
    await this.mutate(doc => {
      const id = typeof input?.id === 'string' && input.id ? input.id : undefined
      const existing = id ? doc.accounts.find(account => account.id === id) : undefined
      if (id && !existing) throw new MailAccountError('账号不存在，请刷新后重试', 'mail-account-conflict')
      const account = this.normalize(input, existing)
      if (!existing && doc.accounts.some(item => item.id === account.id)) throw new MailAccountError('该邮箱已添加')
      if (!existing && doc.accounts.length >= 20) throw new MailAccountError('最多添加 20 个邮箱账号')
      doc.accounts = existing ? doc.accounts.map(item => item.id === account.id ? account : item) : [...doc.accounts, account]
    }, revision)
    return (await this.views()).accounts
  }
  async remove(id: string, revision: number): Promise<void> {
    await this.mutate(doc => {
      if (!doc.accounts.some(account => account.id === id)) throw new MailAccountError('账号不存在，请刷新后重试', 'mail-account-conflict')
      doc.accounts = doc.accounts.filter(account => account.id !== id)
      if (doc.defaultAccount === id) delete doc.defaultAccount
    }, revision)
  }
  async setDefault(id: string, revision: number): Promise<void> {
    await this.mutate(doc => { if (!doc.accounts.some(account => account.id === id)) throw new MailAccountError('账号不存在'); doc.defaultAccount = id }, revision)
  }

  /** dsh-email's resolved settings for these accounts (endpoint presets, policy, limits). */
  static resolve(accounts: MailAccount[], defaultAccount?: string, downloadDir?: string): ResolvedEmailSettings {
    const map: Record<string, AccountConfig> = {}
    for (const account of accounts) {
      const preset = presetOf(account.provider)
      map[account.id] = {
        user: account.user, password: account.password, authKind: 'password',
        ...(account.senderName ? { senderName: account.senderName } : {}),
        ...(account.authUser ? { authUser: account.authUser } : {}),
        imap: account.imap ?? preset?.imap, smtp: account.smtp ?? preset?.smtp,
        inboxFolder: account.inboxFolder || 'INBOX',
      }
    }
    const policies = new Map<string, RecipientPolicy>()
    for (const account of accounts) { const rules = policy(account); if (rules) policies.set(account.id, rules) }
    const fallback = accounts.some(account => account.id === defaultAccount) ? defaultAccount : accounts[0]?.id
    return resolveEmailSettings({ accounts: map, ...(fallback ? { defaultAccount: fallback } : {}), trustedRecipientsYaml: serializeRecipientPolicies(policies), ...(downloadDir ? { downloadDir } : {}) })
  }
  async settings(downloadDir?: string): Promise<ResolvedEmailSettings> {
    const doc = await this.read()
    if (!doc.accounts.length) throw new MailAccountError('请先在工作台设置中添加邮箱账号', 'mail-not-configured')
    return MailAccounts.resolve(doc.accounts, doc.defaultAccount, downloadDir)
  }
}
