import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, stat, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { Store } from '../lib/store.js'
import { Engine } from '../lib/engine.js'
import { WorkbenchApi } from '../lib/api.js'
import { MailService } from '../lib/mail/service.js'
import { MailAccounts } from '../lib/mail/accounts.js'

const account = { provider: 'qq', user: 'Sales@Example.test', password: 'synthetic-auth-code', senderName: '销售部' }

/** A stand-in for the IMAP/SMTP pool: one inbox, recorded sends. */
function fakePool() {
  const state = { inbox: [], sends: [], created: 0, disposed: 0, settings: [] }
  const create = settings => {
    state.created++; state.settings.push(settings)
    return {
      startIdleSweep() {}, dispose() { state.disposed++ },
      async scanChanges(name, folder, cursor) {
        const last = Math.max(10, ...state.inbox.map(m => m.uid))
        return { cursor: { uidValidity: 7, lastUid: cursor ? last : 10 }, messages: cursor ? state.inbox.filter(m => m.uid > cursor.lastUid) : [], firstRun: !cursor, reset: false, hasMore: false }
      },
      async readForWorkbench(name, folder, uid) { return { uid, text: '请报价 500 台 TH-100。', from: [{ address: 'buyer@example.test' }], replyTo: [], attachments: [], messageId: `m${uid}@example.test`, references: '' } },
      async folders() { return { account: 'x', folders: [{ path: 'INBOX', name: 'INBOX' }, { path: 'Box', name: 'Box', selectable: false }] } },
      async sendPrepared(...args) { state.sends.push(args); return { account: args[0], accepted: ['buyer@example.test'], rejected: [], messageId: '<sent@example.test>', response: '250 ok' } },
      async search(name, query) { return { account: name, query, messages: [] } },
      async withImap() { throw Object.assign(new Error('Command failed'), {}) },
    }
  }
  return { state, create }
}

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'bkms-mail-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const pool = fakePool(), mail = new MailService(join(root, 'mail'), pool.create)
  await mail.reload()
  t.after(() => mail.close())
  return { root, mail, pool }
}

test('accounts: validated, password kept server-side, file private, presets resolved', async t => {
  const { mail, root } = await setup(t)
  assert.equal(mail.configured(), false)
  assert.equal(mail.status().error, undefined, 'no account yet is not an error')
  await assert.rejects(mail.saveAccount({ provider: 'outlook', user: 'a@example.test', password: 'x' }, 0), /OAuth2/)
  await assert.rejects(mail.saveAccount({ provider: 'qq', user: 'not-an-address', password: 'x' }, 0), /完整邮箱地址/)
  await assert.rejects(mail.saveAccount({ provider: 'qq', user: 'a@example.test' }, 0), /授权码/)
  await assert.rejects(mail.saveAccount({ provider: 'custom', user: 'a@example.test', password: 'x' }, 0), /IMAP 和 SMTP/)
  await mail.saveAccount({ ...account, trusted: 'example.test\nboss@partner.test', blocked: ['@competitor.test'] }, 0)
  assert.equal(mail.configured(), true)
  const { revision, accounts } = await mail.views()
  assert.equal(revision, 1)
  assert.equal(accounts[0].id, 'sales@example.test')
  assert.equal(accounts[0].hasPassword, true); assert.equal(accounts[0].isDefault, true)
  assert.equal('password' in accounts[0], false, 'the page never receives the password')
  assert.deepEqual(accounts[0].trusted, ['example.test', 'boss@partner.test']); assert.deepEqual(accounts[0].blocked, ['competitor.test'])
  // Stored privately; a blank password on edit keeps the stored one.
  if (process.platform !== 'win32') assert.equal((await stat(join(root, 'mail', 'accounts.json'))).mode & 0o777, 0o600)
  await mail.saveAccount({ id: 'sales@example.test', ...account, password: '', senderName: '销售一组' }, 1)
  assert.match(await readFile(join(root, 'mail', 'accounts.json'), 'utf8'), /synthetic-auth-code/)
  await assert.rejects(mail.saveAccount({ id: 'sales@example.test', ...account, user: 'other@example.test' }, 2), /不能修改/)
  await assert.rejects(mail.saveAccount(account, 1), /别处修改/, 'stale revision')
  await assert.rejects(mail.saveAccount(account, 2), /已添加/)
  assert.equal((await mail.views()).revision, 2, 'failed edits change nothing')
  // Presets: QQ and Tencent Exmail; recipient rules become dsh-email policies.
  const settings = MailAccounts.resolve([mail.accounts.normalize(account), mail.accounts.normalize({ provider: 'exmail', user: 'me@corp.test', password: 'p' })])
  assert.equal(settings.accounts.get('sales@example.test').imap.host, 'imap.qq.com')
  assert.equal(settings.accounts.get('me@corp.test').smtp.host, 'smtp.exmail.qq.com')
  const ruled = await mail.accounts.settings()
  assert.deepEqual(ruled.recipientPolicies.get('sales@example.test'), { skipApproval: false, addresses: ['boss@partner.test'], domains: ['example.test'], denyAddresses: [], denyDomains: ['competitor.test'] })
  assert.equal(ruled.accounts.get('sales@example.test').senderName, '销售一组')
  // An explicit empty list clears the rules.
  await mail.saveAccount({ id: 'sales@example.test', ...account, password: '', trusted: '', blocked: [] }, 2)
  assert.equal((await mail.accounts.settings()).recipientPolicies.size, 0)
})

