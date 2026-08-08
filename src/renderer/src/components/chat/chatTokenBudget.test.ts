import { describe, it, expect } from 'vitest'
import {
  contextBudgetForModel,
  sessionTokenStats,
  sessionCostStats,
  formatK,
  formatUsd,
  budgetFraction
} from './chatTokenBudget'

describe('contextBudgetForModel (P2-1)', () => {
  it('maps known model families to their context windows', () => {
    expect(contextBudgetForModel('grok-4.5')).toBe(131_072)
    expect(contextBudgetForModel('claude-sonnet-4')).toBe(200_000)
    expect(contextBudgetForModel('gpt-4o')).toBe(128_000)
    expect(contextBudgetForModel('gemini-2.5-flash')).toBe(1_000_000)
  })

  it('falls back for unknown models and empty input', () => {
    expect(contextBudgetForModel('weird-model-9000')).toBe(64_000)
    expect(contextBudgetForModel('', 32_000)).toBe(32_000)
    expect(contextBudgetForModel(undefined)).toBe(64_000)
  })
})

describe('sessionTokenStats (P2-1)', () => {
  it('sums output tokens across all replies', () => {
    const s = sessionTokenStats([{ tokensUsed: 100 }, { tokensUsed: 250 }, { tokensUsed: 150 }])
    expect(s.outputTokens).toBe(500)
  })

  it('keeps the LATEST context estimate, not the sum', () => {
    const s = sessionTokenStats([
      { tokensUsed: 100, contextTokens: 800 },
      { tokensUsed: 250, contextTokens: 1200 }
    ])
    expect(s.outputTokens).toBe(350)
    expect(s.contextTokens).toBe(1200)
    expect(s.replies).toBe(2)
  })

  it('ignores messages without token data', () => {
    const s = sessionTokenStats([{}, { tokensUsed: 0 }, {}])
    expect(s.outputTokens).toBe(0)
    expect(s.contextTokens).toBe(0)
    expect(s.replies).toBe(0)
  })
})

describe('sessionCostStats + formatUsd (R2-1)', () => {
  it('sums per-reply costUsd across the session', () => {
    expect(sessionCostStats([{ costUsd: 0.001 }, { costUsd: 0.002 }, {}])).toBeCloseTo(0.003, 6)
    expect(sessionCostStats([])).toBe(0)
    expect(sessionCostStats([{}, {}])).toBe(0)
  })

  it('formats fractions, cents and dollars compactly', () => {
    expect(formatUsd(0)).toBe('$0')
    expect(formatUsd(0.001234)).toBe('$0.0012')
    expect(formatUsd(1.23)).toBe('$1.23')
    expect(formatUsd(12.5)).toBe('$12.5')
    expect(formatUsd(-3)).toBe('$0')
  })
})

describe('formatK + budgetFraction (P2-1)', () => {
  it('formats compactly', () => {
    expect(formatK(950)).toBe('950')
    expect(formatK(12_000)).toBe('12k')
    expect(formatK(1_200_000)).toBe('1.2M')
    expect(formatK(2_000_000)).toBe('2M')
  })

  it('clamps the fraction to [0,1] and guards a zero budget', () => {
    expect(budgetFraction(50_000, 100_000)).toBe(0.5)
    expect(budgetFraction(200_000, 100_000)).toBe(1)
    expect(budgetFraction(-5, 100_000)).toBe(0)
    expect(budgetFraction(1000, 0)).toBe(0)
  })
})
