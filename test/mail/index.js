// Test-only shim: the dsh-email `lib/index.js` exports used by the ported upstream tests, served by the vendored copies.
export * from '../../lib/mail/config.js'
export * from '../../lib/mail/mail-client.js'
export * from '../../lib/mail/parse.js'
export * from '../../lib/mail/oauth2.js'
export * from '../../lib/mail/recipient-policy.js'
export * from '../../lib/mail/draft-store.js'
export * from '../../lib/mail/email-format.js'
export { EmailDraftBackend, EMAIL_DRAFT_ROUTE } from '../../lib/mail/drafts.js'
