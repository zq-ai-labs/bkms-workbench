import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, stat, rm, mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { DraftStore, draftFields } from '../../lib/mail/draft-store.js'
// Ported from dsh-email test/drafts.test.mjs. Recipient rules now come from the resolved settings; the chat draft tool,
// the settings-page rule editor and the plugin route installer are not part of the workbench.
import { EmailDraftBackend, EMAIL_DRAFT_ROUTE, DRAFT_HEADER } from '../../lib/mail/drafts.js'
import { resolveEmailSettings } from '../../lib/mail/config.js'
import { createServer } from 'node:net'
import { EmailPool } from '../../lib/mail/mail-client.js'

async function setup(t, sender) {
  const home = await mkdtemp(join(import.meta.dirname, '.draft-fixture-'))
  t.after(async () => { assert.equal(dirname(home), import.meta.dirname); await rm(home, { recursive: true, force: true }) })
  const config = { user: 'sender@example.test', password: 'synthetic-secret', senderName: '合成测试', imap: { host: '127.0.0.1' }, smtp: { host: '127.0.0.1' } }, value = { sendApproval: true, trustedRecipientsYaml: '' }, sends = []
  const runtime = { getEffectiveSettings: () => resolveEmailSettings({ ...config, trustedRecipientsYaml: value.trustedRecipientsYaml }), getPool: () => ({ async sendPrepared(...args) { sends.push(args); if (sender) return sender(...args); return { account: args[0], messageId: '<synthetic@example.test>', accepted: ['alice@example.test'], rejected: [], response: '250 accepted' } } }) }
  let now = Date.now()
  const store = new DraftStore(home), backend = new EmailDraftBackend(runtime, { store, now: () => now })
  return { home, store, backend, config, value, sends, runtime, tick: ms => { now += ms }, fields: { account: 'default', to: 'Alice <alice@example.test>', cc: 'bob@example.test', subject: '测试草稿', text: '纯文本内容' }, request: (body, headers = {}, signal) => backend.fetch(new Request('http://127.0.0.1' + EMAIL_DRAFT_ROUTE, { method: 'POST', headers: { 'content-type': 'application/json', [DRAFT_HEADER]: '1', ...headers }, body: JSON.stringify(body), signal })) }
}
test('corrupt local data is preserved rather than silently replaced', async t => {
  const x = await setup(t), file = join(x.home, 'data/dsh-email/drafts-v1.json'); await mkdir(dirname(file), { recursive: true }); await writeFile(file, '{broken')
  await assert.rejects(x.store.create(x.fields), /已保留原文件/); assert.equal(await readFile(file, 'utf8'), '{broken')
})
test('separate stores serialize writes and stale revisions cannot overwrite user edits', async t => {
  const x = await setup(t), other = new DraftStore(x.home)
  const created = await Promise.all([x.store.create(x.fields), other.create({ ...x.fields, subject: '另一份' })]); assert.equal((await other.list()).length, 2)
  await x.store.change(created[0].id, 1, draft => { draft.subject = '已修改' })
  await assert.rejects(other.change(created[0].id, 1, draft => { draft.subject = '旧值' }), error => error.code === 'draft-conflict')
  assert.equal((await other.get(created[0].id)).subject, '已修改')
})
test('editing, cancellation and unconfirmed sends perform zero SMTP submissions', async t => {
  const x = await setup(t), draft = await x.backend.create(x.fields), edited = await x.backend.action({ ...x.fields, action: 'update', id: draft.id, revision: 1, text: '编辑后的正文' })
  const plan = await x.backend.action({ action: 'preview', id: draft.id, revision: edited.revision })
  await assert.rejects(x.backend.action({ action: 'send', id: draft.id, preview: plan.id }), /明确确认/)
  await x.backend.action({ action: 'cancelPreview', id: draft.id })
  await assert.rejects(x.backend.action({ action: 'send', id: draft.id, preview: plan.id, confirmed: true }), /预览已过期/)
  assert.equal(x.sends.length, 0); assert.equal((await x.store.get(draft.id)).state, 'draft')
})
test('blocked recipients remain visible in review and a confirmed API send leaves a draft with zero submissions', async t => {
  const x = await setup(t)
  x.value.sendApproval = false
  x.value.trustedRecipientsYaml = 'default: { domains: [example.test], skipApproval: true, denyAddresses: [bob@example.test] }'
  const draft = await x.backend.create(x.fields)
  const preview = await x.backend.action({ action: 'preview', id: draft.id, revision: 1 })
  assert.equal(preview.matching.blocked, true); assert.equal(preview.matching.skipsApproval, false)
  assert.equal(preview.matching.rows.find(row => row.field === 'cc').blocked, true)
  await assert.rejects(x.backend.action({ action: 'send', id: draft.id, preview: preview.id, confirmed: true }), { code: 'recipient-denied' })
  assert.equal(x.sends.length, 0); assert.equal((await x.store.get(draft.id)).state, 'draft')
})
test('the attachment downloaded in preview is exactly what is sent even if the original changes', async t => {
  const x = await setup(t), path = join(x.home, 'original.txt'); await writeFile(path, 'reviewed bytes')
  const draft = await x.backend.create({ ...x.fields, attachments: [path] }), preview = await x.backend.action({ action: 'preview', id: draft.id, revision: 1 })
  await writeFile(path, 'changed after review')
  const response = await x.backend.fetch(new Request('http://127.0.0.1' + EMAIL_DRAFT_ROUTE + '?preview=' + preview.id + '&attachment=' + preview.attachments[0].id))
  assert.equal(await response.text(), 'reviewed bytes'); assert.match(response.headers.get('content-disposition'), /^attachment;/)
  const result = await x.backend.action({ action: 'send', id: draft.id, preview: preview.id, confirmed: true })
  assert.equal(result.draft.state, 'sent'); assert.equal(x.sends[0][5][0].content.toString(), 'reviewed bytes'); assert.equal(x.sends[0][4], x.fields.cc)
  await assert.rejects(x.backend.action({ action: 'send', id: draft.id, preview: preview.id, confirmed: true })); assert.equal(x.sends.length, 1)
  await x.backend.action({ action: 'delete', id: draft.id, revision: result.draft.revision, confirmed: true }); assert.equal(await readFile(path, 'utf8'), 'changed after review')
})
test('draft, account and saved-policy edits invalidate a preview without sending', async t => {
  for (const kind of ['draft', 'account', 'policy', 'expiry']) {
    const x = await setup(t), draft = await x.backend.create(x.fields), plan = await x.backend.action({ action: 'preview', id: draft.id, revision: 1 })
    if (kind === 'draft') await x.store.change(draft.id, 1, draft => { draft.to = 'other@example.test' })
    if (kind === 'account') x.config.user = 'other-sender@example.test'
    if (kind === 'policy') x.value.trustedRecipientsYaml = 'default: { domains: [example.test] }'
    if (kind === 'expiry') x.tick(10 * 60 * 1000 + 1)
    await assert.rejects(x.backend.action({ action: 'send', id: draft.id, preview: plan.id, confirmed: true })); assert.equal(x.sends.length, 0)
  }
})
test('concurrent confirmations from separate backends submit at most one message', async t => {
  let release, entered
  const holding = new Promise(resolve => { release = resolve }), started = new Promise(resolve => { entered = resolve })
  const x = await setup(t, async () => { entered(); await holding; return { account: 'default', accepted: ['alice@example.test'], rejected: [], messageId: 'one', response: '250' } })
  const second = new EmailDraftBackend(x.runtime, { store: new DraftStore(x.home) })
  const draft = await x.backend.create(x.fields), a = await x.backend.action({ action: 'preview', id: draft.id, revision: 1 }), b = await second.action({ action: 'preview', id: draft.id, revision: 1 })
  const send = x.backend.action({ action: 'send', id: draft.id, preview: a.id, confirmed: true }); await started
  try {
    await assert.rejects(second.action({ action: 'send', id: draft.id, preview: b.id, confirmed: true }), error => ['draft-busy', 'draft-submitted'].includes(error.code))
    await second.action({ action: 'list' }); assert.equal((await x.store.get(draft.id)).state, 'sending', 'list must not recover another process active send')
    const other = await second.create({ ...x.fields, subject: '发送期间仍能新建' }); assert.equal(other.state, 'draft')
  } finally { release(); await send }
  assert.equal(x.sends.length, 1)
})
test('SMTP uncertainty is persisted, never auto-retried and can be copied only after explicit confirmation', async t => {
  const x = await setup(t, async () => { throw new Error('transport lost after DATA') }), draft = await x.backend.create(x.fields), plan = await x.backend.action({ action: 'preview', id: draft.id, revision: 1 })
  const result = await x.backend.action({ action: 'send', id: draft.id, preview: plan.id, confirmed: true })
  assert.equal(result.draft.state, 'uncertain'); await x.backend.action({ action: 'list' }); assert.equal(x.sends.length, 1)
  await assert.rejects(x.backend.action({ action: 'preview', id: draft.id, revision: result.draft.revision }), /不能再次发送/)
  await assert.rejects(x.backend.action({ action: 'copy', id: draft.id, revision: result.draft.revision }), /核对邮箱/)
  const copied = await x.backend.action({ action: 'copy', id: draft.id, revision: result.draft.revision, confirmed: true }); assert.notEqual(copied.id, draft.id); assert.equal(copied.state, 'draft'); assert.equal(x.sends.length, 1)
})

