import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import { tmpdir } from 'os'
import {
  AUTO_INGEST_EVERY_MESSAGES,
  shouldAutoIngest,
  loadAutoIngestState,
  saveAutoIngestState,
  extractIngestFacts,
  buildIngestLines,
  appendLogEntry,
  runAutoIngest,
  notifyStreamCompleted,
  DEFAULT_AUTO_INGEST_STATE,
  type AutoIngestState
} from './autoIngest'
import { AI_MEMORY_DIR, AI_MEMORY_FILES, ensureAiMemoryScaffold } from './WorkspaceMemory'
import { workspaceEngine } from '../engine/WorkspaceEngine'
import { logAIEvent } from './AIEventLog'

describe('autoIngest (R2-4) — cadence', () => {
  it('does not run from a fresh state', () => {
    expect(shouldAutoIngest(DEFAULT_AUTO_INGEST_STATE, Date.now())).toBe(false)
  })

  it('runs after N completed streams', () => {
    const state: AutoIngestState = { lastRunAt: null, messagesSinceRun: AUTO_INGEST_EVERY_MESSAGES }
    expect(shouldAutoIngest(state, Date.now())).toBe(true)
  })

  it('runs daily even when the message count is below the threshold', () => {
    const now = Date.now()
    const state: AutoIngestState = { lastRunAt: now - 25 * 60 * 60 * 1000, messagesSinceRun: 1 }
    expect(shouldAutoIngest(state, now)).toBe(true)
  })

  it('does not run before either threshold', () => {
    const now = Date.now()
    const state: AutoIngestState = { lastRunAt: now - 60 * 60 * 1000, messagesSinceRun: 3 }
    expect(shouldAutoIngest(state, now)).toBe(false)
  })
})

