import { splitQuoted } from './quoted.js'
import type { Activity, State, Task, Topic, TopicSummary } from './types.js'

/** Statuses that require the user's decision. Unmatched requests count too once triage says they need someone. */
export const ATTENTION = new Set(['review', 'needs_info', 'failed', 'uncertain'])
export const needsAttention = (task: Task): boolean => ATTENTION.has(task.status) || (task.status === 'unmatched' && (['request', 'reply_needed'].includes(task.triage?.category ?? '') || task.match?.state === 'suggested' || task.classification?.state === 'pending'))

const pad = (value: number) => String(value).padStart(2, '0')
/** Local calendar date of the DSH host, which runs on the user's machine. */
export const localDate = (date = new Date()): string => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
export const localMinutes = (date = new Date()): number => date.getHours() * 60 + date.getMinutes()
export const parseClock = (value: string | undefined, fallback: string): number => { const [h, m] = (value || fallback).split(':').map(Number); return h * 60 + m }
export const startOfWeek = (date = new Date()): Date => { const day = new Date(date.getFullYear(), date.getMonth(), date.getDate()); day.setDate(day.getDate() - ((day.getDay() + 6) % 7)); return day }

export const senderAddress = (from: string): string => (from.match(/<([^>]+)>/)?.[1] || from).trim().toLowerCase()
/** Preference key for a task's counterpart: the email address, or the WeChat conversation. */
/** Short, content-light summary used as a learned example for a workflow. */
export const exampleText = (task: Task): string => {
  const what = task.triage?.reason || splitQuoted(task.body).latest.replace(/\s+/g, ' ').slice(0, 160)
  return `${task.source?.kind === 'wechat' ? '微信 ' + (task.wechat?.chatName || '') : '发件人 ' + senderAddress(task.from)}｜主题：${(task.subject || task.title).slice(0, 80)}｜${what}`.slice(0, 300)
}
export const senderKey = (task: Task): string => task.source?.kind === 'wechat' ? `wechat:${task.source.folder}` : senderAddress(task.from)
const normalizedSubject = (subject: string) => subject.replace(/^\s*((re|fw|fwd|回复|答复|转发)\s*[:：]\s*)+/gi, '').trim().toLowerCase()

/** Reliable thread links (Message-ID references) and weaker same-sender/same-subject suggestions. */
export function relations(tasks: Task[]): Map<string, { related: string[]; possible: string[] }> {
  const byMessage = new Map<string, Task>()
  for (const task of tasks) if (task.messageId) byMessage.set(task.messageId.replace(/[<>]/g, ''), task)
  const result = new Map<string, { related: Set<string>; possible: Set<string> }>()
  const entry = (id: string) => { let value = result.get(id); if (!value) result.set(id, value = { related: new Set(), possible: new Set() }); return value }
  for (const task of tasks) {
    for (const ref of (task.references || '').split(/\s+/).map(item => item.replace(/[<>]/g, '')).filter(Boolean)) {
      const other = byMessage.get(ref)
      if (other && other.id !== task.id) { entry(task.id).related.add(other.id); entry(other.id).related.add(task.id) }
    }
  }
  // Segments of the same WeChat conversation are reliably related.
  const chats = new Map<string, Task[]>()
  for (const task of tasks) if (task.source?.kind === 'wechat') chats.set(task.source.folder, [...(chats.get(task.source.folder) || []), task])
  for (const items of chats.values()) for (const a of items) for (const b of items) if (a.id !== b.id) entry(a.id).related.add(b.id)
  const groups = new Map<string, Task[]>()
  for (const task of tasks) {
    if (task.source?.kind === 'wechat') continue
    const subject = normalizedSubject(task.subject)
    if (subject.length < 2) continue
    const key = `${senderAddress(task.from)}\n${subject}`
    groups.set(key, [...(groups.get(key) || []), task])
  }
  for (const group of groups.values()) if (group.length > 1 && group.length <= 20) for (const task of group) for (const other of group) {
    if (other.id === task.id || Math.abs(Date.parse(task.receivedAt) - Date.parse(other.receivedAt)) > 60 * 864e5) continue
    if (!entry(task.id).related.has(other.id)) entry(task.id).possible.add(other.id)
  }
  return new Map([...result].map(([id, value]) => [id, { related: [...value.related], possible: [...value.possible] }]))
}

