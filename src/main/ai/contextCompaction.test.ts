import { describe, it, expect } from 'vitest'
import {
  compactMessages,
  estimateTokens,
  messageTokens,
  contextBudgetForModel,
  DEFAULT_COMPACTION_BUDGET,
  COMPACT_THRESHOLD,
  KEEP_RECENT,
  RESERVED_OUTPUT_TOKENS
} from './contextCompaction'
import type { AIMessage } from './providers/BaseProvider'

const user = (content: string): AIMessage => ({ role: 'user', content })
const asst = (content: string): AIMessage => ({ role: 'assistant', content })

/** A message worth roughly `tokens` estimated tokens (≈4 chars/token). */
const big = (role: 'user' | 'assistant', tokens: number): AIMessage => ({
  role,
  content: 'x'.repeat(tokens * 4)
})

describe('contextCompaction', () => {
  describe('token estimates', () => {
    it('estimateTokens is chars/4 (same convention as the middleware)', () => {
      expect(estimateTokens('abcd')).toBe(1)
      expect(estimateTokens('')).toBe(0)
      expect(estimateTokens('a'.repeat(100))).toBe(25)
    })

    it('messageTokens adds overhead + tool args + images', () => {
      const plain = messageTokens(user('halo'))
      expect(plain).toBe(estimateTokens('halo') + 4)
      const withTool = messageTokens({
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'c1', name: 'search', arguments: '{"query":"x"}' }]
      })
      expect(withTool).toBeGreaterThan(plain)
      const withImage = messageTokens({
        role: 'user',
        content: '',
        images: [{ mimeType: 'image/png', dataBase64: 'aGk=' }]
      })
      expect(withImage).toBeGreaterThan(4)
    })
  })

  describe('contextBudgetForModel', () => {
    it('maps model families to nominal context windows', () => {
      expect(contextBudgetForModel('grok-4.5')).toBe(131_072)
      expect(contextBudgetForModel('claude-sonnet-4')).toBe(200_000)
      expect(contextBudgetForModel('gemini-2.5-flash')).toBe(1_000_000)
      expect(contextBudgetForModel('deepseek-chat')).toBe(64_000)
    })

    it('falls back to the default for unknown models', () => {
      expect(contextBudgetForModel('my-custom-model')).toBe(DEFAULT_COMPACTION_BUDGET)
      expect(contextBudgetForModel(undefined)).toBe(DEFAULT_COMPACTION_BUDGET)
      expect(contextBudgetForModel(null, 99)).toBe(99)
    })
  })

  describe('compactMessages', () => {
    it('is a no-op when the history fits comfortably', () => {
      const history = [user('hai'), asst('hai juga'), user('apa kabar?')]
      const res = compactMessages(history, 32_000)
      expect(res.compactedCount).toBe(0)
      expect(res.messages).toBe(history) // unchanged reference, zero work
      expect(res.freedTokens).toBe(0)
    })

    it('is a no-op for very short histories even when big', () => {
      const history = [big('user', 50_000), asst('jawaban')]
      const res = compactMessages(history, 32_000)
      // 2 messages can't be compacted (nothing meaningful to keep) — and it
      // must not crash or loop forever
      expect(res.compactedCount).toBe(0)
      expect(res.messages).toHaveLength(2)
    })

    it('folds the oldest messages into a [Compacted] block with topic + preserved tail', () => {
      const history: AIMessage[] = [user('Bagaimana cara setup vault?')]
      for (let i = 0; i < 60; i++) {
        history.push(asst(`Jawaban ${i} ` + 'y'.repeat(1000)))
        history.push(user(`Pertanyaan lanjutan ${i} ` + 'y'.repeat(1000)))
      }
      expect(history.length).toBe(121)

      const res = compactMessages(history, 32_000)

      expect(res.compactedCount).toBeGreaterThan(0)
      expect(res.messages.length).toBeLessThan(history.length)
      // The block is the first message and carries the topic seed
      const block = res.messages[0]
      expect(block.role).toBe('user')
      expect(block.content).toContain('[Compacted]')
      expect(block.content).toContain('Bagaimana cara setup vault?')
      // The recent tail survives byte-for-byte
      expect(res.messages.slice(-KEEP_RECENT)).toEqual(history.slice(-KEEP_RECENT))
      // Real savings were made
      expect(res.afterTokens).toBeLessThan(res.beforeTokens)
      expect(res.freedTokens).toBeGreaterThan(0)
    })

    it('keeps tool pairing intact — no orphan tool message after compaction', () => {
      const history: AIMessage[] = [
        user('mulai riset'),
        asst('saya cek dulu'),
        {
          role: 'assistant',
          content: '',
          tool_calls: [{ id: 'c1', name: 'search', arguments: '{"query":"alpha"}' }]
        },
        { role: 'tool', tool_call_id: 'c1', content: 'hasil alpha' }
      ]
      for (let i = 0; i < 40; i++) {
        history.push(asst(`jawaban ${i} ` + 'z'.repeat(2000)))
        history.push(
          {
            role: 'assistant',
            content: '',
            tool_calls: [{ id: `c${i}`, name: 'read_note', arguments: '{"path":"a.md"}' }]
          },
          { role: 'tool', tool_call_id: `c${i}`, content: 'isi ' + 'q'.repeat(1500) }
        )
      }
      history.push(asst('ringkasan akhir'))

      const res = compactMessages(history, 32_000)

      // Every tool message must be preceded by its assistant tool_calls partner
      const validIds = new Set<string>()
      for (let i = 0; i < res.messages.length; i++) {
        const m = res.messages[i]
        if (m.role === 'assistant' && m.tool_calls?.length) {
          for (const tc of m.tool_calls) validIds.add(tc.id)
        }
        if (m.role === 'tool') {
          expect(validIds.has(m.tool_call_id || '')).toBe(true)
        }
      }
      expect(res.compactedCount).toBeGreaterThan(0)
    })

    it('terminates even when individual messages are enormous', () => {
      const history: AIMessage[] = [
        user('topik awal'),
        big('user', 60_000),
        asst('jawaban besar'),
        big('assistant', 60_000),
        user('pertanyaan terakhir')
      ]
      const res = compactMessages(history, 32_000)
      // Best effort: folded, kept ≥ 2 messages, never a hang
      expect(res.compactedCount).toBeGreaterThan(0)
      expect(res.messages.length).toBeGreaterThanOrEqual(2)
      expect(res.messages[0].content).toContain('[Compacted]')
    })

    it('honors the threshold constant (compact only past COMPACT_THRESHOLD)', () => {
      // Just under 80% of 32k: 20 × 1000-token messages = 20k
      const under = Array.from({ length: 20 }, () => big('user', 1000))
      expect(compactMessages(under, 32_000).compactedCount).toBe(0)
      // Just over: 30 × 1000-token = 30k > 25.6k
      const over = Array.from({ length: 30 }, () => big('user', 1000))
      expect(compactMessages(over, 32_000).compactedCount).toBeGreaterThan(0)
      // The compact threshold is genuinely 80% (not a laxer bound)
      expect(COMPACT_THRESHOLD).toBe(0.8)
      // RESERVED_OUTPUT_TOKENS is a positive headroom constant
      expect(RESERVED_OUTPUT_TOKENS).toBeGreaterThan(0)
    })
  })
})
