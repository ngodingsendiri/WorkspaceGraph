/**
 * R2-4: Auto-learning loop — episodic ingest of verified AI activity into
 * AI Memory/Log Ingest.md.
 *
 * Every completed stream bumps `messagesSinceRun`; once the threshold is hit
 * (N streams) OR a day has passed since the last run, the vault's recent AI
 * event trail is summarized and appended to Log Ingest.md as a dated section.
 *
 * Design rules (from the AI Memory principles — never invent data):
 * - Only facts present in the AIEventLog trail are recorded (streams, errors,
 *   tool usage, tokens) — never model speculation.
 * - Appends are deduped: a bullet already present in the file is not added
 *   again, so repeated identical runs stay silent.
 * - The runner never throws: ingest failures must not break the chat stream
 *   that triggered them.
 */
import fs from 'fs'
import path from 'path'
import { workspaceEngine } from '../engine/WorkspaceEngine'
import { atomicWriteJson } from '../utils/quarantine'
import { readAIEvents, type AIEvent } from './AIEventLog'
import { AI_MEMORY_DIR, AI_MEMORY_FILES } from './WorkspaceMemory'
import { markSelfWrite, syncSingleFile } from '../ipc/shared'

/** Run ingest after this many completed streams (default; overridable in tests). */
export const AUTO_INGEST_EVERY_MESSAGES = 8
/** Also run when this much time passed since the last run, whatever the count. */
export const AUTO_INGEST_EVERY_MS = 24 * 60 * 60 * 1000
/** State file lives under the vault's .workspacegraph (same as checkpoints). */
export const AUTO_INGEST_STATE_FILE = '.workspacegraph/autoingest.json'

export interface AutoIngestState {
  lastRunAt: number | null
  messagesSinceRun: number
}

export const DEFAULT_AUTO_INGEST_STATE: AutoIngestState = {
  lastRunAt: null,
  messagesSinceRun: 0
}

export function autoIngestStateFile(root: string): string {
  return path.join(root, AUTO_INGEST_STATE_FILE)
}

/** Pure: should the ingest run now? N completed streams OR daily cadence. */
export function shouldAutoIngest(
  state: AutoIngestState,
  now: number,
  everyMessages = AUTO_INGEST_EVERY_MESSAGES,
  everyMs = AUTO_INGEST_EVERY_MS
): boolean {
  if (state.messagesSinceRun >= everyMessages) return true
  if (state.lastRunAt !== null && now - state.lastRunAt >= everyMs) return true
  return false
}

export function loadAutoIngestState(root: string): AutoIngestState {
  try {
    const raw = fs.readFileSync(autoIngestStateFile(root), 'utf-8')
    const parsed = JSON.parse(raw) as Partial<AutoIngestState>
    return {
      lastRunAt:
        typeof parsed.lastRunAt === 'number' && Number.isFinite(parsed.lastRunAt)
          ? parsed.lastRunAt
          : null,
      messagesSinceRun:
        typeof parsed.messagesSinceRun === 'number' && parsed.messagesSinceRun >= 0
          ? Math.floor(parsed.messagesSinceRun)
          : 0
    }
  } catch {
    return { ...DEFAULT_AUTO_INGEST_STATE }
  }
}

export function saveAutoIngestState(root: string, state: AutoIngestState): void {
  try {
    const file = autoIngestStateFile(root)
    const dir = path.dirname(file)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    atomicWriteJson(file, state)
  } catch {
    /* state persistence is best-effort */
  }
}

/** Facts extracted from the AI event trail — the ONLY thing ingest records. */
export interface IngestFacts {
  streams: number
  errors: number
  tokens: number
  tools: { name: string; ok: number; error: number }[]
}

/** Pure: summarize terminal events (stream_end/send/pipeline) + tool events. */
export function extractIngestFacts(events: AIEvent[]): IngestFacts {
  const facts: IngestFacts = { streams: 0, errors: 0, tokens: 0, tools: [] }
  const toolMap = new Map<string, { name: string; ok: number; error: number }>()
  for (const e of events) {
    if (e.status === 'started') continue
    if (e.kind === 'stream_end' || e.kind === 'send' || e.kind === 'pipeline') {
      facts.streams++
      if (e.status === 'error') facts.errors++
      if (typeof e.tokensUsed === 'number') facts.tokens += e.tokensUsed
    }
    if (e.kind === 'tool' && e.tool) {
      const cur = toolMap.get(e.tool) || { name: e.tool, ok: 0, error: 0 }
      if (e.status === 'error') cur.error++
      else cur.ok++
      toolMap.set(e.tool, cur)
    }
  }
  facts.tools = [...toolMap.values()].sort((a, b) => a.name.localeCompare(b.name))
  return facts
}

