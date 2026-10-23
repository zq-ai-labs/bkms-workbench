import { SOURCE_KINDS } from './types.js'
import type { Channel } from './channels/types.js'

/**
 * Connection status of each information source, for the page. Mail is built in; other sources are installed channels
 * (`src/channels`). A source that is declared but not installed shows `adapter-required`: the workbench never
 * simulates a connection that does not exist.
 */
export interface SourceStatus { kind: string; connected: boolean; detail: string }

export function sourceStatuses(email: { ready: boolean; accounts: number; error?: string }, channels: { channel: Channel; settings: unknown }[]): SourceStatus[] {
  const installed = new Map(channels.map(item => [item.channel.kind, item]))
  const status = (kind: string): SourceStatus => {
    if (kind === 'email') return { kind, connected: email.ready && email.accounts > 0, detail: email.ready ? (email.accounts ? `${email.accounts}` : 'no-account') : 'unavailable' }
    const found = installed.get(kind)
    if (!found) return { kind, connected: false, detail: 'adapter-required' }
    const enabled = found.channel.settings.enabled(found.settings), health = found.channel.health()
    return { kind, connected: enabled && !!health?.ready, detail: !enabled ? 'disabled' : health?.ready ? (health.name || 'ready') : 'unavailable' }
  }
  return [...new Set<string>([...SOURCE_KINDS, ...installed.keys()])].map(status)
}
