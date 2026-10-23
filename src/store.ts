import { now, type Task } from './types.js'

/**
 * Small helpers shared by the engine and the API. Storage itself lives in `src/storage/` (SQLite, docs/DESIGN-CORE-CHANNELS.md).
 */
export const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/

export function touch(task: Task, message: string): void {
  task.revision++; task.updatedAt = now(); task.history.push({ at: task.updatedAt, message }); task.history = task.history.slice(-100)
}
