import { sql, type Generated, type Kysely, type Migration } from 'zq-sqlite'

/**
 * Workbench database (docs/DESIGN-CORE-CHANNELS.md §5.5). Every table starts with `user_id`; the local plugin always
 * uses `'local'`. Columns hold what is queried; the rest of a record is JSON in `data`, so new optional fields need no
 * schema change. Shipped migrations are never edited: add a new one.
 */
export interface WorkbenchTable { user_id: string; change_seq: number; config_revision: number; settings: string; ui_language: string | null; brief: string | null }
export interface OrderedTable { user_id: string; id: string; position: number; data: string }
export interface ExampleTable { user_id: string; kind: 'rule' | 'category'; owner: string; id: string; position: number; data: string }
export interface TaskTable {
  seq: Generated<number>; user_id: string; id: string; revision: number; changed_seq: number
  /** Where the item came from and its key there, unique together: duplicate mail is never added twice. */
  channel: string; scope: string; item_key: string
  status: string; attention: number; received_at: string; updated_at: string
  rule_id: string | null; message_id: string | null; next_attempt_at: string | null; auto_send_at: string | null
  body: string; data: string
}
export interface KeyedTable { user_id: string; channel: string; key: string; value: string }
export interface ContactTable { user_id: string; key: string; value: string }
export interface LogTable { seq: Generated<number>; user_id: string; id: string; at: string; level: string; task_id: string | null; message: string }
export interface ActivityTable { seq: Generated<number>; user_id: string; id: string; at: string; kind: string; task_id: string | null; undone_at: string | null; data: string }
export interface ReportTable { seq: Generated<number>; user_id: string; id: string; kind: string; topic_id: string | null; period_start: string; data: string }
export interface Database {
  workbench: WorkbenchTable
  rules: OrderedTable
  classifiers: OrderedTable
  topics: OrderedTable
  examples: ExampleTable
  tasks: TaskTable
  cursors: KeyedTable
  channel_state: KeyedTable
  contacts: ContactTable
  logs: LogTable
  activity: ActivityTable
  reports: ReportTable
}

