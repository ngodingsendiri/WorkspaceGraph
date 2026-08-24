/**
 * Shared retry/backoff for provider calls (R0-3).
 *
 * Retries ONLY transient failures — 429 rate limits and 5xx server errors.
 * 4xx auth/bad-request failures are never retried (a wrong key won't fix
 * itself in 500ms). Streams are retried at CREATE time only (before any chunk
 * was emitted); a mid-stream failure cannot be resumed without duplicating the
 * content the user already saw.
 */

export interface RetryPolicy {
  /** Total attempts including the first call. Default 2. */
  attempts?: number
  /** First backoff in ms, doubles each attempt. Default 500. */
  baseDelayMs?: number
  /** Backoff cap. Default 4000. */
  maxDelayMs?: number
  /**
   * Extra give-up check evaluated on EVERY retryable failure — return false to
   * rethrow immediately (e.g. the user cancelled mid-backoff). Receives the
   * zero-based attempt that just failed.
   */
  shouldRetry?: (failedAttempt: number) => boolean
}

/** True for 429 or 5xx — the only statuses worth retrying. */
export function isRetryableProviderError(err: unknown): boolean {
  if (!err) return false
  const anyErr = err as { status?: unknown; response?: { status?: unknown }; message?: unknown }
  const status = Number(anyErr?.status ?? anyErr?.response?.status ?? NaN)
  if (Number.isFinite(status) && status > 0) {
    return status === 429 || (status >= 500 && status <= 599)
  }
  // Fallback for providers that only put the code in the message text
  const msg = typeof anyErr?.message === 'string' ? anyErr.message : String(err)
  return /\b(429|5\d\d)\b/.test(msg)
}

/**
 * M2.2 (MC-2): true when the provider rejected the request because the context
 * is too long — the signal for `force_compact_and_retry` (fold the history and
 * retry the same round, once). Providers report this as a 400 with a body like
 * "maximum context length is X", "context_length_exceeded", "token limit", etc.
 */
export function isContextLengthExceeded(err: unknown): boolean {
  if (!err) return false
  const msg =
    typeof err === 'string'
      ? err
      : typeof (err as { message?: unknown })?.message === 'string'
        ? String((err as { message?: string }).message)
        : String(err)
  return /(context.{0,30}(length|window|limit)|token.{0,20}(exceed|too long|limit)|context_length_exceeded)/i.test(
    msg
  )
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Run `run()` with bounded exponential backoff on transient failures.
 * Re-throws the last error when attempts are exhausted, the failure is
 * non-retryable, or shouldRetry() says stop.
 */
export async function withProviderRetry<T>(
  run: () => Promise<T>,
  policy: RetryPolicy = {}
): Promise<T> {
  const attempts = Math.max(1, policy.attempts ?? 2)
  const baseDelayMs = policy.baseDelayMs ?? 500
  const maxDelayMs = policy.maxDelayMs ?? 4000
  let lastErr: unknown
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await run()
    } catch (err) {
      lastErr = err
      const exhausted = attempt === attempts - 1
      const giveUp =
        !isRetryableProviderError(err) || (policy.shouldRetry && !policy.shouldRetry(attempt))
      if (exhausted || giveUp) throw err
      // Exponential backoff with a small jitter so parallel retries don't
      // thundering-herd. The cap INCLUDES the jitter — never overshoot maxDelayMs.
      const delay = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt + Math.random() * 100)
      await sleep(delay)
      // User cancelled DURING the backoff window — don't fire one more request
      if (policy.shouldRetry && !policy.shouldRetry(attempt)) throw err
    }
  }
  // Every iteration either returns or throws — TS keeps the loop's normal exit
  // open, runtime never reaches here.
  throw lastErr
}
