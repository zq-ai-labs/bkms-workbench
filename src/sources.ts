import type { SourceKind } from './types.js'

/**
 * Contract for an information source. Email is implemented through the dsh-email
 * `emailWorkbench` service; IM and meeting platforms need an adapter that fulfils
 * the same contract before they can be connected. The workbench never simulates
 * a connection that does not exist.
 */
export interface SourceAdapter {
  kind: SourceKind
  /** Incremental read from a cursor; returns normalized messages and the next cursor. */
  scan(cursor: unknown, signal: AbortSignal): Promise<{ cursor: unknown; messages: { id: string; from: string; subject: string; text: string; at: string; thread?: string }[] }>
  /** Reply in the original conversation. Only ever invoked after review or within a workflow's bounded autonomy. */
  reply?(messageId: string, text: string, signal: AbortSignal): Promise<{ receipt: string }>
}

export interface SourceStatus { kind: SourceKind; connected: boolean; detail: string }

export function sourceStatuses(email: { ready: boolean; accounts: number; error?: string }): SourceStatus[] {
  return [
    { kind: 'email', connected: email.ready && email.accounts > 0, detail: email.ready ? (email.accounts ? `${email.accounts}` : 'no-account') : 'unavailable' },
    { kind: 'feishu', connected: false, detail: 'adapter-required' },
    { kind: 'wecom', connected: false, detail: 'adapter-required' },
    { kind: 'wechat', connected: false, detail: 'adapter-required' },
    { kind: 'meeting', connected: false, detail: 'adapter-required' },
  ]
}
