import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import { tmpdir } from 'os'
import { AIMiddleware, StreamEvent } from './AIMiddleware'
import {
  BaseProvider,
  AIRequest,
  AIResponse,
  AIStreamChunk,
  ModelInfo,
  ProviderCapabilities
} from './providers/BaseProvider'
import { workspaceEngine } from '../engine/WorkspaceEngine'

/**
 * Scripted fake provider: records every request it receives and replays a
 * per-call script of stream chunks — no network, deterministic tool loop.
 * A step may return a never-resolving promise to simulate a stalled stream
 * (exercises the middleware's watchdog).
 */
class ScriptedProvider extends BaseProvider {
  readonly id = 'fake'
  readonly name = 'Fake'
  readonly capabilities: ProviderCapabilities = {
    chat: true,
    streaming: true,
    vision: false,
    toolCalling: this.native,
    embeddings: false
  }

  calls: AIRequest[] = []
  script: ((req: AIRequest, onChunk: (c: AIStreamChunk) => void) => void | Promise<void>)[] = []

  constructor(private native = true) {
    super()
  }

  isConfigured(): boolean {
    return true
  }

  async healthCheck(): Promise<boolean> {
    return true
  }

  async listModels(): Promise<ModelInfo[]> {
    return []
  }

  async sendMessage(): Promise<AIResponse> {
    return { content: '', model: 'fake', provider: 'fake' }
  }

  async streamMessage(request: AIRequest, onChunk: (c: AIStreamChunk) => void): Promise<void> {
    this.calls.push(request)
    const step = this.script.shift()
    if (step) await step(request, onChunk)
    else onChunk({ content: '', done: true, model: 'fake' })
  }
}