export function topicMatches(topic: Topic, task: Task): boolean {
  const sender = senderAddress(task.from)
  if (topic.senders.some(item => item && (sender === item.toLowerCase() || (item.startsWith('@') && sender.endsWith(item.toLowerCase()))))) return true
  const haystack = `${task.subject}\n${task.from}\n${task.summary || ''}\n${task.body.slice(0, 4000)}`.toLowerCase()
  return topic.keywords.some(keyword => keyword && haystack.includes(keyword.toLowerCase()))
}

const brief = (task: Task) => ({
  id: task.id, title: task.subject || task.title, from: task.from, status: task.status, receivedAt: task.receivedAt,
  category: task.triage?.category, urgency: task.triage?.urgency, nextStep: task.triage?.nextStep || undefined,
  workflow: task.ruleName, summary: (task.summary || '').slice(0, 400) || undefined,
})

/** Data handed to the writer (or the template) for today's brief. Contains no full mail bodies. */
export function briefData(state: State, at = new Date()) {
  const since = new Date(at.getTime() - 24 * 3600e3).toISOString()
  const decisions = state.tasks.filter(needsAttention).sort((a, b) => urgencyRank(a) - urgencyRank(b) || b.receivedAt.localeCompare(a.receivedAt))
  const activity = (state.activity || []).filter(item => item.at >= since && !item.undoneAt)
  const notable = state.tasks.filter(task => task.receivedAt >= since && task.triage?.category === 'fyi')
  return {
    date: localDate(at),
    decisions: decisions.slice(0, 8).map(brief), decisionCount: decisions.length,
    activity: activity.slice(-20).map(item => ({ kind: item.kind, title: item.title })), activityCount: activity.length,
    archivedCount: activity.filter(item => item.kind === 'archive').length,
    notable: notable.slice(0, 5).map(brief),
    received: state.tasks.filter(task => task.receivedAt >= since).length,
  }
}
const urgencyRank = (task: Task) => task.triage?.urgency === 'high' ? 0 : task.status === 'uncertain' || task.status === 'failed' ? 1 : 2

export function briefTemplate(data: ReturnType<typeof briefData>, en: boolean): string {
  const top = data.decisions[0]
  if (en) return [
    data.decisionCount ? `${data.decisionCount} item(s) need your decision${top ? `; start with “${top.title}”` : ''}.` : 'Nothing needs your decision right now.',
    data.activityCount ? `Since yesterday the assistant handled ${data.activityCount} item(s), including ${data.archivedCount} archived notification(s).` : '',
    data.notable.length ? `${data.notable.length} message(s) are worth a look but need no action.` : '',
  ].filter(Boolean).join(' ')
  return [
    data.decisionCount ? `今天有 ${data.decisionCount} 件事需要你决策${top ? `，建议先处理「${top.title}」` : ''}。` : '目前没有需要你决策的事。',
    data.activityCount ? `过去 24 小时 AI 替你处理了 ${data.activityCount} 件事，其中归档 ${data.archivedCount} 条通知。` : '',
    data.notable.length ? `另有 ${data.notable.length} 条信息值得关注，无需处理。` : '',
  ].join('')
}

