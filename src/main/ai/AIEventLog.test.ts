import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import { tmpdir } from 'os'
import {
  AIEvent,
  logAIEvent,
  logAIOutcome,
  readAIEvents,
  readTerminalAIEvents,
  aiEventsToCSV,
  getAIEventStats,
  getAIEventStatsWindow,
  rotateAIEventLog,
  clearAIEvents,
  pruneAIEventsOlderThan,
  RETENTION_SETTING_KEY,
  aiEventsDir,
  aiEventsFile,
  LOG_MAX_BYTES
} from './AIEventLog'
import { workspaceEngine } from '../engine/WorkspaceEngine'

describe('AIEventLog (P3 structured JSONL audit trail)', () => {
  let vault: string

  beforeEach(() => {
    vault = fs.mkdtempSync(path.join(tmpdir(), 'wg-aielog-'))
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

  it('appends one JSON line per event under .workspacegraph/logs/ai-events.jsonl', () => {
    logAIEvent({
      kind: 'stream_start',
      provider: 'grok',
      model: 'grok-4.5',
      requestId: 'r1',
      status: 'started'
    })
    logAIEvent({
      kind: 'stream_end',
      provider: 'grok',
      model: 'grok-4.5',
      requestId: 'r1',
      status: 'ok',
      tokensUsed: 123,
      durationMs: 42
    })
    const file = aiEventsFile(vault)
    expect(fs.existsSync(file)).toBe(true)
    const lines = fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean)
    expect(lines).toHaveLength(2)
    const first = JSON.parse(lines[0]) as AIEvent
    expect(first.kind).toBe('stream_start')
    expect(first.provider).toBe('grok')
    expect(first.model).toBe('grok-4.5')
    expect(first.ts).toBeTruthy()
    const second = JSON.parse(lines[1]) as AIEvent
    expect(second.status).toBe('ok')
    expect(second.tokensUsed).toBe(123)
    expect(second.durationMs).toBe(42)
  })

  it('readAIEvents returns newest first with a limit', () => {
    for (let i = 1; i <= 5; i++) {
      logAIEvent({ kind: 'tool', tool: `t${i}`, status: 'ok', requestId: `r${i}` })
    }
    const all = readAIEvents(vault, 100)
    expect(all.map((e) => e.tool)).toEqual(['t5', 't4', 't3', 't2', 't1'])
    const limited = readAIEvents(vault, 2)
    expect(limited.map((e) => e.tool)).toEqual(['t5', 't4'])
  })

  it('logAIOutcome stamps duration + ok/error status from startedAt', () => {
    const startedAt = Date.now() - 150
    logAIOutcome('send', { startedAt, ok: true, provider: 'openai', model: 'gpt-x', tokensUsed: 7 })
    logAIOutcome('test', {
      startedAt: Date.now(),
      ok: false,
      error: 'auth failed',
      provider: 'gemini'
    })
    const events = readAIEvents(vault, 10)
    expect(events[1].kind).toBe('send')
    expect(events[1].status).toBe('ok')
    expect(events[1].durationMs).toBeGreaterThanOrEqual(150)
    expect(events[1].tokensUsed).toBe(7)
    expect(events[0].kind).toBe('test')
    expect(events[0].status).toBe('error')
    expect(events[0].error).toBe('auth failed')
  })

  it('rotates by size: active → .1, cascade shifts, old files dropped', () => {
    // Fill the active file past a tiny limit, then trigger rotation via logAIEvent
    const small = 200
    const payload = { kind: 'tool' as const, tool: 'x', status: 'ok' as const }
    for (let i = 0; i < 12; i++) logAIEvent(payload)
    const file = aiEventsFile(vault)
    const big = fs.readFileSync(file, 'utf-8')
    expect(big.length).toBeGreaterThan(small)
    // Force rotation with the tiny limit
    rotateAIEventLog(vault, small)
    expect(fs.existsSync(file)).toBe(false) // active rolled to .1
    const r1 = path.join(aiEventsDir(vault), 'ai-events.1.jsonl')
    expect(fs.existsSync(r1)).toBe(true)
    expect(fs.readFileSync(r1, 'utf-8')).toBe(big)
    // New writes start a fresh active file
    logAIEvent({ kind: 'stream_end', status: 'ok', provider: 'fake' })
    expect(fs.existsSync(file)).toBe(true)
  })

  it('rotation keeps at most KEEP files (oldest dropped)', () => {
    const dir = aiEventsDir(vault)
    fs.mkdirSync(dir, { recursive: true })
    // Simulate a full cascade: active + .1 .. .4
    fs.writeFileSync(aiEventsFile(vault), 'x'.repeat(100))
    for (let i = 1; i <= 4; i++) {
      fs.writeFileSync(path.join(dir, `ai-events.${i}.jsonl`), 'y')
    }
    rotateAIEventLog(vault, 10, 5)
    // The oldest (.4) was dropped; everything else shifted UP one slot
    expect(fs.existsSync(path.join(dir, 'ai-events.5.jsonl'))).toBe(false)
    expect(fs.readFileSync(path.join(dir, 'ai-events.4.jsonl'), 'utf-8')).toBe('y') // old .3
    expect(fs.readFileSync(path.join(dir, 'ai-events.3.jsonl'), 'utf-8')).toBe('y') // old .2
    expect(fs.readFileSync(path.join(dir, 'ai-events.2.jsonl'), 'utf-8')).toBe('y') // old .1
    expect(fs.readFileSync(path.join(dir, 'ai-events.1.jsonl'), 'utf-8')).toBe('x'.repeat(100))
  })

  it('is a no-op without an open vault (never writes, never throws)', () => {
    workspaceEngine.closeWorkspace()
    expect(() => {
      logAIEvent({ kind: 'stream_end', status: 'ok', provider: 'x' })
      logAIOutcome('send', { startedAt: Date.now(), ok: false, error: 'boom', provider: 'x' })
    }).not.toThrow()
    expect(readAIEvents(vault, 10)).toEqual([])
    expect(getAIEventStats(vault).total).toBe(0)
  })

  it('getAIEventStats aggregates by kind + status', () => {
    logAIEvent({ kind: 'stream_start', status: 'started', provider: 'grok' })
    logAIEvent({ kind: 'stream_end', status: 'ok', provider: 'grok' })
    logAIEvent({ kind: 'stream_end', status: 'error', provider: 'grok', error: 'boom' })
    logAIEvent({ kind: 'tool', tool: 'search', status: 'ok' })
    const stats = getAIEventStats(vault)
    expect(stats.total).toBe(4)
    expect(stats.file).toBe(aiEventsFile(vault))
    expect(stats.sizeBytes).toBeGreaterThan(0)
    expect(stats.byKind.stream_end).toBe(2)
    expect(stats.byKind.stream_start).toBe(1)
    expect(stats.byKind.tool).toBe(1)
    expect(stats.byStatus.ok).toBe(2)
    expect(stats.byStatus.error).toBe(1)
    expect(stats.byStatus.started).toBe(1)
    expect(stats.lastTs).toBeTruthy()
  })

  it('is resilient to corrupt lines (skipped, not fatal)', () => {
    const file = aiEventsFile(vault)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, '{valid}\nnot json\n{also valid}\n')
    // hand-craft valid entries
    fs.writeFileSync(
      file,
      `${JSON.stringify({ ts: '1', kind: 'tool', tool: 'a' })}\nbroken line\n${JSON.stringify({ ts: '2', kind: 'tool', tool: 'b' })}\n`
    )
    const events = readAIEvents(vault, 10)
    expect(events).toHaveLength(2)
    expect(events[0].tool).toBe('b')
    expect(events[1].tool).toBe('a')
  })

  it('default rotation size constant is 5 MB', () => {
    expect(LOG_MAX_BYTES).toBe(5 * 1024 * 1024)
  })

  it('clearAIEvents wipes active + rotated files and reports the count', () => {
    logAIEvent({ kind: 'stream_end', status: 'ok', provider: 'grok' })
    logAIEvent({ kind: 'stream_end', status: 'error', provider: 'gemini', error: 'x' })
    // Simulate rotated files
    const dir = aiEventsDir(vault)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'ai-events.1.jsonl'), 'y')
    fs.writeFileSync(path.join(dir, 'ai-events.2.jsonl'), 'y')
    fs.writeFileSync(path.join(dir, 'not-a-log.txt'), 'keep me')

    const res = clearAIEvents(vault)
    expect(res.ok).toBe(true)
    expect(res.removed).toBe(3) // active + .1 + .2
    expect(fs.existsSync(aiEventsFile(vault))).toBe(false)
    expect(fs.existsSync(path.join(dir, 'ai-events.1.jsonl'))).toBe(false)
    // Unrelated files survive
    expect(fs.readFileSync(path.join(dir, 'not-a-log.txt'), 'utf-8')).toBe('keep me')
    // A fresh log starts empty
    logAIEvent({ kind: 'send', status: 'ok', provider: 'openai' })
    expect(readAIEvents(vault, 10)).toHaveLength(1)
  })

  it('clearAIEvents is a safe no-op for null root or an empty dir', () => {
    expect(clearAIEvents(null)).toEqual({ ok: false, removed: 0 })
    expect(clearAIEvents(undefined)).toEqual({ ok: false, removed: 0 })
    // Vault exists but no log files yet → ok, nothing removed
    expect(clearAIEvents(vault)).toEqual({ ok: true, removed: 0 })
  })

  // ── CSV export (Settings → AI Activity → Ekspor CSV) ─────────────────────

  it('aiEventsToCSV writes a header + one row per event with the panel columns', () => {
    const csv = aiEventsToCSV([
      {
        ts: '2026-08-07T09:00:00.000Z',
        kind: 'stream_end',
        provider: 'grok',
        model: 'grok-4.5',
        durationMs: 1500,
        tokensUsed: 1200,
        status: 'ok'
      },
      {
        ts: '2026-08-07T10:00:00.000Z',
        kind: 'pipeline',
        provider: 'openai',
        model: 'gpt-x',
        status: 'error',
        error: 'rate limited'
      }
    ])
    const lines = csv.trim().split('\n')
    expect(lines[0]).toBe('timestamp,kind,provider,model,duration_ms,tokens_used,status,error')
    expect(lines[1]).toContain('stream_end,grok,grok-4.5,1500,1200,ok,')
    // Missing numeric fields stay empty (not 'undefined'); a bare space needs
    // no quoting (only commas, quotes and newlines do)
    expect(lines[2]).toBe('2026-08-07T10:00:00.000Z,pipeline,openai,gpt-x,,,error,rate limited')
  })

  it('aiEventsToCSV quotes + doubles values containing commas, quotes or newlines', () => {
    const csv = aiEventsToCSV([{ ts: 't', kind: 'stream_end', status: 'error', error: 'a,"b"\nc' }])
    expect(csv).toContain('"a,""b""\nc"')
  })

  it('aiEventsToCSV neuters spreadsheet formula injection (= + - @ prefix)', () => {
    const csv = aiEventsToCSV([
      { ts: 't', kind: 'stream_end', status: 'error', error: '=HYPERLINK("x")' },
      { ts: 'u', kind: 'send', status: 'ok', provider: '@x' }
    ])
    const lines = csv.trim().split('\n')
    // Prefix `'` goes INSIDE the quoting; embedded quotes get doubled too
    expect(lines[1]).toBe('t,stream_end,,,,,error,"\'=HYPERLINK(""x"")"')
    expect(lines[2]).toBe("u,send,'@x,,,,ok,")
  })

  it('readAIEvents spans rotated files newest-first (post-rotation history kept)', () => {
    // Fill + rotate so the trail spans active + .1, then confirm a read
    // stitches them back in the global newest-first order.
    const payload = { kind: 'tool' as const, tool: 'x', status: 'ok' as const }
    for (let i = 0; i < 8; i++) logAIEvent(payload)
    rotateAIEventLog(vault, 200)
    logAIEvent({ kind: 'stream_end', status: 'ok', provider: 'after-rotation' })
    const events = readAIEvents(vault, 100)
    expect(events[0].kind).toBe('stream_end') // newest is in the fresh active file
    expect(events[0].provider).toBe('after-rotation')
    expect(events.length).toBe(9) // 8 rotated + 1 active — nothing dropped
    // Newest-first order holds across the file boundary
    expect(events.every((e, i) => i === 0 || e.tool === 'x')).toBe(true)
    expect(events[events.length - 1].tool).toBe('x')
  })

  it('aiEventsToCSV with no events is just the header', () => {
    expect(aiEventsToCSV([]).trim()).toBe(
      'timestamp,kind,provider,model,duration_ms,tokens_used,status,error'
    )
  })

  // ── Retention (prune older than N days) ─────────────────────────────────

  const tsOf = (offsetDays: number): string =>
    new Date(Date.now() - offsetDays * 24 * 60 * 60 * 1000).toISOString()

  it('pruneAIEventsOlderThan removes stale lines across active + rotated files', () => {
    const dir = aiEventsDir(vault)
    fs.mkdirSync(dir, { recursive: true })
    // Fixed timestamps (tsOf at call time — re-deriving later shifts by ms)
    const stale90 = tsOf(90)
    const fresh2 = tsOf(2)
    const stale120 = tsOf(120)
    // Active: fresh + stale interleaved (chronological like production)
    fs.writeFileSync(
      aiEventsFile(vault),
      `${JSON.stringify({ ts: stale90, kind: 'stream_end', status: 'ok' })}\n` +
        `${JSON.stringify({ ts: fresh2, kind: 'stream_end', status: 'ok' })}\n`
    )
    // Rotated: all stale
    fs.writeFileSync(
      path.join(dir, 'ai-events.1.jsonl'),
      `${JSON.stringify({ ts: stale120, kind: 'stream_end', status: 'ok' })}\n`
    )
    const removed = pruneAIEventsOlderThan(vault, 30)
    expect(removed).toBe(2) // 90d + 120d
    const left = readAIEvents(vault, 100)
    expect(left).toHaveLength(1)
    expect(left[0].ts).toBe(fresh2)
    // Stale-only rotated file was deleted entirely
    expect(fs.existsSync(path.join(dir, 'ai-events.1.jsonl'))).toBe(false)
  })

  it('pruneAIEventsOlderThan deletes the active file when everything is stale', () => {
    fs.mkdirSync(aiEventsDir(vault), { recursive: true })
    fs.writeFileSync(
      aiEventsFile(vault),
      `${JSON.stringify({ ts: tsOf(400), kind: 'stream_end', status: 'ok' })}\n`
    )
    expect(pruneAIEventsOlderThan(vault, 30)).toBe(1)
    expect(fs.existsSync(aiEventsFile(vault))).toBe(false)
  })

  it('pruneAIEventsOlderThan keeps corrupt lines and is a no-op for days < 1', () => {
    fs.mkdirSync(aiEventsDir(vault), { recursive: true })
    fs.writeFileSync(
      aiEventsFile(vault),
      `broken line\n${JSON.stringify({ ts: tsOf(400), kind: 'stream_end', status: 'ok' })}\n`
    )
    // Corrupt line has unknown age → kept; stale valid line dropped
    expect(pruneAIEventsOlderThan(vault, 30)).toBe(1)
    const text = fs.readFileSync(aiEventsFile(vault), 'utf-8')
    expect(text).toContain('broken line')
    expect(text).not.toContain(tsOf(400))
    // days < 1 → nothing happens
    expect(pruneAIEventsOlderThan(vault, 0)).toBe(0)
    expect(pruneAIEventsOlderThan(null, 30)).toBe(0)
  })

  it('rotation prunes by age when retentionDays is passed', () => {
    const dir = aiEventsDir(vault)
    fs.mkdirSync(dir, { recursive: true })
    const stale60 = tsOf(60)
    const fresh1 = tsOf(1)
    fs.writeFileSync(
      aiEventsFile(vault),
      `${JSON.stringify({ ts: stale60, kind: 'stream_end', status: 'ok' })}\n` +
        `${JSON.stringify({ ts: fresh1, kind: 'stream_end', status: 'ok' })}\n`
    )
    rotateAIEventLog(vault, 10, 3, 30)
    // The stale line never survives the rotation-time prune
    const left = readAIEvents(vault, 100)
    expect(left).toHaveLength(1)
    expect(left[0].ts).toBe(fresh1)
  })

  it('retention setting key is a stable constant', () => {
    expect(RETENTION_SETTING_KEY).toBe('aiEventRetentionDays')
  })

  it('readTerminalAIEvents keeps only terminal kinds with a real outcome', () => {
    logAIEvent({ kind: 'stream_start', status: 'started', provider: 'grok' })
    logAIEvent({ kind: 'tool', tool: 'search', status: 'ok' })
    logAIEvent({ kind: 'stream_end', status: 'ok', provider: 'grok', tokensUsed: 10 })
    logAIEvent({ kind: 'pipeline', status: 'started', provider: 'grok' })
    logAIEvent({ kind: 'pipeline', status: 'ok', provider: 'grok', stageCount: 2 })
    const out = readTerminalAIEvents(vault, 100)
    expect(out).toHaveLength(2)
    expect(out.map((e) => e.kind)).toEqual(['pipeline', 'stream_end'])
    expect(out.every((e) => e.status && e.status !== 'started')).toBe(true)
  })

  // ── Dashboard windowed summary (getAIEventStatsWindow) ───────────────────

  /** Write raw lines with CONTROLLED ts values (logAIEvent stamps now). */
  function writeEvents(rows: AIEvent[]): void {
    const file = aiEventsFile(vault)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf-8')
  }

  const day = (offsetDays: number, h = 12): string =>
    new Date(Date.now() - offsetDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10) +
    (h < 10 ? `T0${h}` : `T${h}`) +
    ':00:00.000Z'

  it('window aggregates terminal ops: operations, tokens, error rate, avg duration', () => {
    // Chronological file order (oldest first) — mirrors real logAIEvent appends;
    // the window scan early-exits once events fall behind the cutoff.
    writeEvents([
      { ts: day(1), kind: 'tool', tool: 'search', status: 'ok' }, // non-terminal → ignored
      { ts: day(1), kind: 'stream_start', status: 'started' }, // non-terminal → ignored
      { ts: day(1), kind: 'send', status: 'ok', tokensUsed: 500, durationMs: 1000 },
      {
        ts: day(0),
        kind: 'stream_end',
        status: 'error',
        tokensUsed: 300,
        durationMs: 500,
        error: 'x'
      },
      { ts: day(0), kind: 'stream_end', status: 'ok', tokensUsed: 1200, durationMs: 2000 }
    ])
    const w = getAIEventStatsWindow(vault, 7)
    expect(w).not.toBeNull()
    expect(w!.operations).toBe(3)
    expect(w!.tokensUsed).toBe(2000)
    expect(w!.errors).toBe(1)
    expect(w!.errorRate).toBeCloseTo(1 / 3)
    expect(w!.avgDurationMs).toBe(Math.round(3500 / 3))
  })

  it('window filters out events older than `days`', () => {
    writeEvents([
      { ts: day(30), kind: 'stream_end', status: 'ok' }, // outside
      { ts: day(9), kind: 'stream_end', status: 'error' }, // outside 7-day window
      { ts: day(4), kind: 'stream_end', status: 'error' },
      { ts: day(0), kind: 'stream_end', status: 'ok' }
    ])
    const w = getAIEventStatsWindow(vault, 7)
    expect(w!.operations).toBe(2) // day0 + day4
    expect(w!.errors).toBe(1)
    // A 3-day window keeps day(0) but drops day(4) (4 days back)
    const w3 = getAIEventStatsWindow(vault, 3)
    expect(w3!.operations).toBe(1)
  })

  it('series has exactly `days` buckets, oldest → newest, errors flagged per day', () => {
    // Look buckets up by day key instead of hardcoded indices — immune to a
    // UTC-midnight rollover between the write and the aggregation call.
    const keyOf = (offsetDays: number): string =>
      new Date(Date.now() - offsetDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
    writeEvents([
      { ts: day(3), kind: 'stream_end', status: 'ok', tokensUsed: 7 },
      { ts: day(0), kind: 'stream_end', status: 'error', tokensUsed: 5 },
      { ts: day(0), kind: 'stream_end', status: 'ok', tokensUsed: 10 }
    ])
    const w = getAIEventStatsWindow(vault, 7)
    expect(w!.series).toHaveLength(7)
    const today = w!.series.find((s) => s.day === keyOf(0))!
    expect(today.operations).toBe(2)
    expect(today.errors).toBe(1)
    expect(today.tokensUsed).toBe(15)
    const day3 = w!.series.find((s) => s.day === keyOf(3))!
    expect(day3.operations).toBe(1)
    expect(day3.tokensUsed).toBe(7)
    // Empty days stay zeroed
    expect(w!.series.filter((s) => s.operations === 0).length).toBeGreaterThanOrEqual(5)
    // Oldest bucket first (ISO day keys sort chronologically)
    expect(w!.series[0].day < w!.series[6].day).toBe(true)
  })

  it('returns null without a vault or with days < 1', () => {
    expect(getAIEventStatsWindow(null, 7)).toBeNull()
    expect(getAIEventStatsWindow(undefined, 7)).toBeNull()
    expect(getAIEventStatsWindow(vault, 0)).toBeNull()
    expect(getAIEventStatsWindow(vault, 7)).not.toBeNull()
  })
})
