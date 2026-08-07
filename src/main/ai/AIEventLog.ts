/**
 * Structured AI event log (P3 — audit logging).
 *
 * Every AI operation (stream lifecycle, sendMessage, provider test, tool runs,
 * knowledge promotion) appends ONE JSON line to
 *
 *     <vault>/.workspacegraph/logs/ai-events.jsonl
 *
 * Rotation: when the active file exceeds LOG_MAX_BYTES it is shifted to
 * ai-events.1.jsonl (the rest cascade), keeping at most LOG_KEEP files — so the
 * log never grows unbounded on a long-lived vault.
 *
 * Safety contract: logging must NEVER break an AI stream — every path is
 * try/catch-swallowed, and without an open vault the call is a no-op. The
 * FileWatcher already ignores `.workspacegraph/logs`, so writes never trigger
 * graph/search re-indexing.
 */
import fs from 'fs'
import path from 'path'
import { workspaceEngine } from '../engine/WorkspaceEngine'

export type AIEventStatus = 'ok' | 'error' | 'cancelled' | 'timeout' | 'started'

export type AIEventKind =
  'stream_start' | 'stream_end' | 'send' | 'test' | 'tool' | 'ipc' | 'pipeline' | 'failover'

export interface AIEvent {
  ts: string
  kind: AIEventKind
  provider?: string
  model?: string
  requestId?: string
  channel?: string
  /** Pipeline stage role (Research/Writer/…) or agent role for tool events */
  role?: string
  /** R1-2: the provider that served as the failover replacement */
  target?: string
  /** Number of stages in a pipeline invocation */
  stageCount?: number
  durationMs?: number
  tokensUsed?: number
  status?: AIEventStatus
  error?: string
  tool?: string
  rounds?: number
}

/** 5 MB per file before rotation; keep the active + 4 rotated files. */
export const LOG_MAX_BYTES = 5 * 1024 * 1024
export const LOG_KEEP = 5
export const LOG_DIR = '.workspacegraph'
export const LOG_SUBDIR = 'logs'
export const LOG_FILE = 'ai-events.jsonl'

export function aiEventsDir(root: string): string {
  return path.join(root, LOG_DIR, LOG_SUBDIR)
}

export function aiEventsFile(root: string): string {
  return path.join(aiEventsDir(root), LOG_FILE)
}

/**
 * Remove events older than `days` from EVERY log file (active + rotated), so a
 * long-lived vault never accumulates years of stale history. Corrupt lines are
 * kept (unknown age); a file left empty is deleted. Never throws.
 * Returns the number of removed lines.
 */
export function pruneAIEventsOlderThan(root: string, days: number): number {
  if (!root || days < 1) return 0
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000
  let removed = 0
  try {
    const dir = aiEventsDir(root)
    if (!fs.existsSync(dir)) return 0
    for (const f of fs.readdirSync(dir)) {
      if (!f.startsWith('ai-events') || !f.endsWith('.jsonl')) continue
      const file = path.join(dir, f)
      let kept = 0
      let text = ''
      for (const line of fs.readFileSync(file, 'utf-8').split('\n')) {
        if (!line.trim()) continue
        let ts = 0
        try {
          ts = Date.parse((JSON.parse(line) as AIEvent).ts)
        } catch {
          /* corrupt — keep it */
        }
        if (ts > 0 && ts < cutoff) {
          removed++
          continue
        }
        text += line + '\n'
        kept++
      }
      if (kept === 0) {
        fs.rmSync(file, { force: true })
      } else {
        fs.writeFileSync(file, text, 'utf-8')
      }
    }
    return removed
  } catch {
    return removed
  }
}

/**
 * Cascade-rotate the log: current → .1, .1 → .2 … keeping LOG_KEEP files.
 * Exported for direct unit-testing with tiny size limits. When `retentionDays`
 * is set (> 0) the trail is pruned by age right after rotation.
 */
