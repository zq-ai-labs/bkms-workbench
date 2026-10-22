import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * WeChat is becoming an optional channel plugin (docs/DESIGN-CORE-CHANNELS.md). Until the split is done, the core
 * may not gain new WeChat references: each file's count is a ratchet that can only go down. "企业微信" (WeCom and
 * Tencent Exmail) is a different product and is not counted.
 */
const CHANNEL_FILES = new Set(['src/wechat.ts', 'client/wechat.tsx'])
const BASELINE = {
  'src/agent.ts': 3,
  'src/api.ts': 28,
  'src/classify.ts': 1,
  'src/digest.ts': 6,
  'src/engine.ts': 85,
  'src/index.ts': 5,
  'src/rules.ts': 4,
  'src/sources.ts': 3,
  'src/store.ts': 2,
  'src/triage.ts': 1,
  'src/types.ts': 31,
  'client/lib.ts': 17,
  'client/plans.tsx': 2,
  'client/settings.tsx': 5,
  'client/store.ts': 2,
  'client/views.tsx': 4,
  'client/workspace.tsx': 21,
}
const WECHAT = /wechat|(?<!企业)微信/i
const root = fileURLToPath(new URL('..', import.meta.url))
const sources = dir => readdirSync(join(root, dir), { recursive: true, withFileTypes: true })
  .filter(entry => entry.isFile() && /\.tsx?$/.test(entry.name))
  .map(entry => join(entry.parentPath ?? entry.path, entry.name).slice(root.length).replaceAll('\\', '/').replace(/^\//, ''))

test('the core gains no new WeChat references (ratchet towards the channel split)', () => {
  const counts = {}
  for (const file of [...sources('src'), ...sources('client')]) {
    if (CHANNEL_FILES.has(file)) continue
    const lines = readFileSync(join(root, file), 'utf8').split(/\r?\n/).filter(line => WECHAT.test(line)).length
    if (lines) counts[file] = lines
  }
  const problems = []
  for (const [file, lines] of Object.entries(counts)) {
    const allowed = BASELINE[file] ?? 0
    if (lines > allowed) problems.push(`${file}: ${lines} WeChat lines, at most ${allowed}. Put WeChat logic in the WeChat channel instead.`)
    if (lines < allowed) problems.push(`${file}: down to ${lines} WeChat lines. Lower its baseline in test/core-boundary.test.mjs to ${lines}.`)
  }
  for (const file of Object.keys(BASELINE)) if (!counts[file]) problems.push(`${file}: no WeChat lines left. Remove it from the baseline in test/core-boundary.test.mjs.`)
  assert.deepEqual(problems, [])
})
