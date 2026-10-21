import test from 'node:test'
import assert from 'node:assert/strict'
import nodemailer from 'nodemailer'
import { simpleParser } from 'mailparser'
import { renderEmailHtml } from '../../lib/mail/email-format.js'
import { EmailPool } from '../../lib/mail/mail-client.js'
import { resolveEmailSettings } from '../../lib/mail/config.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DraftStore } from '../../lib/mail/draft-store.js'
import { EmailDraftBackend } from '../../lib/mail/drafts.js'

test('standard email layout preserves Chinese, numbered lines and paragraph order without excess gaps', () => {
  const html = renderEmailHtml('您好：\r\n\r\n\r\n需求已收到。\r\n\r\n1. 核对数量\r\n2. 确认交期\r\n\r\n谢谢！\r\n')
  assert.equal((html.match(/<p style=/g) ?? []).length, 4)
  assert.match(html, /1\. 核对数量<br>2\. 确认交期/)
  assert.match(html, /Microsoft YaHei/)
  assert.match(html, /charset="utf-8"/)
  assert.doesNotMatch(html, /BKMS|鲸鱼|<pre|<img|<script/)
  assert.equal((renderEmailHtml('').match(/<p style=/g) ?? []).length, 0)
})

test('untrusted HTML and attributes are displayed as literal text without active elements or resources', () => {
  const html = renderEmailHtml('<img src="https://example.test/pixel" onerror="alert(1)">\n<script>alert(1)</script> & \'quoted\'')
  assert.doesNotMatch(html, /<img|<script|<[^>]*\bsrc=/)
  assert.match(html, /&lt;img src=&quot;/)
  assert.match(html, /&lt;script&gt;/)
  assert.match(html, /&amp; &#39;quoted&#39;/)
})

test('reviewed text is delivered as UTF-8 multipart alternatives with the exact preview HTML', async t => {
  const text = '您好：\r\n\r\n\r\n需求已收到 & 正在核对。\r\n\r\n谢谢！'
  const home = await mkdtemp(join(tmpdir(), 'email-format-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const settings = resolveEmailSettings({ provider: 'qq', user: 'sender@example.test', password: 'synthetic-secret' })
  const pool = new EmailPool(settings)
  const value = { sendApproval: true, trustedRecipientsYaml: '' }
  const backend = new EmailDraftBackend({ getEffectiveSettings: () => settings, getSettingsValue: () => value, getPool: () => pool }, { snapshot: async () => ({ accounts: ['default'], settings: { value } }) }, { store: new DraftStore(home) })
  const transport = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'unix' })
  let input, raw
  pool.sendMail = async (_name, _config, message) => {
    input = message
    const result = await transport.sendMail(message)
    raw = result.message
    return { messageId: result.messageId, accepted: ['recipient@example.test'] }
  }
  const draft = await backend.create({ account: 'default', to: 'recipient@example.test', subject: '需求确认', text })
  const preview = await backend.action({ action: 'preview', id: draft.id, revision: draft.revision })
  const result = await backend.action({ action: 'send', id: draft.id, preview: preview.id, confirmed: true })
  assert.equal(result.draft.state, 'sent')
  assert.equal(input.text, text, 'formatting must not rewrite stored plain text')
  assert.equal(input.html, preview.bodyHtml)
  assert.match(raw.toString(), /multipart\/alternative/)
  assert.match(raw.toString(), /text\/plain; charset=utf-8/)
  assert.match(raw.toString(), /text\/html; charset=utf-8/)
  const parsed = await simpleParser(raw)
  assert.equal(parsed.subject, '需求确认')
  assert.equal(parsed.html, input.html)
  assert.equal(parsed.text.replace(/\r\n/g, '\n').trimEnd(), text.replace(/\r\n/g, '\n'))
})
