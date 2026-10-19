import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'
import { WorkbenchError, type WechatChat, type WechatList, type WechatMessage, type WechatPending, type WechatService, type WechatSettings, type WechatStatus } from './types.js'

/** Accounts that are never conversations with people: official accounts, system helpers and folded entries. */
const SYSTEM = new Set(['filehelper', 'weixin', 'fmessage', 'floatbottle', 'medianote', 'notifymessage', 'newsapp', 'brandsessionholder', 'brandservicesessionholder', 'qqmail', 'qmessage', 'tmessage', 'notification_messages', 'opencustomerservicemsg', 'officialaccounts', 'helper_entry'])
export function chatKind(id: string): 'person' | 'group' | 'other' {
  if (!id || SYSTEM.has(id) || id.startsWith('@') || id.startsWith('gh_') || id.includes('@placeholder')) return 'other'
  return id.endsWith('@chatroom') ? 'group' : 'person'
}
export const QUIET_MINUTES = 3
/** A segment is handled at the latest after this many messages or this long after it started, even in a busy chat. */
export const SEGMENT_MAX_MESSAGES = 40
export const SEGMENT_MAX_MINUTES = 30
const PENDING_CAP = 60

export function wechatSettingsOf(value?: WechatSettings): WechatSettings & { quietMinutes: number } {
  return {
    enabled: value?.enabled === true,
    ...(value?.python ? { python: value.python } : {}),
    ...(value?.library ? { library: value.library } : {}),
    people: { mode: value?.people?.mode === 'block' ? 'block' : 'allow', list: [...(value?.people?.list ?? [])] },
    groups: { mode: value?.groups?.mode === 'block' ? 'block' : 'allow', list: [...(value?.groups?.list ?? [])], scope: value?.groups?.scope === 'all' ? 'all' : 'mention' },
    quietMinutes: value?.quietMinutes ?? QUIET_MINUTES,
    ...(value?.names ? { names: { ...value.names } } : {}),
  }
}
const listed = (list: WechatList, id: string): boolean => list.mode === 'allow' ? list.list.includes(id) : !list.list.includes(id)
/** Whether a conversation may be read at all. Official and system accounts never are. */
export function chatAllowed(settings: WechatSettings | undefined, id: string): boolean {
  const s = wechatSettingsOf(settings), kind = chatKind(id)
  if (!s.enabled || kind === 'other') return false
  return listed(kind === 'group' ? s.groups : s.people, id)
}

export function appendPending(current: WechatPending | undefined, chatName: string, group: boolean, messages: WechatMessage[], arrived: string): WechatPending {
  const all = [...(current?.messages ?? []), ...messages].sort((a, b) => a.seq - b.seq)
  const unique = all.filter((m, i) => i === 0 || m.seq !== all[i - 1].seq).slice(-PENDING_CAP)
  const last = unique.at(-1)?.at || arrived
  return { chatName, group, messages: unique, firstAt: current?.firstAt ?? (unique[0]?.at || arrived), lastAt: last > arrived ? arrived : last }
}
/** Ready once the chat has been quiet long enough, or the segment grew too large or too old. */
export function segmentDue(pending: WechatPending, nowMs: number, quietMinutes: number): boolean {
  return nowMs - Date.parse(pending.lastAt) >= quietMinutes * 60000 || pending.messages.length >= SEGMENT_MAX_MESSAGES || nowMs - Date.parse(pending.firstAt) >= SEGMENT_MAX_MINUTES * 60000
}
const meaningful = (m: WechatMessage) => m.type !== '系统消息' && !!m.text.trim()
/**
 * Decide whether a finished segment becomes a task. Segments without anything from others,
 * group segments outside the mention scope, and segments you already answered in WeChat are dropped.
 */
