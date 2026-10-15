import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import lockfile from 'proper-lockfile'
import { validateRule } from './rules.js'
import { WorkbenchError, now, type State, type Task } from './types.js'

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
  }
}

export class Store {
  readonly file: string
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
      if (state.tasks.length > 5000 || state.rules.length > 100) throw new WorkbenchError('任务或规则数量达到上限，请先归档运行数据。')
      validateState(state)
      const data = JSON.stringify(state)
      if (Buffer.byteLength(data) > 64 * 1024 * 1024) throw new WorkbenchError('工作台存储达到 64 MiB 上限，请先备份归档。')
      temporary = join(this.root, '.' + randomUUID() + '.tmp')
      const handle = await open(temporary, 'wx', 0o600)
      try { await handle.writeFile(data); await handle.sync() } finally { await handle.close() }
      if (compromised) throw new WorkbenchError('存储锁已失效，已停止本次写入，请检查运行目录。', 'storage-lock-lost', 503)
      await rename(temporary, this.file)
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
