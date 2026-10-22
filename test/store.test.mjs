import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { rename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store, replaceFile } from '../lib/store.js'

const locked = code => Object.assign(new Error(`${code}: operation not permitted, rename`), { code })
const noWait = async () => {}

test('replacing the data file retries while Windows holds it, then succeeds', async () => {
  const calls = [], waits = []
  let failures = 3
  await replaceFile('a.tmp', 'workbench-v1.json', async (from, to) => { calls.push([from, to]); if (failures-- > 0) throw locked(['EPERM', 'EACCES', 'EBUSY'][failures % 3]) }, async ms => { waits.push(ms) })
  assert.equal(calls.length, 4)
  assert.deepEqual(waits, [50, 100, 150])
})

test('a lock that does not go away fails the write with a clear message; other errors are not retried', async () => {
  let calls = 0
  await assert.rejects(replaceFile('a.tmp', 'b.json', async () => { calls++; throw locked('EPERM') }, noWait), error => error.code === 'storage-busy' && /被其他程序占用/.test(error.message))
  assert.equal(calls, 10)
  calls = 0
  await assert.rejects(replaceFile('a.tmp', 'b.json', async () => { calls++; throw locked('ENOSPC') }, noWait), /ENOSPC/)
  assert.equal(calls, 1, 'a full disk is not a lock')
})

test('the store saves through a briefly locked file and keeps the old data when the lock stays', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bkms-store-'))
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5 }))
  const store = new Store(root)
  await store.mutate(state => { state.settings.pollSeconds = 120 })
  // Locked for the first two attempts, as antivirus scanning the file would.
  let busy = 2
  store.replace = (source, target) => replaceFile(source, target, async (from, to) => { if (busy-- > 0) throw locked('EPERM'); await rename(from, to) }, noWait)
  await store.mutate(state => { state.settings.pollSeconds = 300 })
  assert.equal((await store.read()).settings.pollSeconds, 300)
  // Locked for good: the change is refused, the previous data stays, no temporary file is left behind.
  store.replace = (source, target) => replaceFile(source, target, async () => { throw locked('EPERM') }, noWait)
  await assert.rejects(store.mutate(state => { state.settings.pollSeconds = 600 }), error => error.code === 'storage-busy')
  assert.equal((await store.read()).settings.pollSeconds, 300)
  assert.deepEqual((await readdir(root)).filter(name => name.endsWith('.tmp')), [])
})
