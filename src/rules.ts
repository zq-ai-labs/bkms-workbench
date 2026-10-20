import { randomUUID } from 'node:crypto'
import { AUTONOMY, DEFAULT_EXCLUDE, SOURCE_KINDS, TRIAGE_CATEGORIES, WorkbenchError, type Confidence, type Rule, type TriageCategory } from './types.js'
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
  // The background runner is read/prepare only. Sending is exclusively a reviewed UI action
  // or a bounded, withdrawable automatic reply scheduled by the engine itself.
  if (rule.tools.some(t => !isPreparationTool(t))) throw new WorkbenchError('后台规则仅允许读取与查询工具；发送、写入、执行及转交能力由人工确认入口控制。')
  // Optional fields are only written when present so legacy rules keep their exact persisted shape.
  if (input.semantic !== undefined && input.semantic !== '') rule.semantic = string(input.semantic, 1000)
  if (rule.semantic === '') delete rule.semantic
  if (input.exclude !== undefined) {
    if (!Array.isArray(input.exclude) || input.exclude.some((c: unknown) => !TRIAGE_CATEGORIES.includes(c as TriageCategory))) throw new WorkbenchError('排除类别无效。')
    rule.exclude = [...new Set<TriageCategory>(input.exclude)]
  }
  if (input.autonomy !== undefined) {
    if (!AUTONOMY.includes(input.autonomy)) throw new WorkbenchError('自主级别无效。')
    if (input.autonomy !== 'draft') rule.autonomy = input.autonomy
  }
  if (rule.autonomy && rule.output !== 'reply') delete rule.autonomy
  if (input.sources !== undefined) {
    if (!Array.isArray(input.sources) || !input.sources.length || input.sources.some((s: unknown) => !SOURCE_KINDS.includes(s as any))) throw new WorkbenchError('信息来源无效。')
    const sources = [...new Set(input.sources)] as Rule['sources']
    if (!(sources!.length === 1 && sources![0] === 'email')) rule.sources = sources
  }
  if (input.matchMode !== undefined) {
    if (!['ai', 'literal'].includes(input.matchMode)) throw new WorkbenchError('匹配方式无效。')
    if (input.matchMode === 'literal') rule.matchMode = 'literal'
  }
  return rule
}
export const ruleExcludes = (rule: Rule): readonly TriageCategory[] => rule.exclude ?? DEFAULT_EXCLUDE
export const ruleSources = (rule: Rule) => rule.sources ?? ['email']
export function matches(rule: Rule, mail: { account: string; folder?: string; from: string; subject: string; hasAttachments: boolean; kind?: 'email' | 'wechat' }): boolean {
  if (!rule.enabled) return false
  // Mailbox and folder only narrow email; a WeChat segment matches by source plus sender and chat name.
  if (mail.kind === 'wechat') { if (!ruleSources(rule).includes('wechat')) return false }
  else if (!ruleSources(rule).includes('email') || (rule.account && rule.account !== mail.account) || (mail.folder && rule.folder !== mail.folder)) return false
  const tests: boolean[] = []
  if (rule.match.from) tests.push(mail.from.toLowerCase().includes(rule.match.from.toLowerCase()))
  if (rule.match.subject) tests.push(mail.subject.toLowerCase().includes(rule.match.subject.toLowerCase()))
  if (rule.match.hasAttachments) tests.push(mail.hasAttachments)
  return !tests.length || (rule.match.mode === 'any' ? tests.some(Boolean) : tests.every(Boolean))
}
const byPriority = (rules: Rule[]) => [...rules].sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id))
/** With AI triage switched off, routing is purely literal for every workflow (your explicit choice in settings). */
export const chooseRule = (rules: Rule[], mail: Parameters<typeof matches>[1]): Rule | undefined => byPriority(rules).find(rule => matches(rule, mail))
/** All enabled workflows whose literal conditions accept the mail, highest priority first. */
export const candidateRules = (rules: Rule[], mail: Parameters<typeof matches>[1]): Rule[] => byPriority(rules).filter(rule => matches(rule, mail))
export const ruleMode = (rule: Rule) => rule.matchMode ?? 'ai'
/** Workflows that take every literal match without AI, highest priority first. */
export const literalRules = (candidates: Rule[]): Rule[] => candidates.filter(rule => ruleMode(rule) === 'literal')
export type MatchDecision = { rule?: Rule; by?: 'ai' | 'literal'; suggestion?: { rule: Rule; confidence: Confidence; reason: string }; needsAi?: number }
/**
 * Decide the workflow after triage. Workflows never receive a category they exclude.
 * - AI available: its pick is applied only with high confidence (or when the pick is a literal-mode workflow);
 *   otherwise a literal-mode candidate applies, and an uncertain AI pick becomes a suggestion for you to confirm.
 * - Triage on but no AI decision (no model or the call failed): only literal-mode workflows apply; AI-mode
 *   workflows are never assigned by guesswork. (Triage switched off uses `chooseRule`: literal for all.)
 */
export function decideAfterTriage(candidates: Rule[], category: TriageCategory, ai?: { ruleId: string; confidence?: Confidence; reason?: string }): MatchDecision {
  const allowed = candidates.filter(rule => !ruleExcludes(rule).includes(category))
  const literal = literalRules(allowed)[0]
  if (ai) {
    const picked = allowed.find(rule => rule.id === ai.ruleId)
    const confidence = ai.confidence ?? 'medium'
    if (picked && (confidence === 'high' || ruleMode(picked) === 'literal')) return { rule: picked, by: 'ai' }
    if (literal) return { rule: literal, by: 'literal' }
    if (picked) return { suggestion: { rule: picked, confidence, reason: ai.reason || '' } }
    return {}
  }
  if (literal) return { rule: literal, by: 'literal' }
  const needsAi = allowed.filter(rule => ruleMode(rule) === 'ai').length
  return needsAi ? { needsAi } : {}
}
