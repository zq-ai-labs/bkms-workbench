import { CHANNEL_API_VERSION, type Channel, type Lang } from './types.js'

/** A channel that could not be used, and which side has to be upgraded (decision D10). */
export interface RejectedChannel { kind: string; label: Record<Lang, string>; upgrade: 'channel' | 'workbench' }

/** The channels that are currently installed. Mail is built in and not listed here. */
export class ChannelRegistry {
  private readonly channels = new Map<string, Channel<any>>()
  private readonly refused = new Map<string, RejectedChannel>()
  /** Add a channel; the returned function removes it again (plugin unloaded). Same version only. */
  register(channel: Channel<any>): () => void {
    if (!/^[a-z][a-z0-9-]{0,30}$/.test(channel.kind) || channel.kind === 'email') throw new Error(`invalid channel kind: ${channel.kind}`)
    if (channel.apiVersion !== CHANNEL_API_VERSION) {
      this.refused.set(channel.kind, { kind: channel.kind, label: channel.label, upgrade: channel.apiVersion < CHANNEL_API_VERSION ? 'channel' : 'workbench' })
      return () => { this.refused.delete(channel.kind) }
    }
    if (this.channels.has(channel.kind)) throw new Error(`channel already registered: ${channel.kind}`)
    for (const name of Object.keys(channel.actions ?? {})) if (this.actionOwner(name)) throw new Error(`channel action already registered: ${name}`)
    this.channels.set(channel.kind, channel)
    this.refused.delete(channel.kind)
    return () => { if (this.channels.get(channel.kind) === channel) { this.channels.delete(channel.kind); void channel.close?.() } }
  }
  /** The channel of a kind stored on a task; undefined for mail and for a channel that is not installed. */
  get(kind: string | undefined): Channel<any> | undefined { return kind ? this.channels.get(kind) : undefined }
  list(): Channel<any>[] { return [...this.channels.values()] }
  rejected(): RejectedChannel[] { return [...this.refused.values()] }
  actionOwner(action: string): Channel<any> | undefined { return this.list().find(channel => Object.hasOwn(channel.actions ?? {}, action)) }
  async close(): Promise<void> { for (const channel of this.list()) await channel.close?.() }
}
