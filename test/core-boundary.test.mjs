import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * WeChat is becoming an optional channel plugin (docs/DESIGN-CORE-CHANNELS.md). The WeChat channel's own code lives in
 * its channel folders; everywhere else each file's count is a ratchet that can only go down. "企业微信" (WeCom and
 * Tencent Exmail) is a different product and is not counted.
 */
const CHANNEL_DIRS = ['src/channels/wechat/', 'client/channels/wechat/']
const BASELINE = {
  'src/classify.ts': 1,
  'src/index.ts': 4,
  'src/rules.ts': 1,
  'src/types.ts': 3,
  // The page registers the WeChat parts itself until the WeChat plugin does (phase 4).
  'client/index.tsx': 3,
  // Name of a known source, also for a channel that is not installed.
  'client/lib.ts': 1,
}
const WECHAT = /wechat|(?<!企业)微信/i
const root = fileURLToPath(new URL('..', import.meta.url))
const sources = dir => readdirSync(join(root, dir), { recursive: true, withFileTypes: true })
  .filter(entry => entry.isFile() && /\.tsx?$/.test(entry.name))
  .map(entry => join(entry.parentPath ?? entry.path, entry.name).slice(root.length).replaceAll('\\', '/').replace(/^\//, ''))

test('the core gains no new WeChat references (ratchet towards the channel split)', () => {
  const counts = {}
  for (const file of [...sources('src'), ...sources('client')]) {
    if (CHANNEL_DIRS.some(dir => file.startsWith(dir))) continue
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
