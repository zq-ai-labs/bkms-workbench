export type Status = 'queued' | 'running' | 'review' | 'needs_info' | 'failed' | 'sending' | 'sent' | 'uncertain' | 'ignored' | 'unmatched' | 'completed'
export interface Rule {
  id: string; name: string; enabled: boolean; priority: number; account: string; folder: string
  match: { from: string; subject: string; hasAttachments: boolean; mode: 'all' | 'any' }
  instructions: string; tools: string[]; skills?: string[]; output: 'reply' | 'report'; maxRetries: number
}
export interface Cursor { uidValidity: number; lastUid: number }
export interface Source { account: string; folder: string; uid: number; uidValidity: number }
export interface Task {
  id: string; revision: number; title: string; account: string; status: Status; from: string; subject: string; body: string
  receivedAt: string; updatedAt: string; ruleId?: string; ruleName?: string; rule?: Rule
  source: Source; summary?: string; error?: string; draftId?: string; draft?: any; sessionId?: string; hasAttachments?: boolean; mailLoaded?: boolean
  messageId?: string; references?: string; replyTo?: string; attachments: { filename: string; size: number; part?: string; contentType?: string; localPath?: string }[]
  history: { at: string; message: string }[]; attempts: number; nextAttemptAt?: string; supplement?: string; workspace?: string; prepareKey?: string
}
export interface Log { id: string; at: string; level: 'info' | 'error'; message: string; taskId?: string }
export interface State {
  version: 1; revision: number; configRevision: number; settings: { enabled: boolean; pollSeconds: number }; rules: Rule[]; tasks: Task[]
  cursors: Record<string, Cursor>; logs: Log[]
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
  }
}
export interface AgentOutput { summary: string; needsInfo?: string; subject?: string; text?: string }
export interface AgentRunner { available(): boolean; run(task: Task, rule: Rule, signal: AbortSignal): Promise<{ output: AgentOutput; sessionId?: string }> }
export interface RuleSuggestion { rule: Rule; warnings: string[] }
export type RuleAssistant = (input: { description: string; account: string; folder: string; uiLanguage?: 'zh' | 'en' }, signal: AbortSignal) => Promise<RuleSuggestion>
export class WorkbenchError extends Error {
  constructor(message: string, readonly code = 'invalid', readonly status = 400) { super(message) }
}
export const now = (): string => new Date().toISOString()