/** Build the human-readable bullets for the dated log section. */
export function buildIngestLines(facts: IngestFacts): string[] {
  const lines: string[] = []
  const outcome =
    facts.streams === 0
      ? 'belum ada sesi AI tervalidasi'
      : facts.errors === 0
        ? `${facts.streams} sesi AI sukses`
        : `${facts.streams} sesi AI · ${facts.errors} error`
  lines.push(`Auto-ingest: ${outcome}${facts.tokens > 0 ? ` · ${facts.tokens} token` : ''}.`)
  if (facts.tools.length > 0) {
    const tools = facts.tools
      .map((t) => `${t.name}${t.error > 0 ? ` (${t.ok} ok / ${t.error} error)` : ` ${t.ok}×`}`)
      .join(', ')
    lines.push(`Tool dipakai: ${tools}.`)
  }
  return lines
}

export interface AppendLogResult {
  text: string
  added: number
}

/**
 * Pure: append `lines` as bullets under the `## <date>` section, deduped —
 * a bullet already present anywhere in the file is not added again. Creates
 * the section when the date heading is missing.
 */
export function appendLogEntry(existing: string, date: string, lines: string[]): AppendLogResult {
  const bullets = lines.map((l) => `- ${l}`).filter((b) => b.trim().length > 2)
  const fresh = bullets.filter((b) => !existing.includes(b))
  if (fresh.length === 0) return { text: existing, added: 0 }

  const heading = `## ${date}`
  const headingIdx = existing.indexOf(heading)
  if (headingIdx === -1) {
    const sep = existing.length > 0 && !existing.endsWith('\n') ? '\n' : ''
    const section = `${sep}${heading}\n\n${fresh.join('\n')}\n`
    return { text: existing + section, added: fresh.length }
  }

  // Insert under the existing date heading, before the next `## ` heading.
  const afterHeading = headingIdx + heading.length
  let nextHeading = existing.indexOf('\n## ', afterHeading)
  if (nextHeading === -1) nextHeading = existing.length
  const head = existing.slice(0, nextHeading)
  const tail = existing.slice(nextHeading)
  const sectionEndsWithBlank = /(?:\n\n|\n)$/.test(head.slice(afterHeading))
  const join = sectionEndsWithBlank ? '' : '\n'
  return {
    text: `${head}${join}${fresh.join('\n')}\n${tail}`,
    added: fresh.length
  }
}

function memoryLogAbs(root: string): string {
  return path.join(root, AI_MEMORY_DIR, AI_MEMORY_FILES.logIngest)
}

/**
 * Run one ingest pass: read the event trail, append a dated summary to
 * AI Memory/Log Ingest.md (deduped), reset the cadence state. Never throws —
 * ingest failure must not break the chat stream that triggered it.
 * Returns the number of appended bullets (0 when nothing new or no vault).
 */
export function runAutoIngest(root: string | null | undefined, now = Date.now()): number {
  if (!root) return 0
  try {
    const logAbs = memoryLogAbs(root)
    if (!fs.existsSync(logAbs)) return 0

    // Facts from the recent trail — newest first, take the last N streams worth.
    const events = readAIEvents(root, 500)
    const facts = extractIngestFacts(events)
    const lines = buildIngestLines(facts)
    if (lines.length === 0) return 0

    const date = new Date(now).toISOString().split('T')[0]
    const existing = fs.readFileSync(logAbs, 'utf-8')
    const { text, added } = appendLogEntry(existing, date, lines)
    if (added === 0) return 0

    workspaceEngine.writeFile(logAbs, text)
    try {
      markSelfWrite(logAbs)
      syncSingleFile(logAbs, root)
    } catch {
      /* ignore single-file sync failure — watcher will pick it up */
    }
    return added
  } catch {
    return 0
  }
}

/** Guard against overlapping runs per vault. */
const running = new Set<string>()

/**
 * Called after every completed stream. Bumps the message counter and, when the
 * cadence says so, runs the ingest. Fire-and-forget — never throws.
 */
export function notifyStreamCompleted(root: string | null | undefined, now = Date.now()): void {
  if (!root || running.has(root)) return
  running.add(root)
  try {
    const state = loadAutoIngestState(root)
    const next: AutoIngestState = {
      lastRunAt: state.lastRunAt,
      messagesSinceRun: state.messagesSinceRun + 1
    }
    if (!shouldAutoIngest(next, now)) {
      saveAutoIngestState(root, next)
      return
    }
    runAutoIngest(root, now)
    saveAutoIngestState(root, { lastRunAt: now, messagesSinceRun: 0 })
  } catch {
    /* swallow */
  } finally {
    running.delete(root)
  }
}
