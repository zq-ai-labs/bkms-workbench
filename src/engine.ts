import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { open, stat, unlink } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { join, basename } from 'node:path'
import { candidateRules, chooseAfterTriage, chooseRule } from './rules.js'
import { originalMailFields } from './original-mail.js'
import { Store, findTask, log, touch } from './store.js'
import { heuristicTriage } from './triage.js'
import { activityEntry, briefData, briefTemplate, localDate, localMinutes, parseClock, senderAddress, startOfWeek, topicData, topicMatches, topicTemplate, weeklyData, weeklyTemplate } from './digest.js'
import { WorkbenchError, now, type AgentOutput, type AgentRunner, type Check, type EmailService, type Rule, type Settings, type State, type Task, type TopicSummary, type TriageRunner, type WriterRunner } from './types.js'

const address = (entries: any[]): string => (entries || []).map(e => e.address || '').filter(Boolean).join(', ')
const readableFrom = (entries: any[]): string => (entries || []).map(e => e.name ? `${e.name} <${e.address || ''}>` : e.address || '').filter(Boolean).join(', ')
/** Settings with defaults applied. Stored settings keep only what the user saved. */
export const settingsOf = (settings: Settings) => ({
  triage: settings.triage !== false, undoMinutes: settings.undoMinutes ?? 30,
  briefEnabled: settings.briefEnabled !== false, briefTime: settings.briefTime ?? '08:00',
  weeklyEnabled: settings.weeklyEnabled !== false, weeklyDay: settings.weeklyDay ?? 5, weeklyTime: settings.weeklyTime ?? '17:00',
  meetingBriefMinutes: settings.meetingBriefMinutes ?? 30,
})
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g
const STALE_AUTO_SEND = 60 * 60000
/** Deterministic bounds for an automatic reply. The model's own judgement is necessary but never sufficient. */
export function autoSendDecision(rule: Rule, task: Task, output: AgentOutput, checks: Check[], prefs: State['senders']): { ok: true } | { ok: false; reason: string } {
  const autonomy = rule.autonomy ?? 'draft'
  if (autonomy === 'draft' || rule.output !== 'reply') return { ok: false, reason: '' }
  const text = output.text || '', to = (task.replyTo || '').trim().toLowerCase()
  if (output.needsInfo || output.informationGaps?.trim() || checks.length) return { ok: false, reason: '存在待核实事项，转为人工审核。' }
  if (!to || to.includes(',') || !/^[\w.+-]+@[\w-]+(\.[\w-]+)+$/.test(to)) return { ok: false, reason: '回复对象不是单一邮箱地址，转为人工审核。' }
  if (prefs?.[to]?.neverAutoSend) return { ok: false, reason: '你曾撤回发给该联系人的自动回复，转为人工审核。' }
  if (/https?:\/\/|www\./i.test(text)) return { ok: false, reason: '回复包含链接，转为人工审核。' }
  if ((text.match(EMAIL) || []).some(item => item.toLowerCase() !== to)) return { ok: false, reason: '回复提到其他邮箱地址，转为人工审核。' }
  if (autonomy === 'low_risk' && (output.lowRisk !== true || text.length > 800)) return { ok: false, reason: '回复不属于低风险的简单确认，转为人工审核。' }
  if (text.length > 6000) return { ok: false, reason: '回复过长，转为人工审核。' }
  return { ok: true }
}
/** Keep only checks whose quote really occurs in the draft so highlights never point at invented text. */
export function cleanChecks(checks: Check[] | undefined, text: string | undefined): Check[] {
  return (checks || []).slice(0, 10).map(check => ({ item: check.item.trim().slice(0, 500), ...(check.quote && text?.includes(check.quote.trim()) && check.quote.trim().length >= 2 ? { quote: check.quote.trim().slice(0, 300) } : {}) })).filter(check => check.item)
}

