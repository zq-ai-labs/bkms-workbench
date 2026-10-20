import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, open, stat } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { DraftError, DraftStore, draftFields, draftThreading, type DraftAttachment, type EmailDraft } from './draft-store.js'
import { assertRecipientsAllowed, matchRecipients, serializeRecipientPolicies, RecipientPolicyError } from './recipient-policy.js'
import { messageOf, redactCredentials } from './mail-client.js'
import { EMAIL_BODY_FORMAT, renderEmailHtml } from './email-format.js'
import type { ResolvedEmailSettings } from './config.js'
import type { EmailPool } from './mail-client.js'
import type { EmailSendResult } from './types.js'

/**
 * Adapted from dsh-email src/draft-web.ts (MIT): accounts and recipient rules come from the workbench's own account
 * store, the settings-page rule editor actions are gone, and the route lives under the workbench API.
 */
export const EMAIL_DRAFT_ROUTE = '/api/bkms-workbench/drafts'
export const DRAFT_HEADER = 'x-bkms-workbench-draft'
export interface DraftRuntime { getEffectiveSettings(): ResolvedEmailSettings; getPool(): Pick<EmailPool, 'sendPrepared'> }
const MAX_BYTES = 20 * 1024 * 1024
const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const json = (status: number, value: unknown): Response => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
interface Options { store?: DraftStore; now?: () => number }
interface AttachmentSnapshot { id: string; filename: string; content: Buffer }
interface Plan { id: string; created: number; key: string; draft: EmailDraft; attachments: AttachmentSnapshot[] }
const editable = (draft: EmailDraft): void => { if (draft.state !== 'draft') throw new DraftError('已提交或结果未确定的邮件不能再次发送；请先去邮箱核对，必要时复制为新草稿', 'draft-submitted') }
// Structured transport evidence only. A generic timeout after DATA remains uncertain.
function failedBeforeSubmission(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const { command, syscall, code } = error as { command?: string; syscall?: string; code?: string }
  return (command === 'CONN' || syscall === 'connect') && ['ETIMEDOUT', 'ECONNREFUSED', 'ECONNRESET', 'ENETUNREACH', 'EHOSTUNREACH', 'ENOTFOUND', 'EAI_AGAIN', 'ESOCKET', 'ECONNECTION', 'EDNS'].includes(code ?? '')
}
const view = (draft: EmailDraft) => ({ ...draft, attachments: draft.attachments.map(({ id, filename }) => ({ id, filename })) })

