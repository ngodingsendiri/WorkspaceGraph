/**
 * P2-1: per-session token budget bar helpers.
 *
 * The chunk stream already carries `tokensUsed` (provider-reported, summed
 * across tool rounds in the store) and `contextTokens` (estimated workspace
 * context injected for the reply). This module derives the *session* totals
 * and maps the active model to a nominal context-window budget so the bar can
 * show usage as a fraction of what the model can hold.
 */

/** Rough context-window per model family — enough for a usage bar, not billing. */
const CONTEXT_WINDOWS: Array<[RegExp, number]> = [
  [/gemini-1\.5-pro/i, 2_000_000],
  [/gemini-2\.5-pro/i, 1_000_000],
  [/gemini-2\.5-flash/i, 1_000_000],
  [/gemini-1\.5-flash/i, 1_000_000],
  [/gemini/i, 128_000],
  [/claude/i, 200_000],
  [/grok/i, 131_072],
  [/gpt-4/i, 128_000],
  [/gpt-3\.5/i, 16_000],
  [/o1|o3|o4/i, 200_000],
  [/llama/i, 32_000],
  [/qwen/i, 32_000],
  [/mistral/i, 32_000],
  [/deepseek/i, 64_000]
]

export function contextBudgetForModel(
  modelId: string | undefined | null,
  fallback = 64_000
): number {
  const id = String(modelId || '')
  for (const [re, window] of CONTEXT_WINDOWS) {
    if (re.test(id)) return window
  }
  return fallback
}

export interface TokenStatsInput {
  tokensUsed?: number
  costUsd?: number
  contextTokens?: number
  contextSavedTokens?: number
}

/** R2-1: per-session estimated USD cost — sum of per-reply costUsd (0 when none). */
export function sessionCostStats(messages: TokenStatsInput[]): number {
  let total = 0
  for (const m of messages) {
    if (typeof m.costUsd === 'number') total += m.costUsd
  }
  return total
}

/** Compact USD for the budget bar / status line: `$0.0012`, `$1.23`, `$12`. */
export function formatUsd(usd: number): string {
  const v = Math.max(0, usd)
  if (v === 0) return '$0'
  if (v < 0.01) return `$${v.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')}`
  if (v < 100) return `$${v.toFixed(2).replace(/\.?0+$/, '')}`
  return `$${v.toFixed(1)}`
}

export interface SessionTokenStats {
  /** Sum of provider-reported output tokens across every reply this session. */
  outputTokens: number
  /** Injected workspace context of the LATEST reply (re-injected each turn). */
  contextTokens: number
  /** P1-4: context tokens the LATEST reply avoided re-sending in tool rounds. */
  savedTokens: number
  /** Number of assistant replies that reported a context estimate. */
  replies: number
}

export function sessionTokenStats(messages: TokenStatsInput[]): SessionTokenStats {
  let outputTokens = 0
  let contextTokens = 0
  let savedTokens = 0
  let replies = 0
  for (const m of messages) {
    if (typeof m.tokensUsed === 'number') outputTokens += m.tokensUsed
    // Context is per-reply, not cumulative — the last reply's estimate wins.
    if (typeof m.contextTokens === 'number') {
      contextTokens = m.contextTokens
      replies++
    }
    if (typeof m.contextSavedTokens === 'number') savedTokens = m.contextSavedTokens
  }
  return { outputTokens, contextTokens, savedTokens, replies }
}

/** Compact token count: `950`, `12k`, `1.2M`. */
export function formatK(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`
  return String(n)
}

/** Fraction of the budget consumed, clamped to [0, 1]. */
export function budgetFraction(used: number, budget: number): number {
  if (budget <= 0) return 0
  return Math.min(1, Math.max(0, used / budget))
}
