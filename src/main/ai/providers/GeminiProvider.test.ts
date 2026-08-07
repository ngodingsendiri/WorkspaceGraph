import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { AIStreamChunk } from './BaseProvider'

/** Mock @google/genai — only the models.generateContentStream surface is used. */
const mocks = vi.hoisted(() => ({
  generateContentStream: vi.fn()
}))

vi.mock('@google/genai', () => ({
  GoogleGenAI: class {
    models = {
      generateContentStream: mocks.generateContentStream
    }
  }
}))

import { GeminiProvider } from './GeminiProvider'

describe('GeminiProvider abort signal (P1-runtime)', () => {
  beforeEach(() => {
    mocks.generateContentStream.mockReset()
  })

  function makeProvider(): GeminiProvider {
    const p = new GeminiProvider()
    p.configure({ apiKey: 'test-key' })
    return p
  }

  /** Replay a fixed chunk list through an async-iterable stream. */
  function fakeStream(chunks: { text?: string }[]): void {
    mocks.generateContentStream.mockResolvedValue({
      [Symbol.asyncIterator]: async function* () {
        for (const c of chunks) yield c
      }
    })
  }

  it('forwards the AbortSignal into generateContentStream config', async () => {
    const p = makeProvider()
    fakeStream([{ text: 'Halo' }, { text: ' dunia' }])
    const controller = new AbortController()
    const got: string[] = []
    await p.streamMessage(
      { messages: [{ role: 'user', content: 'hai' }], model: 'gemini-2.0-flash' },
      (c: AIStreamChunk) => {
        if (c.content) got.push(c.content)
      },
      controller.signal
    )

    // Cancel/watchdog can now kill the HTTP request mid-flight
    const params = mocks.generateContentStream.mock.calls[0][0] as {
      config?: { abortSignal?: AbortSignal }
    }
    expect(params.config?.abortSignal).toBe(controller.signal)
    expect(got.join('')).toBe('Halo dunia')
    expect(mocks.generateContentStream).toHaveBeenCalledTimes(1)
  })

  it('leaves abortSignal undefined when no signal is passed', async () => {
    const p = makeProvider()
    fakeStream([{ text: 'ok' }])
    await p.streamMessage(
      { messages: [{ role: 'user', content: 'hai' }], model: 'gemini-2.0-flash' },
      () => {}
    )

    const params = mocks.generateContentStream.mock.calls[0][0] as {
      config?: { abortSignal?: AbortSignal }
    }
    expect(params.config?.abortSignal).toBeUndefined()
  })

  it('stops text emission on an already-aborted signal', async () => {
    const p = makeProvider()
    fakeStream([{ text: 'Halo' }, { text: ' dunia' }])
    const controller = new AbortController()
    controller.abort()
    const got: string[] = []
    await p.streamMessage(
      { messages: [{ role: 'user', content: 'hai' }], model: 'gemini-2.0-flash' },
      (c: AIStreamChunk) => {
        if (c.content) got.push(c.content)
      },
      controller.signal
    )

    // The chunk loop breaks on the first pull — nothing reaches the UI
    expect(got).toHaveLength(0)
  })
})
