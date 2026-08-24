/**
 * R1-2 — provider failover helpers (pure, unit-testable).
 *
 * When the ACTIVE provider fails TERMINALLY (auth 401/403, 429 after the
 * provider's internal retries, 5xx after retries), the stream retries on the
 * next CONFIGURED provider. Transient codes are already retried INSIDE each
 * provider (providerRetry.ts); an error that reaches the middleware is the
 * final outcome of that provider and is the failover signal.
 *
 * Deliberate choices:
 *  - Ollama is never a failover candidate: it is local, `isConfigured()` is
 *    always true by design, and a dead daemon would turn every cloud outage
 *    into an extra connection-refused hop. Failover targets are cloud providers.
 *  - Non-terminal errors (400/404/422, model not found) surface immediately —
 *    hopping providers on a bad request just wastes a call.
 *
 * M2.3 (MC-3): classification delegates to the shared taxonomy
 * (`providerErrors.ts`) — one categorizer for retry, failover, and
 * context-length decisions, so they can never drift apart.
 */
import type { BaseProvider } from './providers/BaseProvider'
import { categorizeProviderError } from './providers/providerRetry'

/** True when a provider error is a terminal condition worth failing over on. */
export function shouldFailoverError(err: unknown): boolean {
  if (!err) return false
  const category = categorizeProviderError(err)
  // context_length is recoverable in-place (force_compact_and_retry) — never
  // hop providers for it.
  if (category === 'context_length_exceeded') return false
  return category === 'auth' || category === 'rate_limit' || category === 'server'
}

export interface FailoverCandidate {
  id: string
  name: string
  isConfigured: () => boolean
}

/**
 * Ordered failover candidates for `activeId`: every registered provider except
 * the active one that is configured — in settings `aiFailoverOrder` when that
 * is a valid non-empty list, otherwise registration order. Ollama is skipped.
 */
export function resolveFailoverCandidates(
  registered: FailoverCandidate[],
  activeId: string,
  settings?: { aiFailoverOrder?: unknown }
): FailoverCandidate[] {
  let order: string[] = registered.map((p) => p.id)
  const configuredIds = new Set(registered.map((p) => p.id))
  if (settings && Array.isArray(settings.aiFailoverOrder)) {
    const valid = settings.aiFailoverOrder.filter(
      (id): id is string => typeof id === 'string' && configuredIds.has(id)
    )
    if (valid.length > 0) order = valid
  }
  const seen = new Set<string>()
  const out: FailoverCandidate[] = []
  for (const id of order) {
    if (id === activeId || id === 'ollama' || seen.has(id)) continue
    seen.add(id)
    const p = registered.find((r) => r.id === id)
    if (p && p.isConfigured()) out.push(p)
  }
  return out
}

/** Convenience wrapper around the registered provider map. */
export function failoverCandidatesFor(
  providers: Map<string, BaseProvider>,
  activeId: string,
  settings?: { aiFailoverOrder?: unknown }
): BaseProvider[] {
  const registered: FailoverCandidate[] = Array.from(providers.values()).map((p) => ({
    id: p.id,
    name: p.name,
    isConfigured: () => p.isConfigured()
  }))
  const candidates = resolveFailoverCandidates(registered, activeId, settings)
  return candidates.map((c) => providers.get(c.id)).filter((p): p is BaseProvider => Boolean(p))
}