export const migrations: Record<string, Migration> = {
  '0001-initial': {
    async up(db: Kysely<any>) {
      await db.schema.createTable('workbench')
        .addColumn('user_id', 'text', c => c.primaryKey())
        .addColumn('change_seq', 'integer', c => c.notNull())
        .addColumn('config_revision', 'integer', c => c.notNull())
        .addColumn('settings', 'text', c => c.notNull())
        .addColumn('ui_language', 'text')
        .addColumn('brief', 'text')
        .execute()
      for (const table of ['rules', 'classifiers', 'topics']) {
        await db.schema.createTable(table)
          .addColumn('user_id', 'text', c => c.notNull()).addColumn('id', 'text', c => c.notNull())
          .addColumn('position', 'integer', c => c.notNull()).addColumn('data', 'text', c => c.notNull())
          .addPrimaryKeyConstraint(`${table}_pk`, ['user_id', 'id'])
          .execute()
      }
      await db.schema.createTable('examples')
        .addColumn('user_id', 'text', c => c.notNull()).addColumn('kind', 'text', c => c.notNull())
        .addColumn('owner', 'text', c => c.notNull()).addColumn('id', 'text', c => c.notNull())
        .addColumn('position', 'integer', c => c.notNull()).addColumn('data', 'text', c => c.notNull())
        .addPrimaryKeyConstraint('examples_pk', ['user_id', 'kind', 'owner', 'id'])
        .execute()
      await db.schema.createTable('tasks')
        .addColumn('seq', 'integer', c => c.primaryKey().autoIncrement())
        .addColumn('user_id', 'text', c => c.notNull()).addColumn('id', 'text', c => c.notNull())
        .addColumn('revision', 'integer', c => c.notNull()).addColumn('changed_seq', 'integer', c => c.notNull())
        .addColumn('channel', 'text', c => c.notNull()).addColumn('scope', 'text', c => c.notNull()).addColumn('item_key', 'text', c => c.notNull())
        .addColumn('status', 'text', c => c.notNull()).addColumn('attention', 'integer', c => c.notNull())
        .addColumn('received_at', 'text', c => c.notNull()).addColumn('updated_at', 'text', c => c.notNull())
        .addColumn('rule_id', 'text').addColumn('message_id', 'text').addColumn('next_attempt_at', 'text').addColumn('auto_send_at', 'text')
        .addColumn('body', 'text', c => c.notNull()).addColumn('data', 'text', c => c.notNull())
        .addUniqueConstraint('tasks_identity', ['user_id', 'id'])
        .addUniqueConstraint('tasks_source', ['user_id', 'channel', 'scope', 'item_key'])
        .execute()
      await db.schema.createIndex('tasks_queue').on('tasks').columns(['user_id', 'status', 'next_attempt_at']).execute()
      await db.schema.createIndex('tasks_message').on('tasks').columns(['user_id', 'message_id']).where(sql.ref('message_id'), 'is not', null).execute()
      await db.schema.createIndex('tasks_attention').on('tasks').columns(['user_id', 'seq']).where(sql.ref('attention'), '=', 1).execute()
      await db.schema.createIndex('tasks_auto_send').on('tasks').columns(['user_id', 'auto_send_at']).where(sql.ref('auto_send_at'), 'is not', null).execute()
      for (const table of ['cursors', 'channel_state']) {
        await db.schema.createTable(table)
          .addColumn('user_id', 'text', c => c.notNull()).addColumn('channel', 'text', c => c.notNull())
          .addColumn('key', 'text', c => c.notNull()).addColumn('value', 'text', c => c.notNull())
          .addPrimaryKeyConstraint(`${table}_pk`, ['user_id', 'channel', 'key'])
          .execute()
      }
      await db.schema.createTable('contacts')
        .addColumn('user_id', 'text', c => c.notNull()).addColumn('key', 'text', c => c.notNull()).addColumn('value', 'text', c => c.notNull())
        .addPrimaryKeyConstraint('contacts_pk', ['user_id', 'key'])
        .execute()
      await db.schema.createTable('logs')
        .addColumn('seq', 'integer', c => c.primaryKey().autoIncrement())
        .addColumn('user_id', 'text', c => c.notNull()).addColumn('id', 'text', c => c.notNull())
        .addColumn('at', 'text', c => c.notNull()).addColumn('level', 'text', c => c.notNull())
        .addColumn('task_id', 'text').addColumn('message', 'text', c => c.notNull())
        .execute()
      await db.schema.createIndex('logs_user').on('logs').columns(['user_id', 'seq']).execute()
      await db.schema.createTable('activity')
        .addColumn('seq', 'integer', c => c.primaryKey().autoIncrement())
        .addColumn('user_id', 'text', c => c.notNull()).addColumn('id', 'text', c => c.notNull())
        .addColumn('at', 'text', c => c.notNull()).addColumn('kind', 'text', c => c.notNull())
        .addColumn('task_id', 'text').addColumn('undone_at', 'text').addColumn('data', 'text', c => c.notNull())
        .addUniqueConstraint('activity_identity', ['user_id', 'id'])
        .execute()
      await db.schema.createIndex('activity_task').on('activity').columns(['user_id', 'task_id']).execute()
      await db.schema.createTable('reports')
        .addColumn('seq', 'integer', c => c.primaryKey().autoIncrement())
        .addColumn('user_id', 'text', c => c.notNull()).addColumn('id', 'text', c => c.notNull())
        .addColumn('kind', 'text', c => c.notNull()).addColumn('topic_id', 'text').addColumn('period_start', 'text', c => c.notNull())
        .addColumn('data', 'text', c => c.notNull())
        .addUniqueConstraint('reports_identity', ['user_id', 'id'])
        .execute()
    },
  },
}
