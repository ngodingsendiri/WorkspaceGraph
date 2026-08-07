import { describe, it, expect } from 'vitest'
import { summarizeToolRuns, toolSummaryLabel } from './chatToolSummary'

describe('summarizeToolRuns (P2-2)', () => {
  it('counts ok and error runs', () => {
    expect(
      summarizeToolRuns([{ status: 'ok' }, { status: 'ok' }, { status: 'ok' }, { status: 'error' }])
    ).toEqual({ ok: 3, failed: 1, total: 4 })
  })

  it('treats interrupted close-outs as failures', () => {
    expect(summarizeToolRuns([{ status: 'ok' }, { status: 'error' }])).toEqual({
      ok: 1,
      failed: 1,
      total: 2
    })
  })

  it('returns null for an empty or missing trail', () => {
    expect(summarizeToolRuns(undefined)).toBeNull()
    expect(summarizeToolRuns([])).toBeNull()
  })

  it('ignores running status (should not survive a settled stream)', () => {
    const sum = summarizeToolRuns([{ status: 'running' }, { status: 'ok' }])
    expect(sum).toEqual({ ok: 1, failed: 0, total: 2 })
  })
})

describe('toolSummaryLabel (P2-2)', () => {
  it('renders the failed part only when failures exist', () => {
    expect(toolSummaryLabel({ ok: 4, failed: 0, total: 4 })).toBe('tools: 4 ok')
    expect(toolSummaryLabel({ ok: 4, failed: 1, total: 5 })).toBe('tools: 4 ok · 1 gagal')
  })

  it('renders empty for a null summary', () => {
    expect(toolSummaryLabel(null)).toBe('')
  })
})
