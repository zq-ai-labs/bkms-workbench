import { WorkbenchError } from './types.js'

/**
 * Why a background AI run gave no result, told so the user knows what to do: it timed out, its output was cut off, the
 * model service failed (and how), or the model did not submit a valid result. The provider's own error text is never
 * passed on (it can carry request details); it stays in the run record (src/trace.ts).
 */

/** A run that keeps submitting results that fail validation is stopped after this many; DSH sets no step limit. */
export const MAX_REJECTED_RESULTS = 3

/** The caller's signal, also aborted after `ms` with a TimeoutError. */
export const withTimeout = (signal: AbortSignal, ms: number): AbortSignal => AbortSignal.any([signal, AbortSignal.timeout(ms)])
export const timedOut = (signal: AbortSignal): boolean => signal.aborted && (signal.reason as { name?: unknown } | undefined)?.name === 'TimeoutError'
export const timeoutError = (): WorkbenchError => new WorkbenchError('AI 处理超时，请稍后重试。', 'model_timeout', 504)

// Stable failure codes of the DSH model layer (dsh-llm error.ts and retry-policy.ts). Transient ones (rate limit,
// server, network) were already retried by DSH before the turn ended.
const MODEL_FAILURES: Record<string, [code: string, message: string, status: number]> = {
  INVALID_CREDENTIAL: ['model_auth', '模型服务拒绝了访问凭据，请在 DSH 中检查模型配置。', 502],
  QUOTA: ['model_quota', '模型服务额度不足，请检查模型账号后重试。', 502],
  ACCOUNT_QUOTA: ['model_quota', '模型服务额度不足，请检查模型账号后重试。', 502],
  RATE_LIMIT: ['model_busy', '模型服务繁忙，请稍后重试。', 503],
  CONTEXT_WINDOW_EXCEEDED: ['model_context', '内容超出模型能处理的长度，请减少内容后重试。', 413],
}

/** The error for a run that ended without a valid result; `invalid` is used when the model did not submit one. */
export function runFailure(events: readonly unknown[], signal: AbortSignal, invalid: { message: string; code: string }): unknown {
  if (signal.aborted) return timedOut(signal) ? timeoutError() : signal.reason
  const ending = [...events].reverse().find(event => (event as { type?: unknown }).type === 'turn/end') as { data?: { reason?: { kind?: unknown; error?: { code?: unknown } } } } | undefined
  const reason = ending?.data?.reason
  if (reason?.kind === 'max-tokens') return new WorkbenchError('AI 输出过长被截断，请精简要求后重试。', 'model_truncated', 502)
  if (reason?.kind === 'error') {
    const known = typeof reason.error?.code === 'string' ? MODEL_FAILURES[reason.error.code] : undefined
    return known ? new WorkbenchError(known[1], known[0], known[2]) : new WorkbenchError('模型服务出错，请稍后重试。', 'model_error', 502)
  }
  return new WorkbenchError(invalid.message, invalid.code, 503)
}
