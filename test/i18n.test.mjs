import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import { join } from 'node:path'
import { build } from 'esbuild'

const require = createRequire(import.meta.url)
const ts = require('typescript')
const english = JSON.parse(readFileSync(new URL('../client/en.json', import.meta.url)))
const systemEnglish = JSON.parse(readFileSync(new URL('../client/system-en.json', import.meta.url)))
const en = { ...english, ...systemEnglish }
const bundle = await build({ entryPoints: [new URL('../client/i18n.ts', import.meta.url).pathname.replace(/^\/(\w:)/, '$1')], bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react'] })
const module = { exports: {} }
vm.runInNewContext(bundle.outputFiles[0].text, { module, exports: module.exports, require })
const i18n = module.exports

const clientFiles = readdirSync(new URL('../client/', import.meta.url)).filter(name => /\.tsx?$/.test(name) && !name.endsWith('.d.ts') && name !== 'i18n.ts')
test('every workbench UI label has English text and matching placeholders', () => {
  const placeholders = text => (text.match(/\{\d+\}/g) || []).sort()
  for (const [key, value] of Object.entries(en)) {
    assert.ok(value.trim(), key)
    assert.doesNotMatch(value, /[\u4e00-\u9fff]/, key)
    assert.deepEqual(placeholders(value), placeholders(key), key)
    // System messages are recognized by pattern: a text that is only placeholders would match every message.
    assert.doesNotMatch(value, /^\s*(\{\d+\}\s*)+$/, `${key}: English text is only placeholders`)
  }
  assert.ok(clientFiles.includes('index.tsx') && clientFiles.length > 5)
  for (const file of clientFiles) check(file)
})
function check(file) {
  const source = readFileSync(new URL(`../client/${file}`, import.meta.url), 'utf8')
  const sf = ts.createSourceFile(file, source, 99, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  // Label tables are constant, upper-case declarations translated at render time; every entry needs English.
  const table = node => { for (let parent = node.parent; parent; parent = parent.parent) if (ts.isVariableDeclaration(parent)) return /^[A-Z][A-Z_]+$/.test(parent.name.getText(sf)); return false }
  function visit(node) {
    if (ts.isCallExpression(node) && node.expression.getText(sf) === 't' && ts.isStringLiteral(node.arguments[0])) assert.ok(en[node.arguments[0].text], `${file}: ${node.arguments[0].text}`)
    if (ts.isJsxText(node)) assert.doesNotMatch(node.getText(sf), /[\u4e00-\u9fff。]/, file)
    if (ts.isStringLiteral(node) && /[\u4e00-\u9fff]/.test(node.text)) {
      let parent = node.parent
      while (ts.isConditionalExpression(parent)) parent = parent.parent
      const translated = ts.isCallExpression(parent) && parent.expression.getText(sf) === 't'
      if (translated || table(node)) assert.ok(en[node.text], `${file}: ${node.text}`)
      assert.ok(translated || table(node), `Unlocalized string in ${file}: ${node.text}`)
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
}

test('system messages change language without modifying dynamic user content', () => {
  let active = 'en', revision = 0, dictionaries, listeners = new Set()
  const locale = {
    getSnapshot: () => ({ active, revision }), subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn) },
    register: (namespace, values) => { assert.equal(namespace, 'bkms-workbench'); dictionaries = values; return () => { dictionaries = undefined } },
    bind: () => (key, params = {}) => (dictionaries[active][key] || key).replace(/\{(\d+)\}/g, (token, index) => String(params[index] ?? token)),
  }
  const dispose = i18n.connectLocale(locale)
  assert.equal(i18n.t('任务工作台'), 'Task workbench')
  assert.equal(i18n.systemMessage('命中规则「客户询价」，等待处理。'), 'Matched workflow “客户询价”. Waiting for processing.')
  assert.equal(i18n.systemMessage('sales / 客户/询价 检查失败：后台尚未就绪。'), 'Mailbox check failed for sales / 客户/询价: The background worker is not ready.')
  assert.equal(i18n.systemMessage('这是用户手工输入的中文邮件。'), '这是用户手工输入的中文邮件。')
  assert.equal(i18n.t('发件人包含 {0}', 'customer{0}'), 'Sender contains customer{0}')
  const notice = i18n.t('检测完成，新增 {0} 项任务', 3)
  active = 'zh'; revision++; listeners.forEach(fn => fn())
  assert.equal(i18n.systemMessage(notice), '检测完成，新增 3 项任务')
  assert.equal(i18n.t('AI 处理方案'), 'AI 处理方案')
  dispose()
  assert.equal(listeners.size, 0)
  assert.equal(dictionaries, undefined)
})

test('workbench translations use the real DSH locale service and fallback chain', { skip: !process.env.DSH_SOURCE_ROOT }, () => {
  const source = readFileSync(join(process.env.DSH_SOURCE_ROOT, 'packages/client/locale/lib/client.js'), 'utf8')
  let exports
  vm.runInNewContext(source, { navigator: { languages: ['zh-CN'], language: 'zh-CN' }, window: { __ModuleLoader__: { load: ({ factory }) => { exports = factory(name => name.startsWith('react') ? require(name) : {}) } } } })
  const locale = new exports.LocaleRuntime({ emit() {}, effect: fn => fn() }, undefined, { languages: ['zh'] })
  const dispose = i18n.connectLocale(locale)
  assert.equal(i18n.t('任务工作台'), '任务工作台')
  locale.setLocale('en')
  assert.equal(i18n.t('任务工作台'), 'Task workbench')
  assert.equal(i18n.t('最近检测 {0}', '10:15'), 'Last checked 10:15')
  const removeLanguage = locale.addLanguage({ id: 'fr', label: 'Français', fallback: 'en' })
  locale.setLocale('fr')
  assert.equal(i18n.t('AI 处理方案'), 'AI workflows')
  locale.setLocale('zh')
  assert.equal(i18n.systemMessage('Workflow “客户询价” saved.'), '已保存规则「客户询价」。')
  dispose(); removeLanguage()
})
