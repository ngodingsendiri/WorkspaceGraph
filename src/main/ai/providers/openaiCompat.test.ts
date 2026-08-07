import { describe, it, expect } from 'vitest'
import type { AIRequest, AIMessage } from './BaseProvider'
import {
  buildOpenAIMessages,
  accumulateToolCallDeltas,
  deltaReasoning,
  finalizeToolCalls,
  MutableToolCall
} from './openaiCompat'

describe('buildOpenAIMessages', () => {
  it('prepends the system prompt as the first system message', () => {
    const req: AIRequest = {
      systemPrompt: 'Kernel',
      messages: [{ role: 'user', content: 'hi' }]
    }
    const msgs = buildOpenAIMessages(req)
    expect(msgs[0]).toEqual({ role: 'system', content: 'Kernel' })
    expect(msgs[1]).toEqual({ role: 'user', content: 'hi' })
  })

  it('maps a tool-role result to a tool message with tool_call_id', () => {
    const req: AIRequest = {
      messages: [{ role: 'tool', tool_call_id: 'call_1', content: '{"ok":true}' }] as AIMessage[]
    }
    const msgs = buildOpenAIMessages(req)
    expect(msgs[0]).toEqual({
      role: 'tool',
      tool_call_id: 'call_1',
      content: '{"ok":true}'
    })
  })

  it('maps assistant tool_calls into the SDK shape (type: function, null content)', () => {
    const req: AIRequest = {
      messages: [
        {
          role: 'assistant',
          content: '',
          tool_calls: [{ id: 'call_1', name: 'search', arguments: '{"query":"x"}' }]
        }
      ]
    }
    const msgs = buildOpenAIMessages(req)
    expect(msgs[0]).toEqual({
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          type: 'function',
          id: 'call_1',
          function: { name: 'search', arguments: '{"query":"x"}' }
        }
      ]
    })
  })

  it('passes plain user/assistant messages through unchanged', () => {
    const req: AIRequest = {
      messages: [
        { role: 'user', content: 'a' },
        { role: 'assistant', content: 'b' }
      ]
    }
    const msgs = buildOpenAIMessages(req)
    expect(msgs).toEqual([
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' }
    ])
  })

  it('turns a user message with images into image_url content parts (P-A2)', () => {
    const req: AIRequest = {
      messages: [
        {
          role: 'user',
          content: 'Apa isi gambar ini?',
          images: [{ mimeType: 'image/png', dataBase64: 'aGVsbG8=', name: 'x.png' }]
        }
      ]
    }
    const msgs = buildOpenAIMessages(req)
    expect(msgs).toHaveLength(1)
    const content = msgs[0].content
    expect(Array.isArray(content)).toBe(true)
    const parts = content as { type: string; image_url?: { url: string }; text?: string }[]
    expect(parts[0]).toEqual({
      type: 'image_url',
      image_url: { url: 'data:image/png;base64,aGVsbG8=' }
    })
    expect(parts[1]).toEqual({ type: 'text', text: 'Apa isi gambar ini?' })
  })

  it('keeps image parts BEFORE the text part for multiple images (P-A2)', () => {
    const req: AIRequest = {
      messages: [
        {
          role: 'user',
          content: 'c',
          images: [
            { mimeType: 'image/jpeg', dataBase64: 'aa' },
            { mimeType: 'image/webp', dataBase64: 'bb' }
          ]
        }
      ]
    }
    const msgs = buildOpenAIMessages(req)
    const parts = msgs[0].content as { type: string }[]
    expect(parts.map((p) => p.type)).toEqual(['image_url', 'image_url', 'text'])
  })
})

describe('deltaReasoning (P2-4)', () => {
  it('reads reasoning_content (xAI / DeepSeek compat)', () => {
    expect(deltaReasoning({ reasoning_content: 'berpikir dulu' })).toBe('berpikir dulu')
  })

  it('reads the OpenAI o-series `reasoning` field', () => {
    expect(deltaReasoning({ reasoning: 'think step by step' })).toBe('think step by step')
  })

  it('prefers reasoning_content over reasoning when both are present', () => {
    expect(deltaReasoning({ reasoning_content: 'a', reasoning: 'b' })).toBe('a')
  })

  it('tolerates nulls and non-objects', () => {
    expect(deltaReasoning({ reasoning_content: null })).toBe('')
    expect(deltaReasoning({ reasoning: null })).toBe('')
    expect(deltaReasoning(null)).toBe('')
    expect(deltaReasoning(undefined)).toBe('')
    expect(deltaReasoning('nope')).toBe('')
  })
})

describe('tool_calls delta accumulation (P-A1)', () => {
  it('concatenates arguments split across chunks', () => {
    const acc: MutableToolCall[] = []
    accumulateToolCallDeltas(acc, [{ index: 0, id: 'call_1', function: { name: 'search' } }])
    accumulateToolCallDeltas(acc, [{ index: 0, function: { arguments: '{"qu' } }])
    accumulateToolCallDeltas(acc, [{ index: 0, function: { arguments: 'ery":"hi"}' } }])
    const calls = finalizeToolCalls(acc)
    expect(calls).toEqual([{ id: 'call_1', name: 'search', arguments: '{"query":"hi"}' }])
  })

  it('accumulates two parallel calls in index order', () => {
    const acc: MutableToolCall[] = []
    // Out-of-order arrival: index 1 first, then 0
    accumulateToolCallDeltas(acc, [
      { index: 1, id: 'call_b', function: { name: 'list_dir', arguments: '{}' } }
    ])
    accumulateToolCallDeltas(acc, [
      { index: 0, id: 'call_a', function: { name: 'search', arguments: '{"query":"x"}' } }
    ])
    const calls = finalizeToolCalls(acc)
    expect(calls.map((c) => c.name)).toEqual(['search', 'list_dir'])
  })

  it('drops unnamed calls but KEEPS legit empty-args calls (e.g. list_templates)', () => {
    const acc: MutableToolCall[] = []
    accumulateToolCallDeltas(acc, [
      { index: 0, id: 'ghost', function: { arguments: '{}' } }, // no name → dropped
      { index: 1, id: 'empty', function: { name: 'list_templates' } }, // no args → kept
      { index: 2, id: 'ok', function: { name: 'search', arguments: '{"query":"y"}' } }
    ])
    const calls = finalizeToolCalls(acc)
    expect(calls).toHaveLength(2)
    expect(calls[0].id).toBe('empty')
    expect(calls[0].arguments).toBe('')
    expect(calls[1].id).toBe('ok')
  })

  it('ignores null/undefined delta lists', () => {
    const acc: MutableToolCall[] = []
    accumulateToolCallDeltas(acc, undefined)
    accumulateToolCallDeltas(acc, null)
    expect(finalizeToolCalls(acc)).toEqual([])
  })

  it('assigns name once and keeps the first id (no duplication on repeated parts)', () => {
    const acc: MutableToolCall[] = []
    accumulateToolCallDeltas(acc, [{ index: 0, id: 'call_1', function: { name: 'search' } }])
    accumulateToolCallDeltas(acc, [{ index: 0, id: 'call_1', function: { name: 'search' } }])
    accumulateToolCallDeltas(acc, [{ index: 0, function: { arguments: '{"query":"z"}' } }])
    const calls = finalizeToolCalls(acc)
    expect(calls).toHaveLength(1)
    expect(calls[0].name).toBe('search')
    expect(calls[0].arguments).toBe('{"query":"z"}')
  })
})
