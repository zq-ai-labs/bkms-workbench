import { randomUUID } from 'node:crypto'
import { WorkbenchError, type BusinessVerdict, type Classifier, type ClassifierCategory, type RuleExample, type State, type TriageClassifier } from './types.js'

/** Most recent learned examples per category given to the AI. */
export const CATEGORY_EXAMPLES = 6
const MAX_CATEGORIES = 30

const text = (value: unknown, max: number, label: string, required = false): string => {
  if (value === undefined || value === null) value = ''
  if (typeof value !== 'string' || value.length > max || value.includes('\0')) throw new WorkbenchError(`${label}无效或过长（最多 ${max} 字）。`)
  const trimmed = value.trim()
  if (required && !trimmed) throw new WorkbenchError(`请填写${label}。`)
  return trimmed
}
/** A folder path as typed: `/` separates levels; the mail service converts it to the server's delimiter. */
export const folderPath = (value: unknown, label: string): string => {
  const path = text(value, 200, label).replace(/^\/+|\/+$/g, '')
  if (/[\r\n\t*%]/.test(path)) throw new WorkbenchError(`${label}包含不允许的字符。`)
  return path
}

/** Validate and normalize a classification scheme. The "none of these" category always comes last. */
export function validateClassifier(input: any): Classifier {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new WorkbenchError('分类方案无效。')
  const classifier: Classifier = {
    id: input.id ? text(input.id, 80, '分类方案编号') : randomUUID(), name: text(input.name, 100, '分类方案名称', true), enabled: input.enabled === true,
    account: text(input.account, 200, '邮箱'), folder: folderPath(input.folder || 'INBOX', '读取的文件夹') || 'INBOX', categories: [],
  }
  const guidance = text(input.guidance, 4000, '总说明')
  if (guidance) classifier.guidance = guidance
  if (input.includeNotices === true) classifier.includeNotices = true
  if (!Array.isArray(input.categories) || input.categories.length > MAX_CATEGORIES) throw new WorkbenchError(`分类最多 ${MAX_CATEGORIES} 个。`)
  const names = new Set<string>(), ids = new Set<string>()
  for (const raw of input.categories) {
    if (!raw || typeof raw !== 'object') throw new WorkbenchError('分类无效。')
    const fallback = raw.fallback === true
    const category: ClassifierCategory = {
      id: raw.id ? text(raw.id, 80, '分类编号') : randomUUID(), name: text(raw.name, 40, '分类名称', true),
      include: text(raw.include, 2000, `分类「${String(raw.name ?? '').slice(0, 40)}」的“属于本类”`, !fallback) || '不属于以上任何一类。',
      action: raw.action === 'move' ? 'move' : 'label',
    }
    const exclude = text(raw.exclude, 2000, `分类「${category.name}」的“不属于本类”`)
    if (exclude) category.exclude = exclude
    if (category.action === 'move') {
      const folder = folderPath(raw.folder, `分类「${category.name}」的目标文件夹`)
      if (!folder) throw new WorkbenchError(`分类「${category.name}」要移到文件夹，请填写目标文件夹。`)
      if (folder.toLowerCase() === classifier.folder.toLowerCase()) throw new WorkbenchError(`分类「${category.name}」的目标文件夹不能是方案读取的文件夹。`)
      category.folder = folder
    }
    if (fallback) category.fallback = true
    const key = category.name.toLowerCase()
    if (names.has(key)) throw new WorkbenchError(`分类名称「${category.name}」重复。`)
    if (ids.has(category.id)) throw new WorkbenchError('分类编号重复，请刷新后重试。')
    names.add(key); ids.add(category.id)
    classifier.categories.push(category)
  }
  const fallbacks = classifier.categories.filter(category => category.fallback)
  if (fallbacks.length > 1) throw new WorkbenchError('只能有一个“其他”分类。')
  if (!fallbacks.length) classifier.categories.push({ id: randomUUID(), name: names.has('其他') ? '其他（兜底）' : '其他', include: '不属于以上任何一类。', action: 'label', fallback: true })
  else classifier.categories = [...classifier.categories.filter(category => !category.fallback), fallbacks[0]]
  if (classifier.categories.length < 2) throw new WorkbenchError('至少需要一个业务分类。')
  return classifier
}

