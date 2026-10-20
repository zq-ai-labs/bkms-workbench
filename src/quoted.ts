/**
 * Split an email's plain text into what the sender wrote this time and the quoted history below it.
 *
 * Replies usually carry the earlier exchange under a separator that depends on the mail client:
 *   QQ/Foxmail   ------------------ 原始邮件 ------------------   then 发件人/发送时间/收件人/主题
 *   Outlook      发件人: …  发送时间: …   (often after a line of underscores)   From: … Sent: …
 *   Outlook old  -----Original Message-----
 *   Gmail        On Sat, Oct 18, 2026 at 10:31 AM Li Ming <x> wrote:   李明 <x> 于2026年10月18日周六 10:31写道：
 *   NetEase      在 2026-10-18 10:31:00，"李明" <x> 写道：
 *   Apple Mail   On Oct 18, 2026, at 10:31, Li Ming <x> wrote:
 *   plain        > quoted lines
 * The split is conservative: when nothing recognizable is found, everything is the latest message.
 */
export interface QuotedPart { header: string; text: string }
export interface SplitMail { latest: string; history: QuotedPart[] }

const DASHED = /^[ \t>]*-{2,}[ \t]*(?:原始邮件|原邮件|Original Message|Original|转发邮件信息|Forwarded message|回复的原邮件)[ \t]*-{2,}[ \t]*$/i
const RULE = /^[ \t]*_{8,}[ \t]*$/
const FROM = /^[ \t>*]*(?:发件人|From)[ \t*]*[:：]/i
const WHEN = /^[ \t>*]*(?:发送时间|发送日期|日期|时间|Sent|Date)[ \t*]*[:：]/i
const HEADER_FIELD = /^[ \t>*]*(?:发件人|收件人|抄送|发送时间|发送日期|日期|时间|主题|From|To|Cc|Sent|Date|Subject)[ \t*]*[:：]/i
const WROTE_END = /(?:wrote|写道)[ \t]*[:：]?[ \t]*$/i
const WROTE_START = /^[ \t]*(?:On\b|在\b|在\s|.{1,120}于\s?\d{4})/i

const lines = (text: string) => text.replace(/\r\n?/g, '\n').split('\n')

/** Index of the line where a quoted message starts, and how many lines its header spans; -1 when none. */
function findSeparator(rows: string[], from: number, quoteBlocks = true): { index: number; headerEnd: number } | undefined {
  for (let i = from; i < rows.length; i++) {
    const row = rows[i]
    if (DASHED.test(row)) return { index: i, headerEnd: headerBlockEnd(rows, i + 1) }
    if (RULE.test(row) && rows.slice(i + 1, i + 4).some(next => FROM.test(next))) return { index: i, headerEnd: headerBlockEnd(rows, i + 1) }
    if (FROM.test(row) && rows.slice(i + 1, i + 5).some(next => WHEN.test(next))) return { index: i, headerEnd: headerBlockEnd(rows, i) }
    // “On … wrote:” may wrap onto a second line.
    if (WROTE_START.test(row) && row.length < 260) {
      if (WROTE_END.test(row)) return { index: i, headerEnd: i + 1 }
      if (i + 1 < rows.length && WROTE_END.test(rows[i + 1]) && rows[i + 1].length < 200) return { index: i, headerEnd: i + 2 }
    }
    // A run of “>” lines starts a quote only at the top level; inside an already-quoted part it is just its body.
    if (quoteBlocks && /^[ \t]*>/.test(row)) {
      const rest = rows.slice(i).filter(line => line.trim())
      if (rest.length && rest.filter(line => /^[ \t]*>/.test(line)).length / rest.length >= 0.6) return { index: i, headerEnd: i }
    }
  }
  return undefined
}
function headerBlockEnd(rows: string[], start: number): number {
  let i = start
  while (i < rows.length && !rows[i].trim()) i++
  while (i < rows.length && (HEADER_FIELD.test(rows[i]) || (i > start && /^[ \t]{2,}\S/.test(rows[i]) && HEADER_FIELD.test(rows[i - 1])))) i++
  return i
}
const unquote = (text: string) => text.split('\n').map(line => line.replace(/^[ \t]*(?:>[ \t]?)+/, '')).join('\n')
const tidy = (text: string) => text.replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim()

export function splitQuoted(text: string, maxParts = 10): SplitMail {
  const rows = lines(text || '')
  const first = findSeparator(rows, 0)
  if (!first) return { latest: tidy(text || ''), history: [] }
  const latest = tidy(rows.slice(0, first.index).join('\n'))
  // A reply with nothing above the separator (e.g. a bare forward) keeps everything as the latest message.
  if (!latest) return { latest: tidy(text), history: [] }
  const history: QuotedPart[] = []
  let current: { index: number; headerEnd: number } | undefined = first
  while (current && history.length < maxParts) {
    const headerRows = rows.slice(current.index, current.headerEnd).map(row => row.replace(/^[ \t>*]+/, '').trim()).filter(row => row && !DASHED.test(row) && !RULE.test(row))
    const next = findSeparator(rows, Math.max(current.headerEnd, current.index + 1), false)
    const body = rows.slice(current.headerEnd, next ? next.index : rows.length).join('\n')
    history.push({ header: headerRows.join(' · ').slice(0, 300), text: tidy(unquote(body)) })
    current = next
  }
  return { latest, history: history.filter(part => part.text || part.header) }
}

/** Compact, labelled history for a model prompt, newest first, bounded in length. */
export function historyForPrompt(parts: QuotedPart[], limit: number): string {
  let out = ''
  for (const [index, part] of parts.entries()) {
    const block = `【往来 ${index + 1}${part.header ? '｜' + part.header : ''}】\n${part.text}\n\n`
    if (out.length + block.length > limit) { out += block.slice(0, Math.max(0, limit - out.length)); break }
    out += block
  }
  return out.trim()
}
