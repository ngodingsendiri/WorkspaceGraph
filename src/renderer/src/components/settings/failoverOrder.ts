/**
 * R1-2 — failover order helpers (pure, unit-testable).
 *
 * The Settings AI tab lets the user drag-reorder the backup providers used
 * when the ACTIVE provider fails terminally (401/403/429/5xx). These pure
 * functions keep the reorder logic off the React component so it can be
 * tested without a DOM.
 *
 * Mirror of the main-side contract in src/main/ai/providerFailover.ts:
 * the active provider is never a candidate, and Ollama (local daemon) never
 * participates — a dead local daemon is not a cloud outage.
 */

export interface NamedProvider {
  id: string
  name: string
}

/** Providers Ollama is always excluded from the failover chain. */
export const FAILOVER_EXCLUDED = new Set<string>(['ollama'])

/**
 * Ordered failover candidates for the UI: every provider except `activeId`
 * and the excluded set, honoring `order` (settings `aiFailoverOrder`) for the
 * head, with any not-yet-ordered providers appended in registration order.
 * Unknown ids in `order` are dropped (matches the main-side validator).
 */
export function buildFailoverCandidates<T extends NamedProvider>(
  providers: T[],
  order: string[],
  activeId: string,
  excluded: ReadonlySet<string> = FAILOVER_EXCLUDED
): T[] {
  const pool = providers.filter((p) => p.id !== activeId && !excluded.has(p.id))
  const byId = new Map(pool.map((p) => [p.id, p]))
  // Dedupe while preserving order (mirrors main-side resolveFailoverCandidates)
  const seen = new Set<string>()
  const head: T[] = []
  for (const id of order) {
    if (seen.has(id)) continue
    seen.add(id)
    const p = byId.get(id)
    if (p) head.push(p)
  }
  const tail = pool.filter((p) => !seen.has(p.id))
  return [...head, ...tail]
}

/**
 * Move the item at `from` to `to` in a string order (drag / ▲▼ buttons).
 * Out-of-range and no-op moves return a defensive copy — callers can persist
 * the result directly.
 */
export function moveInOrder(order: string[], from: number, to: number): string[] {
  if (from === to) return [...order]
  if (from < 0 || from >= order.length) return [...order]
  if (to < 0 || to >= order.length) return [...order]
  const next = [...order]
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved)
  return next
}
