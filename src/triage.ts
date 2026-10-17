import { selectedModel } from './agent.js'
import { runStructured, text } from './structured.js'
import { TRIAGE_CATEGORIES, WorkbenchError, type TriageCategory, type TriageInput, type TriageOutput, type TriageRunner } from './types.js'

export const TRIAGE_TOOL = 'bkms_workbench_triage'
const schema = {
  type: 'object', additionalProperties: false, required: ['category', 'urgency', 'reason', 'nextStep', 'ruleId'],
  properties: {
    category: { type: 'string', enum: [...TRIAGE_CATEGORIES], description: 'request=对方提出需要处理的请求或询问；reply_needed=需要回复但不涉及业务请求；fyi=值得知道但无需行动；notification=系统或服务自动通知、提醒、账单、工资条、验证码等；marketing=营销推广、订阅资讯；other=无法归类' },
    urgency: { type: 'string', enum: ['high', 'normal', 'low'], description: 'high=明确要求当天或更早处理，或有直接业务影响' },
    reason: { type: 'string', maxLength: 200, description: '一句话说明判断依据，引用邮件中的事实' },
    nextStep: { type: 'string', maxLength: 80, description: '收件人需要做的下一步，具体到缺什么或要决定什么；无需行动时留空' },
    ruleId: { type: 'string', description: '最适合的候选处理方案 id；没有合适方案时为空字符串' },
  },
}

const noticeSender = /(?:^|[<\s"'])(?:no-?reply|do-?not-?reply|notice|notification|notifications|system|mailer-daemon|postmaster|alert|alerts|service|support|news|newsletter|billing|account|security)[@.]/i
const noticeSubject = /(通知|提醒|提示|到期|续费|账单|对账单|工资条|验证码|安全提示|登录提醒|订阅|周报订阅|系统消息|服务恢复|自动回复|out of office|automatic reply|notification|reminder|receipt|invoice|statement|verification code|security alert|your account)/i
const marketing = /(退订|unsubscribe|促销|优惠|广告|活动报名|限时|折扣|newsletter|webinar|promotion|special offer)/i
const asks = /(请|麻烦|能否|是否可以|报价|询价|咨询|确认|回复|安排|提供|需要|\?|？|please|could you|can you|quote|inquiry|request)/i
const urgent = /(今天|今日|尽快|马上|立即|紧急|截止|ASAP|urgent|today|by end of day)/i

/** Deterministic fallback when no model is available. It only separates obvious noise from requests. */
export function heuristicTriage(mail: TriageInput['mail']): Omit<TriageOutput, 'ruleId'> {
  const head = `${mail.subject}\n${mail.body.slice(0, 3000)}`
  let category: TriageCategory = 'other'
  if (marketing.test(head)) category = 'marketing'
  else if (noticeSender.test(mail.from) || noticeSubject.test(mail.subject)) category = 'notification'
  else if (asks.test(head)) category = 'request'
  return {
    category,
    urgency: category === 'request' && urgent.test(head) ? 'high' : category === 'notification' || category === 'marketing' ? 'low' : 'normal',
    reason: category === 'notification' ? '发件人或主题符合系统通知特征。' : category === 'marketing' ? '包含营销或退订特征。' : category === 'request' ? '邮件中包含请求或询问。' : '未识别出明确的请求。',
    nextStep: '',
  }
}

export function parseTriage(args: any, ruleIds: Set<string>): TriageOutput {
  if (Object.keys(args).some(key => !['category', 'urgency', 'reason', 'nextStep', 'ruleId'].includes(key))) throw new WorkbenchError('分拣结果包含未知字段。')
  if (!TRIAGE_CATEGORIES.includes(args.category) || !['high', 'normal', 'low'].includes(args.urgency)) throw new WorkbenchError('分拣结果类别无效。')
  const ruleId = typeof args.ruleId === 'string' ? args.ruleId.trim() : ''
  return { category: args.category, urgency: args.urgency, reason: text(args.reason ?? '', 400, 'reason').slice(0, 200), nextStep: text(args.nextStep ?? '', 200, 'nextStep').slice(0, 80), ruleId: ruleIds.has(ruleId) ? ruleId : '' }
}

export function createTriageRunner(ctx: any): TriageRunner {
  return {
    available: () => { try { const agents = typeof ctx.get === 'function' ? ctx.get('agents') : ctx.agents; return typeof agents?.create === 'function' && selectedModel(ctx) !== undefined } catch { return false } },
    run: (input, signal) => runStructured(ctx, {
      name: TRIAGE_TOOL, description: '提交这条信息的分拣结果。', schema, input, signal,
      parse: args => parseTriage(args, new Set(input.rules.map(rule => rule.id))),
      system: `你是工作台的信息分拣助手。判断一条新信息是什么、是否需要收件人处理，以及应该交给哪个候选处理方案。
只在候选方案中选择 ruleId。候选方案已通过发件人、主题等字面条件；你需要根据方案名称、语义条件(semantic)和处理要求摘要(hint)判断这条信息是否真正属于该方案。例如“报价处理”方案不应接收服务故障通知、域名续费提醒或工资条。没有合适方案时 ruleId 为空字符串。
系统自动通知、账单、提醒、验证码归为 notification；营销推广归为 marketing。只有对方需要收件人做事或回复时才归为 request 或 reply_needed。
nextStep 要具体，例如“确认 500 台报价并今天回复”“补充 10/09 的高铁票”；无需行动时留空。reason 和 nextStep 使用${input.uiLanguage === 'en' ? '英文' : '中文'}。不要编造邮件中没有的事实。`,
    }),
  }
}
