import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { WorkbenchRepository } from '../lib/storage/repository.js'
import { stateOf, setSettings, editRules, editTask, editTasks, readFresh } from './helpers.mjs'
import { DEMO } from '../scripts/demo-content.mjs'

const run = promisify(execFile)

test('demo content is parallel in Chinese and English', () => {
  const shape = lang => DEMO[lang].mails.map(({ key, rule, suggested, status, category, urgency, confidence, reply, checks, gaps }) => ({ key, rule, suggested, status, category, urgency, confidence, reply: !!reply, checks: checks?.length, gaps: !!gaps }))
  assert.deepEqual(shape('en'), shape('zh'))
  assert.deepEqual(Object.keys(DEMO.en.rules), Object.keys(DEMO.zh.rules))
  // Every check quotes text that is really in its draft, so the page can highlight it.
  for (const lang of ['zh', 'en']) for (const mail of DEMO[lang].mails) for (const check of mail.checks ?? []) assert.ok(mail.reply.includes(check.quote), `${lang}/${mail.key}: ${check.quote}`)
})

for (const lang of ['zh', 'en']) test(`seed-demo creates a readable ${lang} workbench with one draft per reviewed email`, async t => {
  const root = await mkdtemp(join(tmpdir(), 'bkw-demo-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const home = join(root, 'runtime', 'poc', 'bkms-workbench-demo-' + lang)
  await run(process.execPath, ['scripts/seed-demo.mjs', '--home', home, '--lang', lang])
  const state = await readFresh(join(home, 'data', 'bkms-workbench'))
  assert.equal(state.uiLanguage, lang)
  assert.equal(state.settings.enabled, false)
  assert.deepEqual(state.rules.map(rule => rule.name), Object.values(DEMO[lang].rules).map(rule => rule.name))
  assert.equal(state.tasks.filter(task => task.draftId).length, DEMO[lang].mails.filter(mail => mail.reply).length)
  assert.ok(!(await readFile(join(home, 'data', 'bkms-workbench', 'workbench.sqlite'))).includes('demo-placeholder'), 'the placeholder password stays in the mail account file')
  await assert.rejects(run(process.execPath, ['scripts/seed-demo.mjs', '--home', join(root, 'elsewhere'), '--lang', lang]))
})
