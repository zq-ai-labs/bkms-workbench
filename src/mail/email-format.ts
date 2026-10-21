/** Deterministic, resource-free layout shared by human review and SMTP delivery. */
export const EMAIL_BODY_FORMAT = 'standard-v1'

const escapeHtml = (text: string): string => text.replace(/[&<>"']/g, value => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[value]!)

export function renderEmailHtml(text: string): string {
  // Collapse extra empty lines in the presentation only; the plain-text part is untouched.
  const normalized = text.replace(/\r\n?/g, '\n').replace(/^(?:[ \t]*\n)+|(?:\n[ \t]*)+$/g, '')
  const paragraphs = normalized ? normalized.split(/\n[ \t]*\n(?:[ \t]*\n)*/).map(paragraph =>
    `<p style="margin:0 0 12px;white-space:pre-wrap;overflow-wrap:break-word;word-break:normal">${escapeHtml(paragraph).replace(/\n/g, '<br>')}</p>`,
  ).join('\n') : ''
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#ffffff;color:#24292f">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="padding:20px 24px;font-family:Arial,'Microsoft YaHei','PingFang SC',sans-serif;font-size:14px;line-height:1.65;color:#24292f">
<div style="max-width:720px;margin:0">${paragraphs}</div>
</td></tr></table></body></html>`
}
