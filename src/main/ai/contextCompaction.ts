/**
 * R1-1 — auto context compaction.
 *
 * Long conversations drift toward the model's context window; a 200-message
 * chat would otherwise blow the budget (or stall on provider limits). When the
 * estimated history crosses a threshold of the model's context budget, the
 * OLDEST messages are folded into a single deterministic `[Compacted]` block —
 * an extractive one-line-per-message summary (no extra model call, no network,
 * always reproducible for tests).
 *
 * Guarantees:
 *  - As many of the MOST RECENT messages as fit the budget survive (the tail
 *    starts at KEEP_RECENT and only shrinks when the tail itself is over).
 *  - Tool pairing stays intact: an assistant `tool_calls` message and its
 *    `tool` results are folded together, so the remaining messages never
 *    contain an orphan tool result (OpenAI rejects those).
 *  - Termination: the fold loop shrinks the kept tail geometrically; it stops
 *    when it fits the threshold or only 2 messages remain.
 *  - No-op when already under the threshold (budget-friendly: estimate is
 *    chars/4, the same convention as the middleware's token accounting).
 */
import type { AIMessage } from './providers/BaseProvider'

/** Fallback budget when the model's context window is unknown. */
export const DEFAULT_COMPACTION_BUDGET = 32_000
/** Compact when the estimated history exceeds this fraction of the budget. */
export const COMPACT_THRESHOLD = 0.8
/** Minimum tail that always survives compaction (recent context). */
export const KEEP_RECENT = 8
/** Headroom reserved for the model's reply (never compacted away). */
export const RESERVED_OUTPUT_TOKENS = 4_096

/** Rough context-window per model family — mirrors the renderer's budget bar. */
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

export function estimateTokens(text: string): number {
  return Math.ceil(String(text || '').length / 4)
}

/** Rough tokens for one message: content + tool args + a per-message overhead. */
export function messageTokens(m: AIMessage): number {
  let t = estimateTokens(m.content || '') + 4
  for (const tc of m.tool_calls || []) t += estimateTokens(tc.arguments || '') + 8
  if (m.images?.length) t += m.images.length * 20
  return t
}

function totalTokens(messages: AIMessage[]): number {
  return messages.reduce((sum, m) => sum + messageTokens(m), 0)
}

/** Map a model id to a nominal context window (rough, for a usage budget). */
export function contextBudgetForModel(
  modelId: string | undefined | null,
  fallback = DEFAULT_COMPACTION_BUDGET
): number {
  const id = String(modelId || '')
  for (const [re, window] of CONTEXT_WINDOWS) {
    if (re.test(id)) return window
  }
  return fallback
}

function oneLine(text: string, max: number): string {
  return (text || '').replace(/\s+/g, ' ').trim().slice(0, max)
}

/** Build the extractive `[Compacted]` block summarizing the folded messages. */
function buildCompactedBlock(removed: AIMessage[], first: AIMessage | undefined): AIMessage {
  const topic = first?.role === 'user' && first.content ? oneLine(first.content, 200) : ''
  const lines: string[] = []
  let userCount = 0
  let asstCount = 0
  let toolCount = 0
  for (const m of removed) {
    if (m.role === 'user') {
      userCount++
      if (lines.length < 8) lines.push(`- user: ${oneLine(m.content, 140)}`)
    } else if (m.role === 'assistant') {
      if (m.tool_calls?.length) toolCount++
      else {
        asstCount++
        if (lines.length < 8) lines.push(`- asisten: ${oneLine(m.content, 140)}`)
      }
    }
  }
  const parts = [
    `[Compacted] — ${removed.length} pesan sebelumnya (${userCount} user, ${asstCount} jawaban, ${toolCount} panggilan tool) diringkas.`
  ]
  if (topic) parts.push(`Topik awal: "${topic}"`)
  if (lines.length > 0) parts.push('', ...lines)
  parts.push(
    '',
    'Lanjutkan percakapan berdasarkan ringkasan ini — jangan mengulang detail yang sudah diringkas.'
  )
  return { role: 'user', content: parts.join('\n') }
}

export interface CompactResult {
  messages: AIMessage[]
  /** Number of messages folded into the [Compacted] block. */
  compactedCount: number
  /** Estimated tokens freed (before − after). */
  freedTokens: number
  beforeTokens: number
  afterTokens: number
}

/**
 * Fold the oldest messages into a `[Compacted]` block when the estimated
 * history exceeds `budget * COMPACT_THRESHOLD`. The tail (last KEEP_RECENT
 * messages) always survives; the block is prepended in its place. Returns the
 * input unchanged when already under the threshold.
 */
export function compactMessages(
  messages: AIMessage[],
  budget = DEFAULT_COMPACTION_BUDGET
): CompactResult {
  const threshold = Math.floor(budget * COMPACT_THRESHOLD)
  const beforeTokens = totalTokens(messages)
  const noop: CompactResult = {
    messages,
    compactedCount: 0,
    freedTokens: 0,
    beforeTokens,
    afterTokens: beforeTokens
  }
  // Nothing to fold: too few messages, or already comfortably under budget.
  if (messages.length <= 2 || beforeTokens <= threshold) return noop

  // Fold from the front, geometrically shrinking the kept tail until it fits.
  let keepCount = Math.min(KEEP_RECENT, Math.max(2, Math.floor(messages.length / 2)))
  let result: CompactResult = noop
  for (;;) {
    let split = Math.max(0, messages.length - keepCount)
    // Never split a tool run: if the kept tail would START on a `tool` message,
    // its assistant `tool_calls` partner was folded → orphan result (OpenAI
    // rejects tool messages without a preceding call). Fold the leading tools too.
    while (split < messages.length && messages[split].role === 'tool') split++
    const removed = messages.slice(0, split)
    const kept = messages.slice(split)
    const block = buildCompactedBlock(removed, messages[0])
    const afterTokens = messageTokens(block) + totalTokens(kept)
    result = {
      messages: [block, ...kept],
      compactedCount: removed.length,
      freedTokens: Math.max(0, beforeTokens - afterTokens),
      beforeTokens,
      afterTokens
    }
    if (afterTokens <= threshold || keepCount <= 2) break
    keepCount = Math.max(2, Math.floor(keepCount / 2))
  }
  return result
}
