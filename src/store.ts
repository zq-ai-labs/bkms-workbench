import { WorkbenchError, now, type Task } from './types.js'

/**
 * Small helpers shared by the engine and the API. Storage itself lives in `src/storage/` (SQLite, docs/DESIGN-CORE-CHANNELS.md).
 */
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

export function touch(task: Task, message: string): void {
  task.revision++; task.updatedAt = now(); task.history.push({ at: task.updatedAt, message }); task.history = task.history.slice(-100)
}
