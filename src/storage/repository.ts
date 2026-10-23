import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import lockfile from 'proper-lockfile'
import { openDatabase, ZqSqliteError, type Kysely, type SqliteDatabase } from 'zq-sqlite'
import { needsAttention } from '../digest.js'
import { migrations, type Database } from './schema.js'
import { WorkbenchError, type Activity, type Backfill, type Brief, type Classifier, type Cursor, type Log, type Report, type Rule, type RuleExample, type SenderPreference, type Settings, type Status, type Task, type Topic } from '../types.js'

/** The local plugin has one user. A server version would bind each request to its signed-in user here. */
const USER = 'local'
const LIMITS = { logs: 1000, activity: 1000, reports: 200 } as const
const DEFAULT_SETTINGS: Settings = { enabled: false, pollSeconds: 60, showWorkbench: true, notifyNewTodo: false }

/** Configuration read together: saving any part of it bumps `revision` (except the interface language). */
export interface Config { revision: number; settings: Settings; rules: Rule[]; classifiers: Classifier[]; uiLanguage?: 'zh' | 'en' }
export interface TaskFilter { statuses?: readonly Status[]; channel?: string }
/** A channel's saved progress: a cursor per scope (a mailbox folder, a conversation) and any other entries it keeps. */
export interface ChannelState { cursors: Record<string, unknown>; entries: Record<string, unknown> }

const parse = <T>(text: string): T => JSON.parse(text) as T
/**
 * Where a task's source lives and its key there; together they identify one message, so it is never added twice.
 * Mail: the folder, then mailbox generation and UID. Other channels: the scope (e.g. a conversation) and a position.
 */
export function sourceKey(task: Task): { channel: string; scope: string; item_key: string } {
  const channel = task.source.kind ?? 'email'
  return channel === 'email'
    ? { channel, scope: JSON.stringify([task.source.account, task.source.folder]), item_key: `${task.source.uidValidity}:${task.source.uid}` }
    : { channel, scope: task.source.folder, item_key: String(task.source.uid) }
}
const messageKey = (id: string | undefined) => id ? id.replace(/[<>]/g, '').trim() || null : null
function taskRow(task: Task, changed: number) {
  const { body, ...rest } = task
  const pending = task.autoSend && !task.autoSend.canceledAt && task.status === 'review' ? task.autoSend.at : null
  return {
    ...sourceKey(task), revision: task.revision, changed_seq: changed, status: task.status, attention: needsAttention(task) ? 1 : 0,
    received_at: task.receivedAt, updated_at: task.updatedAt, rule_id: task.ruleId ?? null, message_id: messageKey(task.messageId),
    next_attempt_at: task.nextAttemptAt ?? null, auto_send_at: pending, body: body ?? '', data: JSON.stringify(rest),
  }
}
const toTask = (row: { body: string; data: string }): Task => ({ ...parse<Omit<Task, 'body'>>(row.data), body: row.body })

/**
 * Typed access to the workbench records, either directly or inside one write transaction. Business rules stay with the
 * engine and the API; this layer only reads and writes records, so another database needs only this file redone.
 */
