import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { build } from 'esbuild'

const bundle = await build({ entryPoints: ['client/preferences.ts'], bundle: true, write: false, platform: 'node', format: 'cjs' })
const module = { exports: {} }
vm.runInNewContext(bundle.outputFiles[0].text, { module, exports: module.exports })
const { TodoTracker } = module.exports

test('reminders establish a silent baseline, deduplicate polls and ignore edits to an existing to-do', () => {
  const tracker = new TodoTracker(), a = { id: 'a', status: 'review' }, b = { id: 'b', status: 'needs_info' }
  assert.equal(tracker.accept(true, [a]), 0)
  assert.equal(tracker.accept(true, [a]), 0)
  assert.equal(tracker.accept(true, [a, b]), 1)
  assert.equal(tracker.accept(true, [{ ...a, revision: 999 }, b]), 0)
  assert.equal(tracker.accept(true, [{ ...a, status: 'failed' }, b]), 1)
  assert.equal(tracker.accept(true, [b]), 0)
  assert.equal(tracker.accept(true, [a, b]), 1)
})

test('turning reminders off and back on never replays existing tasks; fresh connection is also silent', () => {
  const tracker = new TodoTracker(), a = { id: 'a', status: 'review' }, b = { id: 'b', status: 'uncertain' }
  assert.equal(tracker.accept(false, [a]), 0)
  assert.equal(tracker.accept(true, [a, b]), 0)
  assert.equal(tracker.accept(true, [a, b, { id: 'c', status: 'failed' }]), 1)
  assert.equal(tracker.accept(false, []), 0)
  assert.equal(tracker.accept(true, [a, b]), 0)
  assert.equal(new TodoTracker().accept(true, [a, b]), 0)
})
