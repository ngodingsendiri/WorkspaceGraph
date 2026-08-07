/**
 * P2-2: tool-trail summary for the kernel status line.
 *
 * After a stream settles, the last assistant message carries its `toolRuns`
 * trail (P1-1). This module turns it into a one-line summary — `tools: 4 ok ·
 * 1 gagal` — so the status line reports what the agent actually did instead of
 * just "idle". `error` includes the interrupted close-out (abort/timeout).
 */

export interface ToolRunLike {
  status: string
}

export interface ToolSummary {
  ok: number
  failed: number
  total: number
}

/** Count ok/error runs; null when there is no trail to summarize. */
export function summarizeToolRuns(runs: ToolRunLike[] | undefined): ToolSummary | null {
  if (!runs || runs.length === 0) return null
  let ok = 0
  let failed = 0
  for (const r of runs) {
    if (r.status === 'ok') ok++
    else if (r.status === 'error') failed++
  }
  return { ok, failed, total: runs.length }
}

/** `tools: 4 ok · 1 gagal` — failed part omitted when zero. Empty when no runs. */
export function toolSummaryLabel(sum: ToolSummary | null): string {
  if (!sum || sum.total === 0) return ''
  const parts = [`${sum.ok} ok`]
  if (sum.failed > 0) parts.push(`${sum.failed} gagal`)
  return `tools: ${parts.join(' · ')}`
}