export class Records {
  private touched = new Set<keyof typeof LIMITS>()
  constructor(protected readonly db: Kysely<Database>, private readonly seq = 0) {}
  // Configuration
  async config(): Promise<Config> {
    const row = await this.db.selectFrom('workbench').selectAll().where('user_id', '=', USER).executeTakeFirst()
    const settings: Settings = row ? parse<Settings>(row.settings) : { ...DEFAULT_SETTINGS }
    settings.showWorkbench ??= true
    settings.notifyNewTodo ??= false
    return {
      revision: row?.config_revision ?? 1, settings,
      rules: (await this.ordered('rules')) as Rule[], classifiers: (await this.ordered('classifiers')) as Classifier[],
      ...(row?.ui_language === 'zh' || row?.ui_language === 'en' ? { uiLanguage: row.ui_language } : {}),
    }
  }
  /** Throws a 409 when the page saved against an older configuration. */
  async checkConfig(expected: unknown): Promise<void> {
    if (!Number.isSafeInteger(expected) || Number(expected) < 1) throw new WorkbenchError('缺少有效版本，请刷新后重试。')
    if ((await this.config()).revision !== expected) throw new WorkbenchError('配置已更新，请刷新后重试。', 'conflict', 409)
  }
  /** Save configuration parts; returns the new configuration revision. */
  async saveConfig(patch: { settings?: Settings; rules?: Rule[]; classifiers?: Classifier[] }): Promise<number> {
    if (patch.settings) await this.db.updateTable('workbench').set({ settings: JSON.stringify(patch.settings) }).where('user_id', '=', USER).execute()
    if (patch.rules) await this.replaceOrdered('rules', patch.rules)
    if (patch.classifiers) await this.replaceOrdered('classifiers', patch.classifiers)
    const row = await this.db.updateTable('workbench').set(eb => ({ config_revision: eb('config_revision', '+', 1) })).where('user_id', '=', USER).returning('config_revision').executeTakeFirstOrThrow()
    return row.config_revision
  }
  async setUiLanguage(language: 'zh' | 'en'): Promise<void> { await this.db.updateTable('workbench').set({ ui_language: language }).where('user_id', '=', USER).execute() }
  private async ordered(table: 'rules' | 'classifiers' | 'topics'): Promise<unknown[]> {
    return (await this.db.selectFrom(table).select('data').where('user_id', '=', USER).orderBy('position').execute()).map(row => parse(row.data))
  }
  private async replaceOrdered(table: 'rules' | 'classifiers' | 'topics', list: { id: string }[]): Promise<void> {
    await this.db.deleteFrom(table).where('user_id', '=', USER).execute()
    if (list.length) await this.db.insertInto(table).values(list.map((item, position) => ({ user_id: USER, id: item.id, position, data: JSON.stringify(item) }))).execute()
  }
  // Tasks
  async task(id: unknown, revision?: unknown): Promise<Task> {
    const row = typeof id === 'string' && id ? await this.db.selectFrom('tasks').select(['body', 'data']).where('user_id', '=', USER).where('id', '=', id).executeTakeFirst() : undefined
    if (!row) throw new WorkbenchError('任务不存在。', 'missing', 404)
    const task = toTask(row)
    if (revision !== undefined && task.revision !== revision) throw new WorkbenchError('任务已更新，请刷新后重试。', 'conflict', 409)
    return task
  }
  /** Tasks in the order they arrived. */
  async tasks(filter: TaskFilter = {}): Promise<Task[]> {
    let query = this.db.selectFrom('tasks').select(['body', 'data']).where('user_id', '=', USER)
    if (filter.statuses) query = query.where('status', 'in', filter.statuses.length ? [...filter.statuses] : ['-'])
    if (filter.channel) query = query.where('channel', '=', filter.channel)
    return (await query.orderBy('seq').execute()).map(toTask)
  }
  async attention(): Promise<{ id: string; status: Status }[]> {
    return (await this.db.selectFrom('tasks').select(['id', 'status']).where('user_id', '=', USER).where('attention', '=', 1).orderBy('seq').execute()) as { id: string; status: Status }[]
  }
  /** Queued tasks whose retry time has come, oldest first. */
  async ready(now: string, limit = 1000): Promise<Task[]> {
    return (await this.db.selectFrom('tasks').select(['body', 'data']).where('user_id', '=', USER).where('status', '=', 'queued')
      .where(eb => eb.or([eb('next_attempt_at', 'is', null), eb('next_attempt_at', '<=', now)])).orderBy('seq').limit(limit).execute()).map(toTask)
  }
  /** The first automatic reply whose withdrawal window has ended. */
  async dueAutoSend(now: string): Promise<Task | undefined> {
    const row = await this.db.selectFrom('tasks').select(['body', 'data']).where('user_id', '=', USER).where('auto_send_at', 'is not', null).where('auto_send_at', '<=', now).orderBy('auto_send_at').executeTakeFirst()
    return row ? toTask(row) : undefined
  }
  /** Tasks whose Message-ID is one of `ids` (with or without angle brackets). */
  async byMessageIds(ids: string[]): Promise<Task[]> {
    const keys = [...new Set(ids.map(messageKey).filter((key): key is string => !!key))]
    if (!keys.length) return []
    return (await this.db.selectFrom('tasks').select(['body', 'data']).where('user_id', '=', USER).where('message_id', 'in', keys).orderBy('seq').execute()).map(toTask)
  }
  async saveTask(task: Task): Promise<void> {
    await this.db.updateTable('tasks').set(taskRow(task, this.seq)).where('user_id', '=', USER).where('id', '=', task.id).execute()
  }
  /** Add a new task; false when a task for the same message already exists. */
  async insertTask(task: Task): Promise<boolean> {
    const result = await this.db.insertInto('tasks').values({ user_id: USER, id: task.id, ...taskRow(task, this.seq) })
      .onConflict(oc => oc.columns(['user_id', 'channel', 'scope', 'item_key']).doNothing()).executeTakeFirst()
    return Number(result.numInsertedOrUpdatedRows ?? 0n) > 0
  }
  // Logs and activity
  async log(message: string, taskId?: string, level: 'info' | 'error' = 'info'): Promise<void> {
    await this.db.insertInto('logs').values({ user_id: USER, id: randomUUID(), at: new Date().toISOString(), level, task_id: taskId ?? null, message }).execute()
    this.touched.add('logs')
  }
  /** Oldest first, like the former document. */
  async logs(): Promise<Log[]> {
    return (await this.db.selectFrom('logs').select(['id', 'at', 'level', 'task_id', 'message']).where('user_id', '=', USER).orderBy('seq').execute())
      .map(row => ({ id: row.id, at: row.at, level: row.level as Log['level'], message: row.message, ...(row.task_id ? { taskId: row.task_id } : {}) }))
  }
  async addActivity(entry: Activity): Promise<void> {
    await this.db.insertInto('activity').values({ user_id: USER, id: entry.id, at: entry.at, kind: entry.kind, task_id: entry.taskId ?? null, undone_at: entry.undoneAt ?? null, data: JSON.stringify(entry) }).execute()
    this.touched.add('activity')
  }
  /** Oldest first. */
  async activity(): Promise<Activity[]> {
    return (await this.db.selectFrom('activity').select('data').where('user_id', '=', USER).orderBy('seq').execute()).map(row => parse<Activity>(row.data))
  }
  async activityItem(id: unknown): Promise<Activity | undefined> {
    if (typeof id !== 'string') return undefined
    const row = await this.db.selectFrom('activity').select('data').where('user_id', '=', USER).where('id', '=', id).executeTakeFirst()
    return row ? parse<Activity>(row.data) : undefined
  }
  /** Mark a task's open entries of one kind as withdrawn (an archive restored, an automatic send cancelled). */
  async undoActivity(taskId: string, kind: Activity['kind'], at: string): Promise<void> {
    const rows = await this.db.selectFrom('activity').select(['id', 'data']).where('user_id', '=', USER).where('task_id', '=', taskId).where('kind', '=', kind).where('undone_at', 'is', null).execute()
    for (const row of rows) await this.db.updateTable('activity').set({ undone_at: at, data: JSON.stringify({ ...parse<Activity>(row.data), undoneAt: at }) }).where('user_id', '=', USER).where('id', '=', row.id).execute()
  }
  // Contacts and learned examples
  async contacts(): Promise<Record<string, SenderPreference>> {
    return Object.fromEntries((await this.db.selectFrom('contacts').select(['key', 'value']).where('user_id', '=', USER).execute()).map(row => [row.key, parse<SenderPreference>(row.value)]))
  }
  async contact(key: string): Promise<SenderPreference | undefined> {
    const row = await this.db.selectFrom('contacts').select('value').where('user_id', '=', USER).where('key', '=', key).executeTakeFirst()
    return row ? parse<SenderPreference>(row.value) : undefined
  }
  async setContact(key: string, value: SenderPreference): Promise<void> {
    await this.db.insertInto('contacts').values({ user_id: USER, key, value: JSON.stringify(value) }).onConflict(oc => oc.columns(['user_id', 'key']).doUpdateSet({ value: JSON.stringify(value) })).execute()
  }
  async examples(kind: 'rule' | 'category'): Promise<Record<string, RuleExample[]>> {
    const out: Record<string, RuleExample[]> = {}
    for (const row of await this.db.selectFrom('examples').select(['owner', 'data']).where('user_id', '=', USER).where('kind', '=', kind).orderBy('owner').orderBy('position').execute()) (out[row.owner] ??= []).push(parse<RuleExample>(row.data))
    return out
  }
  async examplesOf(kind: 'rule' | 'category', owner: string): Promise<RuleExample[]> {
    return (await this.db.selectFrom('examples').select('data').where('user_id', '=', USER).where('kind', '=', kind).where('owner', '=', owner).orderBy('position').execute()).map(row => parse<RuleExample>(row.data))
  }
  /** Replace one workflow's (or category's) examples; an empty list removes them. */
  async setExamples(kind: 'rule' | 'category', owner: string, list: RuleExample[]): Promise<void> {
    await this.db.deleteFrom('examples').where('user_id', '=', USER).where('kind', '=', kind).where('owner', '=', owner).execute()
    if (list.length) await this.db.insertInto('examples').values(list.map((example, position) => ({ user_id: USER, kind, owner, id: example.id, position, data: JSON.stringify(example) }))).execute()
  }
  // Mailbox cursors, history backfills and other channels' saved progress
  async cursors(): Promise<Record<string, Cursor>> {
    return Object.fromEntries((await this.db.selectFrom('cursors').select(['key', 'value']).where('user_id', '=', USER).where('channel', '=', 'email').execute()).map(row => [row.key, parse<Cursor>(row.value)]))
  }
  async cursor(key: string): Promise<Cursor | undefined> {
    const row = await this.db.selectFrom('cursors').select('value').where('user_id', '=', USER).where('channel', '=', 'email').where('key', '=', key).executeTakeFirst()
    return row ? parse<Cursor>(row.value) : undefined
  }
  async setCursor(key: string, cursor: Cursor): Promise<void> { await this.put('cursors', 'email', key, cursor) }
  async backfills(): Promise<Record<string, Backfill>> {
    return Object.fromEntries((await this.db.selectFrom('channel_state').select(['key', 'value']).where('user_id', '=', USER).where('channel', '=', 'email').where('key', 'like', 'backfill:%').execute()).map(row => [row.key.slice('backfill:'.length), parse<Backfill>(row.value)]))
  }
  async backfill(key: string): Promise<Backfill | undefined> { return (await this.backfills())[key] }
  async setBackfill(key: string, value: Backfill | undefined): Promise<void> {
    if (value) await this.put('channel_state', 'email', 'backfill:' + key, value)
    else await this.db.deleteFrom('channel_state').where('user_id', '=', USER).where('channel', '=', 'email').where('key', '=', 'backfill:' + key).execute()
  }
  async channelState(channel: string): Promise<ChannelState> {
    const cursors = await this.db.selectFrom('cursors').select(['key', 'value']).where('user_id', '=', USER).where('channel', '=', channel).execute()
    const entries = await this.db.selectFrom('channel_state').select(['key', 'value']).where('user_id', '=', USER).where('channel', '=', channel).execute()
    return { cursors: Object.fromEntries(cursors.map(row => [row.key, parse(row.value)])), entries: Object.fromEntries(entries.map(row => [row.key, parse(row.value)])) }
  }
  /** Replace everything a channel saved. */
  async setChannelState(channel: string, state: ChannelState): Promise<void> {
    await this.db.deleteFrom('cursors').where('user_id', '=', USER).where('channel', '=', channel).execute()
    await this.db.deleteFrom('channel_state').where('user_id', '=', USER).where('channel', '=', channel).execute()
    for (const [key, value] of Object.entries(state.cursors)) await this.put('cursors', channel, key, value)
    for (const [key, value] of Object.entries(state.entries)) await this.put('channel_state', channel, key, value)
  }
  private async put(table: 'cursors' | 'channel_state', channel: string, key: string, value: unknown): Promise<void> {
    await this.db.insertInto(table).values({ user_id: USER, channel, key, value: JSON.stringify(value) }).onConflict(oc => oc.columns(['user_id', 'channel', 'key']).doUpdateSet({ value: JSON.stringify(value) })).execute()
  }
  // Topics, reports and the daily brief
  async topics(): Promise<Topic[]> { return (await this.ordered('topics')) as Topic[] }
  async saveTopic(topic: Topic): Promise<void> {
    const position = (await this.db.selectFrom('topics').select(eb => eb.fn.max('position').as('max')).where('user_id', '=', USER).executeTakeFirst())?.max
    await this.db.insertInto('topics').values({ user_id: USER, id: topic.id, position: Number(position ?? -1) + 1, data: JSON.stringify(topic) })
      .onConflict(oc => oc.columns(['user_id', 'id']).doUpdateSet({ data: JSON.stringify(topic) })).execute()
  }
  async deleteTopic(id: string): Promise<void> { await this.db.deleteFrom('topics').where('user_id', '=', USER).where('id', '=', id).execute() }
  /** Oldest first. */
  async reports(): Promise<Report[]> { return (await this.db.selectFrom('reports').select('data').where('user_id', '=', USER).orderBy('seq').execute()).map(row => parse<Report>(row.data)) }
  async addReport(report: Report): Promise<void> {
    await this.db.insertInto('reports').values({ user_id: USER, id: report.id, kind: report.kind, topic_id: report.topicId ?? null, period_start: report.periodStart, data: JSON.stringify(report) }).execute()
    this.touched.add('reports')
  }
  async saveReport(report: Report): Promise<void> { await this.db.updateTable('reports').set({ data: JSON.stringify(report) }).where('user_id', '=', USER).where('id', '=', report.id).execute() }
  async deleteReport(id: string): Promise<void> { await this.db.deleteFrom('reports').where('user_id', '=', USER).where('id', '=', id).execute() }
  async brief(): Promise<Brief | undefined> {
    const row = await this.db.selectFrom('workbench').select('brief').where('user_id', '=', USER).executeTakeFirst()
    return row?.brief ? parse<Brief>(row.brief) : undefined
  }
  async setBrief(brief: Brief): Promise<void> { await this.db.updateTable('workbench').set({ brief: JSON.stringify(brief) }).where('user_id', '=', USER).execute() }
  /** Keep only the latest logs, activity and reports, as the former document did. */
  async prune(): Promise<void> {
    for (const table of this.touched) {
      const keep = LIMITS[table]
      const edge = await this.db.selectFrom(table).select('seq').where('user_id', '=', USER).orderBy('seq', 'desc').offset(keep).limit(1).executeTakeFirst()
      if (edge) await this.db.deleteFrom(table).where('user_id', '=', USER).where('seq', '<=', edge.seq).execute()
    }
    this.touched.clear()
  }
}

