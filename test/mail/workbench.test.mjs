import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EmailPool } from '../../lib/mail/mail-client.js'
import { resolveEmailSettings } from '../../lib/mail/config.js'
// Ported from dsh-email test/workbench.test.mjs; the service now lives in the workbench's mail module.
import { createEmailWorkbenchService } from '../../lib/mail/service.js'
import { DraftStore } from '../../lib/mail/draft-store.js'
import { EmailDraftBackend } from '../../lib/mail/drafts.js'
import { renderEmailHtml } from '../../lib/mail/email-format.js'

const config = { provider: 'qq', user: 'user@example.test', password: 'test-secret' }
function mailbox(uids = [1, 3, 5]) {
  const calls = [], opens = [], client = { mailbox: { uidValidity: 42 }, async mailboxOpen(folder, options) { opens.push([folder, options]) }, async search(query) { calls.push(query); return uids } }
  const pool = new EmailPool(resolveEmailSettings(config))
  pool.withImap = async (_account, _folder, run) => run(client)
  pool.fetchListed = async (_client, batch) => batch.map(uid => ({ uid, seen: true }))
  return { pool, calls, opens, client }
}

test('incremental polling seeds history then includes already-read new mail in ascending bounded batches', async () => {
  const x = mailbox()
  const baseline = await x.pool.scanChanges('default', '', undefined, 2)
  assert.deepEqual(baseline.cursor, { uidValidity: 42, lastUid: 5 })
  assert.equal(baseline.firstRun, true); assert.deepEqual(baseline.messages, [])
  const batch = await x.pool.scanChanges('default', 'INBOX', { uidValidity: 42, lastUid: 1 }, 2)
  assert.deepEqual(batch.messages.map(m => m.uid), [3, 5]); assert.equal(batch.messages.every(m => m.seen), true)
  assert.equal(batch.cursor.lastUid, 5)
  assert.deepEqual(x.calls[1], { uid: '2:*' })
  const pending = await x.pool.scanChanges('default', 'INBOX', { uidValidity: 42, lastUid: 1 }, 1)
  assert.equal(pending.hasMore, true); assert.equal(pending.cursor.lastUid, 3)
  // bkms-workbench: every scan re-selects the folder, so a pooled connection still sees new mail.
  assert.deepEqual(x.opens, [['INBOX', { readOnly: true }], ['INBOX', { readOnly: true }], ['INBOX', { readOnly: true }]])
})

test('UIDVALIDITY change fails before fetching and never silently advances a persisted cursor', async () => {
  const x = mailbox()
  await assert.rejects(x.pool.scanChanges('default', '', { uidValidity: 41, lastUid: 500 }, 20), error => error.code === 'email-cursor-reset' && error.uidValidity === 42)
  assert.equal(x.calls.length, 0)
})

test('the IMAP N:* quirk cannot regress a cursor when the last mail is older than N', async () => {
  const x = mailbox([8])
  const result = await x.pool.scanChanges('default', '', { uidValidity: 42, lastUid: 9 }, 20)
  assert.equal(result.cursor.lastUid, 9); assert.deepEqual(result.messages, [])
})

test('workbench folder catalog uses the account list API and excludes non-selectable containers', async () => {
  const x = mailbox(), calls = [], pool = x.pool, folders = pool.folders.bind(pool)
  x.client.list = async () => [{ path: 'INBOX', name: '收件箱', flags: new Set() }, { path: '客户/询价', name: '询价', flags: new Set() }, { path: '容器', name: '容器', flags: new Set(['\\Noselect']) }]
  pool.folders = async (account, subscribedOnly, signal) => { calls.push({ account, subscribedOnly, signal }); return folders(account, subscribedOnly, signal) }
  const service = createEmailWorkbenchService({ getPool: () => pool }, {}), signal = new AbortController().signal
  const result = await service.folders('default', signal)
  assert.deepEqual(result.folders.map(folder => folder.path), ['INBOX', '客户/询价'])
  assert.deepEqual(calls, [{ account: 'default', subscribedOnly: false, signal }])
})

test('unusable mailbox identity and malformed persisted cursor fail safely', async () => {
  const x = mailbox(); x.client.mailbox.uidValidity = 0
  await assert.rejects(x.pool.scanChanges('default', '', undefined, 20), /UIDVALIDITY/)
  await assert.rejects(x.pool.scanChanges('default', '', { uidValidity: 42, lastUid: -2 }, 20), /游标无效/)
})

