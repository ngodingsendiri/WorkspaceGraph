/**
 * R2-1 — cost tracking.
 *
 * Estimates the USD cost of an AI stream from token counts. Two sources:
 *  1. STATIC table below — per-model-family rates (input/output per 1M tokens),
 *     used for every provider when runtime pricing is unknown.
 *  2. Runtime pricing — OpenRouter exposes EXACT per-token prices in `/models`
 *     (`pricing.prompt` / `pricing.completion`); those ride on ModelInfo and
 *     win over the static table when present.
 *
 * These are ESTIMATES for the budget bar / status line, not billing-grade —
 * prices drift, and a model may route through a cheaper/expensive variant.
 */

export interface ModelPrice {
  /** USD per 1M input tokens */
  inputPerMTok: number
  /** USD per 1M output tokens */
  outputPerMTok: number
}

/**
 * Static per-family rates (USD per 1M tokens), newest-known list first.
 * Deliberately conservative: use the mid-tier variant of each family so the
 * estimate never wildly under-bills. Unknown models default to a generic rate.
 */
const STATIC_PRICES: Array<[RegExp, ModelPrice]> = [
  [/grok-4/i, { inputPerMTok: 3, outputPerMTok: 15 }],
  [/grok-3/i, { inputPerMTok: 3, outputPerMTok: 15 }],
  [/grok/i, { inputPerMTok: 2, outputPerMTok: 10 }],
  [/claude-4/i, { inputPerMTok: 3, outputPerMTok: 15 }],
  [/claude-3\.[57]/i, { inputPerMTok: 3, outputPerMTok: 15 }],
  [/claude-3/i, { inputPerMTok: 5, outputPerMTok: 25 }],
  [/claude/i, { inputPerMTok: 3, outputPerMTok: 15 }],
  [/gpt-5/i, { inputPerMTok: 1.25, outputPerMTok: 10 }],
  [/gpt-4o/i, { inputPerMTok: 2.5, outputPerMTok: 10 }],
  [/gpt-4/i, { inputPerMTok: 30, outputPerMTok: 60 }],
  [/gpt-3\.5/i, { inputPerMTok: 0.5, outputPerMTok: 1.5 }],
  [/o1|o3|o4/i, { inputPerMTok: 2.5, outputPerMTok: 10 }],
  [/gemini-2\.5-pro/i, { inputPerMTok: 1.25, outputPerMTok: 10 }],
  [/gemini-2\.5-flash/i, { inputPerMTok: 0.3, outputPerMTok: 2.5 }],
  [/gemini-2/i, { inputPerMTok: 1.25, outputPerMTok: 10 }],
  [/gemini/i, { inputPerMTok: 1.25, outputPerMTok: 10 }],
  [/deepseek/i, { inputPerMTok: 0.27, outputPerMTok: 1.1 }],
  [/llama/i, { inputPerMTok: 0.2, outputPerMTok: 0.6 }],
  [/qwen/i, { inputPerMTok: 0.2, outputPerMTok: 0.6 }],
  [/mistral/i, { inputPerMTok: 0.2, outputPerMTok: 0.6 }],
  [/llava/i, { inputPerMTok: 0.2, outputPerMTok: 0.6 }]
]

/** Generic fallback — used when the model id matches nothing above. */
const GENERIC_PRICE: ModelPrice = { inputPerMTok: 0.5, outputPerMTok: 1.5 }

/** Local (Ollama etc.) — always $0. */
const FREE_PRICE: ModelPrice = { inputPerMTok: 0, outputPerMTok: 0 }

/**
 * Runtime price from the provider (OpenRouter per-token USD). Passed by the
 * middleware when the provider's ModelInfo carries `pricing`.
 */
export interface RuntimeModelPrice {
  /** USD per input token */
  input: number
  /** USD per output token */
  output: number
}

/** Look up the static rate for a model id, or the generic fallback. */
export function staticPriceForModel(modelId: string | undefined | null): ModelPrice {
  const id = String(modelId || '')
  if (/ollama|local|embedding/i.test(id)) return FREE_PRICE
  for (const [re, price] of STATIC_PRICES) {
    if (re.test(id)) return price
  }
  return GENERIC_PRICE
}

/**
 * Resolve the effective price: runtime (per-token) wins when provided, else
 * the static table. Returns a ModelPrice in per-1M-token units so the caller
 * always computes on the same scale.
 */
export function resolveModelPrice(
  modelId: string | undefined | null,
  runtime?: RuntimeModelPrice | null
): ModelPrice {
  if (runtime) {
    // Runtime pricing wins even when it says "free" (all 0) — a free model
    // through OpenRouter should never fall through to the static table.
    return {
      inputPerMTok: runtime.input * 1_000_000,
      outputPerMTok: runtime.output * 1_000_000
    }
  }
  return staticPriceForModel(modelId)
}

/** Estimated USD cost of one stream completion. Never negative. */
export function estimateStreamCostUsd(
  modelId: string | undefined | null,
  inputTokens: number,
  outputTokens: number,
  runtime?: RuntimeModelPrice | null
): number {
  const price = resolveModelPrice(modelId, runtime)
  const inUsd = (Math.max(0, inputTokens) / 1_000_000) * price.inputPerMTok
  const outUsd = (Math.max(0, outputTokens) / 1_000_000) * price.outputPerMTok
  return inUsd + outUsd
}

/**
 * Compact USD formatting for the budget bar / status line:
 * `$0.0012`, `$1.23`, `$12.3`. Free/unknown → `$0`.
 */
export function formatUsd(usd: number): string {
  const v = Math.max(0, usd)
  if (v === 0) return '$0'
  if (v < 0.01) return `$${v.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')}`
  if (v < 100) return `$${v.toFixed(2).replace(/\.?0+$/, '')}`
  return `$${v.toFixed(1)}`
}
