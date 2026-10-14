import { randomUUID } from 'node:crypto'
import { WorkbenchError, type Rule } from './types.js'
import { isPreparationTool } from './agent.js'
const string = (v: unknown, max: number): string => { if (typeof v !== 'string' || v.length > max || v.includes('\0')) throw new WorkbenchError('规则字段格式或长度无效。'); return v.trim() }
export function validateRule(input: any): Rule {
  if (!input || typeof input !== 'object' || !input.match) throw new WorkbenchError('请填写完整规则。')
  const rule: Rule = {
    id: input.id ? string(input.id, 80) : randomUUID(), name: string(input.name, 100), enabled: input.enabled === true,
    priority: Number(input.priority), account: string(input.account ?? '', 200), folder: string(input.folder || 'INBOX', 200),
    match: { from: string(input.match.from ?? '', 1000), subject: string(input.match.subject ?? '', 1000), hasAttachments: input.match.hasAttachments === true, mode: input.match.mode === 'any' ? 'any' : 'all' },
    instructions: string(input.instructions, 16000), tools: [], output: input.output === 'report' ? 'report' : 'reply', maxRetries: Number(input.maxRetries ?? 1),
  }
  if (!rule.name || !rule.instructions || !Number.isSafeInteger(rule.priority) || Math.abs(rule.priority) > 10000 || !Number.isSafeInteger(rule.maxRetries) || rule.maxRetries < 0 || rule.maxRetries > 3) throw new WorkbenchError('规则名称和处理要求必填；优先级为 ±10000 内整数，重试次数为 0–3。')
  if (!Array.isArray(input.tools) || input.tools.length > 30 || input.tools.some((t: unknown) => typeof t !== 'string' || !/^[\w.-]{1,120}$/.test(t))) throw new WorkbenchError('工具应为最多 30 个准确工具名称。')
  rule.tools = [...new Set<string>(input.tools)]
  const skills = input.skills ?? []
  if (!Array.isArray(skills) || skills.length > 10 || skills.some((s: unknown) => typeof s !== 'string' || !s.trim() || s.length > 200 || /[\r\n\0]/.test(s))) throw new WorkbenchError('请选择最多 10 个有效技能。')
  rule.skills = [...new Set<string>(skills)]
  // The background runner is read/prepare only. Sending is exclusively a reviewed UI action.
  if (rule.tools.some(t => !isPreparationTool(t))) throw new WorkbenchError('后台规则仅允许读取与查询工具；发送、写入、执行及转交能力由人工确认入口控制。')
  return rule
}
export function matches(rule: Rule, mail: { account: string; folder?: string; from: string; subject: string; hasAttachments: boolean }): boolean {
  if (!rule.enabled || (rule.account && rule.account !== mail.account) || (mail.folder && rule.folder !== mail.folder)) return false
  const tests: boolean[] = []
  if (rule.match.from) tests.push(mail.from.toLowerCase().includes(rule.match.from.toLowerCase()))
  if (rule.match.subject) tests.push(mail.subject.toLowerCase().includes(rule.match.subject.toLowerCase()))
  if (rule.match.hasAttachments) tests.push(mail.hasAttachments)
  return !tests.length || (rule.match.mode === 'any' ? tests.some(Boolean) : tests.every(Boolean))
}
export const chooseRule = (rules: Rule[], mail: Parameters<typeof matches>[1]): Rule | undefined => [...rules].sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id)).find(rule => matches(rule, mail))
