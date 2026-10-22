import { selectedModel } from './agent.js'
import { runStructured, text } from './structured.js'
import { businessSchema, parseBusiness } from './classify.js'
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
    confidence: { type: 'string', enum: ['high', 'medium', 'low'], description: '这条信息属于所选方案的把握：high=明确符合方案的适用说明且不在“不适用”之列；medium=可能符合但缺少关键信息或与其他方案难以区分；low=只是勉强相关。没有选方案时填 low' },
    ruleReason: { type: 'string', maxLength: 200, description: '一句话说明为什么选这个方案、或为什么没有合适方案，引用信息中的事实' },
  },
}

// Senders that are automated by construction; mail from them is a notice even when it says "please".
const automatedSender = /(?:^|[<\s"'])(?:no-?reply|do-?not-?reply|mailer-daemon|postmaster|notifications?|alerts?|newsletter)[@.]/i
// Role mailboxes that real people also answer from (service@, support@ …): only a hint, never enough to archive a request.
const roleSender = /(?:^|[<\s"'])(?:notice|system|service|support|news|billing|account|security)[@.]/i
const noticeSubject = /(通知|提醒|提示|到期|续费|账单|对账单|工资条|验证码|安全提示|登录提醒|订阅|周报订阅|系统消息|服务恢复|自动回复|out of office|automatic reply|notification|reminder|receipt|invoice|statement|verification code|security alert|your account)/i
const unsubscribe = /(退订|取消订阅|unsubscribe)/i
const marketing = /(促销|广告|活动报名|限时|折扣|newsletter|webinar|promotion|special offer)/i
const asks = /(请|麻烦|能否|是否可以|报价|询价|咨询|确认|回复|安排|提供|需要|\?|？|please|could you|can you|quote|inquiry|request)/i
const urgent = /(今天|今日|尽快|马上|立即|紧急|截止|ASAP|urgent|today|by end of day)/i

/** Deterministic fallback when no model is available. It only separates obvious noise from requests. */
export function heuristicTriage(mail: TriageInput['mail']): Omit<TriageOutput, 'ruleId'> {
  const head = `${mail.subject}\n${mail.body.slice(0, 3000)}`
  let category: TriageCategory = 'other'
  // Without a model, err towards processing: anything that asks for something reaches a workflow unless it is plainly automated.
  if (unsubscribe.test(head)) category = 'marketing'
  else if (automatedSender.test(mail.from) || (roleSender.test(mail.from) && noticeSubject.test(mail.subject))) category = 'notification'
  else if (asks.test(head)) category = 'request'
  else if (marketing.test(head)) category = 'marketing'
  else if (roleSender.test(mail.from) || noticeSubject.test(mail.subject)) category = 'notification'
  return {
    category,
    urgency: category === 'request' && urgent.test(head) ? 'high' : category === 'notification' || category === 'marketing' ? 'low' : 'normal',
    reason: category === 'notification' ? '发件人或主题符合系统通知特征。' : category === 'marketing' ? '包含营销或退订特征。' : category === 'request' ? '邮件中包含请求或询问。' : '未识别出明确的请求。',
    nextStep: '',
  }
}

/** With a classification scheme the model also fills in `business`: one business category for the message. */
export const triageSchema = (classified: boolean) => classified ? { ...schema, required: [...schema.required, 'business'], properties: { ...schema.properties, business: businessSchema } } : schema
export function parseTriage(args: any, ruleIds: Set<string>, categoryIds?: Set<string>): TriageOutput {
  if (Object.keys(args).some(key => !['category', 'urgency', 'reason', 'nextStep', 'ruleId', 'confidence', 'ruleReason', ...(categoryIds ? ['business'] : [])].includes(key))) throw new WorkbenchError('分拣结果包含未知字段。')
  if (categoryIds && args.business === undefined) throw new WorkbenchError('分拣结果缺少业务分类。')
  if (!TRIAGE_CATEGORIES.includes(args.category) || !['high', 'normal', 'low'].includes(args.urgency)) throw new WorkbenchError('分拣结果类别无效。')
  const ruleId = typeof args.ruleId === 'string' ? args.ruleId.trim() : ''
  if (args.confidence !== undefined && !['high', 'medium', 'low'].includes(args.confidence)) throw new WorkbenchError('分拣结果把握程度无效。')
  const known = ruleIds.has(ruleId)
  // A pick without a stated confidence is treated as uncertain, so it is suggested rather than applied.
  return { category: args.category, urgency: args.urgency, reason: text(args.reason ?? '', 400, 'reason').slice(0, 200), nextStep: text(args.nextStep ?? '', 200, 'nextStep').slice(0, 80), ruleId: known ? ruleId : '', confidence: known ? args.confidence ?? 'medium' : 'low', ruleReason: text(args.ruleReason ?? '', 400, 'ruleReason').slice(0, 200), ...(categoryIds ? { business: parseBusiness(args.business, categoryIds) } : {}) }
}
/** How the model chooses a business category; only added when the folder has a classification scheme. */
const BUSINESS_PROMPT = `
另外，这条信息所在的文件夹有业务分类方案（classifier）。在 business 中为它选一个且只选一个分类：
- 依据每个分类的 include（属于本类）、exclude（不属于本类，即边界）和 examples（用户确认过的判断：match=true 属于该分类，match=false 是用户纠正过“不属于”，相似信息必须遵循）。
- classifier.guidance 是分类之间的取舍规则，优先于你自己的判断；同时符合多类时按 guidance 取舍，guidance 没说的按 categories 的先后顺序（越靠前越优先）。
- fallback=true 的分类表示“不属于以上任何一类”，只有明确不属于其他任何分类时才选它。
- confidence 只有明确符合时才填 high；能想到两个分类都说得通、或信息太少时填 medium 或 low，由用户决定。alternatives 填其次可能的分类 id。
- 业务分类与上面的 category（信息类型）相互独立，两者都要填。reason 同样使用给用户看的语言。`

export function createTriageRunner(ctx: any): TriageRunner {
  return {
    available: () => { try { const agents = typeof ctx.get === 'function' ? ctx.get('agents') : ctx.agents; return typeof agents?.create === 'function' && selectedModel(ctx) !== undefined } catch { return false } },
    run: (input, signal) => runStructured(ctx, {
      name: TRIAGE_TOOL, description: '提交这条信息的分拣结果。', schema: triageSchema(!!input.classifier), input, signal,
      parse: args => parseTriage(args, new Set(input.rules.map(rule => rule.id)), input.classifier ? new Set(input.classifier.categories.map(category => category.id)) : undefined),
      system: `你是工作台的信息分拣助手。判断一条新信息是什么、是否需要收件人处理，以及应该交给哪个候选处理方案。
只在候选方案中选择 ruleId。候选方案只是通过了发件人、主题、文件夹等字面条件，并不代表适用；你需要根据方案名称、适用说明(semantic)、处理要求摘要(hint)和例子(examples)判断这条信息是否真正属于该方案。examples 是用户确认过的历史判断：match=true 表示属于该方案，match=false 表示用户纠正过“不属于”，遇到相似信息时必须遵循。
output=dispatch 的方案表示把信息转交给某个团队、岗位或个人处理（移到其文件夹），按适用说明判断这封信是否归它负责。
宁可不选也不要勉强：普通沟通、内部事务、通知、询问与方案用途不同的信息不要交给专门方案。例如“订单处理”只接收明确的下单、改单、催单；询价、售后、发票、会议、问候都不属于它。没有合适方案时 ruleId 为空字符串，confidence 为 low。
confidence 只有在信息明确符合适用说明时才填 high；与方案相关但不确定时填 medium，由用户确认。
mail.body 是对方这次新写的内容；mail.quotedHistory 是邮件里引用的历史往来（【往来 1】最近），只用来理解上下文，例如“这个价格”“上次说的型号”指什么。分类、紧急程度和下一步以本次新内容为准：历史里已经提过或处理过的请求不是新请求；对方只是确认、致谢时归为 fyi 或 reply_needed，不要因为历史里有询价就归为 request。
若 thread.previousRule 存在，表示同一往来的上一封由该方案处理；本次仍是同一业务的继续（如确认报价、补充数量、询问进度）时优先沿用该方案并给 high，业务已经变了（如从询价转为售后）时按实际内容选择。
系统自动通知、账单、提醒、验证码归为 notification；营销推广归为 marketing。只有对方需要收件人做事或回复时才归为 request 或 reply_needed。
nextStep 要具体，例如“确认 500 台报价并今天回复”“补充 10/09 的高铁票”；无需行动时留空。不要编造邮件中没有的事实。
语言：reason、nextStep、ruleReason 是给用户看的说明，一律使用${input.uiLanguage === 'en' ? '英文（English）' : '中文'}，与信息原文和方案说明使用什么语言无关；人名、公司名、型号、数量、金额保持原样。${input.mail.channel === 'wechat' ? '\n本条信息是一段微信对话记录（channel=wechat），“我”是收件人本人，subject 是会话名称。判断对方是否需要我做事或回复；微信里来自真人的消息不要归为 marketing。' : ''}${input.classifier ? BUSINESS_PROMPT : ''}`,
    }),
  }
}
