import { selectedModel } from './agent.js'
import { list, runStructured, text } from './structured.js'
import { WorkbenchError, type WriterKind, type WriterRunner } from './types.js'

const keys = (args: any, allowed: string[]) => { if (Object.keys(args).some(key => !allowed.includes(key))) throw new WorkbenchError('结果包含未知字段。') }
const specs: Record<WriterKind, { schema: Record<string, unknown>; system: (en: boolean) => string; parse(args: any): Record<string, unknown> }> = {
  brief: {
    schema: { type: 'object', additionalProperties: false, required: ['text'], properties: { text: { type: 'string', maxLength: 600 } } },
    system: en => `你为用户写当天的工作简报开头段落：3 到 4 句话，按“最急的事 → 今天的会议或截止 → AI 已代办 → 风险信号”的顺序，点名具体事项标题，不罗列全部，不写客套话，不编造输入中没有的事实或数字。没有待决策事项时直接说明。使用${en ? '英文' : '中文'}。`,
    parse: args => { keys(args, ['text']); return { text: text(args.text, 1200, 'text') } },
  },
  weekly: {
    schema: { type: 'object', additionalProperties: false, required: ['title', 'text'], properties: { title: { type: 'string', maxLength: 80 }, text: { type: 'string', maxLength: 8000 } } },
    system: en => `根据本周处理过的信息和事项，起草用户本人的工作周报。用 Markdown 二级标题分为：本周完成、进行中与风险、下周计划。按业务事项归并，写结果而不是流水账；下周计划只写输入能支持的事项，其余用“[请补充]”占位。不编造数字、客户或结论。使用${en ? '英文' : '中文'}。`,
    parse: args => { keys(args, ['title', 'text']); return { title: text(args.title, 160, 'title'), text: text(args.text, 16000, 'text') } },
  },
  topic: {
    schema: { type: 'object', additionalProperties: false, required: ['text', 'level', 'risks', 'todos'], properties: { text: { type: 'string', maxLength: 600 }, level: { type: 'string', enum: ['good', 'attention', 'risk'] }, risks: { type: 'array', maxItems: 5, items: { type: 'string', maxLength: 160 } }, todos: { type: 'array', maxItems: 6, items: { type: 'string', maxLength: 120 } } } },
    system: en => `根据与某个客户或项目相关的信息，概括这个主题的现状（3 句以内，说明阶段、最新进展和下一步）、风险（只列有依据的）、待办（谁要做什么）。level：有明显阻塞或逾期为 risk，有需要关注的未决事项为 attention，否则 good。不编造。使用${en ? '英文' : '中文'}。`,
    parse: args => { keys(args, ['text', 'level', 'risks', 'todos']); if (!['good', 'attention', 'risk'].includes(args.level)) throw new WorkbenchError('结果字段 level 无效。'); return { text: text(args.text, 1200, 'text'), level: args.level, risks: list(args.risks, 5, 300, 'risks'), todos: list(args.todos, 6, 240, 'todos') } },
  },
  classify: {
    schema: { type: 'object', additionalProperties: false, required: ['results'], properties: { results: { type: 'array', maxItems: 30, items: { type: 'object', additionalProperties: false, required: ['id', 'categoryId', 'confidence', 'reason'], properties: { id: { type: 'string' }, categoryId: { type: 'string' }, confidence: { type: 'string', enum: ['high', 'medium', 'low'] }, reason: { type: 'string', maxLength: 120 } } } } } },
    system: en => `按业务分类方案（classifier）为每封邮件选一个且只选一个分类，用于保存前的试运行。依据每个分类的 include（属于本类）、exclude（不属于本类）和 examples（用户确认过的判断，相似邮件须遵循）；classifier.guidance 是分类之间的取舍规则，优先于你自己的判断，没说到的按 categories 先后顺序（越靠前越优先）。fallback=true 的分类只在明确不属于其他任何分类时选。confidence 只有明确符合时填 high，两个分类都说得通或信息太少时填 medium 或 low。每封邮件返回一项，id 与输入一致，categoryId 只能是 classifier.categories 中的 id。reason 一句话引用邮件事实，使用${en ? '英文（English）' : '中文'}。`,
    parse: args => {
      keys(args, ['results'])
      if (!Array.isArray(args.results) || args.results.length > 30) throw new WorkbenchError('试运行结果无效。')
      return { results: args.results.map((item: any) => ({ id: text(item?.id, 80, 'id'), categoryId: typeof item?.categoryId === 'string' ? item.categoryId.trim() : '', confidence: ['high', 'medium', 'low'].includes(item?.confidence) ? item.confidence : 'low', reason: text(item?.reason ?? '', 400, 'reason').slice(0, 120) })) }
    },
  },
  trial: {
    schema: { type: 'object', additionalProperties: false, required: ['matches'], properties: { matches: { type: 'array', maxItems: 30, items: { type: 'object', additionalProperties: false, required: ['id', 'matched', 'reason'], properties: { id: { type: 'string' }, matched: { type: 'boolean' }, reason: { type: 'string', maxLength: 120 } } } } } },
    system: en => `判断处理方案是否适用于每封邮件。依据方案名称、适用说明(semantic)、处理要求摘要(hint)和例子(examples：用户确认过属于 match=true、纠正过不属于 match=false，相似邮件须遵循)；exclude 中的类别一律不适用。拿不准时判为不适用。对每封邮件给出 matched 和一句话理由。只判断，不处理邮件。理由使用${en ? '英文' : '中文'}。`,
    parse: args => {
      keys(args, ['matches'])
      if (!Array.isArray(args.matches) || args.matches.length > 30) throw new WorkbenchError('试运行结果无效。')
      return { matches: args.matches.map((item: any) => ({ id: text(item?.id, 80, 'id'), matched: item?.matched === true, reason: text(item?.reason ?? '', 400, 'reason').slice(0, 120) })) }
    },
  },
}

/** AI writing for briefs, weekly drafts, topic summaries and workflow trial runs. Text only; nothing is sent. */
export function createWriter(ctx: any): WriterRunner {
  return {
    available: () => { try { const agents = typeof ctx.get === 'function' ? ctx.get('agents') : ctx.agents; return typeof agents?.create === 'function' && selectedModel(ctx) !== undefined } catch { return false } },
    run: (kind, data, signal) => {
      const spec = specs[kind]
      const en = (data as any)?.uiLanguage === 'en'
      return runStructured(ctx, { name: `bkms_workbench_${kind}`, description: '提交生成结果，不发送、不保存。', schema: spec.schema, system: spec.system(en), input: data, signal, parse: spec.parse })
    },
  }
}
export const parseWriter = (kind: WriterKind, args: any) => specs[kind].parse(args)