test('pre-connect transport errors retain a reviewable draft; generic and DATA timeouts remain uncertain', async t => {
  for (const [details, expected] of [
    [{ code: 'ETIMEDOUT', syscall: 'connect' }, 'draft'],
    [{ code: 'ESOCKET', command: 'CONN' }, 'draft'],
    [{ code: 'EDNS', command: 'CONN' }, 'draft'],
    [{ code: 'ETIMEDOUT', command: 'DATA' }, 'uncertain'],
    [{ code: 'ETIMEDOUT' }, 'uncertain'],
  ]) {
    const x = await setup(t, async () => { throw Object.assign(new Error('synthetic timeout'), details) })
    const draft = await x.backend.create(x.fields), plan = await x.backend.action({ action: 'preview', id: draft.id, revision: 1 })
    const result = await x.backend.action({ action: 'send', id: draft.id, preview: plan.id, confirmed: true })
    assert.equal(result.draft.state, expected); assert.equal(x.sends.length, 1)
    assert.equal(result.draft.sendFailure, expected === 'draft' ? 'not_submitted' : undefined)
    await assert.rejects(x.backend.action({ action: 'send', id: draft.id, preview: plan.id, confirmed: true }))
    assert.equal(x.sends.length, 1)
    if (expected === 'draft') await x.backend.action({ action: 'preview', id: draft.id, revision: result.draft.revision })
  }
})

