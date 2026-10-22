export type Status = 'queued' | 'running' | 'review' | 'needs_info' | 'failed' | 'sending' | 'sent' | 'uncertain' | 'ignored' | 'unmatched' | 'completed'
/** How far a workflow may act without a person: draft only, bounded low-risk sending, or all bounded replies. */
export type Autonomy = 'draft' | 'low_risk' | 'auto'
export const AUTONOMY: readonly Autonomy[] = ['draft', 'low_risk', 'auto']
/** Information sources. Email and WeChat (read-only) have adapters; the others are declared so workflows and UI stay source-neutral. */
export type SourceKind = 'email' | 'feishu' | 'wecom' | 'wechat' | 'meeting'
export const SOURCE_KINDS: readonly SourceKind[] = ['email', 'feishu', 'wecom', 'wechat', 'meeting']
/** A channel kind (`source.kind`, `Rule.sources`): lower-case letters, digits and dashes. */
export const CHANNEL_KIND = /^[a-z][a-z0-9-]{0,30}$/
/** AI triage result of one incoming message. */
export type TriageCategory = 'request' | 'reply_needed' | 'fyi' | 'notification' | 'marketing' | 'other'
export const TRIAGE_CATEGORIES: readonly TriageCategory[] = ['request', 'reply_needed', 'fyi', 'notification', 'marketing', 'other']
/** Categories excluded when a workflow does not specify its own exclusions. */
export const DEFAULT_EXCLUDE: readonly TriageCategory[] = ['notification', 'marketing']
export interface Rule {
  id: string; name: string; enabled: boolean; priority: number; account: string; folder: string
  match: { from: string; subject: string; hasAttachments: boolean; mode: 'all' | 'any' }
  instructions: string; tools: string[]; skills?: string[]; output: RuleOutput; maxRetries: number
  /** `dispatch` only: the folder matched mail is moved to (created when missing), e.g. `分派/华东销售`. */
  dispatchFolder?: string
  /** Natural-language applicability judged by AI triage, e.g. “客户的报价或询价请求”. Empty = no semantic condition. */
  semantic?: string
  /** Triage categories this workflow never handles. Undefined keeps the safe default (notifications and marketing). */
  exclude?: TriageCategory[]
  autonomy?: Autonomy
  /** `email` and channel kinds; a channel that is not installed simply brings no items. */
  sources?: string[]
  /**
   * How a message is assigned. `ai` (default): only when AI confirms the workflow fits; uncertain cases are
   * suggested to you and nothing is assigned without a model. `literal`: every message meeting the literal
   * conditions is handled, e.g. everything in a dedicated folder.
   */
  matchMode?: MatchMode
}
export type MatchMode = 'ai' | 'literal'
/**
 * What a workflow produces. `dispatch` hands the mail to someone else: it is moved to `dispatchFolder` in the
 * mailbox, where that team's own workbench (or mail client) picks it up. No agent runs for a dispatch.
 */
export type RuleOutput = 'reply' | 'report' | 'dispatch'
export const RULE_OUTPUTS: readonly RuleOutput[] = ['reply', 'report', 'dispatch']
export type Confidence = 'high' | 'medium' | 'low'
/** How a task got (or was offered) its workflow, shown as “why this workflow”. */
export interface MatchInfo { ruleId: string; ruleName: string; by: 'ai' | 'literal' | 'manual'; state: 'applied' | 'suggested' | 'rejected'; confidence?: Confidence; reason?: string; at: string }
/** A message you confirmed or rejected for a workflow, kept as a short summary and shown to AI as an example. */
export interface RuleExample { id: string; match: boolean; text: string; at: string; taskId?: string }
/**
 * A business category in a classification scheme, e.g. 投诉. `include` and `exclude` are the user's own definition
 * and boundaries; the AI picks exactly one category per message. `fallback` is the scheme's "none of these" category.
 */
export interface ClassifierCategory { id: string; name: string; include: string; exclude?: string; action: CategoryAction; folder?: string; fallback?: true }
/** `label` only records the category; `move` also moves the mail to `folder` (created when missing). */
export type CategoryAction = 'label' | 'move'
/**
 * A classification scheme for one mailbox folder: every new message there gets exactly one category, or waits for
 * you when the AI is unsure. Categories are in priority order; `guidance` says how to choose between them.
 */
