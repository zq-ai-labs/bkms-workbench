/**
 * Demo fixtures: email classification (complaint / inquiry / consultation) and the reply drafts per category.
 * Synthetic data only. Never starts a worker or sends mail. The one mailbox account points at the reserved
 * `.test` domain, which never resolves: it only lets the page load the reply drafts. See docs/DEMO.md.
 */
import { randomUUID } from 'node:crypto'
import { mkdir, lstat, open, readdir, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { WorkbenchRepository } from '../lib/storage/repository.js'
import { validateRule } from '../lib/rules.js'
import { DraftStore } from '../lib/mail/draft-store.js'
import { MailAccounts } from '../lib/mail/accounts.js'
import { DEMO } from './demo-content.mjs'

const arguments_ = process.argv.slice(2)
const flag = name => { const index = arguments_.indexOf(name); return index >= 0 ? arguments_[index + 1] : undefined }
const lang = flag('--lang') ?? 'zh'
if (!flag('--home') || !isAbsolute(flag('--home')) || !DEMO[lang] || arguments_.length !== (arguments_.includes('--lang') ? 4 : 2)) {
  throw new Error('用法：node scripts/seed-demo.mjs --home <新建或完全空的绝对路径> [--lang zh|en]；路径必须包含 runtime/poc/bkms-workbench-demo。')
}
const content = DEMO[lang]
// Drafts are shown only when a mailbox is configured; this placeholder on the reserved `.test` domain cannot connect.
const ACCOUNT = 'service@demo.example.test'

const home = resolve(flag('--home'))
const demoPath = /(?:^|\/)runtime\/poc\/bkms-workbench-demo(?:[\/_-]|$)/i
const checkPath = path => {
  if (!demoPath.test(path.replaceAll('\\', '/'))) throw new Error('只允许 runtime/poc/bkms-workbench-demo 范围的新空目录，已拒绝目标：' + path)
}
checkPath(home)
// Same guard as seed-visual-qa.mjs: resolve the nearest existing ancestor so a junction cannot redirect the path.
let ancestor = home
for (;;) {
  try { await lstat(ancestor); break }
  catch (error) {
    if (error.code !== 'ENOENT' || dirname(ancestor) === ancestor) throw error
    ancestor = dirname(ancestor)
  }
}
checkPath(resolve(await realpath(ancestor), relative(ancestor, home)))
await mkdir(home, { recursive: true, mode: 0o700 })
const actualHome = await realpath(home)
checkPath(actualHome)
if ((await lstat(home)).isSymbolicLink() || (await readdir(home)).length !== 0) throw new Error('演示 HOME 必须是新建或完全空的普通目录。已有文件已保留，请指定另一个新目录。')

const marker = await open(join(home, 'DEMO-SYNTHETIC.json'), 'wx', 0o600)
try {
  await marker.writeFile(JSON.stringify({ purpose: content.marker, language: lang, createdAt: new Date().toISOString(), backgroundEnabled: false, realAccountsConfigured: false, placeholderAccount: ACCOUNT }, null, 2))
  await marker.sync()
} finally { await marker.close() }

const store = new WorkbenchRepository(join(home, 'data', 'bkms-workbench'))
const drafts = new DraftStore(join(home, 'data', 'bkms-workbench', 'mail'), 'drafts')
const endpoint = host => ({ host, port: 465, secure: true })
await new MailAccounts(join(home, 'data', 'bkms-workbench', 'mail')).save({ provider: 'custom', user: ACCOUNT, password: 'demo-placeholder', senderName: content.sender, imap: { ...endpoint('imap.demo.example.test'), port: 993 }, smtp: endpoint('smtp.demo.example.test') }, 0)
const at = minutes => new Date(Date.now() - minutes * 60_000).toISOString()

// One workflow per category. Matched by AI on meaning (`semantic`); replies are always drafts for review.
const rules = {}
for (const [key, spec] of Object.entries(content.rules)) {
  rules[key] = validateRule({
    id: randomUUID(), name: spec.name, enabled: true, priority: { complaint: 300, inquiry: 200, consultation: 100 }[key],
    account: ACCOUNT, folder: 'INBOX', match: { from: '', subject: '', hasAttachments: false, mode: 'all' },
    semantic: spec.semantic, matchMode: 'ai', autonomy: 'draft', instructions: spec.instructions,
    tools: [], skills: [], output: 'reply', maxRetries: 0,
  })
}

const tasks = []
const activity = []
for (const [index, mail] of content.mails.entries()) {
  const rule = mail.rule ? rules[mail.rule] : undefined
  const body = `${mail.body}\n\n${content.tag}`
  const task = {
    id: randomUUID(), revision: 1, title: mail.subject, subject: mail.subject, account: ACCOUNT, status: mail.status, from: mail.from, body,
    receivedAt: at(mail.minutes), updatedAt: at(Math.max(1, mail.minutes - 3)),
    source: { account: ACCOUNT, folder: 'INBOX', uid: index + 1, uidValidity: 1 },
    messageId: `${mail.key}@demo.example.test`, replyTo: mail.from.match(/<([^>]+)>/)?.[1],
    attachments: [], history: [{ at: at(mail.minutes), message: content.marker }], attempts: 1, mailLoaded: true,
    triage: { state: 'done', category: mail.category ?? 'request', urgency: mail.urgency, reason: mail.reason, ...(mail.nextStep ? { nextStep: mail.nextStep } : {}), by: 'ai', at: at(mail.minutes - 1) },
  }
  if (rule) {
    Object.assign(task, { ruleId: rule.id, ruleName: rule.name, rule: structuredClone(rule), summary: mail.summary })
    task.match = { ruleId: rule.id, ruleName: rule.name, by: 'ai', state: 'applied', confidence: mail.confidence, reason: mail.ruleReason, at: at(mail.minutes - 1) }
  } else if (mail.suggested) {
    const suggested = rules[mail.suggested]
    task.match = { ruleId: suggested.id, ruleName: suggested.name, by: 'ai', state: 'suggested', confidence: mail.confidence, reason: mail.ruleReason, at: at(mail.minutes - 1) }
  } else {
    task.triage.archived = true
    activity.push({ id: randomUUID(), at: at(mail.minutes - 1), kind: 'archive', title: mail.subject, detail: mail.reason, taskId: task.id, source: 'email' })
  }
  if (mail.checks) task.checks = mail.checks
  if (mail.gaps) { task.informationGaps = mail.gaps; task.needsInfoKind = 'information'; task.error = mail.gaps.split('\n')[0] }
  if (mail.reply) {
    const draft = await drafts.create({ account: ACCOUNT, to: mail.from, cc: '', subject: `Re: ${mail.subject}`, text: mail.reply }, [], undefined,
      { sourceKey: `demo:${mail.key}`, inReplyTo: task.messageId, references: task.messageId })
    task.draftId = draft.id
  }
  tasks.push(task)
}

const today = new Date(), day = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
await store.write(async tx => {
  await tx.saveConfig({ settings: { enabled: false, pollSeconds: 60 }, rules: Object.values(rules) })
  await tx.setUiLanguage(lang)
  for (const task of tasks) await tx.insertTask(task)
  for (const entry of activity) await tx.addActivity(entry)
  // One learned example per workflow, shown on the 处理方案 page as what AI has learned.
  for (const [key, rule] of Object.entries(rules)) await tx.setExamples('rule', rule.id, [{ id: randomUUID(), match: true, text: content.rules[key].example, at: at(3000) }])
  await tx.setBrief({ date: day, text: content.brief, generatedAt: at(5), by: 'template' })
  await tx.log(content.log)
})
await store.close()
console.log(JSON.stringify({ home: actualHome, language: lang, rules: Object.keys(rules).length, tasks: tasks.length, drafts: tasks.filter(task => task.draftId).length, backgroundEnabled: false }, null, 2))