describe('AIMiddleware.runStreamInner (P-B1)', () => {
  let vault: string

  beforeEach(() => {
    vault = fs.mkdtempSync(path.join(tmpdir(), 'wg-mid-'))
    workspaceEngine.openWorkspace(vault)
  })

  afterEach(() => {
    try {
      workspaceEngine.closeWorkspace()
      fs.rmSync(vault, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  })

  function writeVaultNote(rel: string, content: string): void {
    const abs = path.join(vault, rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, content)
  }

  function makeMid(provider: ScriptedProvider): AIMiddleware {
    const mid = new AIMiddleware({ providers: { fake: provider } })
    mid.setActiveProvider('fake')
    return mid
  }

  async function run(
    mid: AIMiddleware,
    requestId: string,
    opts: { enableTools?: boolean } = {}
  ): Promise<StreamEvent[]> {
    const chunks: StreamEvent[] = []
    await mid.streamMessage(
      { messages: [{ role: 'user', content: 'list the vault' }], model: 'fake' },
      (c) => chunks.push(c),
      undefined,
      false, // useContext off — keep the test off the context pipeline
      'general',
      opts.enableTools ?? true,
      requestId
    )
    return chunks
  }

  // ── Protocol selection (P-A1) ────────────────────────────────────────────

  it('native path: sends tools + tool_choice, executes, and loops with tool_calls messages', async () => {
    const provider = new ScriptedProvider(true)
    const mid = makeMid(provider)
    provider.script.push((_req, onChunk) => {
      onChunk({ content: 'Let me look.', done: false, model: 'fake' })
      onChunk({
        content: '',
        done: true,
        model: 'fake',
        toolCalls: [{ id: 'call_1', name: 'list_dir', arguments: '{}' }]
      })
    })
    provider.script.push((_req, onChunk) => {
      onChunk({ content: 'The root is empty.', done: false, model: 'fake' })
      onChunk({ content: '', done: true, model: 'fake' })
    })

    const chunks = await run(mid, 'req-native')

    // Round 1 request carries the native tool contract — and NO fence prompt
    expect(provider.calls).toHaveLength(2)
    const first = provider.calls[0]
    expect(first.tools).toHaveLength(8)
    expect(first.tools?.[0].function.name).toBe('search')
    expect(first.tool_choice).toBe('auto')
    expect(first.systemPrompt).not.toContain('wg-action')

    // Round 2 replays the tool_calls + tool result back to the model
    const second = provider.calls[1]
    const asst = second.messages.find((m) => m.role === 'assistant' && m.tool_calls?.length)
    expect(asst?.tool_calls?.[0]).toEqual({
      id: 'call_1',
      name: 'list_dir',
      arguments: '{}'
    })
    const toolMsg = second.messages.find((m) => m.role === 'tool')
    expect(toolMsg?.tool_call_id).toBe('call_1')
    expect(String(toolMsg?.content)).toContain('items')

    // UI saw the tool status and a final done chunk
    expect(chunks.some((c) => c.toolStatus?.includes('▸ list_dir'))).toBe(true)
    const done = chunks.filter((c) => c.done).pop()
    expect(done?.done).toBe(true)
    expect(chunks.some((c) => c.content.includes('The root is empty.'))).toBe(true)
  })

  it('native path: model that returns no tools finishes without looping', async () => {
    const provider = new ScriptedProvider(true)
    const mid = makeMid(provider)
    provider.script.push((_req, onChunk) => {
      onChunk({ content: 'No tools needed.', done: false, model: 'fake' })
      onChunk({ content: '', done: true, model: 'fake' })
    })

    const chunks = await run(mid, 'req-native-none')

    expect(provider.calls).toHaveLength(1)
    expect(provider.calls[0].tools).toHaveLength(8)
    const done = chunks.filter((c) => c.done).pop()
    expect(done?.done).toBe(true)
    expect(chunks.some((c) => c.content.includes('No tools needed.'))).toBe(true)
  })

  it('fence fallback: providers without native tools get the wg-action prompt and fence loop', async () => {
    const provider = new ScriptedProvider(false)
    const mid = makeMid(provider)
    const fence = 'I\'ll look.\n\n```wg-action\n{"tool":"list_dir","args":{}}\n```\n\nDone.'
    provider.script.push((_req, onChunk) => {
      onChunk({ content: fence, done: false, model: 'fake' })
      onChunk({ content: '', done: true, model: 'fake' })
    })
    provider.script.push((_req, onChunk) => {
      onChunk({ content: 'The root is empty.', done: false, model: 'fake' })
      onChunk({ content: '', done: true, model: 'fake' })
    })

    const chunks = await run(mid, 'req-fence')

    // No native tools array; the fence instructions ARE in the system prompt
    expect(provider.calls).toHaveLength(2)
    expect(provider.calls[0].tools).toBeUndefined()
    expect(provider.calls[0].systemPrompt).toContain('wg-action')

    // Tool results come back as a plain user message (fence protocol)
    const second = provider.calls[1]
    const last = second.messages[second.messages.length - 1]
    expect(last.role).toBe('user')
    expect(String(last.content)).toContain('### Tool results')
    const asst = second.messages.find((m) => m.role === 'assistant')
    expect(String(asst?.content)).not.toContain('wg-action')

    const done = chunks.filter((c) => c.done).pop()
    expect(done?.done).toBe(true)
    expect(chunks.some((c) => c.content.includes('The root is empty.'))).toBe(true)
  })

  it('tools disabled: no tools contract, single round, no fence prompt', async () => {
    const provider = new ScriptedProvider(true)
    const mid = makeMid(provider)
    provider.script.push((_req, onChunk) => {
      onChunk({ content: 'Plain answer.', done: false, model: 'fake' })
      onChunk({ content: '', done: true, model: 'fake' })
    })

    const chunks = await run(mid, 'req-notools', { enableTools: false })

    expect(provider.calls).toHaveLength(1)
    expect(provider.calls[0].tools).toBeUndefined()
    expect(provider.calls[0].systemPrompt).not.toContain('wg-action')
    const done = chunks.filter((c) => c.done).pop()
    expect(done?.done).toBe(true)
  })

  // ── Loop lifecycle ───────────────────────────────────────────────────────

  it('stops the tool loop at MAX_TOOL_ROUNDS (4) and reports max rounds', async () => {
    const provider = new ScriptedProvider(true)
    const mid = makeMid(provider)
    // Every round returns a read tool → the loop keeps continuing
    for (let i = 0; i < 6; i++) {
      provider.script.push((_req, onChunk) => {
        onChunk({ content: '', done: false, model: 'fake' })
        onChunk({
          content: '',
          done: true,
          model: 'fake',
          toolCalls: [{ id: `call_${i}`, name: 'list_dir', arguments: '{}' }]
        })
      })
    }

    const chunks = await run(mid, 'req-max')

    expect(provider.calls).toHaveLength(4)
    // Each of the 4 rounds executed its tool and signalled continuation
    expect(chunks.filter((c) => c.toolStatus?.includes('▸ list_dir'))).toHaveLength(4)
    expect(chunks.filter((c) => c.content.includes('continuing'))).toHaveLength(4)
    const done = chunks.filter((c) => c.done).pop()
    expect(done?.content).toContain('max tool rounds reached')
    expect(done?.done).toBe(true)
  })

  it('abort mid-stream: text before cancel is kept, chunks after are dropped, loop ends with cancelled', async () => {
    const provider = new ScriptedProvider(true)
    const mid = makeMid(provider)
    provider.script.push((_req, onChunk) => {
      onChunk({ content: 'partial answer', done: false, model: 'fake' })
      mid.cancelStream('req-abort')
      // Everything after the cancel must be swallowed by the middleware
      onChunk({ content: ' dropped text', done: false, model: 'fake' })
      onChunk({ content: '', done: true, model: 'fake' })
    })

    const chunks = await run(mid, 'req-abort')

    expect(chunks.some((c) => c.content.includes('partial answer'))).toBe(true)
    expect(chunks.some((c) => c.content.includes('dropped text'))).toBe(false)
    const done = chunks.filter((c) => c.done).pop()
    expect(done?.content).toContain('cancelled')
    expect(done?.done).toBe(true)
    // No second round is started after an abort
    expect(provider.calls).toHaveLength(1)
  })

  it('watchdog kills a stalled stream with a timeout chunk', async () => {
    // Fake Date too: the middleware's post-race check is `Date.now() - started
    // > TIMEOUT_MS`, which must see the clock advance alongside setTimeout.
    vi.useFakeTimers({
      toFake: [
        'setTimeout',
        'clearTimeout',
        'setInterval',
        'clearInterval',
        'setImmediate',
        'clearImmediate',
        'Date'
      ]
    })
    try {
      const provider = new ScriptedProvider(true)
      const mid = makeMid(provider)
      // Stream never resolves — the round watchdog must fire
      provider.script.push(() => new Promise<void>(() => {}))
      const chunks: StreamEvent[] = []
      const pending = mid.streamMessage(
        { messages: [{ role: 'user', content: 'stall' }], model: 'fake' },
        (c) => chunks.push(c),
        undefined,
        false,
        'general',
        true,
        'req-timeout'
      )
      // Flush the microtask queue so the watchdog timer is registered BEFORE
      // the clock advances (the middleware registers it after an await on
      // buildSystemPromptAsync). One flush drains the whole continuation;
      // two is belt-and-suspenders — if this ever hangs, advance was called
      // before registration and the 10s test timeout surfaces it.
      await Promise.resolve()
      await Promise.resolve()
      // TIMEOUT_MS = 180_000; +1ms so the post-race Date.now check triggers
      await vi.advanceTimersByTimeAsync(180_001)
      await pending

      // The watchdog chunk is the contract: a stalled stream is killed and the
      // caller sees the timeout. (A fake clock lands the middleware's
      // post-race `Date.now() - started > TIMEOUT_MS` check EXACTLY on the
      // boundary — 180000 > 180000 is false — so it may also emit one empty
      // done chunk; real time always exceeds the boundary. The meaningful
      // assertions are the timeout chunk + no second round.)
      const timeoutChunk = chunks.find((c) => c.error === 'Stream timed out')
      expect(timeoutChunk).toBeDefined()
      expect(timeoutChunk?.done).toBe(true)
      expect(timeoutChunk?.content).toContain('timeout — stream stalled')
      // The stalled round never re-enters the loop
      expect(provider.calls).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  }, 10_000)

  it('provider stream error surfaces as a done error chunk', async () => {
    const provider = new ScriptedProvider(true)
    const mid = makeMid(provider)
    provider.script.push((_req, onChunk) => {
      onChunk({ content: 'partial', done: false, model: 'fake' })
      onChunk({ content: '', done: true, model: 'fake', error: 'boom' })
    })

    const chunks = await run(mid, 'req-err')

    expect(chunks.some((c) => c.content.includes('partial'))).toBe(true)
    const done = chunks.filter((c) => c.done).pop()
    expect(done?.error).toBe('boom')
    expect(done?.content).toContain('**Error:**')
    expect(provider.calls).toHaveLength(1)
  })

  // ── Citations, proposals, dedup ──────────────────────────────────────────

  it('mixed round: read_note adds a citation, create_note adds a proposal, results zip to tool messages', async () => {
    writeVaultNote('Knowledge/Note.md', '# Note\n\nIsi catatan untuk dibaca.')
    const provider = new ScriptedProvider(true)
    const mid = makeMid(provider)
    provider.script.push((_req, onChunk) => {
      onChunk({ content: '', done: false, model: 'fake' })
      onChunk({
        content: '',
        done: true,
        model: 'fake',
        toolCalls: [
          { id: 'call_read', name: 'read_note', arguments: '{"path":"Knowledge/Note.md"}' },
          {
            id: 'call_write',
            name: 'create_note',
            arguments: '{"path":"Knowledge/New.md","content":"# New"}'
          }
        ]
      })
    })
    provider.script.push((_req, onChunk) => {
      onChunk({ content: 'Done.', done: false, model: 'fake' })
      onChunk({ content: '', done: true, model: 'fake' })
    })

    const chunks = await run(mid, 'req-mixed')

    expect(provider.calls).toHaveLength(2)
    const second = provider.calls[1]
    const toolMsgs = second.messages.filter((m) => m.role === 'tool')
    expect(toolMsgs).toHaveLength(2)
    // Zipped 1:1 with the emitted tool_calls order (read first, write second)
    expect(toolMsgs[0].tool_call_id).toBe('call_read')
    expect(String(toolMsgs[0].content)).toContain('Isi catatan')
    expect(toolMsgs[1].tool_call_id).toBe('call_write')
    expect(String(toolMsgs[1].content)).toContain('pending')

    // Final done chunk carries the citation + the proposal
    const done = chunks.filter((c) => c.done).pop()
    expect(done?.citations?.length).toBe(1)
    expect(done?.citations?.[0].path.replace(/\\/g, '/')).toContain('Knowledge/Note.md')
    expect(done?.proposals?.length).toBe(1)
    expect(done?.proposals?.[0].mode).toBe('create')
  })

  it('write-only round proposes then stops — no second round', async () => {
    const provider = new ScriptedProvider(true)
    const mid = makeMid(provider)
    provider.script.push((_req, onChunk) => {
      onChunk({ content: '', done: false, model: 'fake' })
      onChunk({
        content: '',
        done: true,
        model: 'fake',
        toolCalls: [
          {
            id: 'w1',
            name: 'create_note',
            arguments: '{"path":"Knowledge/Only.md","content":"# Only"}'
          }
        ]
      })
    })

    const chunks = await run(mid, 'req-writeonly')

    expect(provider.calls).toHaveLength(1)
    const done = chunks.filter((c) => c.done).pop()
    expect(done?.proposals?.length).toBe(1)
    expect(done?.proposals?.[0].relativePath).toContain('Only.md')
    // Proposals are surfaced while the round runs
    expect(chunks.some((c) => c.content.includes('Write proposal'))).toBe(true)
  })

  it('fence path: duplicate identical actions → one proposal; repeated reads → one citation', async () => {
    writeVaultNote('Knowledge/Note.md', '# Note\n\nIsi.')
    const provider = new ScriptedProvider(false)
    const mid = makeMid(provider)
    const round1 = [
      '```wg-action',
      '{"tool":"read_note","args":{"path":"Knowledge/Note.md"}}',
      '```',
      '```wg-action',
      '{"tool":"create_note","args":{"path":"Knowledge/Dup.md","content":"# Dup"}}',
      '```',
      // Duplicate of the previous create_note — parseToolActions dedupes it
      '```wg-action',
      '{"tool":"create_note","args":{"path":"Knowledge/Dup.md","content":"# Dup"}}',
      '```'
    ].join('\n')
    const round2 = [
      '```wg-action',
      '{"tool":"read_note","args":{"path":"Knowledge/Note.md"}}',
      '```'
    ].join('\n')
    provider.script.push((_req, onChunk) => {
      onChunk({ content: round1, done: false, model: 'fake' })
      onChunk({ content: '', done: true, model: 'fake' })
    })
    provider.script.push((_req, onChunk) => {
      onChunk({ content: round2, done: false, model: 'fake' })
      onChunk({ content: '', done: true, model: 'fake' })
    })
    provider.script.push((_req, onChunk) => {
      onChunk({ content: 'Done.', done: false, model: 'fake' })
      onChunk({ content: '', done: true, model: 'fake' })
    })

    const chunks = await run(mid, 'req-dedup')

    // Same note read in round 1 and round 2 → citation list stays at 1
    // Duplicate create_note fences → a single proposal
    const done = chunks.filter((c) => c.done).pop()
    expect(done?.citations?.length).toBe(1)
    expect(done?.proposals?.length).toBe(1)
    expect(provider.calls).toHaveLength(3)
  })

  // ── Vision (P-A2) ───────────────────────────────────────────────────────

  it('vision: request images attach to the last user message for vision providers', async () => {
    const provider = new ScriptedProvider(false)
    // Flip the capability to vision (the fake's default is false)
    ;(provider.capabilities as ProviderCapabilities).vision = true
    const mid = makeMid(provider)
    provider.script.push((_req, onChunk) => {
      onChunk({ content: 'Saya melihat gambar.', done: false, model: 'fake' })
      onChunk({ content: '', done: true, model: 'fake' })
    })

    const chunks: StreamEvent[] = []
    await mid.streamMessage(
      {
        messages: [{ role: 'user', content: 'Apa isi gambar ini?' }],
        model: 'fake',
        images: [{ mimeType: 'image/png', dataBase64: 'aGVsbG8=', name: 'x.png' }]
      },
      (c) => chunks.push(c),
      undefined,
      false, // useContext off
      'general',
      false, // tools off — vision test stays off the tool loop
      'req-vision'
    )

    // The provider received the images riding on the (only) user message
    expect(provider.calls).toHaveLength(1)
    const sent = provider.calls[0]
    expect(sent.messages[0].role).toBe('user')
    expect(sent.messages[0].images).toEqual([
      { mimeType: 'image/png', dataBase64: 'aGVsbG8=', name: 'x.png' }
    ])
    // And the stream completed normally
    const done = chunks.filter((c) => c.done).pop()
    expect(done?.done).toBe(true)
    expect(done?.error).toBeUndefined()
  })

  it('vision gate: non-vision provider rejects the request before any API call', async () => {
    const provider = new ScriptedProvider(false) // vision: false
    const mid = makeMid(provider)

    const chunks: StreamEvent[] = []
    await mid.streamMessage(
      {
        messages: [{ role: 'user', content: 'Apa isi gambar ini?' }],
        model: 'fake',
        images: [{ mimeType: 'image/png', dataBase64: 'aGVsbG8=' }]
      },
      (c) => chunks.push(c),
      undefined,
      false,
      'general',
      false,
      'req-vision-gate'
    )

    // Hard error chunk, zero provider calls (gate runs before any network)
    const done = chunks.filter((c) => c.done).pop()
    expect(done?.error).toContain('tidak mendukung vision')
    expect(provider.calls).toHaveLength(0)
  })
})
