export type Status = 'queued' | 'running' | 'review' | 'needs_info' | 'failed' | 'sending' | 'sent' | 'uncertain' | 'ignored' | 'unmatched' | 'completed'
/** How far a workflow may act without a person: draft only, bounded low-risk sending, or all bounded replies. */
export type Autonomy = 'draft' | 'low_risk' | 'auto'
export const AUTONOMY: readonly Autonomy[] = ['draft', 'low_risk', 'auto']
/** Information sources. Email and WeChat (read-only) have adapters; the others are declared so workflows and UI stay source-neutral. */
export type SourceKind = 'email' | 'feishu' | 'wecom' | 'wechat' | 'meeting'
export const SOURCE_KINDS: readonly SourceKind[] = ['email', 'feishu', 'wecom', 'wechat', 'meeting']
/** AI triage result of one incoming message. */
export type TriageCategory = 'request' | 'reply_needed' | 'fyi' | 'notification' | 'marketing' | 'other'
export const TRIAGE_CATEGORIES: readonly TriageCategory[] = ['request', 'reply_needed', 'fyi', 'notification', 'marketing', 'other']
/** Categories excluded when a workflow does not specify its own exclusions. */
export const DEFAULT_EXCLUDE: readonly TriageCategory[] = ['notification', 'marketing']
export interface Rule {
  id: string; name: string; enabled: boolean; priority: number; account: string; folder: string
  match: { from: string; subject: string; hasAttachments: boolean; mode: 'all' | 'any' }
  instructions: string; tools: string[]; skills?: string[]; output: 'reply' | 'report'; maxRetries: number
  /** Natural-language applicability judged by AI triage, e.g. “客户的报价或询价请求”. Empty = no semantic condition. */
  semantic?: string
  /** Triage categories this workflow never handles. Undefined keeps the safe default (notifications and marketing). */
  exclude?: TriageCategory[]
  autonomy?: Autonomy
  sources?: SourceKind[]
}
export interface Cursor { uidValidity: number; lastUid: number }
/** Where a task came from. Email uses mailbox coordinates; a WeChat segment reuses the same shape (account `wechat`, folder = chat id, uid = last message sequence) so older builds can still read the data. */
export interface Source { account: string; folder: string; uid: number; uidValidity: number; kind?: 'wechat' }
/** One normalized WeChat message as returned by the read-only bridge. */
export interface WechatMessage {
  seq: number; at: string; sender: string; senderName: string; self: boolean; type: string; text: string
  quote?: { sender: string; text: string }
  mentionsMe?: boolean
}
/** A WeChat conversation segment handled as one task. `reply` is the AI's suggested reply; nothing is ever sent. */
export interface WechatSegment {
  chat: string; chatName: string; group: boolean; messages: WechatMessage[]; fromSeq: number; toSeq: number
  mentioned?: boolean; reply?: string; replyRevision?: number
}
export type WechatChatKind = 'person' | 'group'
export interface WechatChat { id: string; name: string; kind: WechatChatKind; lastAt?: string }
/** Which conversations may be read. Allow mode reads only the listed ones; block mode reads everything except them. */
export interface WechatList { mode: 'allow' | 'block'; list: string[] }
export interface WechatSettings {
  enabled: boolean
  /** Python command, e.g. `py -3` or a full path to python.exe. */
  python?: string
  /** Folder of the wechatauto-replica checkout when it is not installed with pip. */
  library?: string
  people: WechatList
  groups: WechatList & { scope: 'mention' | 'all' }
  /** A segment is handled once the chat has been quiet this long. */
  quietMinutes?: number
  /** Display names of listed chats, so the lists stay readable while WeChat is offline. */
  names?: Record<string, string>
}
export interface WechatPending { chatName: string; group: boolean; messages: WechatMessage[]; firstAt: string; lastAt: string }
export interface WechatState { watermarks: Record<string, number>; pending: Record<string, WechatPending> }
export interface WechatStatus { ready: boolean; wxid?: string; name?: string; library?: string; error?: string }
export interface WechatService {
  status(signal?: AbortSignal): Promise<WechatStatus>
  chats(signal?: AbortSignal): Promise<WechatChat[]>
  search(q: string, signal?: AbortSignal): Promise<WechatChat[]>
  latest(chats: string[], signal?: AbortSignal): Promise<Record<string, number>>
  poll(watermarks: Record<string, number>, signal?: AbortSignal): Promise<Record<string, WechatMessage[]>>
  history(chat: string, offset: number, limit: number, signal?: AbortSignal): Promise<{ messages: WechatMessage[]; more: boolean }>
}
export interface Triage {
  state: 'pending' | 'done'
  category?: TriageCategory
  urgency?: 'high' | 'normal' | 'low'
  reason?: string
  nextStep?: string
  by?: 'ai' | 'heuristic' | 'preference'
  at?: string
  /** Set when triage archived the message without a workflow. */
  archived?: boolean
}
export interface Check { item: string; quote?: string }
export interface AutoSend { at: string; scheduledAt: string; autonomy: Autonomy; draftRevision: number; canceledAt?: string; reason?: string }
export interface Task {
  id: string; revision: number; title: string; account: string; status: Status; from: string; subject: string; body: string
  receivedAt: string; updatedAt: string; ruleId?: string; ruleName?: string; rule?: Rule
  source: Source; summary?: string; error?: string; draftId?: string; draft?: any; sessionId?: string; hasAttachments?: boolean; mailLoaded?: boolean
  informationGaps?: string; needsInfoKind?: 'information' | 'attachments'
  bodyHtml?: string; to?: string; cc?: string; mailDate?: string; mailSize?: number
  messageId?: string; references?: string; replyTo?: string; attachments: { filename: string; size: number; part?: string; contentType?: string; localPath?: string }[]
  history: { at: string; message: string }[]; attempts: number; nextAttemptAt?: string; supplement?: string; workspace?: string; prepareKey?: string
  triage?: Triage
  checks?: Check[]
  autoSend?: AutoSend
  wechat?: WechatSegment
}
export type ActivityKind = 'archive' | 'auto_send_scheduled' | 'auto_sent' | 'auto_send_canceled' | 'auto_send_blocked' | 'report' | 'brief' | 'weekly' | 'topic'
export interface Activity {
  id: string; at: string; kind: ActivityKind; title: string; detail?: string
  taskId?: string; ruleName?: string; autonomy?: Autonomy; source?: SourceKind
  undoUntil?: string; undoneAt?: string
}
export interface TopicSummary { text: string; level: 'good' | 'attention' | 'risk'; risks: string[]; todos: string[]; at: string; by: 'ai' | 'template' }
export interface Topic {
  id: string; name: string; kind: 'customer' | 'project' | 'other'
  keywords: string[]; senders: string[]; schedule: 'none' | 'weekly'
  createdAt: string; updatedAt: string; summary?: TopicSummary
}
export interface Report {
  id: string; kind: 'weekly' | 'topic'; title: string; text: string
  periodStart: string; periodEnd: string; generatedAt: string; updatedAt: string
  topicId?: string; by: 'ai' | 'template'
}
export interface Brief { date: string; text: string; generatedAt: string; by: 'ai' | 'template' }
export interface SenderPreference { neverArchive?: boolean; neverAutoSend?: boolean }
export interface Log { id: string; at: string; level: 'info' | 'error'; message: string; taskId?: string }
export interface Settings {
  enabled: boolean; pollSeconds: number; showWorkbench?: boolean; notifyNewTodo?: boolean
  /** AI triage before workflow matching. Defaults on. */
  triage?: boolean
  /** Delay before an automatic reply is actually submitted; it can be withdrawn meanwhile. */
  undoMinutes?: number
  briefEnabled?: boolean; briefTime?: string
  weeklyEnabled?: boolean; weeklyDay?: number; weeklyTime?: string
  meetingBriefMinutes?: number
  wechat?: WechatSettings
}
export interface State {
  version: 1; revision: number; configRevision: number; settings: Settings; rules: Rule[]; tasks: Task[]
  cursors: Record<string, Cursor>; logs: Log[]
  activity?: Activity[]; topics?: Topic[]; reports?: Report[]; brief?: Brief
  senders?: Record<string, SenderPreference>
  wechat?: WechatState
}
export interface EmailService {
  version: number
  suppressPopups?(): () => void
  accounts(): Promise<{ id: string; address: string; inboxFolder: string }[]> | { id: string; address: string; inboxFolder: string }[]
  folders?(account: string, signal?: AbortSignal): Promise<{ account: string; folders: { path: string; name: string; specialUse?: string }[] }>
  scan(input: { account: string; folder: string; cursor?: Cursor; limit?: number }, signal?: AbortSignal): Promise<{ cursor: Cursor; messages: any[]; firstRun: boolean; reset: boolean; hasMore: boolean }>
  read(account: string, folder: string, uid: number, signal?: AbortSignal): Promise<any>
  downloadAttachment(account: string, folder: string, uid: number, index: number, workspaceHint?: string, signal?: AbortSignal, expectedUidValidity?: number): Promise<any>
  drafts: {
    list?(signal?: AbortSignal): Promise<any[]>
    create(input: Record<string, unknown>, signal?: AbortSignal): Promise<any>
    get(id: string): Promise<any>
    update(id: string, revision: number, fields: Record<string, unknown>, signal?: AbortSignal): Promise<any>
    preview(id: string, revision: number, signal?: AbortSignal): Promise<any>
    send(id: string, previewId: string, confirmed: boolean, signal?: AbortSignal): Promise<any>
    resolveSend?(id: string, revision: number, outcome: 'sent' | 'not_sent', confirmed: boolean, signal?: AbortSignal): Promise<any>
  }
}
export interface AgentOutput { summary: string; needsInfo?: string; needsInfoKind?: 'information' | 'attachments'; informationGaps?: string; subject?: string; text?: string; checks?: Check[]; lowRisk?: boolean }
export interface AgentRunner { available(): boolean; run(task: Task, rule: Rule, signal: AbortSignal): Promise<{ output: AgentOutput; sessionId?: string }> }
export interface TriageInput { mail: { from: string; subject: string; body: string; hasAttachments: boolean; receivedAt: string; channel?: 'email' | 'wechat' }; rules: { id: string; name: string; semantic: string; output: 'reply' | 'report'; hint: string }[]; uiLanguage?: 'zh' | 'en' }
export interface TriageOutput { category: TriageCategory; urgency: 'high' | 'normal' | 'low'; reason: string; nextStep: string; ruleId: string }
export interface TriageRunner { available(): boolean; run(input: TriageInput, signal: AbortSignal): Promise<TriageOutput> }
export type WriterKind = 'brief' | 'weekly' | 'topic' | 'trial'
export interface WriterRunner { available(): boolean; run(kind: WriterKind, data: unknown, signal: AbortSignal): Promise<Record<string, unknown>> }
export interface RuleSuggestion { rule: Rule; warnings: string[] }
export type RuleAssistant = (input: { description: string; account: string; folder: string; uiLanguage?: 'zh' | 'en' }, signal: AbortSignal) => Promise<RuleSuggestion>
export interface InstructionSuggestion { instructions: string }
export type InstructionOptimizer = (input: { instructions: string }, signal: AbortSignal) => Promise<InstructionSuggestion>
export class WorkbenchError extends Error {
  constructor(message: string, readonly code = 'invalid', readonly status = 400) { super(message) }
}
export const now = (): string => new Date().toISOString()