/** All mutations use the host's authenticated fetch carrier and an explicit UI action. */
export class EmailDraftBackend {
  readonly store: DraftStore
  private readonly plans = new Map<string, Plan>()
  constructor(private readonly runtime: DraftRuntime, private readonly options: Options = {}) { this.store = options.store ?? new DraftStore() }
  private now(): number { return this.options.now?.() ?? Date.now() }
  private prune(): void { for (const [id, plan] of this.plans) if (this.now() - plan.created > 10 * 60 * 1000) this.plans.delete(id) }
  private invalidate(id: string): void { for (const [key, plan] of this.plans) if (plan.draft.id === id) this.plans.delete(key) }
  private connection(account: string) {
    const settings = this.runtime.getEffectiveSettings(), name = account || settings.defaultAccount, config = settings.accounts.get(name)
    if (!config) throw new DraftError('发件账号不存在，请重新选择账号')
    const policies = settings.recipientPolicies ?? new Map()
    return { name, config, cap: Math.min(settings.maxAttachmentBytes, MAX_BYTES), policy: policies.get(name), key: hash({ name, config, cap: settings.maxAttachmentBytes, policies: serializeRecipientPolicies(policies) }) }
  }
  private safe(error: unknown): string {
    let message = redactCredentials(messageOf(error, '操作失败，请稍后重试'))
    try { for (const account of this.runtime.getEffectiveSettings().accounts.values()) for (const secret of [account.password, account.authPassword]) if (secret && secret.length >= 4) message = message.split(secret).join('[已隐藏]') } catch { /* Incomplete account errors are actionable. */ }
    return message.slice(0, 1200)
  }
  private async bytes(file: DraftAttachment, cap: number, signal?: AbortSignal): Promise<Buffer> {
    signal?.throwIfAborted()
    let stream: ReturnType<typeof createReadStream> | undefined
    try {
      const info = await stat(file.path)
      if (!info.isFile() || info.size > cap) throw new Error('size')
      stream = createReadStream(file.path, { signal }); const parts: Buffer[] = []; let total = 0
      for await (const part of stream) { signal?.throwIfAborted(); const chunk = Buffer.from(part); total += chunk.length; if (total > cap) throw new Error('size'); parts.push(chunk) }
      return Buffer.concat(parts)
    } catch { signal?.throwIfAborted(); throw new DraftError('附件「' + file.filename + '」不可读或超过草稿附件上限，请移除后重新添加') }
    finally { stream?.destroy() }
  }
  private async attachments(draft: EmailDraft, cap: number, signal?: AbortSignal): Promise<AttachmentSnapshot[]> {
    const result: AttachmentSnapshot[] = []; let used = 0
    for (const file of draft.attachments) { const content = await this.bytes(file, cap - used, signal); used += content.length; result.push({ id: file.id, filename: file.filename, content }) }
    return result
  }
  async create(input: Record<string, unknown>, signal?: AbortSignal): Promise<EmailDraft> {
    const fields = draftFields(input)
    if (!fields.account) { try { fields.account = this.runtime.getEffectiveSettings().defaultAccount } catch { /* A local draft is useful even before the mailbox is configured. */ } }
    const paths = input.attachments ?? []
    if (!Array.isArray(paths) || paths.length > 10 || paths.some(file => typeof file !== 'string' || !file.trim())) throw new DraftError('附件应为最多 10 个本地文件路径')
    const files: DraftAttachment[] = paths.map(path => ({ id: randomUUID(), path: resolve(path as string), filename: basename(path as string), owned: false }))
    if (files.length) { const cap = fields.account ? this.connection(fields.account).cap : MAX_BYTES; await this.attachments({ attachments: files } as EmailDraft, cap, signal) }
    return this.store.create(fields, files, signal, { ...draftThreading(input), ...(input.sourceKey !== undefined ? { sourceKey: input.sourceKey as string } : {}) })
  }
  private async recover(signal?: AbortSignal): Promise<void> {
    for (const draft of await this.store.list()) if (draft.state === 'sending') {
      try { await this.store.sendLock(draft.id, async current => { await this.store.change(draft.id, draft.revision, value => { if (value.state === 'sending') { value.state = 'uncertain'; value.error = '上次提交未留下完整回执；请先去邮箱核对，不会自动重发' } }, current) }, signal) }
      catch (error) { if (!(error instanceof DraftError) || !['draft-busy', 'draft-conflict', 'draft-missing'].includes(error.code)) throw error }
    }
  }
  async action(body: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    this.prune(); signal?.throwIfAborted()
    if (body.action === 'list') {
      await this.recover(signal)
      return { drafts: (await this.store.list()).map(view) }
    }
    if (body.action === 'create') return view(await this.create({ ...body, attachments: [] }, signal)) // Browser attachments only come from its file chooser.
    const id = typeof body.id === 'string' ? body.id : '', draft = await this.store.get(id)
    if (body.action === 'get') return view(draft)
    if (body.action === 'cancelPreview') { this.invalidate(id); return { cancelled: true } }
    if (body.action === 'resolveSend') {
      if (body.confirmed !== true || !['sent', 'not_sent'].includes(body.outcome as string)) throw new DraftError('请先核对邮箱，再明确确认发送结果')
      return this.store.sendLock(id, async current => {
        const changed = await this.store.change(id, body.revision, value => {
          if (value.state !== 'uncertain') throw new DraftError('只有发送待核实的草稿可以核对结果', 'draft-conflict')
          value.sendChecks = [...(value.sendChecks ?? []), { at: new Date(this.now()).toISOString(), outcome: body.outcome as 'sent' | 'not_sent', ...(value.error ? { error: value.error } : {}), ...(value.attemptAt ? { attemptAt: value.attemptAt } : {}) }].slice(-50)
          value.state = body.outcome === 'sent' ? 'sent' : 'draft'
          delete value.error; delete value.sendFailure
          if (value.state === 'draft') delete value.attemptAt
        }, current)
        this.invalidate(id)
        return view(changed)
      }, signal)
    }
    if (body.action === 'update') {
      editable(draft)
      const fields = draftFields(body), keep = body.attachments ?? draft.attachments.map(file => file.id)
      if (!Array.isArray(keep) || keep.some(key => !draft.attachments.some(file => file.id === key)) || new Set(keep).size !== keep.length) throw new DraftError('附件列表无效，请重新打开草稿')
      const changed = await this.store.change(id, body.revision, value => { editable(value); Object.assign(value, fields); value.attachments = value.attachments.filter(file => keep.includes(file.id)) }, signal)
      this.invalidate(id); for (const file of draft.attachments) if (!changed.attachments.some(kept => kept.id === file.id)) await this.store.removeOwnedFile(id, file)
      return view(changed)
    }
    if (body.action === 'delete') {
      if (body.confirmed !== true) throw new DraftError('请先确认删除本地草稿与上传副本')
      await this.store.remove(id, body.revision, signal); this.invalidate(id); return { removed: true }
    }
    if (body.action === 'copy') {
      if (draft.revision !== body.revision) throw new DraftError('草稿已改变，请重新打开后复制', 'draft-conflict')
      if (draft.state === 'sending') throw new DraftError('邮件还在提交，请结束后再复制', 'draft-busy')
      if (body.confirmed !== true) throw new DraftError('请先核对邮箱，再确认复制为新草稿')
      const contents = await this.attachments(draft, MAX_BYTES, signal), created = await this.store.create(draftFields(draft), [], signal), files: DraftAttachment[] = []
      try {
        for (const file of contents) { const owned = this.store.uploadPath(created.id, file.filename), stored = { id: randomUUID(), ...owned, owned: true }; files.push(stored); await this.writeUpload(owned.path, file.content, signal) }
        const changed = await this.store.change(created.id, created.revision, value => { value.attachments = files }, signal); return view(changed)
      } catch (error) { for (const file of files) await this.store.removeOwnedFile(created.id, file); await this.store.remove(created.id, created.revision).catch(() => {}); throw error }
    }
    if (body.action === 'preview') {
      editable(draft); if (draft.revision !== body.revision) throw new DraftError('草稿已改变，请保存后重新预览', 'draft-conflict')
      if (!draft.subject) throw new DraftError('请先填写并保存邮件主题')
      const connection = this.connection(draft.account), matching = await matchRecipients(draft.to, draft.cc, connection.policy), attachments = await this.attachments(draft, connection.cap, signal)
      if (connection.key !== this.connection(draft.account).key || (await this.store.get(id)).revision !== draft.revision) throw new DraftError('草稿或账号已改变，请重新预览', 'draft-conflict')
      this.invalidate(id); if (this.plans.size >= 3) this.plans.delete(this.plans.keys().next().value!)
      const plan: Plan = { id: randomUUID(), created: this.now(), key: connection.key, draft, attachments }; this.plans.set(plan.id, plan)
      return { id: plan.id, draft: view(draft), bodyHtml: renderEmailHtml(draft.text), bodyFormat: EMAIL_BODY_FORMAT, from: { address: connection.config.user, name: connection.config.senderName }, matching, attachments: attachments.map(({ id, filename, content }) => ({ id, filename, size: content.length, sha256: createHash('sha256').update(content).digest('hex') })), expiresAt: plan.created + 10 * 60 * 1000 }
    }
    if (body.action === 'send') {
      if (body.confirmed !== true) throw new DraftError('请核对预览后明确确认发送')
      const plan = typeof body.preview === 'string' ? this.plans.get(body.preview) : undefined
      if (!plan || plan.draft.id !== id) throw new DraftError('预览已过期或已用过，请重新预览', 'draft-preview-expired')
      return this.store.sendLock(id, async current => {
        const before = await this.store.get(id); editable(before)
        if (before.revision !== plan.draft.revision || plan.key !== this.connection(before.account).key) throw new DraftError('草稿、账号或规则已改变，请重新预览', 'draft-conflict')
        await assertRecipientsAllowed(before.to, before.cc, this.connection(before.account).policy)
        const pool = this.runtime.getPool(); current.throwIfAborted()
        const pending = await this.store.change(id, before.revision, value => { editable(value); value.state = 'sending'; value.attemptAt = new Date(this.now()).toISOString(); delete value.sendFailure; delete value.error }, current)
        this.invalidate(id)
        let unchanged = false
        try { unchanged = plan.key === this.connection(before.account).key } catch { /* A now-incomplete account also invalidates this review. */ }
        if (!unchanged) {
          await this.store.change(id, pending.revision, value => { value.state = 'draft'; delete value.attemptAt })
          throw new DraftError('账号或规则已改变，邮件未提交；请重新预览', 'draft-conflict')
        }
        let receipt: EmailSendResult
        try { receipt = await pool.sendPrepared(before.account, before.to, before.subject, before.text, before.cc, plan.attachments.map(({ filename, content }) => ({ filename, content })), current, draftThreading(before as unknown as Record<string, unknown>)) }
        catch (error) {
          if (error instanceof RecipientPolicyError) {
            await this.store.change(id, pending.revision, value => { value.state = 'draft'; delete value.attemptAt })
            throw error
          }
          if (failedBeforeSubmission(error)) {
            const failed = await this.store.change(id, pending.revision, value => { value.state = 'draft'; value.sendFailure = 'not_submitted'; value.error = 'SMTP 连接建立前失败，邮件未提交。请检查网络与发件服务器配置后重新预览发送。' + this.safe(error) }).catch(() => null)
            if (!failed) throw new DraftError('发送失败记录未能保存；请先核对邮箱', 'draft-storage')
            return { draft: view(failed) }
          }
          const failed = await this.store.change(id, pending.revision, value => { value.state = 'uncertain'; value.error = '提交结果未确定；请先去邮箱核对，不会自动重发。' + this.safe(error) }).catch(() => null)
          if (!failed) throw new DraftError('提交结果未确定，且回执未能保存；请先去邮箱核对，不要直接重发', 'draft-storage')
          return { draft: view(failed) }
        }
        // Once SMTP acknowledges, a disconnected browser must not prevent the receipt from being persisted.
        try { return { draft: view(await this.store.change(id, pending.revision, value => { value.state = 'sent'; value.receipt = receipt })) } }
        catch { throw new DraftError('SMTP 已返回回执，但本地保存失败；请先核对邮箱，不要再次发送', 'draft-storage') }
      }, signal)
    }
    throw new DraftError('不支持此草稿操作')
  }
  private async writeUpload(path: string, content: Buffer, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted(); await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    const file = await open(path, 'wx', 0o600)
    try { await file.writeFile(content); signal?.throwIfAborted(); await file.sync() } finally { await file.close() }
  }
  private async upload(request: Request, content: Buffer, signal: AbortSignal): Promise<unknown> {
    const id = request.headers.get('x-dsh-draft-id') ?? '', revision = Number(request.headers.get('x-dsh-draft-revision')), draft = await this.store.get(id); editable(draft)
    if (draft.revision !== revision || draft.attachments.length >= 10) throw new DraftError('草稿已改变或附件已达 10 个，请保存并重新打开后添加', 'draft-conflict')
    let filename: string
    try { filename = decodeURIComponent(request.headers.get('x-dsh-draft-filename') ?? '') } catch { throw new DraftError('附件名称无效') }
    if (!filename || filename.length > 500) throw new DraftError('附件名称为空或过长')
    let existingSize = 0
    for (const file of draft.attachments) { const info = await stat(file.path).catch(() => null); if (info?.isFile()) existingSize += info.size }
    const cap = (() => { try { return this.connection(draft.account).cap } catch { return MAX_BYTES } })()
    if (existingSize + content.length > cap) throw new DraftError('草稿附件总大小最多 ' + Math.floor(cap / 1024 / 1024) + ' MiB')
    const owned = { id: randomUUID(), ...this.store.uploadPath(id, filename), owned: true }
    try {
      await this.writeUpload(owned.path, content, signal)
      const changed = await this.store.change(id, revision, value => { editable(value); value.attachments.push(owned) }, signal); this.invalidate(id); return view(changed)
    } catch (error) { await this.store.removeOwnedFile(id, owned); throw error }
  }
  async fetch(request: Request): Promise<Response> {
    const site = request.headers.get('sec-fetch-site'), origin = request.headers.get('origin')
    const fail = (status: number, error: unknown) => json(status, { ok: false, error: { code: error instanceof DraftError ? error.code : 'draft-invalid', message: this.safe(error) } })
    if (site && !['same-origin', 'none'].includes(site)) return fail(403, new DraftError('请从邮件草稿面板操作'))
    if (origin) { try { const url = new URL(origin); if (!['http:', 'https:'].includes(url.protocol) || url.host !== (request.headers.get('host') || new URL(request.url).host)) return fail(403, new DraftError('拒绝跨源操作')) } catch { return fail(403, new DraftError('无效来源')) } }
    try {
      this.prune()
      if (request.method === 'GET') {
        const url = new URL(request.url), plan = this.plans.get(url.searchParams.get('preview') ?? ''), file = plan?.attachments.find(file => file.id === url.searchParams.get('attachment'))
        if (!plan || !file || plan.key !== this.connection(plan.draft.account).key) return fail(404, new DraftError('附件预览已失效，请重新预览'))
        return new Response(new Uint8Array(file.content), { headers: { 'content-type': 'application/octet-stream', 'content-disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(file.filename), 'x-content-type-options': 'nosniff', 'cache-control': 'no-store' } })
      }
      if (request.method !== 'POST') return fail(405, new DraftError('请使用草稿面板支持的操作'))
      const type = request.headers.get('content-type')?.split(';')[0].trim().toLowerCase()
      if (request.headers.get(DRAFT_HEADER) !== '1' || !['application/json', 'application/octet-stream'].includes(type ?? '')) return fail(403, new DraftError('请从邮件草稿面板操作'))
      const reader = request.body?.getReader(); if (!reader) throw new DraftError('请求为空')
      const limit = type === 'application/octet-stream' ? MAX_BYTES : 256 * 1024, chunks: Uint8Array[] = []; let size = 0
      try { for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > limit) { await reader.cancel(); return fail(413, new DraftError('请求超过大小上限')) } chunks.push(value) } } finally { reader.releaseLock() }
      const content = Buffer.concat(chunks), signal = AbortSignal.any([request.signal, AbortSignal.timeout(120000)])
      if (type === 'application/octet-stream') return json(200, { ok: true, value: await this.upload(request, content, signal) })
      const body = JSON.parse(content.toString('utf8'))
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new DraftError('请求必须为对象')
      return json(200, { ok: true, value: await this.action(body, signal) })
    } catch (error) { return fail(error instanceof DraftError && ['draft-conflict', 'draft-busy', 'draft-submitted'].includes(error.code) ? 409 : 400, error) }
  }
}
