import { randomUUID } from 'node:crypto'
import type { MailService } from './mail/service.js'
import { MAIL_PROVIDERS, MailAccountError, presetOf } from './mail/accounts.js'
import { readFile } from 'node:fs/promises'
import { Engine, isMail, settingsOf } from './engine.js'
import { originalMailFields } from './original-mail.js'
import { matches, ruleExcludes, ruleMode, validateRule } from './rules.js'
import { CLOCK, touch } from './store.js'
import type { Records } from './storage/repository.js'
import { activityEntry, exampleText, localDate, needsAttention, relations, senderKey, topicMatches, trialData } from './digest.js'
import { sourceStatuses } from './sources.js'
import { checkVariables, validateProfile } from './context-vars.js'
import { classifierFor, learnCategory, overlapping, triageClassifier, validateClassifier } from './classify.js'
import { WorkbenchError, now, type RuleExample, type Task, type RuleAssistant, type InstructionOptimizer, type Topic } from './types.js'

const requireRevision = (revision: unknown): number => { if (!Number.isSafeInteger(revision) || Number(revision) < 1) throw new WorkbenchError('缺少有效版本，请刷新后重试。'); return Number(revision) }
const editableTask = (task: Task): void => { if (task.status !== 'review') throw new WorkbenchError('只有待审核任务可以修改或发送草稿。', 'state', 409) }
/** A person acting on a task takes it over: any pending automatic send is withdrawn. */
const takeOver = async (tx: Records, task: Task, reason: string): Promise<void> => {
  if (!task.autoSend || task.autoSend.canceledAt) return
  task.autoSend.canceledAt = now(); task.autoSend.reason = reason
  await tx.undoActivity(task.id, 'auto_send_scheduled', now())
}
/** Remember a confirmed or rejected message for a workflow (latest 20 kept; a newer verdict on the same task replaces the older one). */
const learn = async (tx: Records, ruleId: string, task: Task, match: boolean, label?: string): Promise<void> => {
  const current = (await tx.examplesOf('rule', ruleId)).filter(example => example.taskId !== task.id)
  const example: RuleExample = { id: randomUUID(), match, text: exampleText(task, label), at: now(), taskId: task.id }
  await tx.setExamples('rule', ruleId, [...current, example].slice(-20))
}
const list = (value: unknown, maxItems: number, maxLength: number, message: string): string[] => {
  if (!Array.isArray(value) || value.length > maxItems || value.some(item => typeof item !== 'string' || item.length > maxLength || /[\0\r\n]/.test(item))) throw new WorkbenchError(message)
  return [...new Set(value.map(item => item.trim()).filter(Boolean))]
}
const language = (value: unknown): 'zh' | 'en' | undefined => value === 'en' || value === 'zh' ? value : undefined
const json = (status: number, value: unknown): Response => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } })
/** At most this much history is processed at once, so a mistyped date cannot start hundreds of model calls. */
export const BACKFILL_LIMIT = 200
/** A start time for processing history: a valid date in the past, at most a year back. */
function startTime(value: unknown): Date {
  const at = typeof value === 'string' ? new Date(value) : new Date(NaN)
  if (Number.isNaN(at.getTime())) throw new WorkbenchError('请选择有效的开始时间。')
  if (at.getTime() > Date.now()) throw new WorkbenchError('开始时间不能晚于现在。')
  if (Date.now() - at.getTime() > 366 * 86400000) throw new WorkbenchError('开始时间最多往前一年。')
  return at
}
export class WorkbenchApi {
  private busy = new Set<string>()
  private accepting = true
  private active = 0
  private drains = new Set<() => void>()
  private generating = false
  private controller = new AbortController()
  constructor(readonly engine: Engine, private ruleAssistant?: RuleAssistant, private instructionOptimizer?: InstructionOptimizer, private mail?: MailService) {}
  /** Stop admitting new requests, then wait for accepted actions and receipts. */
  async close(): Promise<void> {
    this.accepting = false
    this.controller.abort(new Error('工作台正在停止，方案生成已取消。'))
    if (this.active) await new Promise<void>(resolve => { this.drains.add(resolve) })
  }
  private async tracked<T>(action: () => Promise<T>): Promise<T> {
    if (!this.accepting) throw new WorkbenchError('工作台正在停止，请稍后重新打开。', 'stopping', 503)
    this.active++
    try { return await action() }
    finally { if (--this.active === 0) { for (const resolve of this.drains) resolve(); this.drains.clear() } }
  }
  private async exclusive<T>(id: string, action: () => Promise<T>): Promise<T> {
    if (this.busy.has(id)) throw new WorkbenchError('任务正在保存或发送，请稍后。', 'busy', 409)
    this.busy.add(id); try { return await action() } finally { this.busy.delete(id) }
  }
  snapshot(): Promise<unknown> { return this.tracked(() => this.buildSnapshot()) }
  /**
   * Everything the page shows. `since` is the `version` of the page's last snapshot: when no data changed and the
   * background status is the same, only `{ unchanged: true }` is returned, so an idle page costs almost nothing.
   */
  private async buildSnapshot(since?: unknown): Promise<unknown> {
    const repo = this.engine.repo
    // Taken before reading: a change made while this snapshot is built makes the next poll fetch again.
    const seq = await repo.changeSeq(), version = `${seq}:${JSON.stringify(this.engine.health())}`
    if (typeof since === 'string' && since === version) return { unchanged: true, version }
    const [config, all, logs, activity, topicList, reports, brief, ruleExamples, categoryExamples] = await Promise.all([
      repo.config(), repo.tasks(), repo.logs(), repo.activity(), repo.topics(), repo.reports(), repo.brief(), repo.examples('rule'), repo.examples('category'),
    ])
    let accounts: { id: string; label: string; inboxFolder: string }[] = []
    let providerError: string | undefined
    let sendRecoveryAvailable = false
    try { const email = this.engine.email(); sendRecoveryAvailable = typeof email.drafts.resolveSend === 'function'; accounts = (await email.accounts()).map(a => ({ id: a.id, label: a.address || a.id, inboxFolder: a.inboxFolder || 'INBOX' })) } catch (error) { providerError = this.engine.safe(error) }
    // The provider's draft file is loaded once for the whole workbench. Loading
    // it per task becomes quadratic as the task history grows.
    let draftMap: Map<string, any> | undefined
    if (all.some(task => task.draftId)) {
      try {
        const service = this.engine.email()
        if (service.drafts.list) draftMap = new Map((await service.drafts.list()).map(draft => [draft.id, draft]))
      } catch (error) { providerError = this.engine.safe(error); draftMap = new Map() }
    }
    const tasks = await Promise.all(all.slice().reverse().map(async task => {
      let draft: any
      if (task.draftId) try {
        draft = draftMap ? draftMap.get(task.draftId) : await this.engine.email().drafts.get(task.draftId)
        if (!draft) throw new WorkbenchError('关联的邮件草稿无法读取或已移除；请核对邮件存储，任务资料仍保留。', 'draft-unavailable', 503)
        // A receipt saved by the mail provider is authoritative after a disconnect/restart.
        const restoredDraft = draft.state === 'draft' && (draft.sendFailure === 'not_submitted' || draft.sendChecks?.at(-1)?.outcome === 'not_sent')
        const reconciledStatus = restoredDraft ? 'review' : draft.state
        if (['sending', 'uncertain', 'review'].includes(task.status) && (['sent', 'uncertain'].includes(draft.state) || (task.status !== 'review' && restoredDraft)) && (task.status !== reconciledStatus || task.error !== draft.error) && !this.busy.has(task.id)) {
          await repo.updateTask(task.id, undefined, current => { if (['sending', 'uncertain', 'review'].includes(current.status)) { current.status = restoredDraft ? 'review' : draft.state; current.error = draft.error; touch(current, restoredDraft ? '已恢复为待审核草稿，请重新预览后手动发送。' : draft.state === 'sent' ? '已核对邮件发送记录。' : '发送结果待核实，请先核对邮箱。'); Object.assign(task, current) } })
        }
      } catch (error) {
        // A finished task (sent, ignored…) whose old draft is gone is history, not a mailbox problem worth a banner.
        if (!(error instanceof WorkbenchError && error.code === 'draft-unavailable') || ['review', 'sending', 'uncertain'].includes(task.status)) providerError ??= this.engine.safe(error)
      }
      const { workspace, rule, ...safe } = task
      const latestRule = config.rules.find(rule => rule.id === task.ruleId)
      return { ...safe, canResolveSend: task.status === 'uncertain' && draft?.state === 'uncertain' && sendRecoveryAvailable, outputKind: task.rule?.output, ruleUpdated: !!latestRule && !!task.rule && JSON.stringify(latestRule) !== JSON.stringify(task.rule), attachments: task.attachments.map(({ localPath, ...file }) => file), draft: draft ? { ...draft, sourceKey: undefined, attachments: draft.attachments.map(({ id, filename }: any) => ({ id, filename })) } : undefined }
    }))
    const health = this.engine.health()
    const links = relations(all)
    const enriched = tasks.map(task => ({ ...task, relatedIds: links.get(task.id)?.related ?? [], possibleIds: links.get(task.id)?.possible ?? [], topicIds: this.engine.topicIds(topicList, task as Task), attention: needsAttention(task as Task) }))
    const topics = topicList.map(topic => { const items = all.filter(task => topicMatches(topic, task)); return { ...topic, count: items.length, open: items.filter(needsAttention).length, lastAt: items.map(task => task.receivedAt).sort().at(-1) } })
    return {
      version, stateRevision: seq,
      tasks: enriched, rules: config.rules, revision: config.revision, settings: config.settings, defaults: settingsOf(config.settings), logs: logs.reverse(), accounts, health: { ...health, error: providerError || health.error }, capabilities: await this.engine.capabilities(),
      activity: activity.slice(-300).sort((a, b) => b.at.localeCompare(a.at)), topics, reports: reports.reverse(), brief, today: localDate(),
      sources: sourceStatuses({ ready: health.email, accounts: accounts.length, error: providerError }, this.engine.channels.list().map(channel => ({ channel, settings: config.settings.channels?.[channel.kind] }))), meetings: [],
      // What each installed channel shows on the page, and channels that need an upgrade before they can be used.
      channels: Object.fromEntries(await Promise.all(this.engine.channels.list().map(async channel => [channel.kind, channel.snapshot?.(config.settings.channels?.[channel.kind], await repo.channelState(channel.kind)) ?? {}]))),
      channelInfo: this.channelInfo(config.settings), rejectedChannels: this.engine.channels.rejected(),
      ruleExamples,
      classifiers: config.classifiers, categoryExamples,
    }
  }
  /** Installed channels for the page: their names, how replies work and whether each is on. */
  private channelInfo(settings: { channels?: Record<string, unknown> }) {
    return this.engine.channels.list().map(channel => ({ kind: channel.kind, label: channel.label, reply: channel.capabilities.reply, enabled: channel.settings.enabled(settings.channels?.[channel.kind]) }))
  }
  /**
   * Trial run over mail received in a chosen time range, read straight from the mailbox (history before the baseline
   * included). Read-only: no task is created, nothing is moved or sent. At most 30 messages, newest first.
   */
  private async trialRange(body: any, uiLanguage: 'zh' | 'en' | undefined, signal: AbortSignal): Promise<unknown> {
    const rule = validateRule({ ...body.rule, enabled: true }), email = this.engine.email()
    if (!email.listRange) throw new WorkbenchError('当前邮件服务不支持按时间读取邮件。', 'provider', 503)
    const since = startTime(body.range.since), until = body.range.until ? new Date(body.range.until) : new Date()
    if (Number.isNaN(until.getTime()) || until <= since) throw new WorkbenchError('结束时间需要晚于开始时间。')
    const accounts = await email.accounts(), account = rule.account || (typeof body.range.account === 'string' && body.range.account) || accounts[0]?.id
    if (!account) throw new WorkbenchError('请先添加邮箱账号。')
    const list = await email.listRange(account, rule.folder, since, until, 30, AbortSignal.any([signal, AbortSignal.timeout(120000)]))
    const items = list.map(mail => {
      const id = `m${mail.uid}`
      if (!matches(rule, { account, folder: rule.folder, from: mail.from, subject: mail.subject, hasAttachments: mail.hasAttachments, kind: 'email' })) return { id, matched: false, reason: '发件人、主题或附件条件不符。' }
      return { id, matched: true, reason: '符合发件人、主题和附件条件。' }
    })
    let by: 'ai' | 'rules' = 'rules'
    const judged = items.filter(item => item.matched)
    if (ruleMode(rule) === 'ai' && this.engine.writer?.available() && judged.length) {
      try {
        const mails = list.filter(mail => judged.some(item => item.id === `m${mail.uid}`)).map(mail => ({ id: `m${mail.uid}`, from: mail.from, subject: mail.subject, excerpt: mail.excerpt }))
        const result = await this.engine.writer.run('trial', { ...trialData({ tasks: [], ruleExamples: await this.engine.repo.examples('rule') }, rule, undefined, mails), uiLanguage: uiLanguage ?? this.engine.language }, AbortSignal.any([signal, this.controller.signal, AbortSignal.timeout(120000)])) as { matches: { id: string; matched: boolean; reason: string }[] }
        for (const verdict of result.matches) { const item = items.find(entry => entry.id === verdict.id && entry.matched); if (item) { item.matched = verdict.matched; item.reason = verdict.reason || item.reason } }
        by = 'ai'
      } catch (error) { if (signal.aborted) throw error }
    }
    if (ruleMode(rule) === 'ai' && by === 'rules') for (const item of judged) { item.matched = false; item.reason = '字面条件符合，但需要 AI 判断是否适用；当前没有可用的 AI，不会自动处理。' }
    return { by, total: items.length, items: items.map(item => { const mail = list.find(entry => `m${entry.uid}` === item.id)!; return { ...item, subject: mail.subject, from: mail.from, receivedAt: mail.date } }), note: '仅预览匹配结果：直接读取邮箱中这段时间的邮件，不会建立事项、移动或发送邮件。' }
  }
  /**
   * Trial run of a classification scheme before saving: which category each message would get. Read-only: no item
   * is created, nothing is moved. Mail from a chosen time range is read from the mailbox; otherwise the latest items.
   */
  private async trialClassifier(body: any, uiLanguage: 'zh' | 'en' | undefined, signal: AbortSignal): Promise<unknown> {
    const classifier = validateClassifier({ ...body.classifier, enabled: true })
    if (!this.engine.writer?.available()) throw new WorkbenchError('试运行分类需要 AI：请先在 DSH 中配置默认模型。', 'model_unavailable', 503)
    let mails: { id: string; from: string; subject: string; excerpt: string; receivedAt: string }[]
    if (body.range) {
      const email = this.engine.email()
      if (!email.listRange) throw new WorkbenchError('当前邮件服务不支持按时间读取邮件。', 'provider', 503)
      const since = startTime(body.range.since), until = body.range.until ? new Date(body.range.until) : new Date()
      if (Number.isNaN(until.getTime()) || until <= since) throw new WorkbenchError('结束时间需要晚于开始时间。')
      const account = classifier.account || (await email.accounts())[0]?.id
      if (!account) throw new WorkbenchError('请先添加邮箱账号。')
      mails = (await email.listRange(account, classifier.folder, since, until, 30, AbortSignal.any([signal, AbortSignal.timeout(120000)]))).map(mail => ({ id: `m${mail.uid}`, from: mail.from, subject: mail.subject, excerpt: mail.excerpt, receivedAt: mail.date }))
    } else {
      mails = (await this.engine.repo.tasks({ channel: 'email' })).filter(task => task.source.folder === classifier.folder && (!classifier.account || task.account === classifier.account)).sort((a, b) => b.receivedAt.localeCompare(a.receivedAt)).slice(0, 30)
        .map(task => ({ id: task.id, from: task.from, subject: task.subject, excerpt: (task.body || '').slice(0, 300), receivedAt: task.receivedAt }))
    }
    if (!mails.length) return { total: 0, items: [], note: '这段时间没有邮件。' }
    const result = await this.engine.writer.run('classify', { classifier: triageClassifier(classifier, await this.engine.repo.examples('category')), mails: mails.map(({ id, from, subject, excerpt }) => ({ id, from, subject, excerpt })), uiLanguage: uiLanguage ?? this.engine.language }, AbortSignal.any([signal, this.controller.signal, AbortSignal.timeout(120000)])) as { results: { id: string; categoryId: string; confidence: 'high' | 'medium' | 'low'; reason: string }[] }
    const byId = new Map(result.results.map(item => [item.id, item]))
    const items = mails.map(mail => {
      const verdict = byId.get(mail.id), category = classifier.categories.find(item => item.id === verdict?.categoryId)
      // Only a confident pick would be applied; the rest would wait for you.
      return { id: mail.id, subject: mail.subject, from: mail.from, receivedAt: mail.receivedAt, categoryId: category && verdict!.confidence === 'high' ? category.id : '', likely: category?.id ?? '', confidence: category ? verdict!.confidence : 'low', reason: verdict?.reason ?? '' }
    })
    return { total: items.length, items, note: '仅预览分类结果：不会建立事项、移动邮件或发送。' }
  }
  /** Built-in mailbox accounts: list, save, remove, set default, test a login. Passwords never leave the server. */
  private async mailAccounts(body: any, signal: AbortSignal): Promise<unknown> {
    const mail = this.mail!
    const list = async () => ({ ...(await mail.views()), providers: MAIL_PROVIDERS, presets: Object.fromEntries(MAIL_PROVIDERS.map(name => [name, presetOf(name)]).filter(([, preset]) => preset)), externalPlugin: mail.externalPlugin })
    if (body.action === 'mailAccounts') return list()
    const revision = body.revision
    if (!Number.isSafeInteger(revision) && body.action !== 'testMailAccount') throw new WorkbenchError('请刷新后重试。')
    try {
      if (body.action === 'testMailAccount') return await mail.test(body.account, AbortSignal.any([signal, AbortSignal.timeout(60000)]))
      if (body.action === 'saveMailAccount') await mail.saveAccount(body.account, revision)
      else if (body.action === 'removeMailAccount') { if (body.confirmed !== true || typeof body.id !== 'string') throw new WorkbenchError('请确认删除该邮箱账号。'); await mail.removeAccount(body.id, revision) }
      else if (body.action === 'defaultMailAccount') { if (typeof body.id !== 'string') throw new WorkbenchError('账号无效。'); await mail.setDefault(body.id, revision) }
      else throw new WorkbenchError('不支持的操作。')
    } catch (error) {
      if (error instanceof MailAccountError) throw new WorkbenchError(error.message, error.code, error.code === 'mail-account-conflict' ? 409 : 400)
      throw error
    }
    return list()
  }
  action(body: any, signal: AbortSignal = new AbortController().signal): Promise<unknown> { return this.tracked(() => this.dispatch(body, signal)) }
  private async dispatch(body: any, signal: AbortSignal): Promise<unknown> {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new WorkbenchError('请求格式无效。')
    const uiLanguage = language(body.uiLanguage)
    if (uiLanguage) {
      this.engine.language = uiLanguage
      // Saved from the page's routine reads only, so other requests (e.g. drafting a workflow) stay free of side effects.
      if (body.action === 'snapshot' || body.action === 'preferences') await this.engine.setLanguage(uiLanguage).catch(() => undefined)
    }
    if (body.action === 'snapshot') return this.buildSnapshot(body.since)
    if (body.action === 'preferences') {
      const repo = this.engine.repo, config = await repo.config()
      // Global navigation and reminders do not need mailbox access or draft bodies.
      return { revision: config.revision, stateRevision: await repo.changeSeq(), settings: config.settings, attention: await repo.attention(), channelInfo: this.channelInfo(config.settings), rejectedChannels: this.engine.channels.rejected() }
    }
    if (body.action === 'mailSettings') {
      const config = await this.engine.repo.config()
      const health = this.engine.health()
      let accounts: { id: string; label: string; inboxFolder: string }[] = []
      const mail = this.mail?.status()
      if (mail?.error) health.error = mail.error
      else if (!this.mail || mail?.configured) {
        try { accounts = (await this.engine.email().accounts()).map(account => ({ id: account.id, label: account.address || account.id, inboxFolder: account.inboxFolder || 'INBOX' })) }
        catch (error) { health.error = this.engine.safe(error) }
      }
      return { revision: config.revision, accounts, health, mail: { builtIn: !!this.mail, configured: mail?.configured ?? accounts.length > 0, externalPlugin: this.mail?.externalPlugin === true } }
    }
    if (typeof body.action === 'string' && body.action.endsWith('MailAccount') || body.action === 'mailAccounts') {
      if (!this.mail) throw new WorkbenchError('当前版本没有内置邮箱。')
      return this.mailAccounts(body, signal)
    }
    if (body.action === 'folders') {
      const email = this.engine.email(), accounts = await email.accounts()
      if (typeof body.account !== 'string' || (body.account && !accounts.some(account => account.id === body.account))) throw new WorkbenchError('请选择已配置的邮箱。')
      if (!email.folders) throw new WorkbenchError('请更新配套邮件插件后读取文件夹；当前选择已保留。', 'folders_unavailable', 503)
      const selected = accounts.filter(account => !body.account || account.id === body.account)
      if (!selected.length) throw new WorkbenchError('请先配置邮箱。')
      const results = await Promise.all(selected.map(account => email.folders!(account.id, signal)))
      const folders = results[0].folders.filter(folder => results.every(result => result.folders.some(item => item.path === folder.path)))
      return { folders, common: selected.length > 1, defaultFolder: selected.every(account => account.inboxFolder === selected[0].inboxFolder) ? selected[0].inboxFolder || 'INBOX' : folders.find(folder => folder.path.toUpperCase() === 'INBOX')?.path || folders[0]?.path || '' }
    }
    if (body.action === 'optimizeInstructions') {
      if (typeof body.instructions !== 'string' || body.instructions.trim().length < 5 || body.instructions.length > 16000 || body.instructions.includes('\0')) throw new WorkbenchError('请填写 5–16000 字的处理要求后再优化。')
      if (!this.instructionOptimizer) throw new WorkbenchError('当前服务未提供 AI 优化，请更新工作台插件并重启 DSH。', 'assistant_unavailable', 503)
      if (this.generating) throw new WorkbenchError('AI 正在生成或优化，请稍后再试。', 'busy', 409)
      this.generating = true
      try {
        const result = await this.instructionOptimizer({ instructions: body.instructions.trim() }, AbortSignal.any([signal, this.controller.signal, AbortSignal.timeout(120000)]))
        if (!result || typeof result.instructions !== 'string' || result.instructions.trim().length < 5 || result.instructions.length > 16000 || result.instructions.includes('\0') || Object.keys(result).some(key => key !== 'instructions')) throw new WorkbenchError('模型返回的处理要求格式无效。')
        return { instructions: result.instructions.trim() }
      } finally { this.generating = false }
    }
    if (body.action === 'generateRule') {
      if (typeof body.description !== 'string' || !body.description.trim() || body.description.length > 8000 || body.description.includes('\0')) throw new WorkbenchError('请用不超过 8000 字描述需要处理的邮件和处理方式。')
      const accounts = await this.engine.email().accounts()
      const account = typeof body.account === 'string' ? body.account : accounts[0]?.id || ''
      if (!accounts.length || (account && !accounts.some(item => item.id === account))) throw new WorkbenchError('请先选择已配置的邮箱。')
      const folder = typeof body.folder === 'string' ? body.folder.trim() : accounts.find(item => item.id === account)?.inboxFolder || 'INBOX'
      if (!folder || folder.length > 200 || /[\0\r\n]/.test(folder)) throw new WorkbenchError('请选择有效的邮件文件夹。')
      if (!this.ruleAssistant) throw new WorkbenchError('当前服务未提供 AI 方案生成，请更新工作台插件。', 'assistant_unavailable', 503)
      if (this.generating) throw new WorkbenchError('AI 正在生成或优化，请稍后再试。', 'busy', 409)
      this.generating = true
      try { return await this.ruleAssistant({ description: body.description.trim(), account, folder, ...(body.uiLanguage === 'en' || body.uiLanguage === 'zh' ? { uiLanguage: body.uiLanguage } : {}) }, AbortSignal.any([signal, this.controller.signal, AbortSignal.timeout(120000)])) }
      finally { this.generating = false }
    }
    if (body.action === 'saveSettings') {
      const settings = body.settings
      if (!settings || typeof settings !== 'object' || Array.isArray(settings) || !Object.keys(settings).length || Object.keys(settings).some(key => !['enabled', 'pollSeconds', 'showWorkbench', 'notifyNewTodo', 'triage', 'undoMinutes', 'briefEnabled', 'briefTime', 'weeklyEnabled', 'weeklyDay', 'weeklyTime', 'meetingBriefMinutes', 'channels', 'hiddenViews', 'profile'].includes(key))) throw new WorkbenchError('工作台设置无效。')
      if ('hiddenViews' in settings) { settings.hiddenViews = list(settings.hiddenViews, 3, 20, '页签设置无效。'); if (settings.hiddenViews.some((view: string) => !['today', 'meetings', 'topics'].includes(view))) throw new WorkbenchError('页签设置无效。') }
      if ('profile' in settings) settings.profile = validateProfile(settings.profile)
      // Each channel checks its own settings; a channel that is not installed cannot be configured.
      const changedChannels: string[] = []
      if ('channels' in settings) {
        if (!settings.channels || typeof settings.channels !== 'object' || Array.isArray(settings.channels)) throw new WorkbenchError('工作台设置无效。')
        for (const [kind, value] of Object.entries(settings.channels)) {
          const channel = this.engine.channels.get(kind)
          if (!channel) throw new WorkbenchError('这个渠道未安装，不能保存它的设置。', 'channel-unavailable', 409)
          settings.channels[kind] = channel.settings.validate(value); changedChannels.push(kind)
        }
      }
      for (const key of ['enabled', 'showWorkbench', 'notifyNewTodo', 'triage', 'briefEnabled', 'weeklyEnabled']) if (key in settings && typeof settings[key] !== 'boolean') throw new WorkbenchError('工作台开关应为布尔值。')
      if ('pollSeconds' in settings && (!Number.isSafeInteger(settings.pollSeconds) || settings.pollSeconds < 30 || settings.pollSeconds > 3600)) throw new WorkbenchError('检查间隔应为 30–3600 秒。')
      if ('undoMinutes' in settings && (!Number.isSafeInteger(settings.undoMinutes) || settings.undoMinutes < 1 || settings.undoMinutes > 240)) throw new WorkbenchError('撤回窗口应为 1–240 分钟。')
      if ('meetingBriefMinutes' in settings && (!Number.isSafeInteger(settings.meetingBriefMinutes) || settings.meetingBriefMinutes < 5 || settings.meetingBriefMinutes > 240)) throw new WorkbenchError('会前简报提前时间应为 5–240 分钟。')
      if ('weeklyDay' in settings && (!Number.isSafeInteger(settings.weeklyDay) || settings.weeklyDay < 0 || settings.weeklyDay > 6)) throw new WorkbenchError('周报日期无效。')
      for (const key of ['briefTime', 'weeklyTime']) if (key in settings && (typeof settings[key] !== 'string' || !CLOCK.test(settings[key]))) throw new WorkbenchError('时间格式应为 HH:MM。')
      return this.engine.repo.write(async tx => {
        await tx.checkConfig(body.revision)
        const current = (await tx.config()).settings, enabled = current.enabled
        const next = { ...current, ...settings, ...(settings.channels ? { channels: { ...current.channels, ...settings.channels } } : {}) }
        await tx.saveConfig({ settings: next })
        await tx.log(enabled !== next.enabled ? next.enabled ? '已开启后台自动处理。' : '已暂停接收和排队执行，正在运行的任务继续完成。' : '已更新工作台设置。')
        return next
      }).finally(() => { for (const kind of changedChannels) this.engine.channels.get(kind)?.settings.changed?.() })
    }
    if (body.action === 'saveRule') {
      const rule = validateRule(body.rule)
      // Variables are checked on save only: reading older data never fails on a stray "{{".
      checkVariables(rule.instructions, '处理要求')
      return this.engine.repo.write(async tx => {
        await tx.checkConfig(body.revision)
        const rules = (await tx.config()).rules, index = rules.findIndex(r => r.id === rule.id)
        if (index < 0) rules.push(rule); else rules[index] = rule
        if (rules.length > 100) throw new WorkbenchError('任务或规则数量达到上限，请先归档运行数据。')
        const revision = await tx.saveConfig({ rules })
        await tx.log(`已保存规则「${rule.name}」。`)
        return { ...rule, revision }
      })
    }
    if (body.action === 'saveClassifier') {
      const classifier = validateClassifier(body.classifier)
      return this.engine.repo.write(async tx => {
        await tx.checkConfig(body.revision)
        const list = (await tx.config()).classifiers, clash = overlapping(list, classifier)
        if (clash) throw new WorkbenchError(`分类方案「${clash.name}」已在处理这个文件夹；一封邮件只能有一个分类，请先停用其中一个。`, 'conflict', 409)
        const index = list.findIndex(item => item.id === classifier.id), before = index < 0 ? undefined : list[index]
        // Examples of categories that were removed are no longer shown to the AI.
        for (const category of before?.categories ?? []) if (!classifier.categories.some(item => item.id === category.id)) await tx.setExamples('category', category.id, [])
        await tx.saveConfig({ classifiers: index < 0 ? [...list, classifier] : list.map(item => item.id === classifier.id ? classifier : item) })
        await tx.log(`已保存分类方案「${classifier.name}」。`)
        return classifier
      })
    }
    if (body.action === 'deleteClassifier') return this.engine.repo.write(async tx => {
      await tx.checkConfig(body.revision)
      const list = (await tx.config()).classifiers, classifier = list.find(item => item.id === body.id)
      if (!classifier) throw new WorkbenchError('分类方案不存在。', 'missing', 404)
      for (const category of classifier.categories) await tx.setExamples('category', category.id, [])
      await tx.saveConfig({ classifiers: list.filter(item => item.id !== body.id) })
      await tx.log(`已删除分类方案「${classifier.name}」；已有事项的分类保留。`)
      return { deleted: true }
    })
    if (body.action === 'deleteCategoryExample') return this.deleteExample('category', body.categoryId, body.exampleId)
    if (body.action === 'trialClassifier') return this.trialClassifier(body, uiLanguage, signal)
    if (body.action === 'deleteExample') return this.deleteExample('rule', body.ruleId, body.exampleId)
    if (body.action === 'deleteRule') return this.engine.repo.write(async tx => {
      await tx.checkConfig(body.revision)
      const rules = (await tx.config()).rules, rule = rules.find(r => r.id === body.id)
      if (!rule) throw new WorkbenchError('规则不存在。')
      await tx.setExamples('rule', rule.id, [])
      await tx.saveConfig({ rules: rules.filter(r => r.id !== body.id) })
      await tx.log(`已删除规则「${rule.name}」，历史任务保留原规则快照。`)
      return { deleted: true }
    })
    if (body.action === 'testRule') {
      const rule = validateRule(body.rule), task = await this.engine.repo.task(body.taskId)
      return { matched: matches(rule, { account: task.account, folder: task.source.folder, from: task.from, subject: task.subject, hasAttachments: task.attachments.length > 0 || task.hasAttachments === true, kind: task.source.kind ?? 'email' }), rule: rule.name, note: '仅匹配预览，不会调用 DSH 或发送邮件。' }
    }
    if (body.action === 'poll') return this.engine.poll()
    if (body.action === 'generateBrief') return this.engine.generateBrief(uiLanguage, signal)
    if (body.action === 'generateReport') {
      if (body.kind === 'weekly') return this.engine.generateWeekly(uiLanguage, signal)
      if (body.kind === 'topic' && typeof body.topicId === 'string') return this.engine.refreshTopic(body.topicId, uiLanguage, signal, true)
      throw new WorkbenchError('报告类型无效。')
    }
    if (body.action === 'refreshTopic') { if (typeof body.id !== 'string') throw new WorkbenchError('主题不存在。'); return this.engine.refreshTopic(body.id, uiLanguage, signal) }
    if (body.action === 'saveTopic') {
      const input = body.topic
      if (!input || typeof input !== 'object' || typeof input.name !== 'string' || !input.name.trim() || input.name.length > 60) throw new WorkbenchError('请填写 60 字以内的主题名称。')
      const keywords = list(input.keywords ?? [], 20, 60, '关键词格式无效。'), senders = list(input.senders ?? [], 20, 200, '联系人格式无效。').map(item => item.toLowerCase())
      if (!keywords.length && !senders.length) throw new WorkbenchError('请至少填写一个关键词或联系人。')
      if (!['customer', 'project', 'other'].includes(input.kind) || !['none', 'weekly'].includes(input.schedule ?? 'none')) throw new WorkbenchError('主题类型或报告周期无效。')
      return this.engine.repo.write(async tx => {
        const topics = await tx.topics()
        const existing = typeof input.id === 'string' && input.id ? topics.find(topic => topic.id === input.id) : undefined
        if (input.id && !existing) throw new WorkbenchError('主题不存在。', 'missing', 404)
        if (!existing && topics.length >= 100) throw new WorkbenchError('主题数量已达到 100 个上限。')
        const topic: Topic = { ...(existing ?? { id: randomUUID(), createdAt: now() }), name: input.name.trim(), kind: input.kind, keywords, senders, schedule: input.schedule ?? 'none', updatedAt: now() } as Topic
        await tx.saveTopic(topic)
        await tx.log(`已保存主题「${topic.name}」。`)
        return topic
      })
    }
    if (body.action === 'deleteTopic') return this.engine.repo.write(async tx => {
      const topic = (await tx.topics()).find(item => item.id === body.id)
      if (!topic) throw new WorkbenchError('主题不存在。', 'missing', 404)
      await tx.deleteTopic(topic.id)
      await tx.log(`已删除主题「${topic.name}」，相关信息保留。`)
      return { deleted: true }
    })
    if (body.action === 'saveReport') {
      if (typeof body.text !== 'string' || body.text.length > 32000 || typeof body.title !== 'string' || !body.title.trim() || body.title.length > 160) throw new WorkbenchError('请填写报告标题和不超过 32000 字的正文。')
      return this.engine.repo.write(async tx => {
        const report = (await tx.reports()).find(item => item.id === body.id)
        if (!report) throw new WorkbenchError('报告不存在。', 'missing', 404)
        report.title = body.title.trim(); report.text = body.text; report.updatedAt = now()
        await tx.saveReport(report)
        return report
      })
    }
    if (body.action === 'deleteReport') return this.engine.repo.write(async tx => {
      if (!(await tx.reports()).some(item => item.id === body.id)) throw new WorkbenchError('报告不存在。', 'missing', 404)
      await tx.deleteReport(body.id)
      return { deleted: true }
    })
    if (body.action === 'trialRule' && body.range) return this.trialRange(body, uiLanguage, signal)
    if (body.action === 'trialRule') {
      const rule = validateRule({ ...body.rule, enabled: true }), tasks = await this.engine.repo.tasks()
      const pool = tasks.slice().sort((a, b) => b.receivedAt.localeCompare(a.receivedAt)).slice(0, 30)
      const items = pool.map(task => {
        const category = task.triage?.category
        if (!matches(rule, { account: task.account, folder: task.source.folder, from: task.from, subject: task.subject, hasAttachments: task.attachments.length > 0 || task.hasAttachments === true, kind: task.source.kind ?? 'email' })) return { id: task.id, matched: false, reason: '发件人、主题或附件条件不符。', category }
        if (category && ruleExcludes(rule).includes(category)) return { id: task.id, matched: false, reason: '属于方案排除的信息类别。', category }
        return { id: task.id, matched: true, reason: '符合发件人、主题和附件条件。', category }
      })
      let by: 'ai' | 'rules' = 'rules'
      const judged = items.filter(item => item.matched)
      // Literal-mode workflows take every literal match; only AI-mode workflows need the AI verdict.
      if (ruleMode(rule) === 'ai' && this.engine.writer?.available() && judged.length) {
        try {
          const result = await this.engine.writer.run('trial', { ...trialData({ tasks, ruleExamples: await this.engine.repo.examples('rule') }, rule, judged.map(item => item.id)), uiLanguage: uiLanguage ?? this.engine.language }, AbortSignal.any([signal, this.controller.signal, AbortSignal.timeout(120000)])) as { matches: { id: string; matched: boolean; reason: string }[] }
          for (const verdict of result.matches) { const item = items.find(entry => entry.id === verdict.id && entry.matched); if (item) { item.matched = verdict.matched; item.reason = verdict.reason || item.reason } }
          by = 'ai'
        } catch (error) { if (signal.aborted) throw error }
      }
      // Without an AI verdict an AI-mode workflow takes nothing automatically; say so instead of showing literal hits as matches.
      if (ruleMode(rule) === 'ai' && by === 'rules') for (const item of judged) { item.matched = false; item.reason = '字面条件符合，但需要 AI 判断是否适用；当前没有可用的 AI，不会自动处理。' }
      return { by, total: items.length, items: items.map(item => { const task = pool.find(entry => entry.id === item.id)!; return { ...item, subject: task.subject || task.title, from: task.from, receivedAt: task.receivedAt } }), note: '仅预览匹配结果，不会调用处理流程或发送邮件。' }
    }
    if (body.action === 'undoActivity') {
      const entry = await this.engine.repo.activityItem(body.activityId)
      if (!entry || entry.undoneAt || !entry.taskId) throw new WorkbenchError('这条记录无法撤回。', 'state', 409)
      if (entry.kind === 'archive') return this.restore(entry.taskId)
      if (entry.kind === 'auto_send_scheduled') return this.cancelAutoSend(entry.taskId)
      throw new WorkbenchError('这条记录无法撤回。', 'state', 409)
    }
    // Actions of an installed channel (its own settings, lists or history), with that channel's settings.
    const owner = this.engine.channels.actionOwner(body.action)
    if (owner) return owner.actions![body.action](body, { settings: (await this.engine.repo.config()).settings.channels?.[owner.kind], signal, log: message => this.engine.repo.write(tx => tx.log(message)) })
    if (body.action === 'baselineWindow') {
      // Preview only: how much mail a start time would bring back. Nothing changes.
      if (typeof body.account !== 'string' || typeof body.folder !== 'string') throw new WorkbenchError('请选择邮箱和文件夹。')
      const since = startTime(body.since), email = this.engine.email()
      if (!email.window) throw new WorkbenchError('当前邮件服务不支持按时间处理历史邮件。', 'provider', 503)
      const window = await email.window(body.account, body.folder, since, AbortSignal.any([signal, AbortSignal.timeout(60000)]))
      return { count: window.count, answered: window.answered.length, limit: BACKFILL_LIMIT }
    }
    if (body.action === 'resetBaseline') {
      await this.engine.repo.checkConfig(body.revision)
      if (body.confirmed !== true || typeof body.account !== 'string' || typeof body.folder !== 'string') throw new WorkbenchError('重建基线需要明确确认，当前已有邮件不会重新处理。')
      const key = JSON.stringify([body.account, body.folder]), email = this.engine.email()
      if (body.since === undefined || body.since === null || body.since === '') {
        const baseline = await email.scan({ account: body.account, folder: body.folder }, signal)
        return this.engine.repo.write(async tx => {
          await tx.checkConfig(body.revision)
          await tx.setCursor(key, baseline.cursor); await tx.setBackfill(key, undefined)
          await tx.log(`${body.account} / ${body.folder} 已人工确认重建基线。`)
          return baseline.cursor
        })
      }
      // Start from a chosen time: move the cursor back to the first mail received since then and mark that history.
      const since = startTime(body.since)
      if (!email.window) throw new WorkbenchError('当前邮件服务不支持按时间处理历史邮件。', 'provider', 503)
      const window = await email.window(body.account, body.folder, since, AbortSignal.any([signal, AbortSignal.timeout(60000)]))
      if (window.count > BACKFILL_LIMIT) throw new WorkbenchError(`这段时间有 ${window.count} 封邮件，一次最多处理 ${BACKFILL_LIMIT} 封；请把开始时间往后调。`)
      const includeAnswered = body.includeAnswered === true
      // Nothing since then: a real baseline from now. Reusing an old cursor (or 0 when there is none) would bring
      // back the whole folder as new mail, unmarked and uncapped.
      const fresh = !window.count || !window.firstUid ? await email.scan({ account: body.account, folder: body.folder }, signal) : undefined
      return this.engine.repo.write(async tx => {
        await tx.checkConfig(body.revision)
        if (fresh) {
          await tx.setCursor(key, fresh.cursor); await tx.setBackfill(key, undefined)
          await tx.log(`${body.account} / ${body.folder} 自 ${body.since} 以来没有邮件，已从现在开始处理。`)
          return fresh.cursor
        }
        const cursor = { uidValidity: window.uidValidity, lastUid: window.firstUid! - 1 }
        await tx.setCursor(key, cursor)
        await tx.setBackfill(key, { uidValidity: window.uidValidity, untilUid: window.lastUid!, skip: includeAnswered ? [] : window.answered, since: since.toISOString(), at: now() })
        await tx.log(`${body.account} / ${body.folder} 将从 ${body.since} 开始补处理 ${window.count} 封邮件${includeAnswered || !window.answered.length ? '' : `（跳过 ${window.answered.length} 封已回复）`}；不会自动发送。`)
        return cursor
      })
    }
    const id = typeof body.id === 'string' ? body.id : ''
    return this.exclusive(id, async () => {
      const repo = this.engine.repo
      const task = await repo.task(id, requireRevision(body.revision))
      // Items from other channels are read-only here: nothing to draft, send or load from a mailbox.
      const channel = this.engine.channelOf(task), other = !isMail(task)
      if (other && ['loadMail', 'saveDraft', 'previewSend', 'send', 'resolveSend'].includes(body.action)) throw new WorkbenchError(channel?.text.readonly ?? '这项信息来自未安装的渠道，只能查看。', channel?.readonlyCode ?? 'channel-unavailable', 409)
      if (body.action === 'classify') {
        // You choose the category: applied at once (a move moves the mail now) and remembered as an example.
        if (other) throw new WorkbenchError(channel?.text.notClassified ?? '这项信息来自未安装的渠道，只能查看。', 'state', 409)
        if (['running', 'queued', 'sending', 'uncertain'].includes(task.status)) throw new WorkbenchError('处理中不能更改分类，请稍后再试。', 'state', 409)
        const current = await repo.config()
        const classifier = current.classifiers.find(item => item.id === task.classification?.classifierId) ?? classifierFor(current, task.account, task.source.folder)
        if (!classifier) throw new WorkbenchError('这项信息所在的文件夹没有分类方案。', 'state', 409)
        const category = classifier.categories.find(item => item.id === body.categoryId)
        if (!category) throw new WorkbenchError('分类不存在，请刷新后重试。', 'missing', 404)
        const previous = task.classification?.state === 'applied' && task.classification.categoryId !== category.id ? task.classification : undefined
        const updated = await repo.updateTask(id, body.revision, async (item, tx) => {
          const example = exampleText(item), at = now()
          await tx.setExamples('category', category.id, learnCategory(await tx.examplesOf('category', category.id), item.id, example, true, at))
          if (previous?.categoryId) await tx.setExamples('category', previous.categoryId, learnCategory(await tx.examplesOf('category', previous.categoryId), item.id, example, false, at))
          if (category.action === 'move') await takeOver(tx, item, '你更改了分类，自动发送取消。')
          item.classification = { classifierId: classifier.id, categoryId: category.id, categoryName: category.name, state: 'applied', by: 'manual', at }
          delete item.error
          touch(item, previous ? `你把分类从「${previous.categoryName ?? ''}」改为「${category.name}」，AI 会参考这次纠正。` : `你把它归为「${category.name}」，AI 会参考这次判断。`)
          if (category.action !== 'move' && item.dispatch) touch(item, `邮件仍在「${item.dispatch.folder}」，没有移回。`)
          await tx.log(`已归为「${category.name}」。`, item.id)
          return item
        })
        if (category.action === 'move') await this.engine.moveMail(updated, category.folder!, signal, { summary: `已归为「${category.name}」，移到「${category.folder}」。`, label: category.name })
        return repo.task(id)
      }
      if (body.action === 'saveReply') {
        if (channel?.capabilities.reply !== 'copy' || task.status !== 'review') throw new WorkbenchError(channel?.text.replyNotEditable ?? '只有待审核的事项可以修改建议回复。', 'state', 409)
        if (typeof body.text !== 'string' || !body.text.trim() || body.text.length > 16000) throw new WorkbenchError('请填写不超过 16000 字的回复。')
        return repo.updateTask(id, body.revision, item => {
          if (body.replyRevision !== undefined && item.reply?.revision !== body.replyRevision) throw new WorkbenchError('建议回复已更新，请刷新后重试。', 'conflict', 409)
          item.reply = { text: body.text.trim(), revision: (item.reply?.revision ?? 0) + 1 }
          touch(item, '已保存修改后的回复。'); return item
        })
      }
      if (body.action === 'markHandled') {
        const copy = channel?.capabilities.reply === 'copy' ? channel : undefined
        if (!copy || ['running', 'queued', 'completed', 'ignored'].includes(task.status)) throw new WorkbenchError('当前状态不能标记为已处理。', 'state', 409)
        return repo.updateTask(id, body.revision, async (item, tx) => { item.status = 'completed'; touch(item, copy.text.handled); await tx.log(copy.text.handledLog, id); return item })
      }
      if (body.action === 'loadMail') {
        if (['running', 'sending'].includes(task.status)) throw new WorkbenchError('任务正在执行，请稍后查看原邮件。')
        const read = await this.engine.readOriginal(task, signal)
        return repo.updateTask(id, body.revision, item => {
          item.body = read.text || ''; item.mailLoaded = true; item.attachments = read.attachments || []; item.messageId = read.messageId; item.references = read.references
          Object.assign(item, originalMailFields(read))
          touch(item, '已人工读取原邮件。')
          return { ...item, rule: undefined, workspace: undefined, attachments: item.attachments.map(({ localPath, ...file }) => file) }
        })
      }
      if (body.action === 'retry' || body.action === 'supplement' || body.action === 'runRule') {
        if (['running', 'sending', 'sent', 'uncertain'].includes(task.status)) throw new WorkbenchError('当前状态不允许重新处理。', 'state', 409)
        if (task.draftId) { const draft = await this.engine.email().drafts.get(task.draftId); if (draft.state !== 'draft') throw new WorkbenchError('草稿已提交或结果待核实，不能重新处理。', 'state', 409) }
        return repo.updateTask(id, body.revision, async (item, tx) => {
          if (body.action === 'runRule') {
            if (body.ruleRevision !== undefined) await tx.checkConfig(body.ruleRevision)
            const rule = (await tx.config()).rules.find(r => r.id === body.ruleId); if (!rule) throw new WorkbenchError('请选择已有规则。')
            const previous = item.ruleId
            item.rule = structuredClone(rule); item.ruleId = rule.id; item.ruleName = rule.name
            // Choosing a workflow for a message teaches AI that such messages belong to it.
            const confirmed = item.match?.state === 'suggested' && item.match.ruleId === rule.id
            // Re-running the same workflow (e.g. after editing it) is not a new judgement.
            if (previous !== rule.id || confirmed) {
              await learn(tx, rule.id, item, true, channel?.ai.exampleLabel(item))
              item.match = { ruleId: rule.id, ruleName: rule.name, by: 'manual', state: 'applied', reason: confirmed ? '你确认了 AI 的建议。' : '你手动选择了这个方案。', at: now() }
              touch(item, confirmed ? `已确认 AI 建议的方案「${rule.name}」，AI 会参考这次判断。` : `已手动选择方案「${rule.name}」，AI 会参考这次判断。`)
            }
          }
          // A message whose triage failed has no workflow yet; retrying runs triage again.
          if (!item.rule && item.triage?.state !== 'pending') throw new WorkbenchError('请先为任务选择处理规则。')
          if (body.action === 'supplement' || (body.action === 'runRule' && body.text !== undefined)) {
            if (typeof body.text !== 'string' || !body.text.trim() || body.text.length > 16000) throw new WorkbenchError('请填写不超过 16000 字的补充信息。')
            const text = [item.supplement, body.text.trim()].filter(Boolean).join('\n\n')
            if (text.length > 16000) throw new WorkbenchError('累计补充信息超过 16000 字，请整理后重新提交。')
            item.supplement = text
          }
          if (item.summary) item.history.push({ at: new Date().toISOString(), message: `重新处理前的结果：\n${item.summary}${item.informationGaps ? '\n待人工核实：\n' + item.informationGaps : ''}${item.error ? '\n阻塞原因：\n' + item.error : ''}` })
          delete item.needsInfoKind
          await takeOver(tx, item, '已重新处理，原自动发送取消。')
          item.status = 'queued'; item.attempts = 0; item.prepareKey = randomUUID(); delete item.nextAttemptAt; delete item.error; touch(item, '已排队重新处理；原草稿保留，重新生成后关联新草稿。'); await tx.log('任务已重新排队。', id); return item
        })
      }
      if (body.action === 'rejectRule') {
        // “Not this workflow”: undo the assignment or decline the suggestion, and remember it as a counter-example.
        if (['running', 'sending', 'sent', 'uncertain'].includes(task.status)) throw new WorkbenchError('当前状态不能更改方案。', 'state', 409)
        const ruleId = task.match?.state === 'rejected' ? task.ruleId : task.match?.ruleId ?? task.ruleId
        if (!ruleId) throw new WorkbenchError('这项信息还没有方案。', 'state', 409)
        return repo.updateTask(id, body.revision, async (item, tx) => {
          const name = item.match?.ruleName ?? item.ruleName ?? ''
          await learn(tx, ruleId, item, false, channel?.ai.exampleLabel(item))
          await takeOver(tx, item, '你更改了方案，自动发送取消。')
          if (item.summary) item.history.push({ at: now(), message: `更改方案前的结果：\n${item.summary}` })
          item.match = { ruleId, ruleName: name, by: 'manual', state: 'rejected', at: now() }
          delete item.rule; delete item.ruleId; delete item.ruleName; delete item.summary; delete item.checks; delete item.informationGaps; delete item.error; delete item.needsInfoKind
          delete item.reply
          item.status = 'unmatched'
          touch(item, `你判断这项信息不属于方案「${name}」，AI 以后会参考这次纠正。可以选择其他方案或忽略。`); await tx.log(`已从方案「${name}」移出并记为反例。`, id)
          return item
        })
      }
      if (body.action === 'ignore') return repo.updateTask(id, body.revision, async (item, tx) => { if (['running', 'sending', 'uncertain', 'sent'].includes(item.status)) throw new WorkbenchError('当前状态不允许忽略。'); await takeOver(tx, item, '已人工忽略，自动发送取消。'); item.status = 'ignored'; touch(item, '已人工忽略。'); await tx.log('任务已忽略。', id); return item })
      if (body.action === 'restore') return this.restoreTask(id, body.revision)
      if (body.action === 'cancelAutoSend') return this.cancelTaskAutoSend(id, body.revision)
      if (body.action === 'saveDraft') {
        editableTask(task)
        if (!task.draftId) throw new WorkbenchError('任务没有回复草稿。')
        const original = await this.engine.email().drafts.get(task.draftId), fields = body.draft
        if (!fields || typeof fields !== 'object') throw new WorkbenchError('请填写草稿。')
        const draft = await this.engine.email().drafts.update(task.draftId, requireRevision(body.draftRevision), { account: task.account, to: fields.to, cc: fields.cc, subject: fields.subject, text: fields.text, attachments: fields.attachments ?? original.attachments.map((file: any) => file.id) }, signal)
        await repo.updateTask(id, body.revision, async (item, tx) => { await takeOver(tx, item, '你修改了草稿，自动发送已取消。'); touch(item, '已保存人工编辑的草稿。') })
        return draft
      }
      if (body.action === 'previewSend') {
        editableTask(task); if (!task.draftId) throw new WorkbenchError('任务没有回复草稿。')
        return this.engine.email().drafts.preview(task.draftId, requireRevision(body.draftRevision), signal)
      }
      if (body.action === 'send') {
        editableTask(task)
        if (!task.draftId || body.confirmed !== true || typeof body.planId !== 'string') throw new WorkbenchError('请预览并明确确认发送。')
        // Keep the same provider for the accepted action even if its plugin
        // detaches while SMTP is in flight; its saved receipt remains authoritative.
        const email = this.engine.email()
        const before = await email.drafts.get(task.draftId)
        if (before.revision !== requireRevision(body.draftRevision)) throw new WorkbenchError('草稿已变化，请重新预览。', 'conflict', 409)
        await repo.updateTask(id, body.revision, async (item, tx) => { editableTask(item); await takeOver(tx, item, '已人工确认发送。'); item.status = 'sending'; touch(item, '人工确认发送。'); await tx.log('开始发送审核后的草稿。', id) })
        try {
          const result = await email.drafts.send(task.draftId, body.planId, true, signal)
          await repo.updateTask(id, undefined, async (item, tx) => { item.status = result.draft.state === 'sent' ? 'sent' : result.draft.state === 'draft' ? 'review' : 'uncertain'; item.error = result.draft.error; touch(item, item.status === 'review' ? '发送未提交，草稿保留，请修复连接后重新预览发送。' : item.status === 'sent' ? 'SMTP 已接受邮件，请以邮箱最终投递结果为准。' : '发送结果待核实，不会自动重发。'); await tx.log(item.status === 'review' ? '发送未提交，已保留待审核草稿。' : item.status === 'sent' ? '邮件发送已获得 SMTP 回执。' : '发送结果待核实。', id) })
          return result
        } catch (error) {
          const draft = await email.drafts.get(task.draftId).catch(() => undefined)
          await repo.updateTask(id, undefined, async (item, tx) => { item.status = draft?.state === 'draft' ? 'review' : draft?.state === 'sent' ? 'sent' : 'uncertain'; item.error = this.engine.safe(error); touch(item, item.status === 'review' ? '发送校验未通过，邮件未提交。' : '发送记录需核实。'); await tx.log(item.error!, id, 'error') })
          throw error
        }
      }
      if (body.action === 'resolveSend') {
        if (task.status !== 'uncertain' || !task.draftId || body.confirmed !== true || !['sent', 'not_sent'].includes(body.outcome)) throw new WorkbenchError('请核对邮箱后确认当前待核实任务的发送结果。', 'state', 409)
        const email = this.engine.email()
        if (!email.drafts.resolveSend) throw new WorkbenchError('请更新配套邮件插件并重启客户端，以恢复发送待核实任务。', 'provider', 503)
        const draft = await email.drafts.get(task.draftId)
        if (draft.revision !== requireRevision(body.draftRevision)) throw new WorkbenchError('草稿已变化，请重新预览。', 'conflict', 409)
        const resolved = await email.drafts.resolveSend(task.draftId, draft.revision, body.outcome, true, signal)
        const status = body.outcome === 'sent' ? 'sent' : 'review'
        if (resolved.state !== (status === 'sent' ? 'sent' : 'draft')) throw new WorkbenchError('邮件服务返回的核对结果无效。')
        await repo.updateTask(id, body.revision, async (item, tx) => {
          if (item.error) touch(item, item.error)
          item.status = status; delete item.error
          const message = status === 'sent' ? '用户核对邮箱后确认已发送；未生成新的 SMTP 回执。' : '用户核对邮箱后确认未发送；已恢复草稿，需重新预览后手动发送。'
          touch(item, message); await tx.log(message, id)
        })
        return { draft: resolved }
      }
      throw new WorkbenchError('不支持此操作。')
    })
  }
  /** Forget one learned example of a workflow or a business category. */
  private deleteExample(kind: 'rule' | 'category', owner: unknown, exampleId: unknown): Promise<unknown> {
    return this.engine.repo.write(async tx => {
      const list = typeof owner === 'string' ? await tx.examplesOf(kind, owner) : []
      if (!list.some(example => example.id === exampleId)) throw new WorkbenchError('例子不存在。', 'missing', 404)
      await tx.setExamples(kind, owner as string, list.filter(example => example.id !== exampleId))
      return { deleted: true }
    })
  }
  /** Bring an AI-archived message back and stop archiving that sender automatically. */
  private restoreTask(id: string, revision?: unknown): Promise<unknown> {
    return this.engine.repo.updateTask(id, revision, async (item, tx) => {
      if (item.status !== 'ignored' || !item.triage?.archived) throw new WorkbenchError('只有 AI 归档的信息可以恢复。', 'state', 409)
      item.status = 'unmatched'; item.triage.archived = false
      const sender = senderKey(item)
      await tx.setContact(sender, { ...(await tx.contact(sender)), neverArchive: true })
      await tx.undoActivity(item.id, 'archive', now())
      touch(item, '已恢复 AI 归档的信息；该发件人的信息以后不再自动归档。'); await tx.log('已恢复归档信息。', item.id)
      return item
    })
  }
  private restore(taskId: string): Promise<unknown> { return this.exclusive(taskId, () => this.restoreTask(taskId)) }
  /** Withdraw a pending automatic reply; future replies to this contact stay manual. */
  private cancelTaskAutoSend(id: string, revision?: unknown): Promise<unknown> {
    return this.engine.repo.updateTask(id, revision, async (item, tx) => {
      if (item.status !== 'review' || !item.autoSend || item.autoSend.canceledAt) throw new WorkbenchError('自动发送已执行或已取消，无法撤回。', 'state', 409)
      await takeOver(tx, item, '你撤回了自动发送。')
      const to = (item.replyTo || '').trim().toLowerCase()
      if (to) await tx.setContact(to, { ...(await tx.contact(to)), neverAutoSend: true })
      await tx.addActivity(activityEntry({ kind: 'auto_send_canceled', title: item.subject || item.title, detail: item.replyTo, taskId: item.id, ruleName: item.ruleName, source: 'email' }, randomUUID()))
      touch(item, '已撤回自动发送，转为人工审核；以后发给该联系人的回复都需要你确认。'); await tx.log('已撤回自动发送。', item.id)
      return item
    })
  }
  private cancelAutoSend(taskId: string): Promise<unknown> { return this.exclusive(taskId, () => this.cancelTaskAutoSend(taskId)) }
  async fetch(request: Request): Promise<Response> {
    try { return await this.tracked(() => this.dispatchFetch(request)) }
    catch (error) { return json(error instanceof WorkbenchError ? error.status : 400, { ok: false, error: this.engine.safe(error), code: (error as any)?.code ?? 'invalid' }) }
  }
  private async dispatchFetch(request: Request): Promise<Response> {
    try {
      if (request.method !== 'POST') return json(405, { ok: false, error: '请使用工作台支持的操作。' })
      if (request.headers.get('x-bkms-workbench') !== '1' || request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') return json(403, { ok: false, error: '请从工作台发起操作。' })
      const site = request.headers.get('sec-fetch-site'), origin = request.headers.get('origin')
      if (site && !['same-origin', 'none'].includes(site)) return json(403, { ok: false, error: '拒绝跨来源操作。' })
      if (origin) {
        let originUrl: URL
        try { originUrl = new URL(origin) } catch { return json(403, { ok: false, error: '无效请求来源。' }) }
        // The authenticated DSH HTTP bridge uses http://dsh.internal as its
        // Fetch URL. Its original admitted Host header remains authoritative.
        if (!['http:', 'https:'].includes(originUrl.protocol) || originUrl.host !== (request.headers.get('host') || new URL(request.url).host)) return json(403, { ok: false, error: '拒绝跨来源操作。' })
      }
      const reader = request.body?.getReader(); if (!reader) throw new WorkbenchError('请求为空。')
      let size = 0; const parts: Uint8Array[] = []
      try { for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > 256 * 1024) { await reader.cancel(); return json(413, { ok: false, error: '请求超过 256 KiB。' }) } parts.push(part.value) } } finally { reader.releaseLock() }
      const body = JSON.parse(Buffer.concat(parts).toString('utf8'))
      const signal = AbortSignal.any([request.signal, AbortSignal.timeout(120000)])
      if (new URL(request.url).pathname.endsWith('/attachment')) {
        const task = await this.engine.repo.task(body.id, requireRevision(body.revision))
        if (!Number.isSafeInteger(body.index) || body.index < 0 || body.index >= task.attachments.length) throw new WorkbenchError('附件索引无效，请重新加载原邮件。')
        await this.engine.readOriginal(task, signal)
        const file = await this.engine.attachment(task, body.index, signal)
        return new Response(new Uint8Array(await readFile(file.path)), { headers: { 'content-type': 'application/octet-stream', 'content-disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(file.filename), 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } })
      }
      const value = await this.dispatch(body, signal)
      return json(200, { ok: true, value })
    } catch (error) { return json(error instanceof WorkbenchError ? error.status : 400, { ok: false, error: this.engine.safe(error), code: (error as any)?.code ?? 'invalid' }) }
  }
}
