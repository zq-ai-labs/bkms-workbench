/** WeChat channel types (read-only). The workbench core never sees these; it stores the segment as a task's `channelData`. */
/** One normalized WeChat message as returned by the read-only bridge. */
export interface WechatMessage {
  seq: number; at: string; sender: string; senderName: string; self: boolean; type: string; text: string
  quote?: { sender: string; text: string }
  mentionsMe?: boolean
}
/** A WeChat conversation segment handled as one task, kept as the task's `channelData`. Nothing is ever sent. */
export interface WechatSegment {
  chat: string; chatName: string; group: boolean; messages: WechatMessage[]; fromSeq: number; toSeq: number
  mentioned?: boolean
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