export function rotateAIEventLog(
  root: string,
  maxBytes = LOG_MAX_BYTES,
  keep = LOG_KEEP,
  retentionDays = 0
): void {
  const active = aiEventsFile(root)
  let size = 0
  try {
    size = fs.statSync(active).size
  } catch {
    return // no active file yet
  }
  if (size <= maxBytes) return

  // Drop the oldest BEFORE shifting so we never hold keep+1 files
  const oldest = path.join(aiEventsDir(root), `ai-events.${keep - 1}.jsonl`)
  try {
    fs.rmSync(oldest, { force: true })
  } catch {
    /* ignore */
  }
  for (let i = keep - 2; i >= 1; i--) {
    const from = path.join(aiEventsDir(root), `ai-events.${i}.jsonl`)
    const to = path.join(aiEventsDir(root), `ai-events.${i + 1}.jsonl`)
    try {
      if (fs.existsSync(from)) fs.renameSync(from, to)
    } catch {
      /* ignore — next rotation will retry */
    }
  }
  try {
    fs.renameSync(active, path.join(aiEventsDir(root), 'ai-events.1.jsonl'))
  } catch {
    /* ignore */
  }
  if (retentionDays > 0) pruneAIEventsOlderThan(root, retentionDays)
}

/**
 * Append one structured event as a JSON line. No-op without an open vault;
 * never throws (a logging failure must not break the AI operation it records).
 */
/** Retention key in the app settings (0 = keep everything). */
export const RETENTION_SETTING_KEY = 'aiEventRetentionDays'

/** Per-vault last-prune timestamp — age-pruning runs at most once per 6h. */
const lastPruneAt = new Map<string, number>()
const PRUNE_MIN_INTERVAL_MS = 6 * 60 * 60 * 1000

/**
 * Append one structured event as a JSON line. No-op without an open vault;
 * never throws (a logging failure must not break the AI operation it records).
 * When a retention is configured, the trail is age-pruned on append — at most
 * once per 6h per vault, so slow-growing logs still respect the limit even
 * before the size-based rotation ever fires.
 */
export function logAIEvent(ev: Omit<AIEvent, 'ts'>): void {
  try {
    const root = workspaceEngine.getState().rootPath
    if (!root) return
    const dir = aiEventsDir(root)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    const retentionDays =
      Number((workspaceEngine.getSettings() as Record<string, unknown>)?.[RETENTION_SETTING_KEY]) ||
      0
    const now = Date.now()
    if (retentionDays > 0 && now - (lastPruneAt.get(root) || 0) > PRUNE_MIN_INTERVAL_MS) {
      pruneAIEventsOlderThan(root, retentionDays)
      lastPruneAt.set(root, now)
    }
    rotateAIEventLog(root, LOG_MAX_BYTES, LOG_KEEP, retentionDays)
    const line = JSON.stringify({ ts: new Date().toISOString(), ...ev }) + '\n'
    fs.appendFileSync(aiEventsFile(root), line, 'utf-8')
  } catch {
    /* logging is best-effort — swallow */
  }
}

/** Log the OUTCOME of a middleware call once it has finished (helper). */
export function logAIOutcome(
  kind: AIEventKind,
  ev: Omit<AIEvent, 'ts' | 'kind' | 'status' | 'durationMs'> & {
    startedAt: number
    ok: boolean
    error?: string
  }
): void {
  logAIEvent({
    kind,
    status: ev.ok ? 'ok' : 'error',
    durationMs: Date.now() - ev.startedAt,
    error: ev.error,
    provider: ev.provider,
    model: ev.model,
    requestId: ev.requestId,
    role: ev.role,
    tool: ev.tool,
    channel: ev.channel,
    stageCount: ev.stageCount,
    rounds: ev.rounds,
    tokensUsed: ev.tokensUsed
  })
}

/**
 * Delete every AI event log file for a vault (active + rotated) — the
 * Settings "AI Activity Log" Clear button. Never throws; no-op without a vault.
 */