export function weeklyData(state: State, start: Date, end: Date) {
  const from = start.toISOString(), to = end.toISOString()
  const inRange = (value: string) => value >= from && value < to
  const tasks = state.tasks.filter(task => inRange(task.receivedAt) || inRange(task.updatedAt))
  const done = tasks.filter(task => ['sent', 'completed'].includes(task.status))
  const open = tasks.filter(needsAttention)
  const activity = (state.activity || []).filter(item => inRange(item.at) && !item.undoneAt)
  return {
    periodStart: localDate(start), periodEnd: localDate(new Date(end.getTime() - 1)),
    done: done.slice(0, 40).map(brief), doneCount: done.length,
    open: open.slice(0, 20).map(brief), openCount: open.length,
    received: tasks.filter(task => inRange(task.receivedAt)).length,
    automated: activity.length,
    workflows: Object.entries(tasks.reduce<Record<string, number>>((acc, task) => { if (task.ruleName) acc[task.ruleName] = (acc[task.ruleName] || 0) + 1; return acc }, {})).map(([name, count]) => ({ name, count })),
  }
}
export function weeklyTemplate(data: ReturnType<typeof weeklyData>, en: boolean): { title: string; text: string } {
  const lines = (items: ReturnType<typeof brief>[]) => items.map(item => `- ${item.title}${item.workflow ? `（${item.workflow}）` : ''}`).join('\n')
  if (en) return { title: `Weekly report ${data.periodStart} – ${data.periodEnd}`, text: `## Completed (${data.doneCount})\n${lines(data.done) || '- None'}\n\n## Still open (${data.openCount})\n${lines(data.open) || '- None'}\n\n## Volume\n- ${data.received} messages received; the assistant completed ${data.automated} actions.\n\n## Next week\n- [Add your plan]` }
  return { title: `周报 ${data.periodStart} 至 ${data.periodEnd}`, text: `## 本周完成（${data.doneCount}）\n${lines(data.done) || '- 无'}\n\n## 仍在处理（${data.openCount}）\n${lines(data.open) || '- 无'}\n\n## 工作量\n- 收到 ${data.received} 条信息，AI 代办 ${data.automated} 件。\n\n## 下周计划\n- [请补充]` }
}

export function topicData(state: State, topic: Topic) {
  const tasks = state.tasks.filter(task => topicMatches(topic, task)).sort((a, b) => b.receivedAt.localeCompare(a.receivedAt))
  return { topic: { name: topic.name, kind: topic.kind }, items: tasks.slice(0, 40).map(brief), count: tasks.length, open: tasks.filter(needsAttention).length }
}
export function topicTemplate(data: ReturnType<typeof topicData>, en: boolean): TopicSummary {
  const latest = data.items[0]
  return {
    text: en ? `${data.count} related message(s). ${data.open ? `${data.open} still need your decision.` : 'Nothing is waiting on you.'}${latest ? ` Latest: “${latest.title}”.` : ''}`
      : `共 ${data.count} 条相关信息。${data.open ? `仍有 ${data.open} 件需要你决策。` : '目前没有等你处理的事。'}${latest ? `最近一条：「${latest.title}」。` : ''}`,
    level: data.open ? 'attention' : 'good', risks: [], todos: data.items.filter(item => ATTENTION.has(item.status)).slice(0, 5).map(item => item.nextStep || item.title),
    at: new Date().toISOString(), by: 'template',
  }
}

/** Trial-run input. `mails` replaces received items, e.g. history read straight from the mailbox for a chosen time range. */
export function trialData(state: State, rule: { id?: string; name: string; semantic?: string; instructions: string; exclude?: string[] }, taskIds?: string[], mails?: { id: string; from: string; subject: string; excerpt: string }[]) {
  const pool = state.tasks.slice().sort((a, b) => b.receivedAt.localeCompare(a.receivedAt)).filter(task => !taskIds || taskIds.includes(task.id)).slice(0, 30)
  const examples = (rule.id ? state.ruleExamples?.[rule.id] ?? [] : []).slice(-8).map(({ match, text }) => ({ match, text }))
  return { rule: { name: rule.name, semantic: rule.semantic || '', hint: rule.instructions.slice(0, 600), exclude: rule.exclude, examples }, mails: mails ? mails.slice(0, 30) : pool.map(task => ({ id: task.id, from: task.from, subject: task.subject, category: task.triage?.category, excerpt: (task.summary || splitQuoted(task.body || '').latest).slice(0, 300) })) }
}

export const activityEntry = (input: Omit<Activity, 'id' | 'at'> & { at?: string }, id: string): Activity => ({ ...input, id, at: input.at ?? new Date().toISOString() })