/** The enabled scheme that covers a mailbox folder, if any. Only email is classified; WeChat is read-only. */
export function classifierFor(state: Pick<State, 'classifiers'>, account: string, folder: string): Classifier | undefined {
  return state.classifiers?.find(item => item.enabled && (!item.account || item.account === account) && item.folder === folder)
}
/** Two enabled schemes may not cover the same folder: a message gets exactly one category. */
export function overlapping(classifiers: Classifier[], candidate: Classifier): Classifier | undefined {
  if (!candidate.enabled) return undefined
  return classifiers.find(item => item.id !== candidate.id && item.enabled && item.folder === candidate.folder && (!item.account || !candidate.account || item.account === candidate.account))
}

export function triageClassifier(classifier: Classifier, examples: State['categoryExamples']): TriageClassifier {
  return {
    guidance: classifier.guidance ?? '',
    categories: classifier.categories.map(category => ({
      id: category.id, name: category.name, include: category.include, exclude: category.exclude ?? '', fallback: category.fallback === true,
      examples: (examples?.[category.id] ?? []).slice(-CATEGORY_EXAMPLES).map(({ match, text }) => ({ match, text })),
    })),
  }
}

/** The structured-output part the triage model fills in for a scheme. */
export const businessSchema = {
  type: 'object', additionalProperties: false, required: ['categoryId', 'confidence', 'reason'],
  properties: {
    categoryId: { type: 'string', description: '业务分类 id，只能从 classifier.categories 中选一个；拿不准也先填最可能的一个' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'], description: 'high=明确符合该分类的“属于本类”且不在“不属于本类”之列；medium=可能属于但与其他分类难以区分；low=只是勉强相关' },
    reason: { type: 'string', maxLength: 200, description: '一句话说明归入该分类的依据，引用邮件中的事实' },
    alternatives: { type: 'array', maxItems: 3, items: { type: 'string' }, description: '其次可能的分类 id，按可能性排序；没有则为空' },
  },
}
export function parseBusiness(value: any, ids: Set<string>): BusinessVerdict {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['categoryId', 'confidence', 'reason', 'alternatives'].includes(key))) throw new WorkbenchError('业务分类结果无效。')
  if (!['high', 'medium', 'low'].includes(value.confidence)) throw new WorkbenchError('业务分类把握程度无效。')
  if (typeof value.reason !== 'string' || value.reason.length > 400) throw new WorkbenchError('业务分类理由无效。')
  const known = typeof value.categoryId === 'string' && ids.has(value.categoryId.trim())
  const alternatives: string[] = Array.isArray(value.alternatives) ? [...new Set<string>(value.alternatives.filter((id: unknown): id is string => typeof id === 'string' && ids.has(id)))].slice(0, 3) : []
  // An id the scheme does not have is no answer: the message waits for you instead of landing somewhere arbitrary.
  return { categoryId: known ? value.categoryId.trim() : '', confidence: known ? value.confidence : 'low', reason: value.reason.trim().slice(0, 200), alternatives }
}

/** Apply only a confident pick; anything else waits for you with the AI's candidates in order. */
export function decideCategory(classifier: Classifier, verdict: BusinessVerdict | undefined): { category: ClassifierCategory } | { candidates: string[] } {
  const category = verdict?.categoryId ? classifier.categories.find(item => item.id === verdict.categoryId) : undefined
  if (category && verdict!.confidence === 'high') return { category }
  const known = new Set(classifier.categories.map(item => item.id))
  return { candidates: [...new Set([verdict?.categoryId, ...(verdict?.alternatives ?? [])].filter((id): id is string => !!id && known.has(id)))] }
}

/** Remember a confirmed or corrected category, outside the configuration. */
export function learnCategory(state: State, categoryId: string, taskId: string, text: string, match: boolean, now: string): void {
  const examples = (state.categoryExamples ??= {})
  const current = (examples[categoryId] ?? []).filter(example => !(example.taskId === taskId && example.match === match))
  const example: RuleExample = { id: randomUUID(), match, text, at: now, taskId }
  examples[categoryId] = [...current, example].slice(-20)
}
