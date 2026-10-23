import { WorkbenchError } from '../../types.js'
import { CHANNEL_API_VERSION, type Channel, type ChannelItem, type ChannelPoll, type ChannelTask } from '../types.js'
import { appendPending, chatAllowed, chatKind, segmentDue, segmentTitle, segmentVerdict, transcript, validateWechatSettings, wechatSettingsOf } from './reader.js'
import type { WechatChat, WechatPending, WechatSegment, WechatService, WechatSettings, WechatStatus } from './types.js'

/** Starts and stops the read-only bridge for the current settings. */
export interface WechatConnection { service(settings: WechatSettings | undefined): WechatService | undefined; clear?(): Promise<void>; close?(): void }

const WRITING_GUIDELINES = `微信回复规范：建议回复要像本人在微信里打字：口语、简短、直接回应对方的问题，一般一到三句话；不要称呼加落款的书信格式，不要主题行、Markdown、列表符号或表情符号堆砌。群聊里回复某人时开头用“@对方名字”。对话记录中“我”是本人。只根据对话和规则资料作答，不确定的事实列入 checks，不要编造承诺。subject 留空。`
const TRIAGE_HINT = '本条信息是一段微信对话记录（channel=wechat），“我”是收件人本人，subject 是会话名称。判断对方是否需要我做事或回复；微信里来自真人的消息不要归为 marketing。'
/** Wait for a shared promise, but stop waiting when this caller is cancelled. */
const waitFor = <T>(promise: Promise<T>, signal: AbortSignal): Promise<T> => new Promise<T>((resolve, reject) => {
  const abort = () => reject(signal.reason instanceof Error ? signal.reason : new Error('已取消'))
  if (signal.aborted) return abort()
  signal.addEventListener('abort', abort, { once: true })
  promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
})
const segmentOf = (task: ChannelTask) => (task.channelData ?? {}) as Partial<WechatSegment>

/**
 * WeChat as a read-only channel: allowed conversations are read through the local bridge, grouped into segments once a
 * chat goes quiet, and queued as tasks. The AI suggests a reply that you copy into WeChat; nothing is ever sent.
 */