export interface Classifier {
  id: string; name: string; enabled: boolean; account: string; folder: string; guidance?: string
  /** Classify notifications and marketing too. Off by default: they are archived as before. */
  includeNotices?: boolean
  categories: ClassifierCategory[]
}
/** The category a message got. `pending` waits for you in “待人工分类”, with the AI's ordered candidates. */
export interface Classification {
  classifierId: string; categoryId?: string; categoryName?: string; state: 'applied' | 'pending'
  by: 'ai' | 'manual'; confidence?: Confidence; reason?: string; candidates?: string[]; at: string
}
export interface Cursor { uidValidity: number; lastUid: number }
/**
 * Where a task came from. Mail: account, folder, UID and the folder's generation. Another channel sets `kind` to its
 * own kind; `folder` is its scope (e.g. a conversation) and `uid` the position there, e.g. the last message.
 */
export interface Source { account: string; folder: string; uid: number; uidValidity: number; kind?: string }
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
export interface SuggestedReply { text: string; revision: number }
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
  /** Channel-private data of an item from another channel (e.g. a conversation segment); only that channel reads it. */
  channelData?: unknown
  /** The AI's suggested reply for a channel where replies are copied by hand; nothing is ever sent from here. */
  reply?: SuggestedReply
  match?: MatchInfo
  /** Business category from a classification scheme. */
  classification?: Classification
  /** Where a dispatch workflow moved the mail; the original is read from here afterwards. */
  dispatch?: { folder: string; uid?: number; uidValidity?: number; at: string }
  /** Picked up by processing history from a chosen start time: never sent automatically. */
  backfill?: true
}
export type ActivityKind = 'dispatch' | 'archive' | 'auto_send_scheduled' | 'auto_sent' | 'auto_send_canceled' | 'auto_send_blocked' | 'report' | 'brief' | 'weekly' | 'topic'
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
/** Your profile (Settings › My profile). Shown to the AI as trusted context; never passwords or keys. */
export interface Profile { name?: string; department?: string; role?: string; title?: string; phone?: string; company?: string; signature?: string; timezone?: string }
export interface Settings {
  enabled: boolean; pollSeconds: number; showWorkbench?: boolean; notifyNewTodo?: boolean
  /** AI triage before workflow matching. Defaults on. */
  triage?: boolean
  /** Delay before an automatic reply is actually submitted; it can be withdrawn meanwhile. */
  undoMinutes?: number
  briefEnabled?: boolean; briefTime?: string
  weeklyEnabled?: boolean; weeklyDay?: number; weeklyTime?: string
  meetingBriefMinutes?: number
  /** Settings of other channels by kind, validated by each channel before saving. */
  channels?: Record<string, unknown>
  /** Who uses this workbench, for `{{user.*}}` variables and the AI's runtime context. No secrets. */
  profile?: Profile
  /** Optional pages hidden from the workbench navigation. */
  hiddenViews?: HideableView[]
}
export type HideableView = 'today' | 'meetings' | 'topics'
export const HIDEABLE_VIEWS: readonly HideableView[] = ['today', 'meetings', 'topics']
export interface State {
  version: 1; revision: number; configRevision: number; settings: Settings; rules: Rule[]; tasks: Task[]
  cursors: Record<string, Cursor>; logs: Log[]
  activity?: Activity[]; topics?: Topic[]; reports?: Report[]; brief?: Brief
  senders?: Record<string, SenderPreference>
  /** Learned examples per workflow, outside `rules` so learning never bumps the configuration revision. */
  ruleExamples?: Record<string, RuleExample[]>
  /** Classification schemes (configuration: saving one bumps `configRevision`). */
  classifiers?: Classifier[]
  /** Learned examples per category id, outside `classifiers` so learning never bumps the configuration revision. */
  categoryExamples?: Record<string, RuleExample[]>
  /** Interface language last used in the workbench; AI-written review text (judgments, summaries, checks) follows it. */
  uiLanguage?: 'zh' | 'en'
  /**
   * History being processed after a baseline was moved back to a chosen time, keyed like `cursors`.
   * Mail up to `untilUid` is marked as backfill; `skip` lists mail already answered when the range was chosen.
   */
  backfills?: Record<string, Backfill>
}
export interface Backfill { uidValidity: number; untilUid: number; skip: number[]; since: string; at: string }
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
  /** Move one message to `target` (created when missing); returns where it landed. Used by dispatch workflows. */
  move?(account: string, folder: string, uid: number, target: string, signal?: AbortSignal, expectedUidValidity?: number): Promise<{ folder: string; uid?: number; uidValidity?: number }>
  /** Mail received at or after `since` in one folder: how many, the first UID, and which were already answered. */
  window?(account: string, folder: string, since: Date, signal?: AbortSignal): Promise<MailWindow>
  /** Up to `limit` messages received in [since, until), newest first, with a short text excerpt; read-only. */
  listRange?(account: string, folder: string, since: Date, until: Date, limit: number, signal?: AbortSignal): Promise<RangeMessage[]>
}
export interface MailWindow { uidValidity: number; count: number; firstUid?: number; lastUid?: number; answered: number[] }
export interface RangeMessage { uid: number; from: string; subject: string; date: string; hasAttachments: boolean; excerpt: string }
export interface AgentOutput { summary: string; needsInfo?: string; needsInfoKind?: 'information' | 'attachments'; informationGaps?: string; subject?: string; text?: string; checks?: Check[]; lowRisk?: boolean }
/** Trusted runtime context for the AI: variable values for the instructions and a short description of who and when. */
export interface RuntimeContext { values: Record<string, string>; text: string }
/** For an item from another channel: its writing rules and what the agent reads, under the channel's own key. */
export interface AgentChannel { kind: string; guide: string; input: Record<string, unknown> }
export interface AgentRunner { available(): boolean; run(task: Task, rule: Rule, signal: AbortSignal, options?: { language?: 'zh' | 'en'; context?: RuntimeContext; channel?: AgentChannel }): Promise<{ output: AgentOutput; sessionId?: string }> }
export interface TriageInput { mail: { from: string; subject: string; body: string; quotedHistory?: string; hasAttachments: boolean; receivedAt: string; channel?: string }; channelHint?: string; thread?: { previousRule?: { id: string; name: string } }; classifier?: TriageClassifier; context?: { now: string; timezone: string; department?: string; role?: string }; rules: { id: string; name: string; semantic: string; output: RuleOutput; hint: string; examples?: { match: boolean; text: string }[] }[]; uiLanguage?: 'zh' | 'en' }
export interface TriageOutput { category: TriageCategory; urgency: 'high' | 'normal' | 'low'; reason: string; nextStep: string; ruleId: string; confidence?: Confidence; ruleReason?: string; business?: BusinessVerdict }
/** What the triage model sees of a classification scheme. */
export interface TriageClassifier { guidance: string; categories: { id: string; name: string; include: string; exclude: string; fallback: boolean; examples: { match: boolean; text: string }[] }[] }
/** The model's business category: one id (or empty), how sure, why, and the next likely categories. */
export interface BusinessVerdict { categoryId: string; confidence: Confidence; reason: string; alternatives: string[] }
export interface TriageRunner { available(): boolean; run(input: TriageInput, signal: AbortSignal): Promise<TriageOutput> }
export type WriterKind = 'brief' | 'weekly' | 'topic' | 'trial' | 'classify'
export interface WriterRunner { available(): boolean; run(kind: WriterKind, data: unknown, signal: AbortSignal): Promise<Record<string, unknown>> }
export interface RuleSuggestion { rule: Rule; warnings: string[] }
export type RuleAssistant = (input: { description: string; account: string; folder: string; uiLanguage?: 'zh' | 'en' }, signal: AbortSignal) => Promise<RuleSuggestion>
export interface InstructionSuggestion { instructions: string }
export type InstructionOptimizer = (input: { instructions: string }, signal: AbortSignal) => Promise<InstructionSuggestion>
export class WorkbenchError extends Error {
  constructor(message: string, readonly code = 'invalid', readonly status = 400) { super(message) }
}
export const now = (): string => new Date().toISOString()
