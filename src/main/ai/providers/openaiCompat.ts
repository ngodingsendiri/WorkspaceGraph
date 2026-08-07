/**
 * Shared OpenAI-compatible glue for the native function-calling path (P-A1).
 *
 * The three OpenAI-chat providers (OpenAI, Grok/xAI, OpenRouter) all speak the
 * same chat.completions wire format. Keeping the message builder and the
 * streaming `tool_calls` delta accumulation here means the tool loop contract
 * is defined once and exercised by unit tests, instead of drifting across
 * three near-identical provider files.
 */
import type OpenAI from 'openai'
import type { AIRequest, AIToolCall } from './BaseProvider'

/** Build chat.completions messages, including native tool roles. */
export function buildOpenAIMessages(request: AIRequest): OpenAI.ChatCompletionMessageParam[] {
  const messages: OpenAI.ChatCompletionMessageParam[] = []
  if (request.systemPrompt) {
    messages.push({ role: 'system', content: request.systemPrompt })
  }
  for (const m of request.messages) {
    if (m.role === 'tool') {
      messages.push({
        role: 'tool',
        tool_call_id: m.tool_call_id || '',
        content: m.content
      })
    } else if (m.role === 'assistant' && m.tool_calls?.length) {
      messages.push({
        role: 'assistant',
        // OpenAI requires null (not "") content on tool_calls messages
        content: m.content || null,
        tool_calls: m.tool_calls.map((tc) => ({
          type: 'function',
          id: tc.id,
          function: {
            name: tc.name,
            arguments: tc.arguments
          }
        }))
      })
    } else if (m.role === 'user' && m.images?.length) {
      // Vision (P-A2): images become image_url content parts before the text.
      // The text part is omitted when content is empty (image-only prompt) —
      // some providers reject empty text parts.
      const parts: OpenAI.ChatCompletionContentPart[] = m.images.map((img) => ({
        type: 'image_url',
        image_url: { url: `data:${img.mimeType};base64,${img.dataBase64}` }
      }))
      if (m.content.trim()) parts.push({ type: 'text', text: m.content })
      messages.push({ role: 'user', content: parts })
    } else {
      messages.push({ role: m.role, content: m.content })
    }
  }
  return messages
}

/**
 * Extract the streaming reasoning delta from a chat.completions delta.
 * Reasoning models emit their chain-of-thought under two names: xAI / DeepSeek
 * / OpenRouter compat send `reasoning_content`, OpenAI o-series sends
 * `reasoning`. Capturing both keeps the collapsible "Berpikir" block (P2-4)
 * working across every OpenAI-compat provider without per-provider drift.
 */
export function deltaReasoning(delta: unknown): string {
  if (!delta || typeof delta !== 'object') return ''
  const d = delta as { reasoning_content?: string | null; reasoning?: string | null }
  return d.reasoning_content || d.reasoning || ''
}

/**
 * One `delta.tool_calls` element as it arrives in a stream chunk. Widened with
 * `null` to structurally accept the OpenAI SDK's DeltaToolCall type.
 */
export interface ToolCallDeltaPart {
  index?: number
  id?: string | null
  function?: { name?: string | null; arguments?: string | null } | null
}

/** In-progress accumulated tool call (per index). */
export interface MutableToolCall {
  index: number
  id: string
  name: string
  arguments: string
}

/**
 * Merge a chunk's `delta.tool_calls` parts into the running accumulator.
 * Arguments arrive split across chunks and must be concatenated; name arrives
 * once (assign, not append).
 */
export function accumulateToolCallDeltas(
  acc: MutableToolCall[],
  parts: ToolCallDeltaPart[] | undefined | null
): void {
  if (!parts) return
  for (const part of parts) {
    if (!part || typeof part !== 'object') continue
    const idx = part.index ?? 0
    let call = acc.find((c) => c.index === idx)
    if (!call) {
      call = { index: idx, id: part.id || `call_${idx}`, name: '', arguments: '' }
      acc.push(call)
    }
    if (part.id) call.id = part.id
    if (part.function?.name) call.name = part.function.name
    if (part.function?.arguments) call.arguments += part.function.arguments
  }
}

/**
 * Finalize accumulated deltas into ordered, complete tool calls.
 * Only calls without a name are dropped (a provider that emitted only args).
 * Empty arguments are kept — providers legitimately emit `''` for no-arg tools
 * like list_templates, and nativeCallsToActions defaults empty args to {}.
 */
export function finalizeToolCalls(acc: MutableToolCall[]): AIToolCall[] {
  return acc
    .slice()
    .sort((a, b) => a.index - b.index)
    .filter((c) => Boolean(c.name.trim()))
    .map((c) => ({ id: c.id || `call_${c.index}`, name: c.name, arguments: c.arguments }))
}
