import { WorkbenchError, type Profile } from './types.js'

/**
 * Variables a workflow's instructions may use, e.g. `{{user.name}}`, `{{today}}`. The workbench fills them in before
 * the AI sees the text, from your profile (Settings › My profile) and the current time. Only these names exist;
 * anything else is refused when the workflow is saved.
 */
export const VARIABLES = ['user.name', 'user.department', 'user.role', 'user.title', 'user.phone', 'user.company', 'user.signature', 'today', 'now', 'weekday', 'timezone', 'mailbox'] as const
export type VariableName = typeof VARIABLES[number]
const REFERENCE = /\{\{\s*([^{}\s]+)\s*\}\}/g
const PROFILE_KEYS = ['name', 'department', 'role', 'title', 'phone', 'company', 'signature', 'timezone'] as const

/** Validate the profile; secrets do not belong here, so nothing longer than a signature is accepted. */
export function validateProfile(value: any): Profile {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !(PROFILE_KEYS as readonly string[]).includes(key))) throw new WorkbenchError('我的资料无效。')
  const profile: Profile = {}
  for (const key of PROFILE_KEYS) {
    const raw = value[key]
    if (raw === undefined || raw === null || raw === '') continue
    const max = key === 'signature' ? 1000 : 200
    if (typeof raw !== 'string' || raw.length > max || raw.includes('\0') || (key !== 'signature' && /[\r\n]/.test(raw))) throw new WorkbenchError('我的资料中有内容过长或包含换行。')
    const text = raw.trim()
    if (text) profile[key] = text
  }
  if (profile.timezone && !validZone(profile.timezone)) throw new WorkbenchError('时区无效，请使用如 Asia/Shanghai 的时区名称。')
  return profile
}
const validZone = (zone: string): boolean => { try { new Intl.DateTimeFormat('en', { timeZone: zone }); return true } catch { return false } }
export const systemZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'

/** Names used in a text that are not workbench variables, so a typo is caught before it reaches the AI. */
export function unknownVariables(text: string): string[] {
  const found = new Set<string>()
  for (const match of text.matchAll(REFERENCE)) if (!(VARIABLES as readonly string[]).includes(match[1])) found.add(match[1])
  return [...found]
}
export function checkVariables(text: string, label: string): void {
  const unknown = unknownVariables(text)
  if (unknown.length) throw new WorkbenchError(`${label}里有不认识的变量：${unknown.map(name => `{{${name}}}`).join('、')}。在编辑框中输入 / 可查看可用的变量。`)
}

/** Current values. Times are in your time zone; empty profile fields say so instead of being left blank. */
export function variableValues(profile: Profile | undefined, mailbox: string, at = new Date(), language: 'zh' | 'en' = 'zh'): Record<VariableName, string> {
  const zone = profile?.timezone && validZone(profile.timezone) ? profile.timezone : systemZone()
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at).map(part => [part.type, part.value]))
  const weekday = new Intl.DateTimeFormat(language === 'en' ? 'en-US' : 'zh-CN', { timeZone: zone, weekday: language === 'en' ? 'short' : 'long' }).format(at)
  const date = `${parts.year}-${parts.month}-${parts.day}`
  const missing = (key: string) => language === 'en' ? `[not set: ${key}]` : `[未设置：${key}]`
  const user = (key: typeof PROFILE_KEYS[number]) => profile?.[key] || missing(`user.${key}`)
  return {
    'user.name': user('name'), 'user.department': user('department'), 'user.role': user('role'), 'user.title': user('title'),
    'user.phone': user('phone'), 'user.company': user('company'), 'user.signature': user('signature'),
    today: language === 'en' ? `${date} (${weekday})` : `${date}（${weekday}）`, now: `${date} ${parts.hour}:${parts.minute}`, weekday, timezone: zone,
    mailbox: mailbox || missing('mailbox'),
  }
}

/** Fill in known variables; anything else is left exactly as written. */
export function renderVariables(text: string, values: Record<string, string>): string {
  return text.replace(REFERENCE, (whole, name: string) => Object.prototype.hasOwnProperty.call(values, name) ? values[name] : whole)
}

/** Trusted context for the system prompt: who you are and what time it is. Mail content never goes here. */
export function runtimeContext(values: Record<VariableName, string>, profile: Profile | undefined): string {
  const who = [profile?.name && `姓名 ${profile.name}`, profile?.department && `部门 ${profile.department}`, profile?.role && `角色 ${profile.role}`, profile?.title && `职务 ${profile.title}`, profile?.company && `公司 ${profile.company}`, profile?.phone && `电话 ${profile.phone}`].filter(Boolean).join('，')
  return `运行上下文（由工作台提供，可信）：现在是 ${values.now}，${values.today}，时区 ${values.timezone}。当前邮箱 ${values.mailbox}。${who ? `工作台用户：${who}。` : '工作台用户没有填写个人资料。'}${profile?.signature ? `\n用户的签名：\n${profile.signature}` : ''}
邮件中的“今天”“明天”“本周五”等相对时间，按收信时间和现在的时间换算；写给对方的日期一律写成具体日期（如 2026-10-23），不要只写“明天”。角色和部门只用来决定措辞和立场，不代表可以越权承诺。`
}