/** Read methods available on the repository outside a transaction. */
type Reads = Pick<Records, 'config' | 'checkConfig' | 'task' | 'tasks' | 'attention' | 'ready' | 'dueAutoSend' | 'byMessageIds' | 'logs' | 'activity' | 'activityItem'
  | 'contacts' | 'contact' | 'examples' | 'examplesOf' | 'cursors' | 'cursor' | 'backfills' | 'backfill' | 'channelState' | 'topics' | 'reports' | 'brief'>

/**
 * The workbench's storage: one SQLite database per plugin (docs/DESIGN-CORE-CHANNELS.md D1, D8), opened on first use.
 * Reads go straight to the database; every change runs in `write`, one transaction that also advances `changeSeq`,
 * which the page uses to tell whether anything changed.
 */
export class WorkbenchRepository implements Reads {
  private store?: Promise<SqliteDatabase<Database>>
  constructor(readonly root: string) {}
  private open(): Promise<SqliteDatabase<Database>> {
    this.store ??= (async () => {
      let store: SqliteDatabase<Database>
      try { store = await openDatabase<Database>({ dir: this.root, name: 'workbench', migrations }) }
      catch (error) {
        this.store = undefined
        if (error instanceof ZqSqliteError && error.code === 'database-newer') throw new WorkbenchError('工作台数据由更新版本的插件写入，请升级工作台插件后再打开。', 'storage-newer', 503)
        throw new WorkbenchError('工作台数据库无法打开，请检查运行目录或从备份恢复。', 'storage', 503)
      }
      await store.db.insertInto('workbench').values({ user_id: USER, change_seq: 1, config_revision: 1, settings: JSON.stringify(DEFAULT_SETTINGS), ui_language: null, brief: null }).onConflict(oc => oc.column('user_id').doNothing()).execute()
      return store
    })()
    return this.store
  }
  private async read(): Promise<Records> { return new Records((await this.open()).db) }
  /** One write transaction. Do no network or file I/O inside: it holds the database. */
  async write<T>(work: (tx: Records) => Promise<T>): Promise<T> {
    const store = await this.open()
    return store.transaction(async db => {
      const { change_seq } = await db.updateTable('workbench').set(eb => ({ change_seq: eb('change_seq', '+', 1) })).where('user_id', '=', USER).returning('change_seq').executeTakeFirstOrThrow()
      const tx = new Records(db, change_seq)
      const result = await work(tx)
      await tx.prune()
      return result
    })
  }
  /** Load one task (optionally at an expected revision), change it and save it in one transaction. */
  updateTask<T>(id: unknown, revision: unknown, change: (task: Task, tx: Records) => T | Promise<T>): Promise<T> {
    return this.write(async tx => {
      const task = await tx.task(id, revision)
      const result = await change(task, tx)
      await tx.saveTask(task)
      return result
    })
  }
  /** Advances with every change; equal values mean nothing was written in between. */
  async changeSeq(): Promise<number> {
    return (await (await this.open()).db.selectFrom('workbench').select('change_seq').where('user_id', '=', USER).executeTakeFirstOrThrow()).change_seq
  }
  /** Close the database; the next use opens it again. */
  async close(): Promise<void> {
    const store = this.store
    this.store = undefined
    if (store) await (await store.catch(() => undefined))?.close()
  }
  /** Only one background worker per data folder (DSH_HOME). */
  async ownWorker(onCompromised?: (error: Error) => void, waitForRecovery = false): Promise<() => Promise<void>> {
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    try { return await lockfile.lock(join(this.root, 'worker'), { realpath: false, stale: 30000, update: 5000, retries: waitForRecovery ? { retries: 35, factor: 1, minTimeout: 1000, maxTimeout: 1000 } : 0, onCompromised: error => { onCompromised?.(error) } }) }
    catch { throw new WorkbenchError('此 DSH_HOME 已有工作台后台进程，请使用独立运行目录。', 'worker-busy', 409) }
  }
  async config() { return (await this.read()).config() }
  async checkConfig(expected: unknown) { return (await this.read()).checkConfig(expected) }
  async task(id: unknown, revision?: unknown) { return (await this.read()).task(id, revision) }
  async tasks(filter?: TaskFilter) { return (await this.read()).tasks(filter) }
  async attention() { return (await this.read()).attention() }
  async ready(now: string, limit?: number) { return (await this.read()).ready(now, limit) }
  async dueAutoSend(now: string) { return (await this.read()).dueAutoSend(now) }
  async byMessageIds(ids: string[]) { return (await this.read()).byMessageIds(ids) }
  async logs() { return (await this.read()).logs() }
  async activity() { return (await this.read()).activity() }
  async activityItem(id: unknown) { return (await this.read()).activityItem(id) }
  async contacts() { return (await this.read()).contacts() }
  async contact(key: string) { return (await this.read()).contact(key) }
  async examples(kind: 'rule' | 'category') { return (await this.read()).examples(kind) }
  async examplesOf(kind: 'rule' | 'category', owner: string) { return (await this.read()).examplesOf(kind, owner) }
  async cursors() { return (await this.read()).cursors() }
  async cursor(key: string) { return (await this.read()).cursor(key) }
  async backfills() { return (await this.read()).backfills() }
  async backfill(key: string) { return (await this.read()).backfill(key) }
  async channelState(channel: string) { return (await this.read()).channelState(channel) }
  async topics() { return (await this.read()).topics() }
  async reports() { return (await this.read()).reports() }
  async brief() { return (await this.read()).brief() }
}
