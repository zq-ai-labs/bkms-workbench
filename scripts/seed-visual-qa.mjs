/** Synthetic UI fixtures only. Never configure an account, start a worker or send mail. */
import { randomUUID } from 'node:crypto'
import { mkdir, lstat, open, readdir, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { Store, log } from '../lib/store.js'
import { validateRule } from '../lib/rules.js'
import { DraftStore } from '../../dsh-email/lib/draft-store.js'

const arguments_ = process.argv.slice(2)
if (arguments_.length !== 2 || arguments_[0] !== '--home' || !isAbsolute(arguments_[1])) {
  throw new Error('用法：node scripts/seed-visual-qa.mjs --home <新建或完全空的绝对 QA HOME 路径>；路径必须包含 runtime/poc/bkms-workbench-visual。不会使用环境中的 DSH_HOME。')
}

const home = resolve(arguments_[1])
const qaPath = /(?:^|\/)runtime\/poc\/bkms-workbench-visual(?:[\/_-]|$)/i
const checkPath = path => {
  if (!qaPath.test(path.replaceAll('\\', '/'))) throw new Error('只允许 runtime/poc/bkms-workbench-visual 范围的新空目录，已拒绝目标：' + path)
}
checkPath(home)
// Resolve the nearest existing ancestor before mkdir, so a junction cannot
// redirect a seemingly isolated QA path to an unrelated runtime.
let ancestor = home
for (;;) {
  try { await lstat(ancestor); break }
  catch (error) {
    if (error.code !== 'ENOENT' || dirname(ancestor) === ancestor) throw error
    ancestor = dirname(ancestor)
  }
}
checkPath(resolve(await realpath(ancestor), relative(ancestor, home)))
await mkdir(home, { recursive: true, mode: 0o700 })
const actualHome = await realpath(home)
checkPath(actualHome)
if ((await lstat(home)).isSymbolicLink() || (await readdir(home)).length !== 0) throw new Error('QA HOME 必须是新建或完全空的普通目录。已有文件已保留，请明确指定另一个新目录。')

// The exclusive marker also prevents a simultaneous second fixture run.
const marker = await open(join(home, 'VISUAL-QA-SYNTHETIC.json'), 'wx', 0o600)
try {
  await marker.writeFile(JSON.stringify({ purpose: 'BKMS 工作台视觉 QA，仅含合成演示数据', createdAt: new Date().toISOString(), backgroundEnabled: false, realAccountsConfigured: false }, null, 2))
  await marker.sync()
} finally { await marker.close() }

const store = new Store(join(home, 'data', 'bkms-workbench'))
const drafts = new DraftStore(home)
const rule = validateRule({
  id: randomUUID(), name: '演示 · 客户询价准备', enabled: false, priority: 100,
  account: 'visual-demo', folder: 'INBOX',
  match: { from: '', subject: '询价', hasAttachments: false, mode: 'all' },
  instructions: '仅为视觉 QA 展示配置。整理邮件中的需求，生成回复草稿；报价和交期缺少依据时请人工补充。此演示规则保持禁用，不连接真实邮箱。',
  tools: [], skills: [], output: 'reply', maxRetries: 0,
})
const at = minutes => new Date(Date.now() - minutes * 60_000).toISOString()
const task = (uid, status, title, from, body, summary, minutes) => ({
  id: randomUUID(), revision: 1, title, subject: title, account: 'visual-demo', status, from, body, summary,
  receivedAt: at(minutes), updatedAt: at(Math.max(1, minutes - 3)),
  source: { account: 'visual-demo', folder: 'INBOX', uid, uidValidity: 1 },
  attachments: [], history: [{ at: at(minutes), message: '已导入合成演示邮件，仅用于工作台视觉验证。' }],
  attempts: 1, ruleId: rule.id, ruleName: rule.name, rule: structuredClone(rule), mailLoaded: true,
})

const quotation = task(1, 'review', '[演示] 华东项目 · 工业设备询价回复', '林女士 <buyer@example.test>',
  '您好，\n\n我们计划采购 200 套标准控制模块，希望了解产品规格、报价和预计交付安排。请同时说明质保及售后支持。\n\n谢谢！\n林女士\n\n【合成演示邮件，无真实客户或订单】',
  '已整理采购数量、产品规格、交付和售后四项需求，并准备好回复草稿。价格与交期保留为待人工确认项。\n\n请核对收件人及回复内容，再决定后续操作。本任务仅用于视觉 QA。', 18)
const draft = await drafts.create({
  account: 'visual-demo', to: '林女士 <buyer@example.test>', cc: '',
  subject: 'Re: [演示] 华东项目 · 工业设备询价回复',
  text: '林女士，您好！\n\n感谢您的咨询。我们已收到关于 200 套标准控制模块的采购需求。\n\n为便于提供准确方案，烦请补充所需接口规格、使用环境及期望到货日期。我们将结合这些信息核实产品配置、报价和交付安排，并同步提供质保与售后支持说明。\n\n期待您的回复，谢谢！\n\n【演示草稿：仅用于视觉验证，未配置发件账号，不可真实发送】',
}, [], undefined, { sourceKey: 'visual-qa:quotation', inReplyTo: 'quotation@example.test', references: 'quotation@example.test' })
quotation.draftId = draft.id
quotation.history.push({ at: quotation.updatedAt, message: '演示回复草稿已准备，等待人工审核。' })

const procurement = task(2, 'needs_info', '[演示] 采购申请 · 补充项目与交付资料', '陈先生 <procurement@example.test>',
  '您好，\n\n请根据本次项目需求准备采购回复。具体设备规格和现场地址稍后补充，希望先确认还需要提供哪些资料。\n\n【合成演示邮件，无真实采购业务】',
  '已提取采购意向。继续准备回复前，需要补充：\n1. 设备型号、数量及关键技术要求；\n2. 项目地址与期望到货日期；\n3. 报价联系人及开票要求。\n\n填写补充信息后可继续准备草稿。', 42)
procurement.error = '请补充设备规格、数量和交付地点。此处为合成演示待办。'
procurement.history.push({ at: procurement.updatedAt, message: '发现关键资料缺失，已转为待补充。' })

const report = task(3, 'completed', '[演示] 客户反馈 · 本周需求分析报告', '项目协调人 <coordination@example.test>',
  '您好，\n\n请整理本周客户反馈的重点，列出共性问题与下一步建议，形成简短分析。\n\n【合成演示邮件，无真实客户资料】',
  '本周需求分析\n\n需求重点\n• 客户关注产品配置与交付时间，希望获得清晰的资料清单。\n• 售后服务范围及响应方式需要在回复中统一说明。\n\n建议行动\n• 先收集型号、数量和使用环境，再核实报价。\n• 对资料不足的邮件创建补充信息待办。\n• 所有对外回复由人工审核后发送。\n\n本报告仅由合成演示资料生成，用于视觉 QA。', 95)
report.rule = { ...structuredClone(rule), output: 'report' }
report.history.push({ at: report.updatedAt, message: '演示分析报告已生成，任务完成。' })

await store.mutate(state => {
  state.settings = { enabled: false, pollSeconds: 60 }
  state.rules = [rule]
  state.tasks = [report, procurement, quotation]
  log(state, '已创建 3 个明确标识的合成演示任务；后台保持关闭，未配置任何真实邮箱或凭据。')
})
console.log(JSON.stringify({ home: actualHome, tasks: 3, drafts: 1, rules: 1, ruleEnabled: false, backgroundEnabled: false, marker: join(home, 'VISUAL-QA-SYNTHETIC.json') }, null, 2))
