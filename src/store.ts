import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import lockfile from 'proper-lockfile'
import { validateRule } from './rules.js'
import { AUTONOMY, HIDEABLE_VIEWS, TRIAGE_CATEGORIES, WorkbenchError, now, type State, type Task } from './types.js'

function validateState(state: State): void {
  const positive = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 1
  const cursor = (value: any): boolean => value && positive(value.uidValidity) && Number.isSafeInteger(value.lastUid) && value.lastUid >= 0
  const statuses = new Set(['queued', 'running', 'review', 'needs_info', 'failed', 'sending', 'sent', 'uncertain', 'ignored', 'unmatched', 'completed'])
  if (!state || state.version !== 1 || !positive(state.revision) || !positive(state.configRevision) || !Array.isArray(state.rules) || state.rules.length > 100 || !Array.isArray(state.tasks) || state.tasks.length > 5000 || !Array.isArray(state.logs) || !state.cursors || typeof state.cursors !== 'object' || Array.isArray(state.cursors) || typeof state.settings?.enabled !== 'boolean' || !Number.isSafeInteger(state.settings.pollSeconds) || state.settings.pollSeconds < 30 || state.settings.pollSeconds > 3600) throw new Error('invalid document')
  if (new Set(state.tasks.map(task => task.id)).size !== state.tasks.length || new Set(state.rules.map(rule => rule.id)).size !== state.rules.length) throw new Error('duplicate identities')
  for (const key of ['showWorkbench', 'notifyNewTodo'] as const) if (state.settings[key] !== undefined && typeof state.settings[key] !== 'boolean') throw new Error('invalid preference')
  for (const rule of state.rules) { if (typeof rule?.id !== 'string' || !rule.id.trim()) throw new Error('invalid rule identity'); validateRule(rule) }
  for (const value of Object.values(state.cursors)) if (!cursor(value)) throw new Error('invalid cursor')
  for (const entry of state.logs) if (!entry || typeof entry.id !== 'string' || typeof entry.at !== 'string' || typeof entry.message !== 'string' || !['info', 'error'].includes(entry.level)) throw new Error('invalid log')
  for (const task of state.tasks) {
    if (!task || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(task.id) || !positive(task.revision) || !statuses.has(task.status) || !task.source || !cursor({ uidValidity: task.source.uidValidity, lastUid: task.source.uid }) || !positive(task.source.uid) || task.source.account !== task.account || typeof task.source.folder !== 'string' || !Array.isArray(task.history) || !Array.isArray(task.attachments) || !Number.isSafeInteger(task.attempts) || task.attempts < 0) throw new Error('invalid task')
    for (const key of ['title', 'account', 'from', 'subject', 'body', 'receivedAt', 'updatedAt'] as const) if (typeof task[key] !== 'string') throw new Error('invalid task text')
    if (task.rule) validateRule(task.rule)
    for (const key of ['to', 'cc', 'mailDate'] as const) if (task[key] !== undefined && (typeof task[key] !== 'string' || task[key]!.length > 16000)) throw new Error('invalid mail metadata')
    if (task.bodyHtml !== undefined && (typeof task.bodyHtml !== 'string' || Buffer.byteLength(task.bodyHtml, 'utf8') > 256 * 1024)) throw new Error('invalid mail HTML')
    if (task.mailSize !== undefined && (!Number.isSafeInteger(task.mailSize) || task.mailSize < 0)) throw new Error('invalid mail size')
    if (task.informationGaps !== undefined && typeof task.informationGaps !== 'string') throw new Error('invalid information gaps')
    if (task.needsInfoKind !== undefined && !['information', 'attachments'].includes(task.needsInfoKind)) throw new Error('invalid information blocker')
    if (task.attachments.some(file => !file || typeof file.filename !== 'string' || !Number.isFinite(file.size) || file.size < 0 || (file.localPath !== undefined && typeof file.localPath !== 'string'))) throw new Error('invalid attachment')
    if (task.triage !== undefined && (!task.triage || !['pending', 'done'].includes(task.triage.state) || (task.triage.category !== undefined && !TRIAGE_CATEGORIES.includes(task.triage.category)))) throw new Error('invalid triage')
    if (task.checks !== undefined && (!Array.isArray(task.checks) || task.checks.length > 20 || task.checks.some(check => !check || typeof check.item !== 'string' || (check.quote !== undefined && typeof check.quote !== 'string')))) throw new Error('invalid checks')
    if (task.autoSend !== undefined && (!task.autoSend || typeof task.autoSend.at !== 'string' || !Number.isSafeInteger(task.autoSend.draftRevision) || !AUTONOMY.includes(task.autoSend.autonomy))) throw new Error('invalid automatic send')
  }
  const s = state.settings
  for (const key of ['triage', 'briefEnabled', 'weeklyEnabled'] as const) if (s[key] !== undefined && typeof s[key] !== 'boolean') throw new Error('invalid preference')
  const integer = (value: unknown, min: number, max: number) => value === undefined || (Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max)
  if (!integer(s.undoMinutes, 1, 240) || !integer(s.weeklyDay, 0, 6) || !integer(s.meetingBriefMinutes, 5, 240)) throw new Error('invalid preference')
  for (const key of ['briefTime', 'weeklyTime'] as const) if (s[key] !== undefined && !CLOCK.test(String(s[key]))) throw new Error('invalid preference')
  if (state.activity !== undefined && (!Array.isArray(state.activity) || state.activity.some(item => !item || typeof item.id !== 'string' || typeof item.at !== 'string' || typeof item.kind !== 'string' || typeof item.title !== 'string'))) throw new Error('invalid activity')
  if (state.topics !== undefined && (!Array.isArray(state.topics) || state.topics.length > 100 || state.topics.some(topic => !topic || typeof topic.id !== 'string' || typeof topic.name !== 'string' || !Array.isArray(topic.keywords) || !Array.isArray(topic.senders)))) throw new Error('invalid topics')
  if (state.reports !== undefined && (!Array.isArray(state.reports) || state.reports.some(report => !report || typeof report.id !== 'string' || typeof report.text !== 'string' || !['weekly', 'topic'].includes(report.kind)))) throw new Error('invalid reports')
  if (state.brief !== undefined && (!state.brief || typeof state.brief.date !== 'string' || typeof state.brief.text !== 'string')) throw new Error('invalid brief')
  if (state.senders !== undefined && (!state.senders || typeof state.senders !== 'object' || Array.isArray(state.senders))) throw new Error('invalid sender preferences')
  if (s.wechat !== undefined) validateWechatSettings(s.wechat)
  if (s.hiddenViews !== undefined && (!Array.isArray(s.hiddenViews) || s.hiddenViews.some(view => !HIDEABLE_VIEWS.includes(view)) || new Set(s.hiddenViews).size !== s.hiddenViews.length)) throw new Error('invalid preference')
  if (state.uiLanguage !== undefined && state.uiLanguage !== 'zh' && state.uiLanguage !== 'en') throw new Error('invalid language')
  if (state.backfills !== undefined && (!state.backfills || typeof state.backfills !== 'object' || Array.isArray(state.backfills) || Object.values(state.backfills).some(item => !item || !positive(item.uidValidity) || !Number.isSafeInteger(item.untilUid) || item.untilUid < 0 || !Array.isArray(item.skip) || item.skip.length > 1000 || item.skip.some(uid => !Number.isSafeInteger(uid)) || typeof item.since !== 'string'))) throw new Error('invalid backfill')
  for (const task of state.tasks) if (task.dispatch !== undefined && (!task.dispatch || typeof task.dispatch.folder !== 'string' || typeof task.dispatch.at !== 'string' || (task.dispatch.uid !== undefined && !Number.isSafeInteger(task.dispatch.uid)))) throw new Error('invalid dispatch')
  if (state.ruleExamples !== undefined && (!state.ruleExamples || typeof state.ruleExamples !== 'object' || Array.isArray(state.ruleExamples) || Object.values(state.ruleExamples).some(list => !Array.isArray(list) || list.length > 50 || list.some(example => !example || typeof example.id !== 'string' || typeof example.match !== 'boolean' || typeof example.text !== 'string' || example.text.length > 1000)))) throw new Error('invalid rule examples')
  for (const task of state.tasks) if (task.match !== undefined && (!task.match || typeof task.match.ruleId !== 'string' || !['applied', 'suggested', 'rejected'].includes(task.match.state) || !['ai', 'literal', 'manual'].includes(task.match.by))) throw new Error('invalid match')
  const plain = (value: unknown) => !!value && typeof value === 'object' && !Array.isArray(value)
  if (state.wechat !== undefined && (!plain(state.wechat) || !plain(state.wechat.watermarks) || !plain(state.wechat.pending) || Object.values(state.wechat.watermarks).some(seq => !Number.isSafeInteger(seq) || seq < 0) || Object.values(state.wechat.pending).some(item => !plain(item) || !Array.isArray(item.messages) || item.messages.length > 100))) throw new Error('invalid wechat state')
  for (const task of state.tasks) if (task.wechat !== undefined && (!plain(task.wechat) || typeof task.wechat.chat !== 'string' || !Array.isArray(task.wechat.messages) || task.wechat.messages.length > 100 || (task.wechat.reply !== undefined && (typeof task.wechat.reply !== 'string' || task.wechat.reply.length > 16000)))) throw new Error('invalid wechat task')
}
const CHAT_ID = /^[\w@.\-]{1,120}$/
/** Shared by storage and the settings API so a bad list can never be persisted. */
export function validateWechatSettings(value: any): void {
  const fail = () => { throw new WorkbenchError('微信设置无效。') }
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['enabled', 'python', 'library', 'people', 'groups', 'quietMinutes', 'names'].includes(key))) fail()
  if (typeof value.enabled !== 'boolean') fail()
  for (const key of ['python', 'library']) if (value[key] !== undefined && (typeof value[key] !== 'string' || value[key].length > 500 || /[\0\r\n]/.test(value[key]))) fail()
  for (const key of ['people', 'groups']) {
    const list = value[key]
    if (!list || typeof list !== 'object' || !['allow', 'block'].includes(list.mode) || !Array.isArray(list.list) || list.list.length > 2000 || list.list.some((id: unknown) => typeof id !== 'string' || !CHAT_ID.test(id))) fail()
    if (list.list.some((id: string) => (key === 'groups') !== id.endsWith('@chatroom'))) throw new WorkbenchError(key === 'groups' ? '群聊名单里只能放群聊。' : '人员名单里不能放群聊。')
  }
  if (!['mention', 'all'].includes(value.groups.scope)) fail()
  if (value.quietMinutes !== undefined && (!Number.isSafeInteger(value.quietMinutes) || value.quietMinutes < 1 || value.quietMinutes > 60)) fail()
  if (value.names !== undefined && (!value.names || typeof value.names !== 'object' || Array.isArray(value.names) || Object.keys(value.names).length > 4000 || Object.entries(value.names).some(([id, name]) => !CHAT_ID.test(id) || typeof name !== 'string' || name.length > 200))) fail()
}
export const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/