export class Engine {
  private stopping = false
  private polling = false
  private processing = false
  private sending = false
  private generating = false
  private timer?: ReturnType<typeof setTimeout>
  private controller = new AbortController()
  private release?: () => Promise<void>
  private lastPoll?: string
  private error?: string
  private lastCheck = 0
  private attempts = new Map<string, number>()
  /** Language of the most recent client request; used for scheduled generation. */
  language: 'zh' | 'en' = 'zh'
  constructor(readonly store: Store, private emailSource: () => EmailService | undefined, readonly agent: AgentRunner, readonly capabilities: () => Promise<unknown> = async () => ({ tools: [], skills: [] }), readonly triage?: TriageRunner, readonly writer?: WriterRunner) {}
  email(): EmailService { const email = this.emailSource(); if (!email || email.version !== 1) throw new WorkbenchError('需要启用提供工作台接口的 dsh-email 本地构建。', 'email-unavailable', 503); return email }
  health() { return { email: this.emailSource()?.version === 1, agent: this.agent.available(), running: !!this.release && !this.stopping, lastPoll: this.lastPoll, error: this.error, triage: !!this.triage?.available(), writer: !!this.writer?.available() } }
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
    await this.sendDue()
    // Scheduled writing is best effort: a busy writer simply waits for the next slot; other failures are logged once per attempt.
    await this.scheduled().catch(error => (error as WorkbenchError)?.code === 'busy' ? undefined : this.store.mutate(state => log(state, `定时生成失败：${this.safe(error)}`, undefined, 'error')).catch(() => {}))
  }
  async stop(): Promise<void> {
    this.stopping = true; clearTimeout(this.timer); this.controller.abort(new Error('工作台已停止'))
    // Do not release the worker lock while an execution can still mutate state.
    while (this.polling || this.processing || this.sending || this.generating) await new Promise(resolve => setTimeout(resolve, 50))
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
  /** Triage runs whenever a triage runner exists and the user has not switched it off. */
  private triageOn(state: State): boolean { return !!this.triage && settingsOf(state.settings).triage }
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
              const triage = this.triageOn(doc)
              for (const mail of batch.messages) {
                if (doc.tasks.some(t => t.source.account === source.account && t.source.folder === source.folder && t.source.uidValidity === batch.cursor.uidValidity && t.source.uid === mail.uid)) continue
                const from = readableFrom(mail.from), meta = { ...source, from, subject: mail.subject || '', hasAttachments: !!mail.hasAttachments }
                const timestamp = now(), task: Task = { id: randomUUID(), revision: 1, title: mail.subject || '无主题邮件', account: source.account, status: 'queued', from, subject: mail.subject || '', body: '', receivedAt: mail.date || timestamp, updatedAt: timestamp, source: { ...source, uid: mail.uid, uidValidity: batch.cursor.uidValidity }, attachments: [], history: [], attempts: 0 }
                task.hasAttachments = !!mail.hasAttachments
                if (triage) { task.triage = { state: 'pending' }; task.history.push({ at: timestamp, message: '等待 AI 分拣。' }) }
                else {
                  const rule = chooseRule(doc.rules, meta)
                  task.status = rule ? 'queued' : 'unmatched'
                  task.history.push({ at: timestamp, message: rule ? `命中规则「${rule.name}」，等待处理。` : '未匹配规则，可手动选择规则处理。' })
                  if (rule) { task.ruleId = rule.id; task.ruleName = rule.name; task.rule = structuredClone(rule) }
                }
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
  private async loadForProcessing(task: Task, signal: AbortSignal): Promise<any> {
    const read = await this.readOriginal(task, signal)
    task.body = read.text || ''; task.attachments = read.attachments || []
    Object.assign(task, originalMailFields(read))
    task.messageId = read.messageId; task.references = read.references; task.replyTo = address(read.replyTo?.length ? read.replyTo : read.from)
    return read
  }
  /** Decide what the message is and which workflow, if any, should handle it. */
  private async runTriage(task: Task, signal: AbortSignal): Promise<void> {
    const read = await this.loadForProcessing(task, signal)
    const state = await this.store.read()
    const meta = { account: task.account, folder: task.source.folder, from: task.from, subject: task.subject, hasAttachments: task.hasAttachments === true || task.attachments.length > 0 }
    const candidates = candidateRules(state.rules, meta)
    const mail = { from: task.from, subject: task.subject, body: task.body.slice(0, 6000), hasAttachments: meta.hasAttachments, receivedAt: task.receivedAt }
    let result: { category: any; urgency: any; reason: string; nextStep: string; ruleId?: string }, by: 'ai' | 'heuristic' = 'heuristic'
    if (this.triage?.available()) {
      try { result = await this.triage.run({ mail, rules: candidates.map(rule => ({ id: rule.id, name: rule.name, semantic: rule.semantic || '', output: rule.output, hint: rule.instructions.slice(0, 400) })), uiLanguage: this.language }, AbortSignal.any([signal, AbortSignal.timeout(90000)])); by = 'ai' }
      catch (error) { if (signal.aborted) throw error; result = heuristicTriage(mail); await this.store.mutate(doc => log(doc, `AI 分拣失败，已改用规则判断：${this.safe(error)}`, task.id, 'error')) }
    } else result = heuristicTriage(mail)
    signal.throwIfAborted()
    const sender = senderAddress(task.from), keep = state.senders?.[sender]?.neverArchive === true
    const rule = chooseAfterTriage(candidates, result.category, result.ruleId, by === 'ai')
    await this.store.mutate(doc => {
      const item = findTask(doc, task.id)
      if (item.status !== 'running') return
      Object.assign(item, originalMailFields(read), { body: task.body, mailLoaded: true, attachments: task.attachments, messageId: task.messageId, references: task.references, replyTo: task.replyTo })
      item.triage = { state: 'done', category: result.category, urgency: result.urgency, reason: result.reason || undefined, nextStep: result.nextStep || undefined, by: keep ? 'preference' : by, at: now() }
      item.attempts = 0
      if (result.reason) touch(item, `AI 分拣：${result.reason}`)
      if (rule) {
        item.rule = structuredClone(rule); item.ruleId = rule.id; item.ruleName = rule.name; item.status = 'queued'
        touch(item, `命中方案「${rule.name}」，等待处理。`)
      } else if (!keep && (result.category === 'notification' || result.category === 'marketing')) {
        item.status = 'ignored'; item.triage.archived = true
        touch(item, '已归档，可随时恢复。')
        doc.activity = [...(doc.activity || []), activityEntry({ kind: 'archive', title: item.subject || item.title, detail: result.reason, taskId: item.id, source: 'email' }, randomUUID())]
      } else {
        item.status = 'unmatched'
        touch(item, result.category === 'fyi' ? '值得关注，无需处理方案；已列入今日简报。' : '没有合适的处理方案，可手动选择方案或忽略。')
      }
      log(doc, '信息已完成分拣。', item.id)
    })
  }
  async processNext(): Promise<void> {
    if (this.processing || this.stopping || !this.release || !this.emailSource()) return
    this.processing = true
    let task: Task | undefined
    const signal = AbortSignal.any([this.controller.signal, AbortSignal.timeout(5 * 60 * 1000)])
    try {
      const agentReady = this.agent.available()
      task = await this.store.mutate(state => {
        // Triage needs no workflow agent; preparation does. Pick accordingly so triage keeps working without a preparation model.
        const item = state.tasks.find(t => t.status === 'queued' && (!t.nextAttemptAt || t.nextAttemptAt <= now()) && (t.triage?.state === 'pending' || agentReady))
        if (!item) return undefined
        item.status = 'running'; item.attempts++; item.prepareKey ??= randomUUID(); delete item.error
        touch(item, item.triage?.state === 'pending' ? '开始读取邮件并分拣。' : '开始读取资料并调用 DSH。'); log(state, '任务开始处理。', item.id)
        return item
      })
      if (!task) return
      if (task.triage?.state === 'pending') { await this.runTriage(task, signal); this.error = undefined; return }
      if (!task.rule) throw new WorkbenchError('任务缺少规则快照。')
      const email = this.email(), read = await this.loadForProcessing(task, signal)
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
      await this.store.mutate(state => { const item = findTask(state, task!.id); Object.assign(item, originalMailFields(read), { body: task!.body, mailLoaded: true, attachments: task!.attachments, workspace, messageId: task!.messageId, references: task!.references, replyTo: task!.replyTo }); touch(item, '原邮件与资料已读取。') })
      const result = await this.agent.run(task, task.rule, signal)
      signal.throwIfAborted()
      let draftId = task.draftId, draftRevision: number | undefined
      if (task.rule.output === 'reply' && !result.output.needsInfo) {
        if (!result.output.text?.trim()) throw new WorkbenchError('DSH 未生成可审核的回复正文。')
        if (draftId) {
          // Never overwrite a human-edited draft when regenerating.
          const current = await email.drafts.get(draftId)
          if (current.state !== 'draft') throw new WorkbenchError('原草稿已发送或结果待核实，不能重新生成。')
        }
        const references = [...new Set([...(task.references || '').split(/\s+/), task.messageId || ''].filter(Boolean))].join(' ')
        const draft = await email.drafts.create({ sourceKey: `bkms-workbench:${task.id}:${task.prepareKey}`, account: task.account, to: task.replyTo, cc: '', subject: result.output.subject || (/^re:/i.test(task.subject) ? task.subject : `Re: ${task.subject}`), text: result.output.text, inReplyTo: task.messageId || '', references, attachments: [] }, signal)
        draftId = draft.id; draftRevision = draft.revision
      }
      const checks = cleanChecks(result.output.checks, result.output.text)
      const informationGaps = result.output.informationGaps?.trim() || (checks.length ? checks.map((check, index) => `${index + 1}. ${check.item}`).join('\n') : undefined)
      await this.store.mutate(state => {
        const item = findTask(state, task!.id)
        const status = result.output.needsInfo ? 'needs_info' : item.rule?.output === 'reply' ? 'review' : 'completed'
        Object.assign(item, { summary: result.output.summary, informationGaps, checks: checks.length ? checks : undefined, needsInfoKind: result.output.needsInfo ? result.output.needsInfoKind || 'information' : undefined, sessionId: result.sessionId, draftId, status, error: result.output.needsInfo || undefined })
        delete item.autoSend
        touch(item, result.output.needsInfo ? '需要补充信息后继续。' : item.rule?.output === 'reply' ? '已生成回复草稿，等待人工审核。' : '分析报告已生成。'); log(state, 'DSH 处理完成。', item.id)
        if (status === 'completed') state.activity = [...(state.activity || []), activityEntry({ kind: 'report', title: item.subject || item.title, detail: item.ruleName, taskId: item.id, ruleName: item.ruleName, source: 'email' }, randomUUID())]
        if (status === 'review' && item.rule && draftRevision !== undefined) {
          const decision = autoSendDecision(item.rule, item, result.output, checks, state.senders)
          if (decision.ok) {
            const minutes = settingsOf(state.settings).undoMinutes, at = new Date(Date.now() + minutes * 60000).toISOString()
            item.autoSend = { at, scheduledAt: now(), autonomy: item.rule.autonomy!, draftRevision }
            touch(item, `按方案自主级别，将在 ${minutes} 分钟后自动发送；此前可撤回。`)
            state.activity = [...(state.activity || []), activityEntry({ kind: 'auto_send_scheduled', title: item.subject || item.title, detail: item.replyTo, taskId: item.id, ruleName: item.ruleName, autonomy: item.rule.autonomy, undoUntil: at, source: 'email' }, randomUUID())]
          } else if (decision.reason) touch(item, decision.reason)
        }
      })
      this.error = undefined
    } catch (error) {
      this.error = this.safe(error)
      if (task) await this.store.mutate(state => {
        const item = findTask(state, task!.id); item.error = this.safe(error)
        const limit = item.triage?.state === 'pending' ? 2 : item.rule?.maxRetries ?? 0
        const retry = !this.stopping && item.attempts <= limit
        item.status = retry ? 'queued' : 'failed'; item.nextAttemptAt = retry ? new Date(Date.now() + 30000 * item.attempts).toISOString() : undefined
        touch(item, retry ? '处理失败，稍后自动重试。' : '处理失败，可人工重试。'); log(state, item.error!, item.id, 'error')
      })
      else throw error
    } finally { this.processing = false }
  }
  /** Submit automatic replies whose withdrawal window has ended. Each goes through the provider's own preview and recipient policy. */
  async sendDue(): Promise<void> {
    if (this.sending || this.stopping || !this.release || !this.emailSource()) return
    const state = await this.store.read(), due = state.tasks.find(task => task.status === 'review' && task.draftId && task.autoSend && !task.autoSend.canceledAt && task.autoSend.at <= now())
    if (!due) return
    this.sending = true
    const signal = AbortSignal.any([this.controller.signal, AbortSignal.timeout(120000)])
    const cancel = (reason: string, kind: 'auto_send_canceled' | 'auto_send_blocked') => this.store.mutate(doc => {
      const item = findTask(doc, due.id)
      if (!item.autoSend || item.autoSend.canceledAt) return
      item.autoSend.canceledAt = now(); item.autoSend.reason = reason; touch(item, reason)
      doc.activity = [...(doc.activity || []), activityEntry({ kind, title: item.subject || item.title, detail: reason, taskId: item.id, ruleName: item.ruleName, source: 'email' }, randomUUID())]
    })
    let claimedSend = false
    try {
      // The workflow is re-read at send time: lowering its autonomy or disabling it stops sends already scheduled.
      const current = state.rules.find(rule => rule.id === due.ruleId)
      if (!current || !current.enabled || (current.autonomy ?? 'draft') === 'draft' || current.output !== 'reply') { await cancel('方案已停用或改为仅起草，自动发送已取消，请人工审核。', 'auto_send_canceled'); return }
      // A send long past its announced time (e.g. background processing was paused) is no longer what the person expected.
      if (Date.now() - Date.parse(due.autoSend!.at) > STALE_AUTO_SEND) { await cancel('已超过计划发送时间较久，自动发送已取消，请人工审核。', 'auto_send_canceled'); return }
      const email = this.email(), draftId = due.draftId!
      const draft = await email.drafts.get(draftId)
      if (draft.state !== 'draft' || draft.revision !== due.autoSend!.draftRevision) { await cancel('草稿已变化，自动发送已取消，请人工审核。', 'auto_send_canceled'); return }
      const plan = await email.drafts.preview(draftId, draft.revision, signal)
      if (plan.matching?.blocked) { await cancel('收件人命中禁止发送规则，自动发送已取消。', 'auto_send_blocked'); return }
      const planId = plan.planId || plan.id
      if (!planId) { await cancel('邮件服务未返回发送预览，自动发送已取消。', 'auto_send_blocked'); return }
      const claimed = await this.store.mutate(doc => {
        const item = findTask(doc, due.id)
        if (item.status !== 'review' || !item.autoSend || item.autoSend.canceledAt || item.revision !== due.revision) return false
        item.status = 'sending'; touch(item, '撤回窗口结束，按方案自动发送。'); log(doc, '开始自动发送。', item.id)
        return true
      })
      if (!claimed) return
      claimedSend = true
      try {
        const result = await email.drafts.send(draftId, planId, true, signal)
        await this.store.mutate(doc => {
          const item = findTask(doc, due.id)
          item.status = result.draft.state === 'sent' ? 'sent' : result.draft.state === 'draft' ? 'review' : 'uncertain'; item.error = result.draft.error
          if (item.status === 'review' && item.autoSend) { item.autoSend.canceledAt = now(); item.autoSend.reason = '发送未提交，已转为人工审核。' }
          touch(item, item.status === 'sent' ? '已自动发送，SMTP 已接受邮件。' : item.status === 'review' ? '自动发送未提交，草稿保留，请人工审核。' : '自动发送结果待核实，不会自动重发。')
          doc.activity = [...(doc.activity || []), activityEntry({ kind: item.status === 'sent' ? 'auto_sent' : 'auto_send_blocked', title: item.subject || item.title, detail: item.status === 'sent' ? item.replyTo : item.error, taskId: item.id, ruleName: item.ruleName, autonomy: item.autoSend?.autonomy, source: 'email' }, randomUUID())]
          log(doc, item.status === 'sent' ? '自动发送已获得 SMTP 回执。' : '自动发送未完成。', item.id)
        })
      } catch (error) {
        const after = await email.drafts.get(draftId).catch(() => undefined)
        await this.store.mutate(doc => {
          const item = findTask(doc, due.id)
          item.status = after?.state === 'draft' ? 'review' : after?.state === 'sent' ? 'sent' : 'uncertain'; item.error = this.safe(error)
          if (item.autoSend && item.status === 'review') { item.autoSend.canceledAt = now(); item.autoSend.reason = '自动发送失败，已转为人工审核。' }
          touch(item, item.status === 'review' ? '自动发送校验未通过，邮件未提交。' : '自动发送记录需核实。'); log(doc, item.error!, item.id, 'error')
        })
      }
    } catch (error) {
      this.error = this.safe(error)
      // Failing before the mail was submitted hands the reply back to a person instead of retrying on every tick.
      if (!claimedSend) await cancel(`自动发送前检查失败，已转为人工审核：${this.safe(error)}`, 'auto_send_blocked').catch(() => undefined)
    } finally { this.sending = false }
  }
  private async writing<T>(work: () => Promise<T>): Promise<T> {
    if (this.generating) throw new WorkbenchError('AI 正在生成内容，请稍后再试。', 'busy', 409)
    this.generating = true
    try { return await work() } finally { this.generating = false }
  }
  private async write(kind: 'brief' | 'weekly' | 'topic', data: object, language: 'zh' | 'en', signal: AbortSignal): Promise<Record<string, unknown> | undefined> {
    if (!this.writer?.available()) return undefined
    return this.writer.run(kind, { ...data, uiLanguage: language }, AbortSignal.any([signal, this.controller.signal, AbortSignal.timeout(120000)]))
  }
  async generateBrief(language = this.language, signal = new AbortController().signal, scheduled = false) {
    return this.writing(async () => {
      const data = briefData(await this.store.read())
      const ai = await this.write('brief', data, language, signal)
      const brief = { date: data.date, text: String(ai?.text || briefTemplate(data, language === 'en')), generatedAt: now(), by: ai ? 'ai' as const : 'template' as const }
      return this.store.mutate(state => {
        state.brief = brief
        if (scheduled) state.activity = [...(state.activity || []), activityEntry({ kind: 'brief', title: language === 'en' ? 'Daily brief' : '今日简报', detail: `${data.decisionCount}` }, randomUUID())]
        return brief
      })
    })
  }
  async generateWeekly(language = this.language, signal = new AbortController().signal, scheduled = false) {
    return this.writing(async () => {
      const start = startOfWeek(), end = new Date(start.getTime() + 7 * 864e5)
      const data = weeklyData(await this.store.read(), start, end)
      const ai = await this.write('weekly', data, language, signal)
      const template = weeklyTemplate(data, language === 'en')
      const report = { id: randomUUID(), kind: 'weekly' as const, title: String(ai?.title || template.title), text: String(ai?.text || template.text), periodStart: data.periodStart, periodEnd: data.periodEnd, generatedAt: now(), updatedAt: now(), by: ai ? 'ai' as const : 'template' as const }
      return this.store.mutate(state => {
        state.reports = [...(state.reports || []), report]
        if (scheduled) state.activity = [...(state.activity || []), activityEntry({ kind: 'weekly', title: report.title }, randomUUID())]
        return report
      })
    })
  }
  async refreshTopic(id: string, language = this.language, signal = new AbortController().signal, report = false) {
    return this.writing(async () => {
      const state = await this.store.read(), topic = state.topics?.find(item => item.id === id)
      if (!topic) throw new WorkbenchError('主题不存在。', 'missing', 404)
      const data = topicData(state, topic)
      const ai = await this.write('topic', data, language, signal)
      const summary: TopicSummary = ai ? { text: String(ai.text), level: ai.level as TopicSummary['level'], risks: ai.risks as string[], todos: ai.todos as string[], at: now(), by: 'ai' } : topicTemplate(data, language === 'en')
      const en = language === 'en'
      const text = [`## ${en ? 'Status' : '现状'}\n${summary.text}`, summary.risks.length ? `## ${en ? 'Risks' : '风险'}\n${summary.risks.map(item => `- ${item}`).join('\n')}` : '', summary.todos.length ? `## ${en ? 'To-dos' : '待办'}\n${summary.todos.map(item => `- ${item}`).join('\n')}` : '', `## ${en ? 'Key messages' : '关键往来'}\n${data.items.slice(0, 10).map(item => `- ${item.receivedAt.slice(0, 10)} ${item.title}`).join('\n') || (en ? '- None' : '- 无')}`].filter(Boolean).join('\n\n')
      return this.store.mutate(doc => {
        const current = doc.topics?.find(item => item.id === id)
        if (!current) throw new WorkbenchError('主题不存在。', 'missing', 404)
        current.summary = summary; current.updatedAt = now()
        if (report) {
          const start = startOfWeek()
          doc.reports = [...(doc.reports || []), { id: randomUUID(), kind: 'topic', topicId: id, title: `${current.name} · ${localDate()}`, text, periodStart: localDate(start), periodEnd: localDate(), generatedAt: now(), updatedAt: now(), by: summary.by }]
          doc.activity = [...(doc.activity || []), activityEntry({ kind: 'topic', title: current.name }, randomUUID())]
        }
        return { topic: current, matched: data.count }
      })
    })
  }
  /** Scheduled briefs and reports run only while background processing is on. Each slot is attempted at most every 30 minutes. */
  private async scheduled(): Promise<void> {
    if (this.generating) return
    const state = await this.store.read(), s = settingsOf(state.settings), at = new Date(), minutes = localMinutes(at), today = localDate(at)
    const due = (key: string) => { const last = this.attempts.get(key) ?? 0; if (Date.now() - last < 30 * 60000) return false; this.attempts.set(key, Date.now()); return true }
    if (s.briefEnabled && minutes >= parseClock(s.briefTime, '08:00') && state.brief?.date !== today && due(`brief:${today}`)) { await this.generateBrief(this.language, undefined, true); return }
    const weekStart = localDate(startOfWeek(at))
    if (s.weeklyEnabled && at.getDay() === s.weeklyDay && minutes >= parseClock(s.weeklyTime, '17:00')) {
      if (!state.reports?.some(report => report.kind === 'weekly' && report.periodStart === weekStart) && due(`weekly:${weekStart}`)) { await this.generateWeekly(this.language, undefined, true); return }
      const topic = state.topics?.find(item => item.schedule === 'weekly' && !state.reports?.some(report => report.kind === 'topic' && report.topicId === item.id && report.periodStart === weekStart))
      if (topic && due(`topic:${topic.id}:${weekStart}`)) await this.refreshTopic(topic.id, this.language, undefined, true)
    }
  }
  topicIds(state: State, task: Task): string[] { return (state.topics || []).filter(topic => topicMatches(topic, task)).map(topic => topic.id) }
}