test('service: unconfigured mail is unavailable; account changes rebuild the pool; other plugins cannot send', async t => {
  const { mail, pool } = await setup(t)
  assert.deepEqual(mail.service().accounts(), [])
  await assert.rejects(async () => mail.service().scan({ account: 'x', folder: 'INBOX' }), /添加邮箱账号/)
  await mail.saveAccount(account, 0)
  const service = mail.service()
  assert.deepEqual(service.accounts(), [{ id: 'sales@example.test', address: 'Sales@example.test', inboxFolder: 'INBOX' }])
  assert.deepEqual((await service.folders('sales@example.test')).folders.map(f => f.path), ['INBOX'])
  assert.equal(pool.state.created, 1)
  await mail.saveAccount({ id: 'sales@example.test', ...account, password: 'new-code' }, 1)
  await service.folders('sales@example.test')
  assert.equal(pool.state.created, 2); assert.equal(pool.state.disposed >= 1, true, 'old connections closed after an account change')
  // A recipient-rule change does not reconnect.
  await mail.saveAccount({ id: 'sales@example.test', ...account, password: '', blocked: 'competitor.test' }, 2)
  await service.folders('sales@example.test')
  assert.equal(pool.state.created, 2)
  const external = mail.external()
  assert.deepEqual(Object.keys(external).sort(), ['accounts', 'read', 'search', 'version'])
  assert.deepEqual(await external.accounts(), [{ id: 'sales@example.test', address: 'Sales@example.test', isDefault: true }])
  assert.throws(() => external.search({ query: '' }), /搜索内容/)
  await mail.removeAccount('sales@example.test', 3)
  assert.equal(mail.configured(), false); assert.deepEqual(service.accounts(), [])
})

test('connection test reports IMAP and SMTP separately and hides the authorization code', async t => {
  const { mail } = await setup(t)
  const closed = createServer(); await new Promise(resolve => closed.listen(0, '127.0.0.1', resolve)); const port = closed.address().port; await new Promise(resolve => closed.close(resolve))
  const result = await mail.test({ provider: 'custom', user: 'a@example.test', password: 'synthetic-auth-code', imap: { host: '127.0.0.1', port: 993 }, smtp: { host: '127.0.0.1', port, secure: false } })
  assert.equal(result.imap.ok, false); assert.match(result.imap.error, /登录失败/)
  assert.equal(result.smtp.ok, false); assert.equal(result.smtp.host, `127.0.0.1:${port}`)
  assert.doesNotMatch(JSON.stringify(result), /synthetic-auth-code/)
  assert.equal((await mail.views()).revision, 0, 'testing never saves')
})

