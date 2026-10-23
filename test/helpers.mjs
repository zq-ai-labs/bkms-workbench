/**
 * Test helpers over the workbench repository (SQLite). `stateOf` assembles a read-only view in the shape of the former
 * workbench-v1.json document, so assertions can stay readable; changes always go through the repository.
 */
/** The former document left empty records out; so does this view. */
const present = async value => { const record = await value; return Object.keys(record).length ? record : undefined }
const wechatOf = async repo => { const { cursors, entries } = await repo.channelState('wechat'); return { watermarks: cursors, pending: entries } }
export async function stateOf(repo) {
  const config = await repo.config()
  return {
    version: 1, revision: await repo.changeSeq(), configRevision: config.revision, settings: config.settings, rules: config.rules,
    classifiers: config.classifiers, uiLanguage: config.uiLanguage,
    tasks: await repo.tasks(), cursors: await repo.cursors(), backfills: await present(repo.backfills()), wechat: await wechatOf(repo),
    logs: await repo.logs(), activity: await repo.activity(), topics: await repo.topics(), reports: await repo.reports(), brief: await repo.brief(),
    senders: await repo.contacts(), ruleExamples: await repo.examples('rule'), categoryExamples: await repo.examples('category'),
  }
}
/** Change saved settings directly, the way an older page or a test setup would. */
export const setSettings = (repo, patch) => repo.write(async tx => { await tx.saveConfig({ settings: { ...(await tx.config()).settings, ...patch } }) })
/** Change saved workflows in place. */
export const editRules = (repo, change) => repo.write(async tx => { const { rules } = await tx.config(); change(rules); await tx.saveConfig({ rules }) })
/** Change one task, picked by arrival index or a predicate. */
export async function editTask(repo, pick, change) {
  const tasks = await repo.tasks(), task = typeof pick === 'number' ? tasks[pick] : tasks.find(pick)
  if (!task) throw new Error('no such task')
  return repo.updateTask(task.id, undefined, change)
}
/** Change every task. */
export async function editTasks(repo, change) {
  for (const task of await repo.tasks()) await repo.updateTask(task.id, undefined, change)
}
/** Read a workbench folder with a repository of its own, closed afterwards (Windows keeps open files). */
export async function readFresh(root) {
  const { WorkbenchRepository } = await import('../lib/storage/repository.js')
  const repo = new WorkbenchRepository(root)
  try { return await stateOf(repo) } finally { await repo.close() }
}
