import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { open, stat, unlink } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { join, basename } from 'node:path'
import { chooseRule } from './rules.js'
import { Store, findTask, log, touch } from './store.js'
import { WorkbenchError, now, type AgentRunner, type EmailService, type Task } from './types.js'

const address = (entries: any[]): string => (entries || []).map(e => e.address || '').filter(Boolean).join(', ')
const readableFrom = (entries: any[]): string => (entries || []).map(e => e.name ? `${e.name} <${e.address || ''}>` : e.address || '').filter(Boolean).join(', ')
export class Engine {
  private stopping = false
  private polling = false
  private processing = false
  private timer?: ReturnType<typeof setTimeout>
  private controller = new AbortController()
  private release?: () => Promise<void>
  private lastPoll?: string
  private error?: string
  private lastCheck = 0
  constructor(readonly store: Store, private emailSource: () => EmailService | undefined, readonly agent: AgentRunner, readonly capabilities: () => Promise<unknown> = async () => ({ tools: [], skills: [] })) {}
  email(): EmailService { const email = this.emailSource(); if (!email || email.version !== 1) throw new WorkbenchError('需要启用提供工作台接口的 dsh-email 本地构建。', 'email-unavailable', 503); return email }
  health() { return { email: this.emailSource()?.version === 1, agent: this.agent.available(), running: !!this.release && !this.stopping, lastPoll: this.lastPoll, error: this.error } }
  async start(): Promise<void> {
    this.release = await this.store.ownWorker(error => { this.error = this.safe(error); void this.stop() }, true)
    try { await this.store.mutate(state => {
      for (const task of state.tasks) {
        if (task.status === 'running') { task.status = 'queued'; touch(task, '服务重启，恢复未完成的准备任务。') }
        if (task.status === 'sending') { task.status = 'uncertain'; task.error = '服务在发送期间重启，请核对发送记录。'; touch(task, task.error) }
      }
      log(state, '工作台后台已启动。首次连接邮箱仅建立基线，不处理历史邮件。')
    }) } catch (error) { await this.release(); this.release = undefined; throw error }
    this.schedule(250)
  }
  private schedule(delay = 5000): void {
    if (this.stopping) return
    this.timer = setTimeout(() => { void this.tick().catch(error => { this.error = this.safe(error) }).finally(() => this.schedule()) }, delay)
    this.timer.unref?.()
  }
  private async tick(): Promise<void> {
    const state = await this.store.read()
    if (!state.settings.enabled) return
    if (Date.now() - this.lastCheck >= state.settings.pollSeconds * 1000) { this.lastCheck = Date.now(); await this.poll() }
    await this.processNext()
  }
  async stop(): Promise<void> {
    this.stopping = true; clearTimeout(this.timer); this.controller.abort(new Error('工作台已停止'))
    // Do not release the worker lock while an execution can still mutate state.
    while (this.polling || this.processing) await new Promise(resolve => setTimeout(resolve, 50))
    await this.release?.(); this.release = undefined
  }
  safe(error: unknown): string {
    const value = error instanceof Error ? error.message : '处理失败，请查看任务记录。'
    return value.replace(/(?:Bearer\s+)[^\s]+/gi, 'Bearer [隐藏]').replace(/((?:password|token|api.?key|authorization)\s*[=:]\s*)[^\s,;]+/gi, '$1[隐藏]').slice(0, 1200)
  }
  async readOriginal(task: Task, signal: AbortSignal): Promise<any> {
    const email = this.email(), source = task.source
    await email.scan({ account: source.account, folder: source.folder, cursor: { uidValidity: source.uidValidity, lastUid: source.uid }, limit: 1 }, signal)
    const read = await email.read(source.account, source.folder, source.uid, signal)
    if (read.uidValidity !== undefined && read.uidValidity !== source.uidValidity) throw new WorkbenchError('邮箱邮件编号已变化，停止处理以避免读取其他邮件。', 'email-cursor-reset', 409)
    return read
  }
  async attachment(task: Task, index: number, signal: AbortSignal): Promise<{ path: string; filename: string }> {
    const workspace = join(this.store.root, 'tasks', task.id)
    await mkdir(workspace, { recursive: true, mode: 0o700 })
    const result = await this.email().downloadAttachment(task.account, task.source.folder, task.source.uid, index, workspace, signal, task.source.uidValidity)
    const maximum = 20 * 1024 * 1024
    const sourceStat = await stat(result.path)
    if (!sourceStat.isFile()) throw new WorkbenchError('附件来源不是普通文件。')
    if (sourceStat.size > maximum) throw new WorkbenchError('单个附件超过 20 MiB，请人工处理。')
    // Explicit email downloadDir may point outside this task. Copy into a
    // private unique file before exposing it to the task's restricted Agent.
    const filename = String(result.filename || 'attachment'), target = join(workspace, randomUUID() + '-' + basename(filename).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(-120))
    const handle = await open(target, 'wx', 0o600)
    let complete = false
    try {
      let size = 0
      for await (const chunk of createReadStream(result.path, { signal })) { size += chunk.length; if (size > maximum) throw new WorkbenchError('附件超过大小上限。'); signal.throwIfAborted(); await handle.writeFile(chunk) }
      await handle.sync()
      complete = true
    } finally { await handle.close(); if (!complete) await unlink(target).catch(() => {}) }
    return { path: target, filename }
  }
  async poll(): Promise<{ checked: boolean; added: number }> {
    if (this.polling) return { checked: false, added: 0 }
    if (this.stopping || !this.release) throw new WorkbenchError('后台尚未就绪。', 'not-ready', 503)
    this.polling = true; let added = 0
    const signal = AbortSignal.any([this.controller.signal, AbortSignal.timeout(90000)])
    try {
      const email = this.email(), accounts = await email.accounts(), state = await this.store.read()
      const folders = new Map<string, { account: string; folder: string }>()
      for (const account of accounts) {
        folders.set(JSON.stringify([account.id, account.inboxFolder || 'INBOX']), { account: account.id, folder: account.inboxFolder || 'INBOX' })
        for (const rule of state.rules.filter(r => r.enabled && (!r.account || r.account === account.id))) folders.set(JSON.stringify([account.id, rule.folder]), { account: account.id, folder: rule.folder })
      }
      for (const [key, source] of folders) {
        try {
          for (let page = 0; page < 10; page++) {
            signal.throwIfAborted()
            const before = (await this.store.read()).cursors[key]
            const batch = await email.scan({ ...source, cursor: before, limit: 50 }, signal)
            if (batch.reset) throw new WorkbenchError('邮箱 UIDVALIDITY 已改变，请在确认邮箱后重建基线。', 'email-cursor-reset', 409)
            added += await this.store.mutate(doc => {
              if (JSON.stringify(doc.cursors[key]) !== JSON.stringify(before)) return 0
              let count = 0
              for (const mail of batch.messages) {
                if (doc.tasks.some(t => t.source.account === source.account && t.source.folder === source.folder && t.source.uidValidity === batch.cursor.uidValidity && t.source.uid === mail.uid)) continue
                const from = readableFrom(mail.from), rule = chooseRule(doc.rules, { ...source, from, subject: mail.subject || '', hasAttachments: !!mail.hasAttachments })
                const timestamp = now(), task: Task = { id: randomUUID(), revision: 1, title: mail.subject || '无主题邮件', account: source.account, status: rule ? 'queued' : 'unmatched', from, subject: mail.subject || '', body: '', receivedAt: mail.date || timestamp, updatedAt: timestamp, source: { ...source, uid: mail.uid, uidValidity: batch.cursor.uidValidity }, attachments: [], history: [{ at: timestamp, message: rule ? `命中规则「${rule.name}」，等待处理。` : '未匹配规则，可手动选择规则处理。' }], attempts: 0 }
                task.hasAttachments = !!mail.hasAttachments
                if (rule) { task.ruleId = rule.id; task.ruleName = rule.name; task.rule = structuredClone(rule) }
                doc.tasks.push(task); count++
              }
              doc.cursors[key] = batch.cursor
              if (batch.firstRun) log(doc, `${source.account} / ${source.folder} 已建立基线，后续新增邮件开始处理。`)
              if (count) log(doc, `${source.account} / ${source.folder} 接收 ${count} 封新邮件。`)
              return count
            })
            if (!batch.hasMore) break
          }
        } catch (error) {
          const message = this.safe(error); this.error = message
          await this.store.mutate(doc => log(doc, `${source.account} / ${source.folder} 检查失败：${message}`, undefined, 'error'))
        }
      }
      this.lastPoll = now()
      return { checked: true, added }
    } finally { this.polling = false }
  }
  async processNext(): Promise<void> {
    if (this.processing || this.stopping || !this.release || !this.agent.available() || !this.emailSource()) return
    this.processing = true
    let task: Task | undefined
    const signal = AbortSignal.any([this.controller.signal, AbortSignal.timeout(5 * 60 * 1000)])
    try {
      task = await this.store.mutate(state => {
        const item = state.tasks.find(t => t.status === 'queued' && (!t.nextAttemptAt || t.nextAttemptAt <= now()))
        if (!item) return undefined
        item.status = 'running'; item.attempts++; item.prepareKey ??= randomUUID(); delete item.error; touch(item, '开始读取资料并调用 DSH。'); log(state, '任务开始处理。', item.id)
        return item
      })
      if (!task) return
      if (!task.rule) throw new WorkbenchError('任务缺少规则快照。')
      const email = this.email(), read = await this.readOriginal(task, signal)
      task.body = read.text || ''; task.attachments = read.attachments || []
      task.messageId = read.messageId; task.references = read.references; task.replyTo = address(read.replyTo?.length ? read.replyTo : read.from)
      const workspace = join(this.store.root, 'tasks', task.id)
      await mkdir(workspace, { recursive: true, mode: 0o700 })
      task.workspace = workspace
      // Download attachments only when a rule explicitly authorizes a tool to read them.
      if (task.rule.tools.length && task.attachments.length) {
        for (let index = 0; index < task.attachments.length && index < 10; index++) {
          const file = task.attachments[index]
          const result = await this.attachment(task, index, signal)
          file.localPath = result.path
        }
      }
      await this.store.mutate(state => { const item = findTask(state, task!.id); Object.assign(item, { body: task!.body, mailLoaded: true, attachments: task!.attachments, workspace, messageId: task!.messageId, references: task!.references, replyTo: task!.replyTo }); touch(item, '原邮件与资料已读取。') })
      const result = await this.agent.run(task, task.rule, signal)
      signal.throwIfAborted()
      let draftId = task.draftId
      if (task.rule.output === 'reply' && !result.output.needsInfo) {
        if (!result.output.text?.trim()) throw new WorkbenchError('DSH 未生成可审核的回复正文。')
        if (draftId) {
          // Never overwrite a human-edited draft when regenerating.
          const current = await email.drafts.get(draftId)
          if (current.state !== 'draft') throw new WorkbenchError('原草稿已发送或结果待核实，不能重新生成。')
        }
        const references = [...new Set([...(task.references || '').split(/\s+/), task.messageId || ''].filter(Boolean))].join(' ')
        const draft = await email.drafts.create({ sourceKey: `bkms-workbench:${task.id}:${task.prepareKey}`, account: task.account, to: task.replyTo, cc: '', subject: result.output.subject || (/^re:/i.test(task.subject) ? task.subject : `Re: ${task.subject}`), text: result.output.text, inReplyTo: task.messageId || '', references, attachments: [] }, signal)
        draftId = draft.id
      }
      await this.store.mutate(state => {
        const item = findTask(state, task!.id)
        Object.assign(item, { summary: result.output.summary, sessionId: result.sessionId, draftId, status: result.output.needsInfo ? 'needs_info' : item.rule?.output === 'reply' ? 'review' : 'completed', error: result.output.needsInfo || undefined })
        touch(item, result.output.needsInfo ? '需要补充信息后继续。' : draftId ? '已生成回复草稿，等待人工审核。' : '分析报告已生成。'); log(state, 'DSH 处理完成。', item.id)
      })
      this.error = undefined
    } catch (error) {
      this.error = this.safe(error)
      if (task) await this.store.mutate(state => {
        const item = findTask(state, task!.id); item.error = this.safe(error)
        const retry = !this.stopping && item.attempts <= (item.rule?.maxRetries ?? 0)
        item.status = retry ? 'queued' : 'failed'; item.nextAttemptAt = retry ? new Date(Date.now() + 30000 * item.attempts).toISOString() : undefined
        touch(item, retry ? '处理失败，稍后自动重试。' : '处理失败，可人工重试。'); log(state, item.error!, item.id, 'error')
      })
      else throw error
    } finally { this.processing = false }
  }
}
