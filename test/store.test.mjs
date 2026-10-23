import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkbenchRepository } from '../lib/storage/repository.js'
import { Engine } from '../lib/engine.js'

async function repository(t) {
  const root = await mkdtemp(join(tmpdir(), 'bkms-store-'))
  const repo = new WorkbenchRepository(root)
  t.after(async () => { await repo.close(); await rm(root, { recursive: true, force: true, maxRetries: 5 }) })
  return { root, repo }
}
const task = (uid, extra = {}) => {
  const at = new Date().toISOString()
  return { id: randomUUID(), revision: 1, title: `邮件 ${uid}`, account: 'sales', status: 'unmatched', from: 'buyer@example.test', subject: `邮件 ${uid}`, body: '正文', receivedAt: at, updatedAt: at, source: { account: 'sales', folder: 'INBOX', uid, uidValidity: 7 }, attachments: [], history: [], attempts: 0, ...extra }
}

test('the workbench keeps its data in workbench.sqlite and across reopening', async t => {
  const { root, repo } = await repository(t)
  const first = task(11)
  await repo.write(tx => tx.insertTask(first))
  await repo.close()
  assert.ok((await readdir(root)).includes('workbench.sqlite'))
  const again = new WorkbenchRepository(root)
  try {
    assert.deepEqual((await again.tasks()).map(item => item.id), [first.id])
    assert.equal((await again.task(first.id)).body, '正文')
  } finally { await again.close() }
})

test('a write is all or nothing', async t => {
  const { repo } = await repository(t)
  await assert.rejects(repo.write(async tx => { await tx.insertTask(task(11)); await tx.log('写到一半'); throw new Error('中途失败') }), /中途失败/)
  assert.deepEqual(await repo.tasks(), [])
  assert.deepEqual(await repo.logs(), [])
})

test('the same message is added once; task revisions are checked', async t => {
  const { repo } = await repository(t)
  const first = task(11)
  assert.equal(await repo.write(tx => tx.insertTask(first)), true)
  assert.equal(await repo.write(tx => tx.insertTask(task(11))), false, 'same folder, generation and UID')
  assert.equal(await repo.write(tx => tx.insertTask(task(11, { source: { account: 'sales', folder: 'INBOX', uid: 11, uidValidity: 8 } }))), true, 'a new mailbox generation is a different message')
  await assert.rejects(repo.task(first.id, 2), error => error.code === 'conflict')
  await assert.rejects(repo.task('missing'), error => error.code === 'missing')
  await repo.updateTask(first.id, 1, item => { item.revision++; item.status = 'review' })
  assert.equal((await repo.task(first.id, 2)).status, 'review')
  assert.deepEqual(await repo.attention(), [{ id: first.id, status: 'review' }])
})

test('the change sequence moves on every write and an idle background never writes', async t => {
  const { repo } = await repository(t)
  const email = { version: 1, accounts: () => [{ id: 'sales', address: 'sales@example.test', inboxFolder: 'INBOX' }], async scan({ cursor }) { return { cursor: { uidValidity: 7, lastUid: 10 }, messages: [], firstRun: !cursor, reset: false, hasMore: false } }, drafts: {} }
  const engine = new Engine(repo, () => email, { available: () => true, async run() { throw new Error('unused') } })
  await engine.start()
  t.after(() => engine.stop())
  await engine.poll()
  const settled = await repo.changeSeq()
  await repo.config(); await repo.tasks(); await repo.logs()
  for (let i = 0; i < 3; i++) { await engine.poll(); await engine.processNext(); await engine.sendDue() }
  assert.equal(await repo.changeSeq(), settled, 'reads, empty polls and an empty queue write nothing')
  await repo.write(tx => tx.log('一次修改'))
  assert.equal(await repo.changeSeq(), settled + 1)
})

test('logs and activity keep the latest 1000 entries, reports the latest 200', async t => {
  const { repo } = await repository(t)
  await repo.write(async tx => {
    for (let i = 0; i < 1005; i++) await tx.log(`记录 ${i}`)
    for (let i = 0; i < 1003; i++) await tx.addActivity({ id: randomUUID(), at: new Date().toISOString(), kind: 'archive', title: `归档 ${i}` })
    for (let i = 0; i < 205; i++) await tx.addReport({ id: randomUUID(), kind: 'weekly', title: `周报 ${i}`, text: '', periodStart: '2026-10-19', periodEnd: '2026-10-25', generatedAt: '', updatedAt: '', by: 'template' })
  })
  const logs = await repo.logs(), activity = await repo.activity(), reports = await repo.reports()
  assert.equal(logs.length, 1000); assert.equal(logs[0].message, '记录 5'); assert.equal(logs.at(-1).message, '记录 1004')
  assert.equal(activity.length, 1000); assert.equal(activity[0].title, '归档 3')
  assert.equal(reports.length, 200); assert.equal(reports[0].title, '周报 5')
})

test('configuration saves bump the configuration revision; stale saves conflict', async t => {
  const { repo } = await repository(t)
  assert.equal((await repo.config()).revision, 1)
  await assert.rejects(repo.checkConfig(2), error => error.code === 'conflict')
  const revision = await repo.write(async tx => { await tx.checkConfig(1); return tx.saveConfig({ settings: { ...(await tx.config()).settings, pollSeconds: 120 } }) })
  assert.equal(revision, 2)
  assert.equal((await repo.config()).settings.pollSeconds, 120)
  await repo.write(tx => tx.setUiLanguage('en'))
  assert.equal((await repo.config()).revision, 2, 'the interface language is not configuration')
  assert.equal((await repo.config()).uiLanguage, 'en')
})