export function segmentVerdict(pending: WechatPending, scope: 'mention' | 'all'): 'task' | 'no-others' | 'not-mentioned' | 'answered' {
  const relevant = pending.messages.filter(meaningful)
  if (!relevant.some(m => !m.self)) return 'no-others'
  if (pending.group && scope === 'mention' && !relevant.some(m => m.mentionsMe)) return 'not-mentioned'
  if (relevant.at(-1)?.self) return 'answered'
  return 'task'
}
const clock = (at: string) => { const d = new Date(at); return Number.isNaN(d.getTime()) ? '' : `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` }
/** Plain-text transcript for triage and preparation. Your own messages are labelled 我. */
export function transcript(messages: WechatMessage[]): string {
  return messages.filter(meaningful).map(m => {
    const who = m.self ? '我' : (m.senderName || m.sender || '对方')
    const quote = m.quote ? `（引用 ${m.quote.sender || ''}：${m.quote.text.slice(0, 200)}）` : ''
    return `[${clock(m.at)}] ${who}${m.mentionsMe ? '（@我）' : ''}：${m.text}${quote}`
  }).join('\n')
}
export function segmentTitle(pending: WechatPending): { from: string; title: string } {
  const last = [...pending.messages].reverse().find(m => !m.self && meaningful(m))
  const from = last?.senderName || last?.sender || pending.chatName
  const text = (last?.text || '').replace(/\s+/g, ' ').trim()
  return { from, title: `${from}：${text}`.slice(0, 80) }
}

function pythonCommand(setting: string | undefined): string[] {
  const value = setting?.trim()
  if (!value) return process.platform === 'win32' ? ['py', '-3'] : ['python3']
  if (existsSync(value) || /\.exe$/i.test(value)) return [value]
  return value.split(/\s+/)
}
export const BRIDGE_PATH = fileURLToPath(new URL('../wechat/bridge.py', import.meta.url))

