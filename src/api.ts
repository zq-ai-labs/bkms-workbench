import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { Engine } from './engine.js'
import { matches, validateRule } from './rules.js'
import { findTask, log, touch } from './store.js'
import { WorkbenchError, type Task, type State, type RuleAssistant, type InstructionOptimizer } from './types.js'

const requireRevision = (revision: unknown): number => { if (!Number.isSafeInteger(revision) || Number(revision) < 1) throw new WorkbenchError('缺少有效版本，请刷新后重试。'); return Number(revision) }
const configCheck = (state: State, revision: unknown): void => { if (requireRevision(revision) !== state.configRevision) throw new WorkbenchError('配置已更新，请刷新后重试。', 'conflict', 409) }
const editableTask = (task: Task): void => { if (task.status !== 'review') throw new WorkbenchError('只有待审核任务可以修改或发送草稿。', 'state', 409) }
const json = (status: number, value: unknown): Response => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } })
export class WorkbenchApi {
  private busy = new Set<string>()
  private accepting = true
  private active = 0
  private drains = new Set<() => void>()
  private generating = false
  private controller = new AbortController()
  constructor(readonly engine: Engine, private ruleAssistant?: RuleAssistant, private instructionOptimizer?: InstructionOptimizer) {}
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
  private async buildSnapshot(): Promise<unknown> {
    const state = await this.engine.store.read()
    let accounts: { id: string; label: string; inboxFolder: string }[] = []
    let providerError: string | undefined
    try { accounts = (await this.engine.email().accounts()).map(a => ({ id: a.id, label: a.address || a.id, inboxFolder: a.inboxFolder || 'INBOX' })) } catch (error) { providerError = this.engine.safe(error) }
    // The provider's draft file is loaded once for the whole workbench. Loading
    // it per task becomes quadratic as the task history grows.
    let draftMap: Map<string, any> | undefined
    if (state.tasks.some(task => task.draftId)) {
      try {
        const service = this.engine.email()
        if (service.drafts.list) draftMap = new Map((await service.drafts.list()).map(draft => [draft.id, draft]))
      } catch (error) { providerError = this.engine.safe(error); draftMap = new Map() }
    }
    const tasks = await Promise.all(state.tasks.slice().reverse().map(async task => {
      let draft: any
      if (task.draftId) try {
        draft = draftMap ? draftMap.get(task.draftId) : await this.engine.email().drafts.get(task.draftId)
        if (!draft) throw new WorkbenchError('关联的邮件草稿无法读取或已移除；请核对邮件存储，任务资料仍保留。', 'draft-unavailable', 503)
        // A receipt saved by the mail provider is authoritative after a disconnect/restart.
        if (['sending', 'uncertain', 'review'].includes(task.status) && ['sent', 'uncertain'].includes(draft.state) && !this.busy.has(task.id)) {
          await this.engine.store.mutate(doc => { const current = findTask(doc, task.id); if (['sending', 'uncertain', 'review'].includes(current.status)) { current.status = draft.state; current.error = draft.error; touch(current, draft.state === 'sent' ? '已核对邮件发送记录。' : '发送结果待核实，请先核对邮箱。'); Object.assign(task, current) } })
        }
      } catch (error) { providerError ??= this.engine.safe(error) }
      const { workspace, rule, ...safe } = task
      return { ...safe, attachments: task.attachments.map(({ localPath, ...file }) => file), draft: draft ? { ...draft, sourceKey: undefined, attachments: draft.attachments.map(({ id, filename }: any) => ({ id, filename })) } : undefined }
    }))
    const health = this.engine.health()
    return { tasks, rules: state.rules, revision: state.configRevision, settings: state.settings, logs: state.logs.slice().reverse(), accounts, health: { ...health, error: providerError || health.error }, capabilities: await this.engine.capabilities() }
  }
  action(body: any, signal: AbortSignal = new AbortController().signal): Promise<unknown> { return this.tracked(() => this.dispatch(body, signal)) }
  private async dispatch(body: any, signal: AbortSignal): Promise<unknown> {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new WorkbenchError('请求格式无效。')
    if (body.action === 'snapshot') return this.buildSnapshot()
    if (body.action === 'preferences') {
      const state = await this.engine.store.read()
      // Global navigation and reminders do not need mailbox access or draft bodies.
      return { revision: state.configRevision, stateRevision: state.revision, settings: state.settings, attention: state.tasks.filter(task => ['review', 'needs_info', 'failed', 'uncertain'].includes(task.status)).map(task => ({ id: task.id, status: task.status })) }
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
      if (!settings || typeof settings !== 'object' || Array.isArray(settings) || !Object.keys(settings).length || Object.keys(settings).some(key => !['enabled', 'pollSeconds', 'showWorkbench', 'notifyNewTodo'].includes(key))) throw new WorkbenchError('工作台设置无效。')
      for (const key of ['enabled', 'showWorkbench', 'notifyNewTodo']) if (key in settings && typeof settings[key] !== 'boolean') throw new WorkbenchError('工作台开关应为布尔值。')
      if ('pollSeconds' in settings && (!Number.isSafeInteger(settings.pollSeconds) || settings.pollSeconds < 30 || settings.pollSeconds > 3600)) throw new WorkbenchError('检查间隔应为 30–3600 秒。')
      return this.engine.store.mutate(state => {
        configCheck(state, body.revision)
        const enabled = state.settings.enabled
        state.settings = { ...state.settings, ...settings }; state.configRevision++
        log(state, enabled !== state.settings.enabled ? state.settings.enabled ? '已开启后台自动处理。' : '已暂停接收和排队执行，正在运行的任务继续完成。' : '已更新工作台设置。')
        return state.settings
      })
    }
    if (body.action === 'saveRule') {
      const rule = validateRule(body.rule)
      return this.engine.store.mutate(state => { configCheck(state, body.revision); const index = state.rules.findIndex(r => r.id === rule.id); if (index < 0) state.rules.push(rule); else state.rules[index] = rule; state.configRevision++; log(state, `已保存规则「${rule.name}」。`); return rule })
    }
    if (body.action === 'deleteRule') return this.engine.store.mutate(state => { configCheck(state, body.revision); const rule = state.rules.find(r => r.id === body.id); if (!rule) throw new WorkbenchError('规则不存在。'); state.rules = state.rules.filter(r => r.id !== body.id); state.configRevision++; log(state, `已删除规则「${rule.name}」，历史任务保留原规则快照。`); return { deleted: true } })
    if (body.action === 'testRule') {
      const rule = validateRule(body.rule), task = findTask(await this.engine.store.read(), body.taskId)
      return { matched: matches(rule, { account: task.account, folder: task.source.folder, from: task.from, subject: task.subject, hasAttachments: task.attachments.length > 0 || task.hasAttachments === true }), rule: rule.name, note: '仅匹配预览，不会调用 DSH 或发送邮件。' }
    }
    if (body.action === 'poll') return this.engine.poll()
    if (body.action === 'resetBaseline') {
      if (body.confirmed !== true || typeof body.account !== 'string' || typeof body.folder !== 'string') throw new WorkbenchError('重建基线需要明确确认，当前已有邮件不会重新处理。')
      const baseline = await this.engine.email().scan({ account: body.account, folder: body.folder }, signal)
      return this.engine.store.mutate(state => { state.cursors[JSON.stringify([body.account, body.folder])] = baseline.cursor; log(state, `${body.account} / ${body.folder} 已人工确认重建基线。`); return baseline.cursor })
    }
    const id = typeof body.id === 'string' ? body.id : ''
    return this.exclusive(id, async () => {
      const task = findTask(await this.engine.store.read(), id, requireRevision(body.revision))
      if (body.action === 'loadMail') {
        if (['running', 'sending'].includes(task.status)) throw new WorkbenchError('任务正在执行，请稍后查看原邮件。')
        const read = await this.engine.readOriginal(task, signal)
        return this.engine.store.mutate(state => {
          const item = findTask(state, id, body.revision)
          item.body = read.text || ''; item.mailLoaded = true; item.attachments = read.attachments || []; item.messageId = read.messageId; item.references = read.references
          touch(item, '已人工读取原邮件。')
          return { ...item, rule: undefined, workspace: undefined, attachments: item.attachments.map(({ localPath, ...file }) => file) }
        })
      }
      if (body.action === 'retry' || body.action === 'supplement' || body.action === 'runRule') {
        if (['running', 'sending', 'sent', 'uncertain'].includes(task.status)) throw new WorkbenchError('当前状态不允许重新处理。', 'state', 409)
        if (task.draftId) { const draft = await this.engine.email().drafts.get(task.draftId); if (draft.state !== 'draft') throw new WorkbenchError('草稿已提交或结果待核实，不能重新处理。', 'state', 409) }
        return this.engine.store.mutate(state => {
          const item = findTask(state, id, body.revision)
          if (body.action === 'runRule') { const rule = state.rules.find(r => r.id === body.ruleId); if (!rule) throw new WorkbenchError('请选择已有规则。'); item.rule = structuredClone(rule); item.ruleId = rule.id; item.ruleName = rule.name }
          if (!item.rule) throw new WorkbenchError('请先为任务选择处理规则。')
          if (body.action === 'supplement') { if (typeof body.text !== 'string' || !body.text.trim() || body.text.length > 16000) throw new WorkbenchError('请填写不超过 16000 字的补充信息。'); item.supplement = body.text.trim() }
          item.status = 'queued'; item.attempts = 0; item.prepareKey = randomUUID(); delete item.nextAttemptAt; delete item.error; touch(item, '已排队重新处理；原草稿保留，重新生成后关联新草稿。'); log(state, '任务已重新排队。', id); return item
        })
      }
      if (body.action === 'ignore') return this.engine.store.mutate(state => { const item = findTask(state, id, body.revision); if (['running', 'sending', 'uncertain', 'sent'].includes(item.status)) throw new WorkbenchError('当前状态不允许忽略。'); item.status = 'ignored'; touch(item, '已人工忽略。'); log(state, '任务已忽略。', id); return item })
      if (body.action === 'saveDraft') {
        editableTask(task)
        if (!task.draftId) throw new WorkbenchError('任务没有回复草稿。')
        const original = await this.engine.email().drafts.get(task.draftId), fields = body.draft
        if (!fields || typeof fields !== 'object') throw new WorkbenchError('请填写草稿。')
        const draft = await this.engine.email().drafts.update(task.draftId, requireRevision(body.draftRevision), { account: task.account, to: fields.to, cc: fields.cc, subject: fields.subject, text: fields.text, attachments: fields.attachments ?? original.attachments.map((file: any) => file.id) }, signal)
        await this.engine.store.mutate(state => { const item = findTask(state, id, body.revision); touch(item, '已保存人工编辑的草稿。') })
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
        await this.engine.store.mutate(state => { const item = findTask(state, id, body.revision); editableTask(item); item.status = 'sending'; touch(item, '人工确认发送。'); log(state, '开始发送审核后的草稿。', id) })
        try {
          const result = await email.drafts.send(task.draftId, body.planId, true, signal)
          await this.engine.store.mutate(state => { const item = findTask(state, id); item.status = result.draft.state === 'sent' ? 'sent' : 'uncertain'; item.error = result.draft.error; touch(item, item.status === 'sent' ? 'SMTP 已接受邮件，请以邮箱最终投递结果为准。' : '发送结果待核实，不会自动重发。'); log(state, item.status === 'sent' ? '邮件发送已获得 SMTP 回执。' : '发送结果待核实。', id) })
          return result
        } catch (error) {
          const draft = await email.drafts.get(task.draftId).catch(() => undefined)
          await this.engine.store.mutate(state => { const item = findTask(state, id); item.status = draft?.state === 'draft' ? 'review' : draft?.state === 'sent' ? 'sent' : 'uncertain'; item.error = this.engine.safe(error); touch(item, item.status === 'review' ? '发送校验未通过，邮件未提交。' : '发送记录需核实。'); log(state, item.error!, id, 'error') })
          throw error
        }
      }
      throw new WorkbenchError('不支持此操作。')
    })
  }
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
        const task = findTask(await this.engine.store.read(), body.id, requireRevision(body.revision))
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