/** Windows refuses to replace a file that antivirus, the search indexer or a reader has open for a moment. */
const LOCKED = new Set(['EPERM', 'EACCES', 'EBUSY'])
/**
 * Atomically replace `target` with `source`, retrying briefly while Windows holds the target (about 2 s in all).
 * Any other error, or a lock that does not go away, fails the write; the previous file is left as it was.
 */
export async function replaceFile(source: string, target: string, move: (from: string, to: string) => Promise<void> = rename, wait: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms))): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try { return await move(source, target) }
    catch (error) {
      if (!LOCKED.has((error as NodeJS.ErrnoException)?.code ?? '')) throw error
      if (attempt >= 10) throw new WorkbenchError('工作台数据文件被其他程序占用（可能是杀毒软件或索引服务），本次保存未完成，请稍后重试。', 'storage-busy', 503)
      await wait(Math.min(50 * attempt, 400))
    }
  }
}

export class Store {
  readonly file: string
  /** Replaces the data file; tests can stand in for a locked file. */
  replace: (source: string, target: string) => Promise<void> = replaceFile
  constructor(readonly root: string) { this.file = join(root, 'workbench-v1.json') }
  async read(): Promise<State> {
    try {
      if ((await stat(this.file)).size > 64 * 1024 * 1024) throw new Error('storage too large')
      const state: State = JSON.parse(await readFile(this.file, 'utf8'))
      state.configRevision ??= 1
      validateState(state)
      state.settings.showWorkbench ??= true
      state.settings.notifyNewTodo ??= false
      return state
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, revision: 1, configRevision: 1, settings: { enabled: false, pollSeconds: 60, showWorkbench: true, notifyNewTodo: false }, rules: [], tasks: [], cursors: {}, logs: [] }
      throw new WorkbenchError('工作台数据无法读取，原文件已保留。请检查存储或从备份恢复。', 'storage', 503)
    }
  }
  async mutate<T>(fn: (state: State) => T): Promise<T> {
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    let compromised: Error | undefined
    const release = await lockfile.lock(this.file, { realpath: false, stale: 30000, update: 5000, retries: { retries: 20, minTimeout: 25, maxTimeout: 100 }, onCompromised: error => { compromised = error } })
    let temporary: string | undefined
    try {
      const state = await this.read(), result = fn(state)
      if (result && typeof (result as any).then === 'function') throw new WorkbenchError('存储修改必须是同步事务。', 'storage', 503)
      state.revision++; state.logs = state.logs.slice(-1000)
      if (state.activity) state.activity = state.activity.slice(-1000)
      if (state.reports) state.reports = state.reports.slice(-200)
      if (state.tasks.length > 5000 || state.rules.length > 100) throw new WorkbenchError('任务或规则数量达到上限，请先归档运行数据。')
      validateState(state)
      const data = JSON.stringify(state)
      if (Buffer.byteLength(data) > 64 * 1024 * 1024) throw new WorkbenchError('工作台存储达到 64 MiB 上限，请先备份归档。')
      temporary = join(this.root, '.' + randomUUID() + '.tmp')
      const handle = await open(temporary, 'wx', 0o600)
      try { await handle.writeFile(data); await handle.sync() } finally { await handle.close() }
      if (compromised) throw new WorkbenchError('存储锁已失效，已停止本次写入，请检查运行目录。', 'storage-lock-lost', 503)
      await this.replace(temporary, this.file)
      return structuredClone(result)
    } finally { if (temporary) await unlink(temporary).catch(() => {}); await release().catch(() => {}) }
  }
  async ownWorker(onCompromised?: (error: Error) => void, waitForRecovery = false): Promise<() => Promise<void>> {
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    try { return await lockfile.lock(join(this.root, 'worker'), { realpath: false, stale: 30000, update: 5000, retries: waitForRecovery ? { retries: 35, factor: 1, minTimeout: 1000, maxTimeout: 1000 } : 0, onCompromised: error => { onCompromised?.(error) } }) }
    catch { throw new WorkbenchError('此 DSH_HOME 已有工作台后台进程，请使用独立运行目录。', 'worker-busy', 409) }
  }
}
export function log(state: State, message: string, taskId?: string, level: 'info' | 'error' = 'info'): void {
  state.logs.push({ id: randomUUID(), at: now(), level, message, taskId })
}
export function touch(task: Task, message: string): void {
  task.revision++; task.updatedAt = now(); task.history.push({ at: task.updatedAt, message }); task.history = task.history.slice(-100)
}
export function findTask(state: State, id: unknown, revision?: unknown): Task {
  const task = state.tasks.find(t => t.id === id)
  if (!task) throw new WorkbenchError('任务不存在。', 'missing', 404)
  if (revision !== undefined && task.revision !== revision) throw new WorkbenchError('任务已更新，请刷新后重试。', 'conflict', 409)
  return task
}