export function clearAIEvents(root: string | null | undefined): { ok: boolean; removed: number } {
  if (!root) return { ok: false, removed: 0 }
  const dir = aiEventsDir(root)
  let removed = 0
  try {
    if (!fs.existsSync(dir)) return { ok: true, removed: 0 }
    for (const f of fs.readdirSync(dir)) {
      if (!f.startsWith('ai-events') || !f.endsWith('.jsonl')) continue
      try {
        fs.rmSync(path.join(dir, f), { force: true })
        removed++
      } catch {
        /* skip locked file */
      }
    }
    return { ok: true, removed }
  } catch {
    return { ok: false, removed }
  }
}

/**
 * Read the last `limit` events (newest first) across the ACTIVE + rotated
 * files (ai-events.jsonl → .1 → .2 …), so a post-rotation export/stats never
 * silently drops history. Each file is chronologically appended and rotation
 * moves the whole active file to .1, so concatenating newest-first per file
 * preserves the global newest-first order. Corrupt lines are skipped.
 */
export function readAIEvents(root: string | null | undefined, limit = 200): AIEvent[] {
  if (!root) return []
  try {
    const out: AIEvent[] = []
    for (let i = 0; i < LOG_KEEP && out.length < limit; i++) {
      const file =
        i === 0 ? aiEventsFile(root) : path.join(aiEventsDir(root), `ai-events.${i}.jsonl`)
      if (!fs.existsSync(file)) continue
      const lines = fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean)
      for (let j = lines.length - 1; j >= 0 && out.length < limit; j--) {
        try {
          out.push(JSON.parse(lines[j]) as AIEvent)
        } catch {
          /* skip corrupt line */
        }
      }
    }
    return out
  } catch {
    return []
  }
}

/** Terminal AI operations — the kinds that represent a completed operation. */
export const TERMINAL_AI_KINDS = new Set<AIEventKind>(['stream_end', 'send', 'pipeline'])

/**
 * Terminal events with a real outcome (drops stream_start/pipeline-start
 * 'started' bookends) — the exact set the Settings panel + CSV export show.
 * Reads the full trail including rotated files; a full 5 MB active file holds
 * ~25k events, so the 50k cap keeps an entire log exportable.
 */
export function readTerminalAIEvents(root: string | null | undefined, limit = 50_000): AIEvent[] {
  return readAIEvents(root, limit).filter(
    (e) => TERMINAL_AI_KINDS.has(e.kind) && Boolean(e.status) && e.status !== 'started'
  )
}

/**
 * Compact windowed summary for the dashboard "AI usage" card — counts only
 * TERMINAL operations (stream_end / send / pipeline) inside the last `days`,
 * plus a per-day series (oldest → newest) for a mini bar chart.
 */
export interface AIEventStatsWindow {
  days: number
  /** Completed AI operations in the window */
  operations: number
  /** Sum of tokensUsed across those operations (provider-reported or estimate) */
  tokensUsed: number
  /** status === 'error' operations */
  errors: number
  cancelled: number
  timedOut: number
  /** errors / operations (0 when there are none) */
  errorRate: number
  /** Mean durationMs over operations that report it */
  avgDurationMs: number
  /** One bucket per day, ISO date key, oldest → newest */
  series: { day: string; operations: number; errors: number; tokensUsed: number }[]
}