test('workbench reads preserve reply recipients, identifiers and mailbox generation', async () => {
  const x = mailbox()
  x.pool.read = async () => ({ account: 'default', folder: 'INBOX', uid: 5, subject: 'Test', text: 'Body' })
  x.client.fetchOne = async () => ({ headers: Buffer.from('Message-ID: <source@example.test>\r\nReferences: <parent@example.test>\r\n'), envelope: { replyTo: [{ name: 'Service desk', address: 'reply@example.test' }] } })
  const body = await x.pool.readForWorkbench('default', 'INBOX', 5)
  assert.equal(body.uidValidity, 42); assert.equal(body.messageId, 'source@example.test')
  assert.equal(body.references, 'parent@example.test'); assert.equal(body.replyTo[0].address, 'reply@example.test')
})

test('workbench display reads only the HTML MIME part, preserves plain text and tolerates missing or oversized HTML', async () => {
  const x = mailbox(), calls = []
  const plain = { account: 'default', folder: 'INBOX', uid: 5, subject: 'Synthetic', text: 'Agent plain text', to: [{ name: 'Demo', address: 'demo@example.test' }], date: '2026-10-15T05:35:00.000Z' }
  x.pool.read = async () => structuredClone(plain)
  x.client.fetchOne = async (_uid, query) => {
    assert.equal(query.source, undefined, 'must not download the whole message including attachments')
    return { size: 600000, bodyStructure: { type: 'multipart/mixed', childNodes: [
      { type: 'text/html', part: '1' }, { type: 'application/pdf', part: '2', disposition: 'attachment' },
    ] } }
  }
  let html = '<table><tr><td>Candidate demo</td></tr></table>'
  x.client.download = async (uid, part, options) => { calls.push({ uid, part, options }); return { content: Readable.from([Buffer.from(html)]) } }
  const rich = await x.pool.readForWorkbench('default', 'INBOX', 5)
  assert.equal(rich.bodyHtml, html); assert.equal(rich.text, plain.text); assert.equal(rich.size, 600000)
  assert.deepEqual(rich.to, plain.to); assert.equal(rich.date, plain.date)
  assert.equal(calls[0].part, '1'); assert.equal(calls[0].options.maxBytes, 256 * 1024 + 1)
  html = '中'.repeat(90000)
  assert.equal((await x.pool.readForWorkbench('default', 'INBOX', 5)).bodyHtml, undefined)
  x.client.download = async () => { throw Error('HTML part unavailable') }
  assert.equal((await x.pool.readForWorkbench('default', 'INBOX', 5)).text, plain.text)
  const controller = new AbortController()
  x.client.download = async () => { controller.abort(Error('Cancelled HTML read')); throw Error('aborted') }
  await assert.rejects(x.pool.readForWorkbench('default', 'INBOX', 5, controller.signal), /Cancelled HTML read/)
})

test('attachment download checks expected generation on its actual connection before fetching bytes', async () => {
  const x = mailbox()
  let indexed = 0
  x.pool.attachmentIndexOf = async () => { indexed++; throw Error('must not fetch a reassigned UID') }
  x.client.mailbox.uidValidity = 99
  await assert.rejects(x.pool.downloadAttachment('default', 'INBOX', 5, 0, undefined, undefined, 42), error => error.code === 'email-cursor-reset' && error.uidValidity === 99)
  assert.equal(indexed, 0)
  await assert.rejects(x.pool.downloadAttachment('default', 'INBOX', 5, 0, undefined, undefined, -1), /代际标识无效/)
})

test('attachment downloads retain compatible behavior when expected generation matches or is omitted', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-email-generation-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const x = mailbox(), part = { filename: 'sample.txt', size: 6, contentType: 'text/plain', part: '2' }
  x.pool.attachmentIndexOf = async () => ({ attachments: [part], parts: [part] })
  x.client.download = async () => ({ meta: { filename: 'sample.txt' }, content: Readable.from([Buffer.from('sample')]) })
  const verified = await x.pool.downloadAttachment('default', 'INBOX', 5, 0, root, undefined, 42)
  const legacy = await x.pool.downloadAttachment('default', 'INBOX', 5, 0, root)
  assert.equal(await readFile(verified.path, 'utf8'), 'sample'); assert.equal(await readFile(legacy.path, 'utf8'), 'sample')
  assert.notEqual(verified.path, legacy.path)
})

test('the workbench bridge forwards the expected generation to the shared pool without opening another connection', async () => {
  let args
  const service = createEmailWorkbenchService({ getPool: () => ({ async downloadAttachment(...values) { args = values; return { path: 'synthetic' } } }) }, {})
  const signal = new AbortController().signal
  await service.downloadAttachment('default', 'INBOX', 5, 0, 'workspace', signal, 42)
  assert.deepEqual(args, ['default', 'INBOX', 5, 0, 'workspace', signal, 42])
})