test('end to end through the built-in service: baseline, new mail, draft, reviewed send', async t => {
  const { root, mail, pool } = await setup(t)
  const store = new Store(join(root, 'data'))
  const agent = { available: () => true, async run() { return { output: { summary: '客户询价。', subject: 'Re: 询价', text: '您好，报价如下。' }, sessionId: 's' } } }
  const engine = new Engine(store, () => mail.configured() ? mail.service() : undefined, agent), api = new WorkbenchApi(engine, undefined, undefined, mail)
  await engine.start(); t.after(() => engine.stop())
  // No account yet: the settings view shows no error, just no account.
  let info = await api.action({ action: 'mailSettings' })
  assert.equal(info.health.email, false); assert.equal(info.health.error, undefined); assert.equal(info.mail.configured, false)
  const listed = await api.action({ action: 'mailAccounts' })
  assert.equal(listed.providers[0], 'exmail', 'Tencent Exmail is listed first and preselected')
  assert.deepEqual(listed.presets.exmail, { imap: { host: 'imap.exmail.qq.com', port: 993, secure: true }, smtp: { host: 'smtp.exmail.qq.com', port: 465, secure: true } })
  assert.ok(listed.providers.includes('qq')); assert.equal(listed.presets.qq.imap.host, 'imap.qq.com'); assert.equal(listed.presets.custom, undefined)
  await assert.rejects(api.action({ action: 'removeMailAccount', id: 'x', revision: 0 }), /确认删除/)
  const saved = await api.action({ action: 'saveMailAccount', account, revision: 0 })
  assert.equal(saved.accounts.length, 1); assert.doesNotMatch(JSON.stringify(saved), /synthetic-auth-code/)
  await assert.rejects(api.action({ action: 'saveMailAccount', account, revision: 0 }), error => error.status === 409)
  info = await api.action({ action: 'mailSettings' })
  assert.equal(info.health.email, true); assert.deepEqual(info.accounts.map(a => a.id), ['sales@example.test'])
  await api.action({ action: 'saveRule', revision: (await store.read()).configRevision, rule: { name: '询价', enabled: true, priority: 100, account: '', folder: 'INBOX', match: { from: '', subject: '', hasAttachments: false, mode: 'all' }, instructions: '回复询价。', tools: [], output: 'reply', maxRetries: 0, matchMode: 'literal' } })
  await engine.poll()
  pool.state.inbox = [{ uid: 11, date: new Date().toISOString(), from: [{ address: 'buyer@example.test' }], subject: '询价', seen: false, hasAttachments: false }]
  await engine.poll()
  for (let i = 0; i < 5 && (await store.read()).tasks.some(task => ['queued', 'running'].includes(task.status)); i++) await engine.processNext()
  const task = (await api.snapshot()).tasks[0]
  assert.equal(task.status, 'review'); assert.equal(task.account, 'sales@example.test'); assert.equal(task.draft.to, 'buyer@example.test')
  const preview = await api.action({ action: 'previewSend', id: task.id, revision: task.revision, draftRevision: task.draft.revision })
  assert.equal(preview.from.address, 'Sales@example.test'); assert.equal(preview.from.name, '销售部')
  await api.action({ action: 'send', id: task.id, revision: task.revision, draftRevision: task.draft.revision, planId: preview.id, confirmed: true })
  assert.equal(pool.state.sends.length, 1)
  assert.deepEqual(pool.state.sends[0][7], { inReplyTo: 'm11@example.test', references: 'm11@example.test' })
  assert.equal((await api.snapshot()).tasks[0].status, 'sent')
})