describe('autoIngest (R2-4) — state persistence', () => {
  let vault: string

  beforeEach(() => {
    vault = fs.mkdtempSync(path.join(tmpdir(), 'wg-autoingest-'))
    workspaceEngine.openWorkspace(vault)
  })

  afterEach(() => {
    try {
      workspaceEngine.closeWorkspace()
      fs.rmSync(vault, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  })

  it('round-trips state through the JSON file', () => {
    const state: AutoIngestState = { lastRunAt: 123456, messagesSinceRun: 4 }
    saveAutoIngestState(vault, state)
    expect(loadAutoIngestState(vault)).toEqual(state)
  })

  it('defaults to a fresh state when the file is missing or corrupt', () => {
    expect(loadAutoIngestState(vault)).toEqual(DEFAULT_AUTO_INGEST_STATE)
    fs.writeFileSync(path.join(vault, '.workspacegraph', 'autoingest.json'), '{corrupt', 'utf-8')
    expect(loadAutoIngestState(vault)).toEqual(DEFAULT_AUTO_INGEST_STATE)
  })
})

describe('autoIngest (R2-4) — facts extraction', () => {
  it('counts terminal streams, errors, tokens and groups tool usage', () => {
    const facts = extractIngestFacts([
      { ts: '1', kind: 'stream_end', status: 'ok', tokensUsed: 100 },
      { ts: '2', kind: 'stream_end', status: 'error', tokensUsed: 50 },
      { ts: '3', kind: 'tool', tool: 'search', status: 'ok' },
      { ts: '4', kind: 'tool', tool: 'search', status: 'ok' },
      { ts: '5', kind: 'tool', tool: 'write_note', status: 'error' },
      { ts: '6', kind: 'stream_start', status: 'started' } // bookend — ignored
    ])
    expect(facts.streams).toBe(2)
    expect(facts.errors).toBe(1)
    expect(facts.tokens).toBe(150)
    expect(facts.tools).toEqual([
      { name: 'search', ok: 2, error: 0 },
      { name: 'write_note', ok: 0, error: 1 }
    ])
  })

  it('builds honest, non-invented lines', () => {
    const lines = buildIngestLines({ streams: 2, errors: 1, tokens: 150, tools: [] })
    expect(lines[0]).toContain('2 sesi AI · 1 error')
    expect(lines[0]).toContain('150 token')
    const okLines = buildIngestLines({ streams: 0, errors: 0, tokens: 0, tools: [] })
    expect(okLines[0]).toContain('belum ada sesi AI tervalidasi')
  })
})

describe('autoIngest (R2-4) — deduped log append', () => {
  it('creates the date section when missing', () => {
    const res = appendLogEntry('', '2026-08-11', ['Auto-ingest: 1 sesi AI sukses.'])
    expect(res.added).toBe(1)
    expect(res.text).toContain('## 2026-08-11')
    expect(res.text).toContain('- Auto-ingest: 1 sesi AI sukses.')
  })

  it('does not duplicate bullets already present (anywhere in the file)', () => {
    const existing = '## 2026-08-11\n\n- Auto-ingest: 1 sesi AI sukses.\n'
    const res = appendLogEntry(existing, '2026-08-11', ['Auto-ingest: 1 sesi AI sukses.'])
    expect(res.added).toBe(0)
    expect(res.text).toBe(existing)
  })

  it('appends fresh bullets under an existing date heading, before the next section', () => {
    const existing =
      '## 2026-08-10\n\n- lama\n\n## 2026-08-11\n\n- Auto-ingest: 1 sesi AI sukses.\n'
    const res = appendLogEntry(existing, '2026-08-11', [
      'Auto-ingest: 1 sesi AI sukses.',
      'Tool dipakai: search 2×.'
    ])
    expect(res.added).toBe(1)
    expect(res.text).toContain(
      '## 2026-08-11\n\n- Auto-ingest: 1 sesi AI sukses.\n- Tool dipakai: search 2×.'
    )
    // old section untouched
    expect(res.text).toContain('## 2026-08-10\n\n- lama')
  })
})

describe('autoIngest (R2-4) — runner', () => {
  let vault: string

  beforeEach(() => {
    vault = fs.mkdtempSync(path.join(tmpdir(), 'wg-autoingest-run-'))
    workspaceEngine.openWorkspace(vault)
    // Scaffold AI Memory so Log Ingest.md exists.
    const res = ensureAiMemoryScaffold(vault)
    expect(res.ok).toBe(true)
  })

  afterEach(() => {
    try {
      workspaceEngine.closeWorkspace()
      fs.rmSync(vault, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  })

  it('appends a dated summary from the real event trail', () => {
    logAIEvent({ kind: 'stream_end', status: 'ok', provider: 'fake', tokensUsed: 10 })
    logAIEvent({ kind: 'stream_end', status: 'ok', provider: 'fake', tokensUsed: 20 })
    const added = runAutoIngest(vault)
    expect(added).toBeGreaterThan(0)
    const logPath = path.join(vault, AI_MEMORY_DIR, AI_MEMORY_FILES.logIngest)
    const text = fs.readFileSync(logPath, 'utf-8')
    expect(text).toContain('2 sesi AI sukses')
    expect(text).toContain('30 token')
  })

  it('runs the ingest once the stream cadence is met and resets the counter', () => {
    for (let i = 0; i < AUTO_INGEST_EVERY_MESSAGES; i++) {
      notifyStreamCompleted(vault)
    }
    const state = loadAutoIngestState(vault)
    expect(state.messagesSinceRun).toBe(0)
    expect(state.lastRunAt).not.toBeNull()
    const logPath = path.join(vault, AI_MEMORY_DIR, AI_MEMORY_FILES.logIngest)
    expect(fs.readFileSync(logPath, 'utf-8')).toContain('## ')
  })

  it('stays silent (no duplicate bullets) when nothing new happened', () => {
    logAIEvent({ kind: 'stream_end', status: 'ok', provider: 'fake' })
    const logPath = path.join(vault, AI_MEMORY_DIR, AI_MEMORY_FILES.logIngest)
    runAutoIngest(vault)
    const first = fs.readFileSync(logPath, 'utf-8')
    // Second pass: same facts → same bullets → nothing appended.
    const added = runAutoIngest(vault)
    expect(added).toBe(0)
    expect(fs.readFileSync(logPath, 'utf-8')).toBe(first)
  })

  it('never throws without a vault or with a missing memory dir', () => {
    expect(runAutoIngest(null)).toBe(0)
    workspaceEngine.closeWorkspace()
    fs.rmSync(path.join(vault, AI_MEMORY_DIR), { recursive: true, force: true })
    expect(runAutoIngest(vault)).toBe(0)
  })
})