test('real Nodemailer loopback connection refusal is recognized as not submitted', async t => {
  const socketServer = createServer()
  await new Promise(resolve => socketServer.listen(0, '127.0.0.1', resolve))
  const port = socketServer.address().port
  await new Promise(resolve => socketServer.close(resolve))
  const x = await setup(t)
  x.config.smtp = { host: '127.0.0.1', port, secure: true }
  const pool = new EmailPool(resolveEmailSettings(x.config))
  t.after(() => pool.dispose())
  x.runtime.getPool = () => pool
  const draft = await x.backend.create(x.fields), plan = await x.backend.action({ action: 'preview', id: draft.id, revision: 1 })
  const result = await x.backend.action({ action: 'send', id: draft.id, preview: plan.id, confirmed: true })
  assert.equal(result.draft.state, 'draft'); assert.equal(result.draft.sendFailure, 'not_submitted')
  assert.match(result.draft.error, /ECONNREFUSED/); assert.equal(result.draft.receipt, undefined)
})

test('manual send verification is revision-checked, audited, locked and never sends or invents receipts', async t => {
  for (const outcome of ['sent', 'not_sent']) {
    const x = await setup(t, async () => { throw new Error('lost after DATA') })
    const draft = await x.backend.create({ ...x.fields, inReplyTo: 'source@example.test' })
    const plan = await x.backend.action({ action: 'preview', id: draft.id, revision: 1 })
    const { draft: pending } = await x.backend.action({ action: 'send', id: draft.id, preview: plan.id, confirmed: true })
    const body = { action: 'resolveSend', id: draft.id, revision: pending.revision, outcome, confirmed: true }
    await assert.rejects(x.backend.action({ ...body, confirmed: false }), /核对邮箱/)
    await assert.rejects(x.backend.action({ ...body, outcome: 'guess' }), /核对邮箱/)
    await assert.rejects(x.backend.action({ ...body, revision: 1 }), e => e.code === 'draft-conflict')
    await x.store.sendLock(draft.id, async () => { await assert.rejects(x.backend.action(body), e => e.code === 'draft-busy') })
    const resolved = await x.backend.action(body)
    assert.equal(resolved.id, draft.id); assert.equal(resolved.state, outcome === 'sent' ? 'sent' : 'draft')
    assert.equal(resolved.text, draft.text); assert.equal(resolved.inReplyTo, 'source@example.test')
    assert.equal(resolved.receipt, undefined); assert.equal(resolved.error, undefined)
    assert.equal(resolved.sendChecks.at(-1).outcome, outcome); assert.match(resolved.sendChecks.at(-1).error, /lost after DATA/)
    assert.deepEqual((await new DraftStore(x.home).get(draft.id)).sendChecks, resolved.sendChecks)
    await assert.rejects(x.backend.action(body), e => e.code === 'draft-conflict')
    await assert.rejects(x.backend.action({ action: 'send', id: draft.id, preview: plan.id, confirmed: true }))
    assert.equal(x.sends.length, 1)
    if (outcome === 'not_sent') await x.backend.action({ action: 'preview', id: draft.id, revision: resolved.revision })
  }
})
test('a process crash leaves an uncertain record after the lock is free, never a fresh sendable draft', async t => {
  const x = await setup(t), draft = await x.backend.create(x.fields); await x.store.change(draft.id, 1, d => { d.state = 'sending'; d.attemptAt = new Date().toISOString() })
  const list = await x.backend.action({ action: 'list' }); assert.equal(list.drafts[0].state, 'uncertain'); assert.equal(x.sends.length, 0)
})
test('aborting an in-flight submit persists uncertainty and does not prevent other drafts', async t => {
  let entered
  const started = new Promise(resolve => { entered = resolve }), controller = new AbortController()
  const x = await setup(t, async (...args) => { entered(); const signal = args.at(-1); await new Promise((_resolve, reject) => { signal.addEventListener('abort', () => reject(signal.reason), { once: true }) }) }), draft = await x.backend.create(x.fields), preview = await x.backend.action({ action: 'preview', id: draft.id, revision: 1 })
  const send = x.backend.action({ action: 'send', id: draft.id, preview: preview.id, confirmed: true }, controller.signal); await started; controller.abort(new Error('cancelled'))
  assert.equal((await send).draft.state, 'uncertain'); assert.equal((await x.store.get(draft.id)).state, 'uncertain')
  assert.equal((await x.backend.create(x.fields)).state, 'draft')
})
test('uploads are bounded, revision-checked and copied independently of deletion', async t => {
  const x = await setup(t), draft = await x.backend.create(x.fields)
  const upload = (revision, text) => x.backend.fetch(new Request('http://127.0.0.1' + EMAIL_DRAFT_ROUTE, { method: 'POST', headers: { 'content-type': 'application/octet-stream', [DRAFT_HEADER]: '1', 'x-dsh-draft-id': draft.id, 'x-dsh-draft-revision': String(revision), 'x-dsh-draft-filename': encodeURIComponent('中文说明.txt') }, body: text }))
  const response = await upload(1, 'owned bytes'); assert.equal(response.status, 200); const changed = (await response.json()).value
  assert.equal((await upload(1, 'stale')).status, 409)
  const stored = await x.store.get(draft.id); assert.equal(stored.attachments.length, 1); assert.equal(stored.attachments[0].owned, true)
  const copied = await x.backend.action({ action: 'copy', id: draft.id, revision: changed.revision, confirmed: true })
  await x.backend.action({ action: 'delete', id: draft.id, revision: changed.revision, confirmed: true })
  await assert.rejects(stat(stored.attachments[0].path), { code: 'ENOENT' })
  const preview = await x.backend.action({ action: 'preview', id: copied.id, revision: copied.revision }); assert.equal(preview.attachments[0].size, 11)
})
test('configured attachment caps and the 500-draft limit stop excessive data', async t => {
  const x = await setup(t), path = join(x.home, 'large.txt'); await writeFile(path, '1234567890'); x.config.maxAttachmentBytes = 5
  // The existing resolver clamps the cap to at least 1024 bytes.
  await writeFile(path, Buffer.alloc(2048)); x.config.maxAttachmentBytes = 1024
  await assert.rejects(x.backend.create({ ...x.fields, attachments: [path] }), /附件.*上限/)
  for (let i = 0; i < 500; i++) await x.store.create(x.fields)
  await assert.rejects(x.store.create(x.fields), /500 份草稿/)
})
test('the authenticated carrier route rejects CSRF, missing custom headers and unknown download handles', async t => {
  const x = await setup(t)
  assert.equal((await x.request({ action: 'list' }, { origin: 'https://untrusted.test' })).status, 403)
  assert.equal((await x.request({ action: 'list' }, { 'sec-fetch-site': 'cross-site' })).status, 403)
  assert.equal((await x.request({ action: 'list' }, { [DRAFT_HEADER]: '' })).status, 403)
  assert.equal((await x.backend.fetch(new Request('http://127.0.0.1' + EMAIL_DRAFT_ROUTE + '?preview=missing&attachment=../secret'))).status, 404)
})
test('header newlines and oversized text never enter draft storage', () => {
  assert.throws(() => draftFields({ to: 'a@example.test\nBcc: b@example.test' }))
  assert.throws(() => draftFields({ text: '中'.repeat(35000) }), /100 KiB/)
})