export function getAIEventStatsWindow(
  root: string | null | undefined,
  days = 7
): AIEventStatsWindow | null {
  if (!root || days < 1) return null
  const events = readAIEvents(root, 100_000)
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000

  // Bucket by ISO day key (UTC) for the last `days` days, oldest → newest
  const buckets = new Map<string, { operations: number; errors: number; tokensUsed: number }>()
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
    buckets.set(d, { operations: 0, errors: 0, tokensUsed: 0 })
  }

  let operations = 0
  let tokensUsed = 0
  let errors = 0
  let cancelled = 0
  let timedOut = 0
  let durationSum = 0
  let durationCount = 0

  for (const e of events) {
    // readAIEvents returns newest-first (file is chronologically appended), so
    // the first event older than the cutoff means every following event is too
    // — stop parsing instead of scanning the whole log (the card refreshes on
    // every graph update, so this keeps each refresh O(window) not O(log)).
    const t = Date.parse(e.ts)
    if (Number.isNaN(t) || t < cutoff) break
    if (!TERMINAL_AI_KINDS.has(e.kind) || !e.status) continue
    const day = e.ts.slice(0, 10)
    operations++
    if (typeof e.tokensUsed === 'number') tokensUsed += e.tokensUsed
    if (e.status === 'error') errors++
    if (e.status === 'cancelled') cancelled++
    if (e.status === 'timeout') timedOut++
    if (typeof e.durationMs === 'number') {
      durationSum += e.durationMs
      durationCount++
    }
    const b = buckets.get(day)
    if (b) {
      b.operations++
      if (e.status === 'error') b.errors++
      if (typeof e.tokensUsed === 'number') b.tokensUsed += e.tokensUsed
    }
  }

  return {
    days,
    operations,
    tokensUsed,
    errors,
    cancelled,
    timedOut,
    errorRate: operations > 0 ? errors / operations : 0,
    avgDurationMs: durationCount > 0 ? Math.round(durationSum / durationCount) : 0,
    series: Array.from(buckets.entries()).map(([dayKey, b]) => ({ day: dayKey, ...b }))
  }
}

/**
 * Serialize AI events to CSV for the Settings "Ekspor CSV" button.
 * RFC-4180-ish: values containing a comma, quote or newline are quoted and
 * embedded quotes doubled. Columns match the panel rows (ts, kind, provider,
 * model, duration, tokens, status, error).
 */
export function aiEventsToCSV(events: AIEvent[]): string {
  const esc = (v: unknown): string => {
    if (v === undefined || v === null || v === '') return ''
    let s = String(v)
    // Formula-injection guard: Excel evaluates cells starting with = + - @ as
    // formulas — prefix them with a single quote so an odd provider/error
    // string can never execute on open.
    if (/^[=+\-@]/.test(s)) s = `'${s}`
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const rows = [
    ['timestamp', 'kind', 'provider', 'model', 'duration_ms', 'tokens_used', 'status', 'error']
  ]
  for (const e of events) {
    rows.push([
      esc(e.ts),
      esc(e.kind),
      esc(e.provider),
      esc(e.model),
      esc(typeof e.durationMs === 'number' ? e.durationMs : ''),
      esc(typeof e.tokensUsed === 'number' ? e.tokensUsed : ''),
      esc(e.status),
      esc(e.error)
    ])
  }
  return rows.map((r) => r.join(',')).join('\n') + '\n'
}

/** Aggregate counters over the active log (for a future Logs view / debug). */
export function getAIEventStats(root: string | null | undefined): {
  total: number
  sizeBytes: number
  file: string | null
  byKind: Record<string, number>
  byStatus: Record<string, number>
  lastTs: string | null
} {
  const empty = { total: 0, sizeBytes: 0, file: null, byKind: {}, byStatus: {}, lastTs: null }
  if (!root) return empty
  try {
    const file = aiEventsFile(root)
    if (!fs.existsSync(file)) return empty
    const events = readAIEvents(root, 100_000)
    const byKind: Record<string, number> = {}
    const byStatus: Record<string, number> = {}
    for (const e of events) {
      byKind[e.kind] = (byKind[e.kind] || 0) + 1
      if (e.status) byStatus[e.status] = (byStatus[e.status] || 0) + 1
    }
    return {
      total: events.length,
      sizeBytes: fs.statSync(file).size,
      file,
      byKind,
      byStatus,
      lastTs: events[0]?.ts ?? null
    }
  } catch {
    return empty
  }
}
