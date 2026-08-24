/**
 * M2.3 (MC-3): normalized provider error taxonomy.
 *
 * Adapted from MiniCore's `errors.ts` (`ProviderErrorCategory`). Before this
 * module, retry/failover/context-length decisions each carried their own
 * regex/status scanning — three places that could drift apart on a
 * non-standard error message. Every provider error is now classified ONCE
 * into a category, and the policies read the category:
 *
 *   rate_limit | network | server | auth | invalid_request
 *   | context_length_exceeded | unknown
 *
 * The public predicates (`isRetryableProviderError`,
 * `shouldFailoverError`, `isContextLengthExceeded`) keep their signatures —
 * they now delegate to `categorizeProviderError` so classification can never
 * drift between call sites.
 */

export type ProviderErrorCategory =
  | 'rate_limit'
  | 'network'
  | 'server'
  | 'auth'
  | 'invalid_request'
  | 'context_length_exceeded'
  | 'unknown'

/** Structured status off an Error (direct or axios/fetch `response.status`). */
function statusOf(err: unknown): number {
  const anyErr = err as { status?: unknown; response?: { status?: unknown } } | null
  if (!anyErr) return NaN
  const status = Number(anyErr.status ?? anyErr.response?.status ?? NaN)
  return Number.isFinite(status) && status > 0 ? status : NaN
}

/** Best-effort message text of an unknown error value. */
function messageOf(err: unknown): string {
  if (typeof err === 'string') return err
  const m = (err as { message?: unknown })?.message
  return typeof m === 'string' ? m : String(err ?? '')
}

/** Retry-After hint in ms when the provider sent one (rate limits). */
export function retryAfterMsOf(err: unknown): number | undefined {
  const v = (err as { retryAfterMs?: unknown; retryAfter?: unknown } | null)?.retryAfterMs
  if (typeof v === 'number' && v > 0) return v
  const header = (err as { response?: { headers?: Record<string, unknown> } } | null)?.response
    ?.headers?.['retry-after']
  const secs = typeof header === 'string' ? Number(header) : NaN
  if (Number.isFinite(secs) && secs > 0) return Math.round(secs * 1000)
  return undefined
}

/** Message patterns that identify auth failures without a structured status. */
const AUTH_PATTERNS =
  /(invalid api key|unauthorized|forbidden|authentication|api key.*(invalid|expired)|not authenticated)/i

/** Message patterns that identify network-level failures. */
const NETWORK_PATTERNS = /(econnrefused|enotfound|etimedout|econnreset|network error|fetch failed)/i

/** Message patterns that identify an over-long context rejection. */
const CONTEXT_LENGTH_PATTERNS =
  /(context.{0,30}(length|window|limit)|token.{0,20}(exceed|too long|limit)|context_length_exceeded)/i

/**
 * Classify a provider failure into exactly one category. Status codes win over
 * message scanning (structured data is more reliable); message patterns only
 * apply when no usable status exists.
 */
export function categorizeProviderError(err: unknown): ProviderErrorCategory {
  if (!err) return 'unknown'
  const status = statusOf(err)
  if (!Number.isNaN(status)) {
    if (status === 429) return 'rate_limit'
    if (status === 401 || status === 403) return 'auth'
    if (status >= 500 && status < 600) return 'server'
    if (status >= 400 && status < 500) return 'invalid_request'
    return 'unknown'
  }
  const msg = messageOf(err)
  if (CONTEXT_LENGTH_PATTERNS.test(msg)) return 'context_length_exceeded'
  if (AUTH_PATTERNS.test(msg)) return 'auth'
  if (NETWORK_PATTERNS.test(msg)) return 'network'
  if (/\b(429)\b/.test(msg)) return 'rate_limit'
  if (/\b(5\d\d)\b/.test(msg)) return 'server'
  if (/\b(401|403)\b/.test(msg)) return 'auth'
  if (/\b(400|404|422)\b/.test(msg)) return 'invalid_request'
  return 'unknown'
}

/** Categories worth retrying with backoff inside one provider (transient). */
const RETRYABLE_CATEGORIES: ReadonlySet<ProviderErrorCategory> = new Set([
  'rate_limit',
  'server',
  'network'
])

/** True for 429 / 5xx / network — transient failures worth an in-provider retry. */
export function isRetryableProviderError(err: unknown): boolean {
  if (!err) return false
  return RETRYABLE_CATEGORIES.has(categorizeProviderError(err))
}

/**
 * Terminal categories worth failing over to another provider: auth (dead key)
 * and rate_limit/server after in-provider retries are exhausted. Client-side
 * invalid_request errors (400/404/422, model not found) never fail over — a
 * bad request just wastes the next provider too.
 */
const FAILOVER_CATEGORIES: ReadonlySet<ProviderErrorCategory> = new Set([
  'auth',
  'rate_limit',
  'server'
])

export function shouldFailoverError(err: unknown): boolean {
  if (!err) return false
  // context_length is recoverable in-place (force_compact_and_retry) — never
  // hop providers for it.
  if (categorizeProviderError(err) === 'context_length_exceeded') return false
  return FAILOVER_CATEGORIES.has(categorizeProviderError(err))
}

/** True when the provider rejected the request as too-long context. */
export function isContextLengthExceeded(err: unknown): boolean {
  if (!err) return false
  return categorizeProviderError(err) === 'context_length_exceeded'
}
