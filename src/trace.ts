/**
 * What one background AI run did, for debugging from the task's own record: the model's messages, each tool call with
 * its input and result, token use and how the run ended. Taken from the run's session events when it finishes and kept
 * with the task, so the run's DSH session does not need to be listed or opened. Texts are cut short to keep tasks small.
 */
export interface AgentTraceStep { kind: 'model' | 'tool'; at?: number; name?: string; text?: string; input?: string; output?: string; error?: string }
export interface AgentTrace { sessionId: string; startedAt: string; durationMs: number; outcome: string; tokens?: { input: number; output: number }; steps: AgentTraceStep[]; truncated?: boolean }

const MAX_STEPS = 60, MAX_TEXT = 2000
const cut = (value: string) => value.length > MAX_TEXT ? value.slice(0, MAX_TEXT) + ` …（${value.length - MAX_TEXT}）` : value
/** Text blocks of a model or tool message; reasoning and binary blocks are left out. */
const textOf = (message: unknown): string => {
  const content = (message as { content?: unknown } | undefined)?.content
  if (!Array.isArray(content)) return ''
  return content.filter(block => block && typeof block === 'object' && (block as { type?: unknown }).type === 'text' && typeof (block as { text?: unknown }).text === 'string').map(block => (block as { text: string }).text).join('\n').trim()
}

export function traceOf(events: readonly unknown[], sessionId: string, startedAt: number, finishedAt = Date.now()): AgentTrace {
  const steps: AgentTraceStep[] = [], calls = new Map<string, AgentTraceStep>()
  let input = 0, output = 0, outcome = 'unknown', truncated = false
  const push = (step: AgentTraceStep) => { if (steps.length < MAX_STEPS) { steps.push(step); return step } truncated = true; return undefined }
  for (const raw of events) {
    const event = raw as { type?: unknown; time?: unknown; data?: Record<string, unknown> }
    const data = event.data ?? {}, at = typeof event.time === 'number' ? event.time : undefined
    if (event.type === 'assistant/message') {
      const usage = data.usage as { inputTokens?: unknown; outputTokens?: unknown } | undefined
      if (typeof usage?.inputTokens === 'number') input += usage.inputTokens
      if (typeof usage?.outputTokens === 'number') output += usage.outputTokens
      const text = textOf(data.message)
      if (text) push({ kind: 'model', ...(at ? { at } : {}), text: cut(text) })
    } else if (event.type === 'tool/call') {
      const step = push({ kind: 'tool', ...(at ? { at } : {}), name: String(data.name ?? ''), input: cut(String(data.arguments ?? '')) })
      if (step && typeof data.callId === 'string') calls.set(data.callId, step)
    } else if (event.type === 'tool/result') {
      const message = data.message as { toolCallId?: unknown; isError?: unknown } | undefined
      const step = typeof message?.toolCallId === 'string' ? calls.get(message.toolCallId) : undefined
      if (!step) continue
      const text = textOf(message)
      if (text) step.output = cut(text)
      const error = data.error as { reason?: unknown; name?: unknown } | undefined
      if (message?.isError === true) step.error = cut(String(error?.reason ?? error?.name ?? text ?? 'error'))
    } else if (event.type === 'turn/end') {
      const reason = data.reason as { kind?: unknown; error?: { message?: unknown } } | undefined
      outcome = String(reason?.kind ?? 'unknown') + (typeof reason?.error?.message === 'string' ? `: ${cut(reason.error.message)}` : '')
    }
  }
  return { sessionId, startedAt: new Date(startedAt).toISOString(), durationMs: Math.max(0, finishedAt - startedAt), outcome, ...(input || output ? { tokens: { input, output } } : {}), steps, ...(truncated ? { truncated: true } : {}) }
}

/**
 * One line on how a failed run ended, for the workbench log: duration, how the turn ended (its kind only, not the
 * provider's message), rejected results with the last reason, tokens. The model's own text is left out.
 */
export function diagnosisOf(trace: AgentTrace): string {
  const rejected = trace.steps.filter(step => step.kind === 'tool' && step.error), last = rejected.at(-1)?.error
  return [
    `${(trace.durationMs / 1000).toFixed(1)}s`, `end ${trace.outcome.split(':')[0]}`,
    ...(rejected.length ? [`rejected ${rejected.length}${last ? `: ${last.slice(0, 200)}` : ''}`] : []),
    ...(trace.tokens ? [`tokens ${trace.tokens.input}/${trace.tokens.output}`] : []),
  ].join(' · ')
}