async function serviceFixture(t, failure) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-email-workbench-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const sends = [], settings = resolveEmailSettings(config), value = { trustedRecipientsYaml: '', sendApproval: true }
  const runtime = { getEffectiveSettings: () => settings, getSettingsValue: () => value, getPool: () => ({ async sendPrepared(...args) { sends.push(args); if (failure) throw Error('synthetic timeout'); return { account: 'default', accepted: ['alice@example.test'], rejected: [], messageId: 'reply@example.test', response: '250 accepted' } } }) }
  const backend = new EmailDraftBackend(runtime, { store: new DraftStore(home) })
  return { service: createEmailWorkbenchService(runtime, backend), backend, sends }
}
const fields = { account: 'default', to: 'alice@example.test', subject: 'Re: test', text: 'Reviewed reply', inReplyTo: 'source@example.test', references: 'parent@example.test source@example.test' }

test('shared service never exposes account credentials and reply headers survive storage, editing and exact-revision approval', async t => {
  const x = await serviceFixture(t)
  assert.deepEqual(x.service.accounts(), [{ id: 'default', address: config.user, inboxFolder: 'INBOX' }])
  const draft = await x.service.drafts.create(fields)
  const edited = await x.service.drafts.update(draft.id, draft.revision, { ...fields, text: 'User edited' })
  assert.equal(edited.inReplyTo, fields.inReplyTo)
  const plan = await x.service.drafts.preview(edited.id, edited.revision)
  assert.equal(plan.bodyFormat, 'standard-v1')
  assert.equal(plan.bodyHtml, renderEmailHtml(edited.text))
  await assert.rejects(x.service.drafts.send(edited.id, plan.id, false), /明确点击发送/)
  const sent = await x.service.drafts.send(edited.id, plan.id, true)
  assert.equal(sent.draft.state, 'sent'); assert.equal(x.sends[0][3], 'User edited')
  assert.deepEqual(x.sends[0][7], { inReplyTo: fields.inReplyTo, references: fields.references })
  assert.equal((await x.service.drafts.send(edited.id, plan.id, true)).draft.state, 'sent')
  assert.equal(x.sends.length, 1)
})

test('SMTP ambiguity is persisted and repeated confirmed action does not submit twice', async t => {
  const x = await serviceFixture(t, true), draft = await x.service.drafts.create(fields), plan = await x.service.drafts.preview(draft.id, draft.revision)
  assert.equal((await x.service.drafts.send(draft.id, plan.id, true)).draft.state, 'uncertain')
  assert.equal((await x.service.drafts.send(draft.id, plan.id, true)).draft.state, 'uncertain')
  assert.equal(x.sends.length, 1)
  const current = await x.service.drafts.get(draft.id)
  await assert.rejects(x.service.drafts.resolveSend(draft.id, current.revision, 'not_sent', false), /核对邮箱/)
  const restored = await x.service.drafts.resolveSend(draft.id, current.revision, 'not_sent', true)
  assert.equal(restored.state, 'draft'); assert.equal(restored.id, draft.id)
  assert.equal(x.sends.length, 1)
})

test('threading metadata rejects header injection and stale reviewed drafts cannot be submitted', async t => {
  const x = await serviceFixture(t)
  await assert.rejects(x.service.drafts.create({ ...fields, inReplyTo: 'source@example.test\r\nBcc: attacker@example.test' }), /回复标识无效/)
  const draft = await x.service.drafts.create(fields), plan = await x.service.drafts.preview(draft.id, draft.revision)
  await x.service.drafts.update(draft.id, draft.revision, { ...fields, text: 'Changed after review' })
  await assert.rejects(x.service.drafts.send(draft.id, plan.id, true), /预览已过期|已改变/)
  assert.equal(x.sends.length, 0)
})

test('SMTP prepared messages serialize reply references as RFC message identifiers', async () => {
  const x = mailbox(); let submitted
  x.pool.sendMail = async (_name, _cfg, input) => { submitted = input; return {} }
  await x.pool.sendPrepared('default', fields.to, fields.subject, fields.text, '', [], undefined, { inReplyTo: fields.inReplyTo, references: fields.references })
  assert.equal(submitted.inReplyTo, '<source@example.test>')
  assert.deepEqual(submitted.references, ['<parent@example.test>', '<source@example.test>'])
})

test('a stable source key recovers a created draft after a crash and prevents concurrent duplicates', async t => {
  const x = await serviceFixture(t)
  const [one, two] = await Promise.all([x.service.drafts.create({ ...fields, sourceKey: 'workbench:task:attempt-1' }), x.service.drafts.create({ ...fields, sourceKey: 'workbench:task:attempt-1' })])
  assert.equal(one.id, two.id); assert.equal((await x.backend.store.list()).length, 1)
  const next = await x.service.drafts.create({ ...fields, sourceKey: 'workbench:task:attempt-2' })
  assert.notEqual(next.id, one.id)
  await assert.rejects(x.service.drafts.create({ ...fields, sourceKey: '\ninvalid' }), /来源标识无效/)
})
