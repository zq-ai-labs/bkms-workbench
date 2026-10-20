import test from 'node:test'
import assert from 'node:assert/strict'
import { canonicalAddress, canonicalDomain, normalizeRecipients, parseRecipientPolicies, matchRecipients, assertRecipientsAllowed } from '../../lib/mail/recipient-policy.js'
import { resolveEmailSettings } from '../../lib/mail/config.js'
import { EmailPool } from '../../lib/mail/mail-client.js'
// Ported from dsh-email test/recipient-policy.test.mjs; the chat-tool approval gate is not part of the workbench.
const policy = { skipApproval: true, addresses: ['Alice@example.test'], domains: ['team.test'] }
test('display names, groups and Cc resolve to the Nodemailer recipient envelope', async () => {
  assert.deepEqual(await normalizeRecipients('Boss <Alice@EXAMPLE.test>, Team: bob@team.test, carol@team.test;', 'Extra <dave@else.test>'), [
    { field: 'to', address: 'Alice@example.test' }, { field: 'to', address: 'bob@team.test' }, { field: 'to', address: 'carol@team.test' }, { field: 'cc', address: 'dave@else.test' },
  ])
  assert.equal((await matchRecipients('Boss <Alice@example.test>', 'dave@else.test', policy)).skipsApproval, false)
  assert.equal((await matchRecipients('Boss <Alice@example.test>', 'dave@team.test', policy)).skipsApproval, true)
})
test('a trusted display name does not hide an untrusted mailbox; local case and subdomains remain distinct', async () => {
  for (const to of ['"Alice@example.test" <attacker@else.test>', 'alice@example.test', 'alice@sub.team.test']) assert.equal((await matchRecipients(to, '', policy)).skipsApproval, false)
})
test('IDN domains canonicalize consistently and rules do not imply trust without explicit opt-in', async () => {
  const domain = canonicalDomain('例子.测试'), address = canonicalAddress('Name@例子.测试')
  assert.equal(domain, 'xn--fsqu00a.xn--0zwm56d'); assert.equal(address, 'Name@' + domain)
  assert.equal((await matchRecipients(address, '', { domains: [domain], addresses: [], skipApproval: false })).allTrusted, true)
  assert.equal((await matchRecipients(address, '', { domains: [domain], addresses: [], skipApproval: false })).skipsApproval, false)
})
test('malformed recipients, newlines, oversized rules, wildcards and duplicate account keys fail closed', async () => {
  for (const value of ['', 'local-only', 'a@example.test\r\nBcc: attacker@else.test']) await assert.rejects(normalizeRecipients(value))
  for (const text of ['work: { skipApproval: yes }', 'work: { domains: ["*.team.test"] }', 'work: { addresses: ["Alice <a@example.test>"] }', 'work: {}\nwork: {}', 'work: &x {}\nother: *x', 'x'.repeat(65537)]) assert.throws(() => parseRecipientPolicies(text))
})
test('blocked Cc and addresses outrank trusted rules and global approval off', async () => {
  const rules = { work: { ...policy, denyAddresses: ['Alice@example.test'], denyDomains: ['blocked.test'] } }
  const p = parseRecipientPolicies(JSON.stringify(rules)).get('work')
  const matches = await matchRecipients('Boss <Alice@example.test>', 'Team: bob@blocked.test;', p)
  assert.equal(matches.blocked, true); assert.equal(matches.skipsApproval, false)
  assert.equal(matches.rows.filter(row => row.blocked).length, 2)
  await assert.rejects(assertRecipientsAllowed('bob@team.test', 'hidden@blocked.test', p), { code: 'recipient-denied' })
  assert.equal((await matchRecipients('bob@sub.blocked.test', '', p)).blocked, false)
})
test('the shared SMTP boundary blocks direct, prepared, reply-all and forward paths before connection', async () => {
  const settings = resolveEmailSettings({ user: 'sender@example.test', password: 'synthetic', imap: { host: '127.0.0.1' }, smtp: { host: '127.0.0.1' }, sendApproval: false, trustedRecipientsYaml: 'default: { denyDomains: [blocked.test] }' })
  const pool = new EmailPool(settings)
  let connections = 0
  pool.transporter = () => { connections++; throw new Error('SMTP must not connect') }
  pool.withImap = async (_name, _folder, callback) => callback({ fetchOne: async () => ({ source: Buffer.from('From: Blocked <reply@blocked.test>\r\nTo: sender@example.test, other@allowed.test\r\nSubject: Test\r\nMessage-ID: <audit@example.test>\r\n\r\nOriginal') }) })
  await assert.rejects(pool.send(undefined, 'a@allowed.test', 'audit', '', 'cc@blocked.test', []), { code: 'recipient-denied' })
  await assert.rejects(pool.sendPrepared('default', 'to@blocked.test', 'audit', '', '', []), { code: 'recipient-denied' })
  for (const mode of ['reply', 'reply-all', 'forward']) await assert.rejects(pool.reply(undefined, 'INBOX', 1, mode, 'audit', 'forward@blocked.test', ''), { code: 'recipient-denied' })
  assert.equal(connections, 0); pool.dispose()
})
