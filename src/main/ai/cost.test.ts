import { describe, it, expect } from 'vitest'
import { staticPriceForModel, resolveModelPrice, estimateStreamCostUsd, formatUsd } from './cost'

describe('staticPriceForModel (R2-1)', () => {
  it('matches model families to the static table', () => {
    expect(staticPriceForModel('grok-4-fast').inputPerMTok).toBe(3)
    expect(staticPriceForModel('claude-4-sonnet').outputPerMTok).toBe(15)
    expect(staticPriceForModel('gpt-4o').inputPerMTok).toBe(2.5)
    expect(staticPriceForModel('gemini-2.5-flash').inputPerMTok).toBe(0.3)
  })

  it('local models are always free', () => {
    expect(staticPriceForModel('ollama/llama3')).toEqual({ inputPerMTok: 0, outputPerMTok: 0 })
    expect(staticPriceForModel('local-embedding')).toEqual({ inputPerMTok: 0, outputPerMTok: 0 })
  })

  it('unknown models fall back to the generic rate', () => {
    const p = staticPriceForModel('totally-unknown-model-xyz')
    expect(p.inputPerMTok).toBeGreaterThan(0)
    expect(p.outputPerMTok).toBeGreaterThan(0)
  })
})

describe('resolveModelPrice (R2-1)', () => {
  it('runtime per-token pricing wins over the static table', () => {
    const price = resolveModelPrice('claude-4-sonnet', { input: 0.000003, output: 0.000015 })
    expect(price.inputPerMTok).toBeCloseTo(3, 5)
    expect(price.outputPerMTok).toBeCloseTo(15, 5)
  })

  it('null runtime pricing falls back to static', () => {
    expect(resolveModelPrice('grok-4', null).inputPerMTok).toBe(3)
  })

  it('explicit free runtime pricing (all 0) stays free — never falls back to static', () => {
    const price = resolveModelPrice('grok-4', { input: 0, output: 0 })
    expect(price.inputPerMTok).toBe(0)
    expect(price.outputPerMTok).toBe(0)
  })
})

describe('estimateStreamCostUsd (R2-1)', () => {
  it('computes input + output cost from per-1M rates', () => {
    // grok-4: $3/M in, $15/M out → 100k in + 50k out = $0.30 + $0.75
    const usd = estimateStreamCostUsd('grok-4', 100_000, 50_000)
    expect(usd).toBeCloseTo(1.05, 6)
  })

  it('uses runtime pricing when provided', () => {
    const usd = estimateStreamCostUsd('some-openrouter-model', 1_000_000, 500_000, {
      input: 0.000001,
      output: 0.000002
    })
    expect(usd).toBeCloseTo(2.0, 6)
  })

  it('runtime free pricing (all 0) yields $0 cost', () => {
    const usd = estimateStreamCostUsd('grok-4', 100_000, 50_000, { input: 0, output: 0 })
    expect(usd).toBe(0)
  })

  it('is zero for free/local models', () => {
    expect(estimateStreamCostUsd('ollama/llama3.1', 50_000, 10_000)).toBe(0)
  })

  it('never returns negative for odd inputs', () => {
    expect(estimateStreamCostUsd('gpt-4', -100, -50)).toBe(0)
  })
})

describe('formatUsd (R2-1)', () => {
  it('formats fractions, cents and dollars compactly', () => {
    expect(formatUsd(0)).toBe('$0')
    expect(formatUsd(0.001234)).toBe('$0.0012')
    expect(formatUsd(1.23)).toBe('$1.23')
    expect(formatUsd(12.5)).toBe('$12.5')
  })

  it('clamps negative to $0', () => {
    expect(formatUsd(-5)).toBe('$0')
  })
})
