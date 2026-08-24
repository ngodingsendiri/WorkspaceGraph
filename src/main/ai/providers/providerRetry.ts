/**
 * Shared retry/backoff for provider calls (R0-3).
 *
 * Retries ONLY transient failures — 429 rate limits, 5xx server errors, and
 * network-level failures. 4xx auth/bad-request failures are never retried (a
 * wrong key won't fix itself in 500ms). Streams are retried at CREATE time
 * only (before any chunk was emitted); a mid-stream failure cannot be resumed
 * without duplicating the content the user already saw.
 *
 * M2.3 (MC-3): classification delegates to the shared taxonomy
 * (`providerErrors.ts`) so retry/failover/context-length decisions can never
 * drift apart on non-standard error messages.
 */

import {
  categorizeProviderError,
  isContextLengthExceeded,
  isRetryableProviderError
} from '../providerErrors'

// Re-exported so existing import sites keep working with unchanged paths.
export { isRetryableProviderError, isContextLengthExceeded, categorizeProviderError }

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
      // M2.3: classification via the shared taxonomy (rate_limit/server/network)
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
