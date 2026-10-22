/**
 * Contract between the workbench core and a channel (docs/DESIGN-CORE-CHANNELS.md §4). A channel brings items in and
 * describes them; the core owns the queue, triage, workflows, the AI run, review and storage. Mail is the built-in
 * channel; other channels register through `ctx.workbenchChannels`, each from its own plugin.
 *
 * Any incompatible change to this file bumps CHANNEL_API_VERSION. A channel built for another version is refused and
 * the settings page asks to upgrade the older side (decision D10); there is no compatibility layer.
 */
export const CHANNEL_API_VERSION = 1
export type Lang = 'zh' | 'en'

export interface ChannelCapabilities {
  /** `copy`: the AI suggests a reply that a person copies into the channel's own app. Nothing is ever sent. */
  reply: 'copy' | 'none'
  /** Whether triage may archive notifications silently. A channel of messages from people keeps everything in view. */
  archive: boolean
}
/** What a channel saved between polls: a cursor per scope (e.g. a conversation) and any other entries. Stored by the core. */
export interface ChannelState { cursors: Record<string, unknown>; entries: Record<string, unknown> }
/**
 * A new item for the queue. `scope` and `position` identify it within the channel (e.g. a conversation and its last
 * message), so it is never queued twice. `data` is kept with the task as `channelData` and handed back to the channel.
 */
export interface ChannelItem { scope: string; position: number; title: string; from: string; subject: string; body: string; receivedAt: string; data?: unknown }
/** One poll's result, applied by the core inside one transaction to the freshly read state. No I/O in `commit`. */
export interface ChannelPoll {
  commit(saved: ChannelState, nowMs: number): { state: ChannelState; items: ChannelItem[]; logs: string[] }
}
/**
 * A task as a channel sees it. Items of one scope (one conversation) are related, and per-contact preferences such as
 * “never archive” are kept by channel and scope.
 */
export interface ChannelTask { id: string; title: string; from: string; subject: string; body: string; receivedAt: string; source: { folder: string; uid: number }; channelData?: unknown }
export interface ChannelHealth { ready: boolean; name?: string; library?: string; error?: string }
/** Wording that names the channel. The page translates it like any other message from the server. */
export interface ChannelText {
  /** Refusing a mail-only action (draft, send, load the original) on this channel's items. */
  readonly: string
  /** Business categories are for mail only. */
  notClassified: string
  /** The suggested reply can only be edited while the item waits for review. */
  replyNotEditable: string
  /** Task history once a suggested reply is ready. */
  replyReady: string
  /** Task history and log once a person marks the item as handled in the channel's app. */
  handled: string
  handledLog: string
  /** Log after a poll queued new items. */
  created(count: number): string
}
export interface ActionContext<S> { settings: S | undefined; signal: AbortSignal; log(message: string): Promise<void> }
export interface Channel<S = unknown> {
  apiVersion: number
  /** Stored with every task of this channel (`source.kind`); never changes. */
  kind: string
  label: Record<Lang, string>
  capabilities: ChannelCapabilities
  text: ChannelText
  /** Error code when a mail-only action is used on this channel's items. */
  readonlyCode: string
  /** Settings live under `settings.channels[kind]`, validated here before they are saved. */
  settings: { defaults(): S; validate(input: unknown): S; enabled(value: S | undefined): boolean; changed?(): void; view?(value: S | undefined): unknown }
  health(): ChannelHealth | undefined
  /** Read new content. Return undefined when nothing needs saving. */
  poll(settings: S | undefined, saved: ChannelState, signal: AbortSignal): Promise<ChannelPoll | undefined>
  ai: {
    /** Appended to the triage instructions for this channel's items. */
    triageHint?(lang: Lang): string
    /** What the preparation agent reads for one item, under its own key (e.g. `conversation`). */
    agentInput(task: ChannelTask): Record<string, unknown>
    /** Writing rules for suggested replies. */
    writingGuide: string
    /** Short prefix of a learned example: the channel and the conversation. */
    exampleLabel(task: ChannelTask): string
  }
  /** Channel actions for the page, by action name. */
  actions?: Record<string, (body: Record<string, unknown>, context: ActionContext<S>) => Promise<unknown>>
  /** Data for the page under `snapshot.channels[kind]`. */
  snapshot?(settings: S | undefined, saved: ChannelState): unknown
  close?(): void | Promise<void>
}
