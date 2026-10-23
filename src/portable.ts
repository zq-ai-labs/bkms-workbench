import { validateClassifier } from './classify.js'
import { checkVariables } from './context-vars.js'
import { validateRule } from './rules.js'
import { WorkbenchError, type Classifier, type Rule } from './types.js'

/**
 * Workflows and business-category schemes as a file to share between workbenches. Only what describes the work goes
 * into the file; what belongs to one person's mailbox stays out: mailbox, folders, ids, on/off state, learned examples
 * (they quote real mail) and dispatch workflows (their target folders are mailbox-specific).
 */
export const PORTABLE_FORMAT = 'bkms-workbench/workflows'
export const PORTABLE_VERSION = 1
const MAX_RULES = 100, MAX_CLASSIFIERS = 50

type PortableRule = Omit<Rule, 'id' | 'account' | 'folder' | 'enabled' | 'dispatchFolder' | 'revision'>
type PortableClassifier = Omit<Classifier, 'id' | 'account' | 'folder' | 'enabled' | 'categories'> & { categories: { name: string; include: string; exclude?: string; action: 'label' | 'move'; fallback?: true }[] }
export interface PortableFile { format: typeof PORTABLE_FORMAT; version: number; exportedAt: string; rules: PortableRule[]; classifiers: PortableClassifier[] }

export function exportWorkflows(rules: Rule[], classifiers: Classifier[], at: string): { file: PortableFile; skipped: string[] } {
  const skipped = rules.filter(rule => rule.output === 'dispatch').map(rule => rule.name)
  const portableRules = rules.filter(rule => rule.output !== 'dispatch').map(({ id, account, folder, enabled, dispatchFolder, ...rest }) => {
    const { revision, ...rule } = rest as typeof rest & { revision?: number }
    return rule
  })
  const portableClassifiers = classifiers.map(({ id, account, folder, enabled, categories, ...rest }) => ({
    ...rest,
    // A "move" keeps its meaning but not its folder, which is the receiving person's to choose.
    categories: categories.map(({ id: categoryId, folder: target, ...category }) => category),
  }))
  return { file: { format: PORTABLE_FORMAT, version: PORTABLE_VERSION, exportedAt: at, rules: portableRules, classifiers: portableClassifiers }, skipped }
}

export interface ImportPlan { rules: Rule[]; classifiers: Classifier[]; renamed: { from: string; to: string }[]; relabeled: string[] }
/**
 * Turn an exported file into workflows and schemes for one mailbox folder, all switched off so they can be checked
 * before use. Names already in use get “（导入）”. Categories that moved mail become labels until a folder is chosen.
 */
export function planImport(input: unknown, target: { account: string; folder: string }, existing: { rules: Rule[]; classifiers: Classifier[] }): ImportPlan {
  const file = input as Partial<PortableFile> | null
  if (!file || typeof file !== 'object' || file.format !== PORTABLE_FORMAT) throw new WorkbenchError('这不是工作台导出的方案文件。', 'import-format')
  if (file.version !== PORTABLE_VERSION) throw new WorkbenchError('方案文件的版本不受支持，请用相同版本的工作台导出。', 'import-version')
  if (!Array.isArray(file.rules) || !Array.isArray(file.classifiers) || file.rules.length > MAX_RULES || file.classifiers.length > MAX_CLASSIFIERS) throw new WorkbenchError('方案文件内容无效。', 'import-format')
  if (!file.rules.length && !file.classifiers.length) throw new WorkbenchError('方案文件里没有可导入的方案。', 'import-empty')
  const renamed: ImportPlan['renamed'] = [], relabeled: string[] = []
  const unique = (name: string, taken: Set<string>, limit: number) => {
    let next = name, count = 0
    while (taken.has(next.toLowerCase())) { count++; next = name.slice(0, limit - 8) + (count === 1 ? '（导入）' : `（导入 ${count}）`) }
    if (next !== name) renamed.push({ from: name, to: next })
    taken.add(next.toLowerCase())
    return next
  }
  const ruleNames = new Set(existing.rules.map(rule => rule.name.toLowerCase()))
  const rules = file.rules.map(raw => {
    if (!raw || typeof raw !== 'object') throw new WorkbenchError('方案文件内容无效。', 'import-format')
    const source = raw as unknown as Record<string, unknown>
    if (source.output === 'dispatch') throw new WorkbenchError('方案文件里不应包含分派方案。', 'import-format')
    const { id, dispatchFolder, revision, ...rest } = source
    const rule = validateRule({ ...rest, account: target.account, folder: target.folder, enabled: false })
    checkVariables(rule.instructions, `方案「${rule.name}」的处理要求`)
    rule.name = unique(rule.name, ruleNames, 100)
    return rule
  })
  const classifierNames = new Set(existing.classifiers.map(item => item.name.toLowerCase()))
  const classifiers = file.classifiers.map(raw => {
    if (!raw || typeof raw !== 'object' || !Array.isArray((raw as PortableClassifier).categories)) throw new WorkbenchError('方案文件内容无效。', 'import-format')
    const { id, account, folder, enabled, ...rest } = raw as PortableClassifier & Record<string, unknown>
    const categories = rest.categories.map(category => {
      if (!category || typeof category !== 'object') throw new WorkbenchError('方案文件内容无效。', 'import-format')
      const { id: categoryId, folder: target, ...kept } = category as typeof category & { id?: unknown; folder?: unknown }
      if (kept.action !== 'move') return kept
      relabeled.push(`${String(rest.name ?? '')} / ${String(kept.name ?? '')}`)
      return { ...kept, action: 'label' as const }
    })
    const classifier = validateClassifier({ ...rest, categories, account: target.account, folder: target.folder, enabled: false })
    classifier.name = unique(classifier.name, classifierNames, 100)
    return classifier
  })
  return { rules, classifiers, renamed, relabeled }
}