/** Long-lived read-only bridge process speaking JSON lines. */
export class WechatBridge implements WechatService {
  private child?: ChildProcess
  private starting?: Promise<void>
  private next = 1
  private waiting = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  private stderr = ''
  private failedAt = 0
  private closed = false
  constructor(readonly options: { python?: string; library?: string; workdir: string; args?: string[] }) {}
  private fail(error: Error): void {
    for (const entry of this.waiting.values()) { clearTimeout(entry.timer); entry.reject(error) }
    this.waiting.clear()
  }
  private start(): Promise<void> {
    if (this.child) return Promise.resolve()
    if (this.starting) return this.starting
    if (Date.now() - this.failedAt < 15000) return Promise.reject(new WorkbenchError(`微信读取进程启动失败，稍后自动重试。${this.lastError()}`, 'wechat-unavailable', 503))
    const [command, ...prefix] = pythonCommand(this.options.python)
    // Keys the library would otherwise copy to %LOCALAPPDATA% stay in the workbench cache, so clearing it removes them too.
    const env = { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', WECHATAUTO_KEYS_DIR: join(this.options.workdir, 'keys'), ...(this.options.library ? { PYTHONPATH: [this.options.library, process.env.PYTHONPATH].filter(Boolean).join(delimiter) } : {}) }
    this.stderr = ''
    this.starting = new Promise<void>((resolve, reject) => {
      let child: ChildProcess
      try { child = spawn(command, [...prefix, BRIDGE_PATH, '--workdir', this.options.workdir, ...(this.options.library ? ['--upstream'] : []), ...(this.options.args ?? [])], { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }) }
      catch (error) { this.failedAt = Date.now(); reject(new WorkbenchError(`无法启动 Python：${(error as Error).message}`, 'wechat-unavailable', 503)); return }
      const timer = setTimeout(() => { child.kill(); reject(new WorkbenchError('微信读取进程启动超时。', 'wechat-unavailable', 503)) }, 20000)
      child.stdin!.on('error', () => {})
      child.stderr!.on('data', chunk => { this.stderr = (this.stderr + chunk.toString()).slice(-4000) })
      child.on('error', error => { clearTimeout(timer); this.failedAt = Date.now(); this.child = undefined; reject(new WorkbenchError(`无法启动 Python（${command}）：${error.message}`, 'wechat-unavailable', 503)) })
      child.on('exit', () => {
        clearTimeout(timer)
        if (this.child === child) this.child = undefined
        if (!this.closed) this.failedAt = Date.now()
        this.fail(new WorkbenchError(`微信读取进程已退出。${this.lastError()}`, 'wechat-unavailable', 503))
        reject(new WorkbenchError(`微信读取进程已退出。${this.lastError()}`, 'wechat-unavailable', 503))
      })
      createInterface({ input: child.stdout! }).on('line', line => {
        let message: any
        try { message = JSON.parse(line) } catch { return }
        if (message.event === 'ready') { clearTimeout(timer); this.child = child; resolve(); return }
        const entry = this.waiting.get(message.id)
        if (!entry) return
        this.waiting.delete(message.id); clearTimeout(entry.timer)
        if (message.ok) entry.resolve(message.result)
        else entry.reject(new WorkbenchError(`微信读取失败：${String(message.error || '未知错误').slice(0, 500)}`, 'wechat-error', 502))
      })
    }).finally(() => { this.starting = undefined })
    return this.starting
  }
  private lastError(): string {
    const line = this.stderr.trim().split(/\r?\n/).filter(Boolean).at(-1)
    return line ? ` ${line.slice(0, 300)}` : ''
  }
  async call<T>(method: string, params: Record<string, unknown> = {}, signal?: AbortSignal, timeout = 60000): Promise<T> {
    if (this.closed) throw new WorkbenchError('微信读取已停止。', 'wechat-unavailable', 503)
    await this.start()
    const id = this.next++, child = this.child!
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.waiting.delete(id); reject(new WorkbenchError('微信读取超时。', 'wechat-timeout', 504)) }, timeout)
      this.waiting.set(id, { resolve, reject, timer })
      signal?.addEventListener('abort', () => { if (this.waiting.delete(id)) { clearTimeout(timer); reject(signal.reason instanceof Error ? signal.reason : new Error('已取消')) } }, { once: true })
      child.stdin!.write(JSON.stringify({ id, method, params }) + '\n')
    })
  }
  async status(signal?: AbortSignal): Promise<WechatStatus> {
    try { return { ready: true, ...(await this.call<any>('status', {}, signal, 120000)) } }
    catch (error) { return { ready: false, error: (error as Error).message } }
  }
  chats(signal?: AbortSignal) { return this.call<WechatChat[]>('chats', { limit: 1000 }, signal) }
  search(q: string, signal?: AbortSignal) { return this.call<WechatChat[]>('search', { q }, signal) }
  latest(chats: string[], signal?: AbortSignal) { return this.call<Record<string, number>>('latest', { chats }, signal) }
  poll(watermarks: Record<string, number>, signal?: AbortSignal) { return this.call<Record<string, WechatMessage[]>>('poll', { watermarks, limit: 100 }, signal) }
  history(chat: string, offset: number, limit: number, signal?: AbortSignal) { return this.call<{ messages: WechatMessage[]; more: boolean }>('history', { chat, offset, limit }, signal) }
  close(): void {
    this.closed = true
    this.fail(new WorkbenchError('微信读取已停止。', 'wechat-unavailable', 503))
    this.child?.stdin?.end(); this.child?.kill(); this.child = undefined
  }
}

/** Owns at most one bridge and restarts it when the Python command or library folder changes. */
export class WechatConnector {
  private bridge?: WechatBridge
  private key = ''
  constructor(private workdir: string, private args: string[] = []) {}
  service(settings: WechatSettings | undefined): WechatService | undefined {
    const s = wechatSettingsOf(settings)
    if (!s.enabled) { this.close(); return undefined }
    const key = JSON.stringify([s.python ?? '', s.library ?? ''])
    if (!this.bridge || key !== this.key) { this.close(); this.bridge = new WechatBridge({ python: s.python, library: s.library, workdir: this.workdir, args: this.args }); this.key = key }
    return this.bridge
  }
  close(): void { this.bridge?.close(); this.bridge = undefined }
  /** Stop the bridge and delete its decrypted database copies and cached keys. They are rebuilt on next use. */
  async clear(): Promise<void> {
    this.close()
    await rm(this.workdir, { recursive: true, force: true })
  }
}
