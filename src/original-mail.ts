import type { Task } from './types.js'

const addresses = (entries: unknown): string => Array.isArray(entries) ? entries.map(e => e?.name ? `${e.name} <${e.address || ''}>` : e?.address || '').filter(Boolean).join(', ').slice(0, 16000) : ''

/** Display metadata is deliberately separate from the plain text passed to the agent. */
export function originalMailFields(read: any): Partial<Task> {
  const from = addresses(read.from)
  return {
    ...(from ? { from } : {}),
    to: addresses(read.to), cc: addresses(read.cc),
    mailDate: typeof read.date === 'string' ? read.date.slice(0, 100) : undefined,
    mailSize: Number.isSafeInteger(read.size) && read.size >= 0 ? read.size : undefined,
    bodyHtml: typeof read.bodyHtml === 'string' && Buffer.byteLength(read.bodyHtml, 'utf8') <= 256 * 1024 ? read.bodyHtml : undefined,
    replyTo: (Array.isArray(read.replyTo) && read.replyTo.length ? read.replyTo : read.from || []).map((e: any) => e.address || '').filter(Boolean).join(', '),
  }
}
