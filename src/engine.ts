import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { open, stat, unlink } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { join, basename } from 'node:path'
import { candidateRules, chooseRule, decideAfterTriage } from './rules.js'
import { classifierFor, decideCategory, triageClassifier } from './classify.js'
import { runtimeContext, variableValues } from './context-vars.js'
import { historyForPrompt, splitQuoted } from './quoted.js'
import { originalMailFields } from './original-mail.js'
import { touch } from './store.js'
import { WorkbenchRepository, type Config, type Records } from './storage/repository.js'
import { heuristicTriage } from './triage.js'
import { activityEntry, briefData, briefTemplate, localDate, localMinutes, parseClock, senderKey, startOfWeek, topicData, topicMatches, topicTemplate, weeklyData, weeklyTemplate } from './digest.js'
import { ChannelRegistry } from './channels/registry.js'
import type { Channel, ChannelItem } from './channels/types.js'
import { WorkbenchError, now, type AgentOutput, type AgentRunner, type Check, type EmailService, type Rule, type Settings, type SourceKind, type State, type Task, type Topic, type TopicSummary, type TriageRunner, type Confidence, type BusinessVerdict, type RuntimeContext, type Profile, type WriterRunner } from './types.js'

/** Mail is the built-in channel; any other kind belongs to an installed channel. */
export const isMail = (task: Pick<Task, 'source'>): boolean => !task.source.kind || task.source.kind === 'email'
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
/** Most recent learned examples per workflow given to AI. */
const EXAMPLES_IN_PROMPT = 8
/** Wait for a shared promise, but stop waiting when this caller is cancelled. */
const waitFor = <T>(promise: Promise<T>, signal: AbortSignal): Promise<T> => new Promise<T>((resolve, reject) => {
  const abort = () => reject(signal.reason instanceof Error ? signal.reason : new Error('已取消'))
  if (signal.aborted) return abort()
  signal.addEventListener('abort', abort, { once: true })
  promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
})
/** Deterministic bounds for an automatic reply. The model's own judgement is necessary but never sufficient. */
export function autoSendDecision(rule: Rule, task: Task, output: AgentOutput, checks: Check[], prefs: State['senders']): { ok: true } | { ok: false; reason: string } {
  const autonomy = rule.autonomy ?? 'draft'
  if (autonomy === 'draft' || rule.output !== 'reply') return { ok: false, reason: '' }
  if (task.backfill) return { ok: false, reason: '历史邮件补处理不会自动发送，转为人工审核。' }
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
  /** Channels being polled right now. */
  private channelPolling = new Set<string>()
  /** Interface language: AI-written review text follows it. Saved so background processing after a restart still knows it. */
  language: 'zh' | 'en' = 'zh'
  async setLanguage(language: 'zh' | 'en'): Promise<void> {
    this.language = language
    if (this.savedLanguage === language) return
    if ((await this.repo.config()).uiLanguage !== language) await this.repo.write(tx => tx.setUiLanguage(language))
    this.savedLanguage = language
  }
  private savedLanguage?: 'zh' | 'en'
  constructor(readonly repo: WorkbenchRepository, private emailSource: () => EmailService | undefined, readonly agent: AgentRunner, readonly capabilities: () => Promise<unknown> = async () => ({ tools: [], skills: [] }), readonly triage?: TriageRunner, readonly writer?: WriterRunner, readonly channels = new ChannelRegistry()) {}
  email(): EmailService { const email = this.emailSource(); if (!email || email.version !== 1) throw new WorkbenchError('请先在工作台设置中添加邮箱账号。', 'email-unavailable', 503); return email }
  health() { return { email: this.emailSource()?.version === 1, agent: this.agent.available(), running: !!this.release && !this.stopping, lastPoll: this.lastPoll, error: this.error, triage: !!this.triage?.available(), writer: !!this.writer?.available(), channels: Object.fromEntries(this.channels.list().map(channel => [channel.kind, channel.health()])) } }
  async start(): Promise<void> {
    this.release = await this.repo.ownWorker(error => { this.error = this.safe(error); void this.stop() }, true)
    try { await this.repo.write(async tx => {
      const { uiLanguage } = await tx.config()
      if (uiLanguage) { this.language = uiLanguage; this.savedLanguage = uiLanguage }
      for (const task of await tx.tasks({ statuses: ['running', 'sending'] })) {
        if (task.status === 'running') { task.status = 'queued'; touch(task, '服务重启，恢复未完成的准备任务。') }
        if (task.status === 'sending') { task.status = 'uncertain'; task.error = '服务在发送期间重启，请核对发送记录。'; touch(task, task.error) }
        await tx.saveTask(task)
      }
      await tx.log('工作台后台已启动。首次连接邮箱仅建立基线，不处理历史邮件。')
    }) } catch (error) { await this.release(); this.release = undefined; throw error }
    this.schedule(250)
  }
  private schedule(delay = 5000): void {
    if (this.stopping) return
    this.timer = setTimeout(() => { void this.tick().catch(error => { this.error = this.safe(error) }).finally(() => this.schedule()) }, delay)
    this.timer.unref?.()
  }
  private async tick(): Promise<void> {
    const { settings } = await this.repo.config()
    if (!settings.enabled) return
    if (this.emailSource() && Date.now() - this.lastCheck >= settings.pollSeconds * 1000) { this.lastCheck = Date.now(); await this.poll().catch(error => { this.error = this.safe(error) }) }
    // A channel records its own errors in its health; one failing channel does not stop the others.
    for (const channel of this.channels.list()) if (channel.settings.enabled(settings.channels?.[channel.kind])) await this.pollChannel(channel).catch(() => undefined)
    await this.processNext()
    await this.sendDue()
    // Scheduled writing is best effort: a busy writer simply waits for the next slot; other failures are logged once per attempt.
    await this.scheduled().catch(error => (error as WorkbenchError)?.code === 'busy' ? undefined : this.repo.write(tx => tx.log(`定时生成失败：${this.safe(error)}`, undefined, 'error')).catch(() => {}))
  }
  async stop(): Promise<void> {
    this.stopping = true; clearTimeout(this.timer); this.controller.abort(new Error('工作台已停止'))
    // Do not release the worker lock while an execution can still mutate state.
    while (this.polling || this.channelPolling.size || this.processing || this.sending || this.generating) await new Promise(resolve => setTimeout(resolve, 50))
    await this.release?.(); this.release = undefined
    await this.repo.close()
  }
  safe(error: unknown): string {
    const value = error instanceof Error ? error.message : '处理失败，请查看任务记录。'
    return value.replace(/(?:Bearer\s+)[^\s]+/gi, 'Bearer [隐藏]').replace(/((?:password|token|api.?key|authorization)\s*[=:]\s*)[^\s,;]+/gi, '$1[隐藏]').slice(0, 1200)
  }
  /** Trusted runtime context for one task: your profile and the current time, for `{{variables}}` and the prompt. */
  private runtime(task: Task, profile: Profile | undefined): RuntimeContext {
    const values = variableValues(profile, isMail(task) ? task.account : '', new Date(), this.language)
    return { values, text: runtimeContext(values, profile) }
  }
  /** Where the original mail is now: after a dispatch it lives in the target folder. */
  location(task: Task): { account: string; folder: string; uid: number; uidValidity?: number } {
    const moved = task.dispatch
    if (moved?.uid) return { account: task.source.account, folder: moved.folder, uid: moved.uid, uidValidity: moved.uidValidity }
    return task.source
  }
  async readOriginal(task: Task, signal: AbortSignal): Promise<any> {
    const email = this.email(), source = this.location(task)
    if (task.dispatch && !task.dispatch.uid) throw new WorkbenchError(`原邮件已分派到「${task.dispatch.folder}」，请在该文件夹中查看。`, 'dispatched', 409)
    if (source.uidValidity) await email.scan({ account: source.account, folder: source.folder, cursor: { uidValidity: source.uidValidity, lastUid: source.uid }, limit: 1 }, signal)
    const read = await email.read(source.account, source.folder, source.uid, signal)
    if (source.uidValidity && read.uidValidity !== undefined && read.uidValidity !== source.uidValidity) throw new WorkbenchError('邮箱邮件编号已变化，停止处理以避免读取其他邮件。', 'email-cursor-reset', 409)
    return read
  }
  async attachment(task: Task, index: number, signal: AbortSignal): Promise<{ path: string; filename: string }> {
    const workspace = join(this.repo.root, 'tasks', task.id)
    await mkdir(workspace, { recursive: true, mode: 0o700 })
    const at = this.location(task)
    const result = await this.email().downloadAttachment(task.account, at.folder, at.uid, index, workspace, signal, at.uidValidity)
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
  private triageOn(settings: Settings): boolean { return !!this.triage && settingsOf(settings).triage }
  async poll(): Promise<{ checked: boolean; added: number }> {
    if (this.polling) return { checked: false, added: 0 }
    if (this.stopping || !this.release) throw new WorkbenchError('后台尚未就绪。', 'not-ready', 503)
    this.polling = true; let added = 0
    const signal = AbortSignal.any([this.controller.signal, AbortSignal.timeout(90000)])
    try {
      const email = this.email(), accounts = await email.accounts(), { rules, classifiers = [] } = await this.repo.config()
      const folders = new Map<string, { account: string; folder: string }>()
      for (const account of accounts) {
        folders.set(JSON.stringify([account.id, account.inboxFolder || 'INBOX']), { account: account.id, folder: account.inboxFolder || 'INBOX' })
        for (const rule of rules.filter(r => r.enabled && (!r.account || r.account === account.id))) folders.set(JSON.stringify([account.id, rule.folder]), { account: account.id, folder: rule.folder })
        // A business-category scheme reads its own folder too, even when no workflow watches it.
        for (const classifier of classifiers.filter(c => c.enabled && (!c.account || c.account === account.id))) folders.set(JSON.stringify([account.id, classifier.folder]), { account: account.id, folder: classifier.folder })
      }
      for (const [key, source] of folders) {
        try {
          for (let page = 0; page < 10; page++) {
            signal.throwIfAborted()
            const before = await this.repo.cursor(key)
            const batch = await email.scan({ ...source, cursor: before, limit: 50 }, signal)
            if (batch.reset) throw new WorkbenchError('邮箱 UIDVALIDITY 已改变，请在确认邮箱后重建基线。', 'email-cursor-reset', 409)
            // Nothing new and nothing to record: no write, so an idle workbench leaves its data untouched.
            if (!batch.messages.length && !batch.firstRun && JSON.stringify(batch.cursor) === JSON.stringify(before) && !(await this.repo.backfill(key))) break
            added += await this.repo.write(async tx => {
              // Someone else moved this folder's cursor meanwhile (a rebuilt baseline): this batch is stale.
              if (JSON.stringify(await tx.cursor(key)) !== JSON.stringify(before)) return 0
              let count = 0, skipped = 0
              const config = await tx.config(), triage = this.triageOn(config.settings)
              // History processed from a chosen start time: marked, never auto-sent; mail already answered then is skipped.
              const backfill = await tx.backfill(key), inBackfill = (uid: number) => !!backfill && backfill.uidValidity === batch.cursor.uidValidity && uid <= backfill.untilUid
              for (const mail of batch.messages) {
                if (inBackfill(mail.uid) && backfill!.skip.includes(mail.uid)) { skipped++; continue }
                const from = readableFrom(mail.from), meta = { ...source, from, subject: mail.subject || '', hasAttachments: !!mail.hasAttachments }
                const timestamp = now(), task: Task = { id: randomUUID(), revision: 1, title: mail.subject || '无主题邮件', account: source.account, status: 'queued', from, subject: mail.subject || '', body: '', receivedAt: mail.date || timestamp, updatedAt: timestamp, source: { ...source, uid: mail.uid, uidValidity: batch.cursor.uidValidity }, attachments: [], history: [], attempts: 0 }
                task.hasAttachments = !!mail.hasAttachments
                if (inBackfill(mail.uid)) { task.backfill = true; task.history.push({ at: timestamp, message: '历史邮件补处理：只生成草稿，不会自动发送。' }) }
                if (triage) { task.triage = { state: 'pending' }; task.history.push({ at: timestamp, message: '等待 AI 分拣。' }) }
                else {
                  const rule = chooseRule(config.rules, meta)
                  task.status = rule ? 'queued' : 'unmatched'
                  task.history.push({ at: timestamp, message: rule ? `命中规则「${rule.name}」，等待处理。` : '未匹配规则，可手动选择规则处理。' })
                  if (rule) { task.ruleId = rule.id; task.ruleName = rule.name; task.rule = structuredClone(rule) }
                }
                // A message already received (same folder, generation and UID) is not added again.
                if (await tx.insertTask(task)) count++
              }
              await tx.setCursor(key, batch.cursor)
              if (skipped) await tx.log(`${source.account} / ${source.folder} 补处理时跳过 ${skipped} 封已回复的邮件。`)
              if (backfill && (backfill.uidValidity !== batch.cursor.uidValidity || batch.cursor.lastUid >= backfill.untilUid)) {
                await tx.setBackfill(key, undefined)
                await tx.log(`${source.account} / ${source.folder} 历史邮件已全部收取，之后按新邮件处理。`)
              }
              if (batch.firstRun) await tx.log(`${source.account} / ${source.folder} 已建立基线，后续新增邮件开始处理。`)
              if (count) await tx.log(`${source.account} / ${source.folder} 接收 ${count} 封新邮件。`)
              return count
            })
            if (!batch.hasMore) break
          }
        } catch (error) {
          const message = this.safe(error); this.error = message
          await this.repo.write(tx => tx.log(`${source.account} / ${source.folder} 检查失败：${message}`, undefined, 'error'))
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
  /** The installed channel of a task from another channel; undefined for mail and for a channel that is not installed. */
  channelOf(task: Task): Channel | undefined { return this.channels.get(task.source.kind) }
  /** Poll one channel and queue what it found, in one transaction with its saved progress. */
  async pollChannel(channel: Channel): Promise<number> {
    if (this.channelPolling.has(channel.kind) || this.stopping || !this.release) return 0
    const settings = (await this.repo.config()).settings.channels?.[channel.kind]
    if (!channel.settings.enabled(settings)) return 0
    this.channelPolling.add(channel.kind)
    const signal = AbortSignal.any([this.controller.signal, AbortSignal.timeout(180000)])
    try {
      const result = await channel.poll(settings, await this.repo.channelState(channel.kind), signal)
      if (!result) return 0
      return await this.repo.write(async tx => {
        const config = await tx.config()
        const { state, items, logs } = result.commit(await tx.channelState(channel.kind), Date.now())
        for (const message of logs) await tx.log(message)
        let created = 0
        // An item already queued (same scope and position) is not added again.
        for (const item of items) if (await tx.insertTask(this.channelTask(channel, config, item))) created++
        await tx.setChannelState(channel.kind, state)
        if (created) await tx.log(channel.text.created(created))
        return created
      })
    } finally { this.channelPolling.delete(channel.kind) }
  }
  /** A queued task for an item from another channel. Its content is already here, so it never reads mail. */
  private channelTask(channel: Channel, config: Config, item: ChannelItem): Task {
    const timestamp = now()
    const task: Task = {
      id: randomUUID(), revision: 1, title: item.title, account: channel.kind, status: 'queued', from: item.from, subject: item.subject, body: item.body,
      receivedAt: item.receivedAt || timestamp, updatedAt: timestamp, source: { account: channel.kind, folder: item.scope, uid: item.position, uidValidity: 1, kind: channel.kind },
      attachments: [], history: [], attempts: 0, mailLoaded: true, ...(item.data !== undefined ? { channelData: item.data } : {}),
    }
    if (this.triageOn(config.settings)) { task.triage = { state: 'pending' }; task.history.push({ at: timestamp, message: '等待 AI 分拣。' }) }
    else {
      const rule = chooseRule(config.rules, { account: channel.kind, from: item.from, subject: item.subject, hasAttachments: false, kind: channel.kind })
      task.status = rule ? 'queued' : 'unmatched'
      task.history.push({ at: timestamp, message: rule ? `命中规则「${rule.name}」，等待处理。` : '未匹配规则，可手动选择规则处理。' })
      if (rule) { task.ruleId = rule.id; task.ruleName = rule.name; task.rule = structuredClone(rule) }
    }
    return task
  }
  /** Prepare an item from a channel where replies are copied by hand: the AI suggests a reply to paste there. Nothing is sent. */
  private async prepareCopy(task: Task, channel: Channel, signal: AbortSignal): Promise<void> {
    const workspace = join(this.repo.root, 'tasks', task.id)
    await mkdir(workspace, { recursive: true, mode: 0o700 })
    task.workspace = workspace
    const result = await this.agent.run(task, task.rule!, signal, { language: this.language, context: this.runtime(task, (await this.repo.config()).settings.profile), channel: { kind: channel.kind, guide: channel.ai.writingGuide, input: channel.ai.agentInput(task) } })
    signal.throwIfAborted()
    const reply = channel.capabilities.reply === 'copy' && task.rule!.output === 'reply' && !result.output.needsInfo
    if (reply && !result.output.text?.trim()) throw new WorkbenchError('DSH 未生成建议回复。')
    const checks = reply ? cleanChecks(result.output.checks, result.output.text) : []
    const informationGaps = result.output.informationGaps?.trim() || (checks.length ? checks.map((check, index) => `${index + 1}. ${check.item}`).join('\n') : undefined)
    await this.repo.updateTask(task.id, undefined, async (item, tx) => {
      const status = result.output.needsInfo ? 'needs_info' : reply ? 'review' : 'completed'
      Object.assign(item, { summary: result.output.summary, informationGaps, checks: checks.length ? checks : undefined, needsInfoKind: result.output.needsInfo ? result.output.needsInfoKind || 'information' : undefined, sessionId: result.sessionId, workspace, status, error: result.output.needsInfo || undefined })
      if (reply) item.reply = { text: result.output.text!.trim(), revision: (item.reply?.revision ?? 0) + 1 }
      touch(item, result.output.needsInfo ? '需要补充信息后继续。' : reply ? channel.text.replyReady : '分析报告已生成。'); await tx.log('DSH 处理完成。', item.id)
      if (status === 'completed') await tx.addActivity(activityEntry({ kind: 'report', title: item.title, detail: item.ruleName, taskId: item.id, ruleName: item.ruleName, source: channel.kind as SourceKind }, randomUUID()))
    })
  }
  /** A dispatch workflow hands the mail to another team: move it to the target folder. No agent runs, nothing is sent. */
  private async dispatch(task: Task, signal: AbortSignal): Promise<void> {
    const target = task.rule!.dispatchFolder
    if (!target) throw new WorkbenchError('分派方案缺少目标文件夹。')
    await this.moveMail(task, target, signal, { summary: `已分派到「${target}」。`, label: task.ruleName })
  }
  /**
   * Move the original mail to `target` (created when missing) and complete the task. Used by dispatch workflows and
   * by categories that move mail. Already there: nothing to move. Moved before: it moves on from where it is now.
   */
  async moveMail(task: Task, target: string, signal: AbortSignal, note: { summary: string; label?: string }): Promise<void> {
    const email = this.email()
    if (!email.move) throw new WorkbenchError('当前邮件服务不支持移动邮件。', 'provider', 503)
    const here = task.dispatch
    if (here && !here.uid && here.folder !== target) throw new WorkbenchError(`邮件已在「${here.folder}」，服务器没有返回它的新编号，无法再次移动；请在邮箱中手动移到「${target}」。`)
    const from = this.location(task)
    const moved = here && [target, target.split('/').join('.')].includes(here.folder) ? here : { ...(await email.move(task.account, from.folder, from.uid, target, signal, from.uidValidity)), at: now() }
    await this.repo.updateTask(task.id, undefined, async (item, tx) => {
      item.dispatch = moved; item.status = 'completed'; item.summary = note.summary
      touch(item, `已移到文件夹「${target}」，由该文件夹的负责人处理。`); await tx.log(`邮件已移到「${target}」。`, item.id)
      await tx.addActivity(activityEntry({ kind: 'dispatch', title: item.subject || item.title, detail: target, taskId: item.id, ruleName: note.label, source: 'email' }, randomUUID()))
    })
  }
  /** Decide what the message is and which workflow, if any, should handle it. */
  private async runTriage(task: Task, signal: AbortSignal): Promise<void> {
    const other = !isMail(task), channel = this.channelOf(task)
    const read = other ? undefined : await this.loadForProcessing(task, signal)
    const config = await this.repo.config()
    const meta = { account: task.account, folder: task.source.folder, from: task.from, subject: task.subject, hasAttachments: task.hasAttachments === true || task.attachments.length > 0, kind: task.source.kind ?? 'email' }
    const candidates = candidateRules(config.rules, meta)
    // Replies carry the earlier exchange below the new text: classify by what was written now, read the rest as context.
    const split = other ? { latest: task.body, history: [] } : splitQuoted(task.body)
    const quotedHistory = historyForPrompt(split.history, 2500)
    const mail = { from: task.from, subject: task.subject, body: split.latest.slice(0, 5000), ...(quotedHistory ? { quotedHistory } : {}), hasAttachments: meta.hasAttachments, receivedAt: task.receivedAt, channel: meta.kind }
    // The workflow that handled the previous message of the same thread, when it is still a candidate.
    const refs = (task.references || '').split(/\s+/).map(ref => ref.replace(/[<>]/g, '')).filter(Boolean)
    const previous = (await this.repo.byMessageIds(refs)).filter(item => item.id !== task.id && item.ruleId).sort((a, b) => b.receivedAt.localeCompare(a.receivedAt))[0]
    const previousRule = previous && candidates.find(rule => rule.id === previous.ruleId)
    const thread = previousRule ? { previousRule: { id: previousRule.id, name: previousRule.name } } : undefined
    // A classification scheme on this folder: the same model call also picks one business category.
    const classifier = other ? undefined : classifierFor(config, task.account, task.source.folder)
    const profile = config.settings.profile, values = variableValues(profile, other ? '' : task.account, new Date(), this.language)
    const context = { now: values.now, timezone: values.timezone, ...(profile?.department ? { department: profile.department } : {}), ...(profile?.role ? { role: profile.role } : {}) }
    let result: { category: any; urgency: any; reason: string; nextStep: string; ruleId?: string; confidence?: Confidence; ruleReason?: string; business?: BusinessVerdict }, by: 'ai' | 'heuristic' = 'heuristic'
    if (this.triage?.available()) {
      const ruleExamples = await this.repo.examples('rule'), categoryExamples = classifier ? await this.repo.examples('category') : {}
      const channelHint = channel?.ai.triageHint?.(this.language)
      try { result = await this.triage.run({ mail, ...(channelHint ? { channelHint } : {}), ...(thread ? { thread } : {}), ...(classifier ? { classifier: triageClassifier(classifier, categoryExamples) } : {}), context, rules: candidates.map(rule => ({ id: rule.id, name: rule.name, semantic: rule.semantic || '', output: rule.output, hint: rule.instructions.slice(0, 400), examples: (ruleExamples[rule.id] ?? []).slice(-EXAMPLES_IN_PROMPT).map(({ match, text }) => ({ match, text })) })), uiLanguage: this.language }, AbortSignal.any([signal, AbortSignal.timeout(90000)])); by = 'ai' }
      catch (error) { if (signal.aborted) throw error; result = heuristicTriage(mail); await this.repo.write(tx => tx.log(`AI 分拣失败，已改用规则判断：${this.safe(error)}`, task.id, 'error')) }
    } else result = heuristicTriage(mail)
    signal.throwIfAborted()
    const sender = senderKey(task), keep = (await this.repo.contact(sender))?.neverArchive === true
    const decision = decideAfterTriage(candidates, result.category, by === 'ai' ? { ruleId: result.ruleId || '', confidence: result.confidence, reason: result.ruleReason } : undefined)
    // Notifications and marketing keep being archived unless the scheme asks to classify them too.
    const classifies = !!classifier && (classifier.includeNotices || !['notification', 'marketing'].includes(result.category))
    const business = classifies ? decideCategory(classifier!, result.business) : undefined
    const applied = business && 'category' in business ? business.category : undefined
    // Until the category is settled, nothing runs on its own: a workflow is only offered.
    const rule = business && !applied ? undefined : applied?.action === 'move' ? undefined : decision.rule
    const suggestion = decision.suggestion ?? (decision.rule && !rule && !applied ? { rule: decision.rule, confidence: (decision.by === 'ai' ? result.confidence : undefined) ?? 'high' as Confidence, reason: result.ruleReason || '' } : undefined)
    let move: string | undefined
    await this.repo.updateTask(task.id, undefined, async (item, tx) => {
      if (item.status !== 'running') return
      if (read) Object.assign(item, originalMailFields(read), { body: task.body, mailLoaded: true, attachments: task.attachments, messageId: task.messageId, references: task.references, replyTo: task.replyTo })
      item.triage = { state: 'done', category: result.category, urgency: result.urgency, reason: result.reason || undefined, nextStep: result.nextStep || undefined, by: keep ? 'preference' : by, at: now() }
      item.attempts = 0
      if (result.reason) touch(item, `AI 分拣：${result.reason}`)
      // A channel of messages from people is never archived silently, so nothing from a person disappears from view.
      delete item.match
      if (classifier && business) {
        item.classification = applied
          ? { classifierId: classifier.id, categoryId: applied.id, categoryName: applied.name, state: 'applied', by: 'ai', confidence: 'high', reason: result.business?.reason || undefined, at: now() }
          : { classifierId: classifier.id, state: 'pending', by: 'ai', ...(result.business ? { confidence: result.business.confidence, reason: result.business.reason || undefined } : {}), candidates: (business as { candidates: string[] }).candidates, at: now() }
        touch(item, applied ? `已归为「${applied.name}」。` : by === 'ai' ? 'AI 拿不准业务分类，等待你选择。' : '当前没有可用的 AI 判断业务分类，等待你选择。')
      } else delete item.classification
      if (applied?.action === 'move') {
        // Moved by the worker right after this: the mail leaves the folder, so no workflow of this folder runs on it.
        move = applied.folder
      } else if (business && !applied) {
        item.status = 'unmatched'
        if (suggestion) item.match = { ruleId: suggestion.rule.id, ruleName: suggestion.rule.name, by: 'ai', state: 'suggested', confidence: suggestion.confidence, reason: suggestion.reason || undefined, at: now() }
      } else if (rule) {
        item.rule = structuredClone(rule); item.ruleId = rule.id; item.ruleName = rule.name; item.status = 'queued'
        item.match = { ruleId: rule.id, ruleName: rule.name, by: decision.by!, state: 'applied', ...(decision.by === 'ai' ? { confidence: result.confidence ?? 'high', reason: result.ruleReason || undefined } : { reason: '符合字面条件，方案设为“字面命中就处理”。' }), at: now() }
        touch(item, `命中方案「${rule.name}」，等待处理。`)
      } else if (suggestion) {
        // Uncertain: offer the workflow instead of running it.
        const { rule: suggested, confidence, reason } = suggestion
        item.status = 'unmatched'
        item.match = { ruleId: suggested.id, ruleName: suggested.name, by: 'ai', state: 'suggested', confidence, reason: reason || undefined, at: now() }
        touch(item, `AI 建议用方案「${suggested.name}」处理，但把握不足，等待你确认。`)
      } else if (!keep && (other ? channel?.capabilities.archive === true : true) && (result.category === 'notification' || result.category === 'marketing')) {
        item.status = 'ignored'; item.triage.archived = true
        touch(item, '已归档，可随时恢复。')
        await tx.addActivity(activityEntry({ kind: 'archive', title: item.subject || item.title, detail: result.reason, taskId: item.id, source: 'email' }, randomUUID()))
      } else {
        item.status = 'unmatched'
        touch(item, result.category === 'fyi' ? '值得关注，无需处理方案；已列入今日简报。' : decision.needsAi ? '有方案需要 AI 判断是否适用，但当前没有可用的 AI 判断，等待你选择。' : '没有合适的处理方案，可手动选择方案或忽略。')
      }
      await tx.log('信息已完成分拣。', item.id)
    })
    if (move && applied) {
      try { await this.moveMail(await this.repo.task(task.id), move, signal, { summary: `已归为「${applied.name}」，移到「${move}」。`, label: applied.name }) }
      catch (error) {
        if (signal.aborted) throw error
        // The category stands; only the move failed. Choosing the category again in the item retries it.
        const message = this.safe(error)
        await this.repo.updateTask(task.id, undefined, async (item, tx) => { if (item.status !== 'running') return; item.status = 'unmatched'; item.error = message; touch(item, `已归为「${applied.name}」，但移到「${move}」失败：${message}。可在事项中重新选择分类重试。`); await tx.log(`移动邮件失败：${message}`, item.id, 'error') })
      }
    }
  }
  async processNext(): Promise<void> {
    if (this.processing || this.stopping || !this.release) return
    const emailReady = !!this.emailSource()
    this.processing = true
    let task: Task | undefined
    const signal = AbortSignal.any([this.controller.signal, AbortSignal.timeout(5 * 60 * 1000)])
    try {
      const agentReady = this.agent.available()
      // Triage needs no workflow agent; preparation does. Pick accordingly so triage keeps working without a preparation model.
      const pickable = (t: Task) => t.status === 'queued' && (!t.nextAttemptAt || t.nextAttemptAt <= now()) && (t.triage?.state === 'pending' || agentReady || t.rule?.output === 'dispatch') && (isMail(t) ? emailReady : !!this.channelOf(t))
      // Look first without writing: an idle background never touches the data.
      const candidate = (await this.repo.ready(now())).find(pickable)
      if (!candidate) return
      task = await this.repo.write(async tx => {
        const item = await tx.task(candidate.id)
        if (!pickable(item)) return undefined
        item.status = 'running'; item.attempts++; item.prepareKey ??= randomUUID(); delete item.error
        touch(item, item.triage?.state === 'pending' ? '开始读取邮件并分拣。' : '开始读取资料并调用 DSH。'); await tx.saveTask(item); await tx.log('任务开始处理。', item.id)
        return item
      })
      if (!task) return
      if (task.triage?.state === 'pending') { await this.runTriage(task, signal); this.error = undefined; return }
      if (!task.rule) throw new WorkbenchError('任务缺少规则快照。')
      const channel = this.channelOf(task)
      if (!isMail(task)) { if (!channel) throw new WorkbenchError('这项信息来自未安装的渠道，安装后再处理。', 'channel-unavailable', 503); await this.prepareCopy(task, channel, signal); this.error = undefined; return }
      if (task.rule.output === 'dispatch') { await this.dispatch(task, signal); this.error = undefined; return }
      const email = this.email(), read = await this.loadForProcessing(task, signal)
      const workspace = join(this.repo.root, 'tasks', task.id)
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
      await this.repo.updateTask(task.id, undefined, item => { Object.assign(item, originalMailFields(read), { body: task!.body, mailLoaded: true, attachments: task!.attachments, workspace, messageId: task!.messageId, references: task!.references, replyTo: task!.replyTo }); touch(item, '原邮件与资料已读取。') })
      const result = await this.agent.run(task, task.rule, signal, { language: this.language, context: this.runtime(task, (await this.repo.config()).settings.profile) })
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
      await this.repo.updateTask(task.id, undefined, async (item, tx) => {
        const status = result.output.needsInfo ? 'needs_info' : item.rule?.output === 'reply' ? 'review' : 'completed'
        Object.assign(item, { summary: result.output.summary, informationGaps, checks: checks.length ? checks : undefined, needsInfoKind: result.output.needsInfo ? result.output.needsInfoKind || 'information' : undefined, sessionId: result.sessionId, draftId, status, error: result.output.needsInfo || undefined })
        delete item.autoSend
        touch(item, result.output.needsInfo ? '需要补充信息后继续。' : item.rule?.output === 'reply' ? '已生成回复草稿，等待人工审核。' : '分析报告已生成。'); await tx.log('DSH 处理完成。', item.id)
        if (status === 'completed') await tx.addActivity(activityEntry({ kind: 'report', title: item.subject || item.title, detail: item.ruleName, taskId: item.id, ruleName: item.ruleName, source: 'email' }, randomUUID()))
        if (status === 'review' && item.rule && draftRevision !== undefined) {
          const decision = autoSendDecision(item.rule, item, result.output, checks, await tx.contacts())
          if (decision.ok) {
            const minutes = settingsOf((await tx.config()).settings).undoMinutes, at = new Date(Date.now() + minutes * 60000).toISOString()
            item.autoSend = { at, scheduledAt: now(), autonomy: item.rule.autonomy!, draftRevision }
            touch(item, `按方案自主级别，将在 ${minutes} 分钟后自动发送；此前可撤回。`)
            await tx.addActivity(activityEntry({ kind: 'auto_send_scheduled', title: item.subject || item.title, detail: item.replyTo, taskId: item.id, ruleName: item.ruleName, autonomy: item.rule.autonomy, undoUntil: at, source: 'email' }, randomUUID()))
          } else if (decision.reason) touch(item, decision.reason)
        }
      })
      this.error = undefined
    } catch (error) {
      this.error = this.safe(error)
      if (task) await this.repo.updateTask(task.id, undefined, async (item, tx) => {
        item.error = this.safe(error)
        const limit = item.triage?.state === 'pending' ? 2 : item.rule?.maxRetries ?? 0
        const retry = !this.stopping && item.attempts <= limit
        item.status = retry ? 'queued' : 'failed'; item.nextAttemptAt = retry ? new Date(Date.now() + 30000 * item.attempts).toISOString() : undefined
        touch(item, retry ? '处理失败，稍后自动重试。' : '处理失败，可人工重试。'); await tx.log(item.error!, item.id, 'error')
      })
      else throw error
    } finally { this.processing = false }
  }
  /** Submit automatic replies whose withdrawal window has ended. Each goes through the provider's own preview and recipient policy. */
  async sendDue(): Promise<void> {
    if (this.sending || this.stopping || !this.release || !this.emailSource()) return
    const due = await this.repo.dueAutoSend(now())
    if (!due?.draftId || !due.autoSend || due.autoSend.canceledAt || due.status !== 'review') return
    const { rules } = await this.repo.config()
    this.sending = true
    const signal = AbortSignal.any([this.controller.signal, AbortSignal.timeout(120000)])
    const cancel = (reason: string, kind: 'auto_send_canceled' | 'auto_send_blocked') => this.repo.updateTask(due.id, undefined, async (item, tx) => {
      if (!item.autoSend || item.autoSend.canceledAt) return
      item.autoSend.canceledAt = now(); item.autoSend.reason = reason; touch(item, reason)
      await tx.addActivity(activityEntry({ kind, title: item.subject || item.title, detail: reason, taskId: item.id, ruleName: item.ruleName, source: 'email' }, randomUUID()))
    })
    let claimedSend = false
    try {
      // The workflow is re-read at send time: lowering its autonomy or disabling it stops sends already scheduled.
      const current = rules.find(rule => rule.id === due.ruleId)
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
      const claimed = await this.repo.updateTask(due.id, undefined, async (item, tx) => {
        if (item.status !== 'review' || !item.autoSend || item.autoSend.canceledAt || item.revision !== due.revision) return false
        item.status = 'sending'; touch(item, '撤回窗口结束，按方案自动发送。'); await tx.log('开始自动发送。', item.id)
        return true
      })
      if (!claimed) return
      claimedSend = true
      try {
        const result = await email.drafts.send(draftId, planId, true, signal)
        await this.repo.updateTask(due.id, undefined, async (item, tx) => {
          item.status = result.draft.state === 'sent' ? 'sent' : result.draft.state === 'draft' ? 'review' : 'uncertain'; item.error = result.draft.error
          if (item.status === 'review' && item.autoSend) { item.autoSend.canceledAt = now(); item.autoSend.reason = '发送未提交，已转为人工审核。' }
          touch(item, item.status === 'sent' ? '已自动发送，SMTP 已接受邮件。' : item.status === 'review' ? '自动发送未提交，草稿保留，请人工审核。' : '自动发送结果待核实，不会自动重发。')
          await tx.addActivity(activityEntry({ kind: item.status === 'sent' ? 'auto_sent' : 'auto_send_blocked', title: item.subject || item.title, detail: item.status === 'sent' ? item.replyTo : item.error, taskId: item.id, ruleName: item.ruleName, autonomy: item.autoSend?.autonomy, source: 'email' }, randomUUID()))
          await tx.log(item.status === 'sent' ? '自动发送已获得 SMTP 回执。' : '自动发送未完成。', item.id)
        })
      } catch (error) {
        const after = await email.drafts.get(draftId).catch(() => undefined)
        await this.repo.updateTask(due.id, undefined, async (item, tx) => {
          item.status = after?.state === 'draft' ? 'review' : after?.state === 'sent' ? 'sent' : 'uncertain'; item.error = this.safe(error)
          if (item.autoSend && item.status === 'review') { item.autoSend.canceledAt = now(); item.autoSend.reason = '自动发送失败，已转为人工审核。' }
          touch(item, item.status === 'review' ? '自动发送校验未通过，邮件未提交。' : '自动发送记录需核实。'); await tx.log(item.error!, item.id, 'error')
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
      const data = briefData({ tasks: await this.repo.tasks(), activity: await this.repo.activity() })
      const ai = await this.write('brief', data, language, signal)
      const brief = { date: data.date, text: String(ai?.text || briefTemplate(data, language === 'en')), generatedAt: now(), by: ai ? 'ai' as const : 'template' as const }
      return this.repo.write(async tx => {
        await tx.setBrief(brief)
        if (scheduled) await tx.addActivity(activityEntry({ kind: 'brief', title: language === 'en' ? 'Daily brief' : '今日简报', detail: `${data.decisionCount}` }, randomUUID()))
        return brief
      })
    })
  }
  async generateWeekly(language = this.language, signal = new AbortController().signal, scheduled = false) {
    return this.writing(async () => {
      const start = startOfWeek(), end = new Date(start.getTime() + 7 * 864e5)
      const data = weeklyData({ tasks: await this.repo.tasks(), activity: await this.repo.activity() }, start, end)
      const ai = await this.write('weekly', data, language, signal)
      const template = weeklyTemplate(data, language === 'en')
      const report = { id: randomUUID(), kind: 'weekly' as const, title: String(ai?.title || template.title), text: String(ai?.text || template.text), periodStart: data.periodStart, periodEnd: data.periodEnd, generatedAt: now(), updatedAt: now(), by: ai ? 'ai' as const : 'template' as const }
      return this.repo.write(async tx => {
        await tx.addReport(report)
        if (scheduled) await tx.addActivity(activityEntry({ kind: 'weekly', title: report.title }, randomUUID()))
        return report
      })
    })
  }
  async refreshTopic(id: string, language = this.language, signal = new AbortController().signal, report = false) {
    return this.writing(async () => {
      const topic = (await this.repo.topics()).find(item => item.id === id)
      if (!topic) throw new WorkbenchError('主题不存在。', 'missing', 404)
      const data = topicData({ tasks: await this.repo.tasks() }, topic)
      const ai = await this.write('topic', data, language, signal)
      const summary: TopicSummary = ai ? { text: String(ai.text), level: ai.level as TopicSummary['level'], risks: ai.risks as string[], todos: ai.todos as string[], at: now(), by: 'ai' } : topicTemplate(data, language === 'en')
      const en = language === 'en'
      const text = [`## ${en ? 'Status' : '现状'}\n${summary.text}`, summary.risks.length ? `## ${en ? 'Risks' : '风险'}\n${summary.risks.map(item => `- ${item}`).join('\n')}` : '', summary.todos.length ? `## ${en ? 'To-dos' : '待办'}\n${summary.todos.map(item => `- ${item}`).join('\n')}` : '', `## ${en ? 'Key messages' : '关键往来'}\n${data.items.slice(0, 10).map(item => `- ${item.receivedAt.slice(0, 10)} ${item.title}`).join('\n') || (en ? '- None' : '- 无')}`].filter(Boolean).join('\n\n')
      return this.repo.write(async tx => {
        const current = (await tx.topics()).find(item => item.id === id)
        if (!current) throw new WorkbenchError('主题不存在。', 'missing', 404)
        current.summary = summary; current.updatedAt = now()
        await tx.saveTopic(current)
        if (report) {
          const start = startOfWeek()
          await tx.addReport({ id: randomUUID(), kind: 'topic', topicId: id, title: `${current.name} · ${localDate()}`, text, periodStart: localDate(start), periodEnd: localDate(), generatedAt: now(), updatedAt: now(), by: summary.by })
          await tx.addActivity(activityEntry({ kind: 'topic', title: current.name }, randomUUID()))
        }
        return { topic: current, matched: data.count }
      })
    })
  }
  /** Scheduled briefs and reports run only while background processing is on. Each slot is attempted at most every 30 minutes. */
  private async scheduled(): Promise<void> {
    if (this.generating) return
    const s = settingsOf((await this.repo.config()).settings), at = new Date(), minutes = localMinutes(at), today = localDate(at)
    const due = (key: string) => { const last = this.attempts.get(key) ?? 0; if (Date.now() - last < 30 * 60000) return false; this.attempts.set(key, Date.now()); return true }
    if (s.briefEnabled && minutes >= parseClock(s.briefTime, '08:00') && (await this.repo.brief())?.date !== today && due(`brief:${today}`)) { await this.generateBrief(this.language, undefined, true); return }
    const weekStart = localDate(startOfWeek(at))
    if (s.weeklyEnabled && at.getDay() === s.weeklyDay && minutes >= parseClock(s.weeklyTime, '17:00')) {
      const reports = await this.repo.reports()
      if (!reports.some(report => report.kind === 'weekly' && report.periodStart === weekStart) && due(`weekly:${weekStart}`)) { await this.generateWeekly(this.language, undefined, true); return }
      const topic = (await this.repo.topics()).find(item => item.schedule === 'weekly' && !reports.some(report => report.kind === 'topic' && report.topicId === item.id && report.periodStart === weekStart))
      if (topic && due(`topic:${topic.id}:${weekStart}`)) await this.refreshTopic(topic.id, this.language, undefined, true)
    }
  }
  topicIds(topics: Topic[], task: Task): string[] { return topics.filter(topic => topicMatches(topic, task)).map(topic => topic.id) }
}