export function createWechatChannel(connection: WechatConnection): Channel<WechatSettings> {
  const controller = new AbortController()
  let info: (WechatStatus & { at: number }) | undefined
  let chatList: { at: number; chats: WechatChat[] } | undefined
  /** The session-list query in flight, shared by the page and the background poll so the bridge is asked once. */
  let chatFetch: Promise<WechatChat[]> | undefined
  let generation = 0
  let lastError: string | undefined
  /** Last-message time per conversation at the last successful poll; unchanged conversations are not queried. */
  const seen = new Map<string, string>()
  let sweepAt = 0
  const safe = (error: unknown) => (error instanceof Error ? error.message : '微信读取失败。').slice(0, 1200)

  /** The bridge for the current settings, or an error explaining why WeChat cannot be read. */
  function serviceFor(settings: WechatSettings | undefined): WechatService {
    const service = wechatSettingsOf(settings).enabled ? connection.service(settings) : undefined
    if (!service) throw new WorkbenchError('请先在设置中开启微信读取。', 'wechat-disabled', 409)
    return service
  }
  /** Ask the bridge for the session list once at a time. The query belongs to the channel, so a page that goes away does not cancel it for others. */
  function fetchChats(service: WechatService): Promise<WechatChat[]> {
    if (chatFetch) return chatFetch
    const asked = generation
    const fetch = service.chats(controller.signal).then(chats => {
      // Lists changed meanwhile: the answer may be from the old settings, so it is not kept.
      if (asked === generation) chatList = { at: Date.now(), chats }
      return chats
    }).finally(() => { if (chatFetch === fetch) chatFetch = undefined })
    chatFetch = fetch
    return fetch
  }
  /** Conversations currently readable under the allow/block lists, with display names. */
  async function eligible(service: WechatService, settings: WechatSettings | undefined, signal: AbortSignal): Promise<Map<string, WechatChat>> {
    // The session list is one cheap query; it tells which conversations have anything new.
    const chats = chatList && Date.now() - chatList.at <= 4000 ? chatList.chats : await waitFor(fetchChats(service), signal)
    const s = wechatSettingsOf(settings), found = new Map<string, WechatChat>()
    for (const chat of chats) if (chatAllowed(settings, chat.id)) found.set(chat.id, chat)
    // Listed chats outside the recent session list are still read.
    for (const id of [...(s.people.mode === 'allow' ? s.people.list : []), ...(s.groups.mode === 'allow' ? s.groups.list : [])]) {
      const kind = chatKind(id)
      if (!found.has(id) && kind !== 'other' && chatAllowed(settings, id)) found.set(id, { id, name: s.names?.[id] || id, kind })
    }
    return found
  }
  /** Forget cached chat names and status after the lists change. */
  function changed(): void { generation++; chatList = undefined; chatFetch = undefined; seen.clear(); sweepAt = 0 }

  /** Read new messages from allowed conversations and group them into segments; finished segments become items. Read-only. */
  async function poll(settings: WechatSettings | undefined, saved: { cursors: Record<string, unknown>; entries: Record<string, unknown> }, signal: AbortSignal): Promise<ChannelPoll | undefined> {
    const s = wechatSettingsOf(settings)
    const service = connection.service(settings)
    if (!service || !s.enabled) return undefined
    try {
      if (!info?.ready || Date.now() - info.at > 300000) {
        info = { ...(await service.status(signal)), at: Date.now() }
        if (!info.ready) throw new WorkbenchError(info.error || '微信未就绪。', 'wechat-unavailable', 503)
      }
      const allowed = await eligible(service, settings, signal)
      const marks = saved.cursors as Record<string, number>, pending = saved.entries as Record<string, WechatPending>
      // New conversations get a baseline in batches so a large block-list setup does not stall one poll.
      const fresh = [...allowed.keys()].filter(id => marks[id] === undefined).slice(0, 100)
      // Query only conversations whose last-message time moved, plus a full sweep every minute.
      const sweep = Date.now() - sweepAt > 60000
      const moved = (id: string) => sweep || !allowed.get(id)?.lastAt || seen.get(id) !== allowed.get(id)!.lastAt
      const known = Object.fromEntries([...allowed.keys()].filter(id => marks[id] !== undefined && moved(id)).map(id => [id, marks[id]]))
      const baseline = fresh.length ? await service.latest(fresh, signal) : {}
      const batch = Object.keys(known).length ? await service.poll(known, signal) : {}
      lastError = undefined
      for (const id of Object.keys(known)) { const at = allowed.get(id)?.lastAt; if (at) seen.set(id, at) }
      if (sweep) sweepAt = Date.now()
      const nowMs = Date.now(), arrived = new Date(nowMs).toISOString()
      const stale = Object.keys(marks).some(id => !allowed.has(id)) || Object.keys(pending).some(id => !allowed.has(id))
      const due = Object.values(pending).some(item => segmentDue(item, nowMs, s.quietMinutes))
      const incoming = Object.values(batch).some(list => list.length)
      if (!stale && !due && !incoming && !Object.keys(baseline).length) return undefined
      return {
        commit(current, commitMs) {
          const watermarks = { ...(current.cursors as Record<string, number>) }, waiting = { ...(current.entries as Record<string, WechatPending>) }
          const logs: string[] = [], items: ChannelItem[] = []
          // A conversation removed from the lists is forgotten, so adding it back starts from new messages only.
          for (const id of Object.keys(watermarks)) if (!allowed.has(id)) delete watermarks[id]
          for (const id of Object.keys(waiting)) if (!allowed.has(id)) delete waiting[id]
          for (const [id, seq] of Object.entries(baseline)) if (watermarks[id] === undefined && Number.isSafeInteger(seq) && seq >= 0) { watermarks[id] = seq; logs.push(`微信会话「${allowed.get(id)?.name || id}」已建立基线，之后的新消息开始处理。`) }
          for (const [id, list] of Object.entries(batch)) {
            const chat = allowed.get(id)
            if (!chat || watermarks[id] !== known[id]) continue
            const messages = list.filter(m => Number.isSafeInteger(m.seq) && m.seq > known[id])
            if (!messages.length) continue
            watermarks[id] = Math.max(...messages.map(m => m.seq))
            let next = appendPending(waiting[id], chat.name, chat.kind === 'group', messages, arrived)
            // Groups outside the mention scope only keep a short context until someone mentions you.
            if (next.group && s.groups.scope === 'mention' && !next.messages.some(m => m.mentionsMe)) next = { ...next, messages: next.messages.slice(-10) }
            waiting[id] = next
          }
          for (const [id, item] of Object.entries(waiting)) {
            if (!segmentDue(item, commitMs, s.quietMinutes)) continue
            delete waiting[id]
            if (segmentVerdict(item, s.groups.scope) !== 'task') continue
            const seqs = item.messages.map(m => m.seq), toSeq = Math.max(...seqs), fromSeq = Math.min(...seqs)
            if (!(toSeq >= 1)) continue
            const { from, title } = segmentTitle(item)
            const segment: WechatSegment = { chat: id, chatName: item.chatName, group: item.group, messages: item.messages, fromSeq, toSeq, ...(item.messages.some(m => m.mentionsMe) ? { mentioned: true } : {}) }
            items.push({ scope: id, position: toSeq, title, from, subject: item.chatName, body: transcript(item.messages), receivedAt: item.messages.at(-1)?.at || new Date(commitMs).toISOString(), data: segment })
          }
          return { state: { cursors: watermarks, entries: waiting }, items, logs }
        },
      }
    } catch (error) { lastError = safe(error); throw error }
  }

  return {
    apiVersion: CHANNEL_API_VERSION, kind: 'wechat', label: { zh: '微信', en: 'WeChat' },
    capabilities: { reply: 'copy', archive: false },
    readonlyCode: 'wechat-readonly',
    text: {
      readonly: '微信消息只读：请复制建议回复，在微信中发送。', notClassified: '微信消息不参与业务分类。', replyNotEditable: '只有待审核的微信事项可以修改建议回复。',
      replyReady: '已生成建议回复，复制到微信后发送。', handled: '已在微信中处理。', handledLog: '微信事项已标记为已处理。', created: count => `微信新增 ${count} 个待处理事项。`,
    },
    settings: {
      defaults: () => wechatSettingsOf(undefined),
      validate(input) {
        validateWechatSettings(input)
        const value = input as WechatSettings
        return { ...value, people: { ...value.people, list: [...new Set(value.people.list)] }, groups: { ...value.groups, list: [...new Set(value.groups.list)] } }
      },
      enabled: value => wechatSettingsOf(value).enabled,
      changed,
      view: value => wechatSettingsOf(value),
    },
    health: () => ({ ready: !!info?.ready && !lastError, name: info?.name, library: info?.library, error: lastError || info?.error }),
    poll,
    ai: {
      triageHint: () => TRIAGE_HINT,
      agentInput: task => ({ conversation: { channel: 'wechat', chat: task.subject, group: !!segmentOf(task).group, transcript: task.body, lastAt: task.receivedAt } }),
      writingGuide: WRITING_GUIDELINES,
      exampleLabel: task => '微信 ' + (segmentOf(task).chatName || ''),
    },
    actions: {
      async wechatStatus(_body, { settings, signal }) {
        info = { ...(await serviceFor(settings).status(signal)), at: Date.now() }
        if (info.ready) lastError = undefined
        return info
      },
      /** The session list for the page: answered from memory at once; a list older than a minute is refreshed in the background. */
      async wechatChats(_body, { settings, signal }) {
        const service = serviceFor(settings), cached = chatList
        if (!cached) return waitFor(fetchChats(service), signal)
        if (Date.now() - cached.at > 60000) fetchChats(service).catch(() => {})
        return cached.chats
      },
      async wechatSearch(body, { settings, signal }) {
        if (typeof body.q !== 'string' || !body.q.trim() || body.q.length > 50) throw new WorkbenchError('请输入 50 字以内的名称。')
        return serviceFor(settings).search(body.q.trim(), signal)
      },
      async wechatHistory(body, { settings, signal }) {
        // Only conversations allowed by the lists can be read, and only in pages.
        const service = serviceFor(settings)
        if (typeof body.chat !== 'string' || !chatAllowed(settings, body.chat)) throw new WorkbenchError('这个会话不在允许读取的范围内。', 'wechat-blocked', 403)
        const offset = Number(body.offset ?? 0), limit = Number(body.limit ?? 50)
        if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100000 || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new WorkbenchError('分页参数无效。')
        return service.history(body.chat, offset, limit, signal)
      },
      async clearWechatCache(body, { log }) {
        if (body.confirmed !== true) throw new WorkbenchError('请确认清除。')
        await connection.clear?.()
        changed()
        await log('已清除微信本地解密缓存，下次读取时重新生成。')
        return { cleared: true }
      },
    },
    snapshot: (settings, saved) => ({ settings: wechatSettingsOf(settings), pending: Object.keys(saved.entries).length, watching: Object.keys(saved.cursors).length }),
    close() { controller.abort(new Error('微信渠道已停止')); connection.close?.() },
  }
}
