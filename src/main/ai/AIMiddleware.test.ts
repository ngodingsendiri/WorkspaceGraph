import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import { tmpdir } from 'os'
import {
  AIMiddleware,
  StreamEvent,
  executeToolWithTimeout,
  EXECUTE_TOOL_TIMEOUT_MS,
  RESEARCH_TO_WRITER_STAGES
} from './AIMiddleware'
import * as AgentTools from './AgentTools'
import type { ToolResult } from './AgentTools'
import {
  BaseProvider,
  AIRequest,
  AIResponse,
  AIStreamChunk,
  AIMessage,
  ModelInfo,
  ProviderCapabilities
} from './providers/BaseProvider'
import { workspaceEngine } from '../engine/WorkspaceEngine'
import { mcpManager } from '../mcp/McpClientManager'
import type { AgentRole } from './ContextEngine'

/** R0-1: compact real MCP server (stdio) for the middleware integration test. */
const MCP_SERVER_SRC = `
const { Server } = require('@modelcontextprotocol/sdk/server/index.js')
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js')
const { CallToolRequestSchema, ListToolsRequestSchema } = require('@modelcontextprotocol/sdk/types.js')
const server = new Server({ name: 'wg-mid-mcp', version: '1.0.0' }, { capabilities: { tools: {} } })
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [
  { name: 'count_words', description: 'Count words', annotations: { readOnlyHint: true }, inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
  { name: 'write_file', description: 'Write file', annotations: { destructiveHint: true }, inputSchema: { type: 'object', properties: { path: { type: 'string' } } } }
] }))
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params
  if (name === 'count_words') return { content: [{ type: 'text', text: String(String(args.text || '').trim().split(/\\s+/).filter(Boolean).length) }] }
  if (name === 'write_file') return { content: [{ type: 'text', text: 'wrote ' + String(args.path || '') }] }
  return { content: [{ type: 'text', text: 'unknown' }], isError: true }
})
server.connect(new StdioServerTransport())
`

/**
 * Scripted fake provider: records every request it receives and replays a
 * per-call script of stream chunks — no network, deterministic tool loop.
 * A step may return a never-resolving promise to simulate a stalled stream
 * (exercises the middleware's watchdog).
 */
class ScriptedProvider extends BaseProvider {
  readonly id: string
  readonly name: string
  readonly capabilities: ProviderCapabilities = {
    chat: true,
    streaming: true,
    vision: false,
    toolCalling: this.native,
    embeddings: false
  }

  calls: AIRequest[] = []
  script: ((req: AIRequest, onChunk: (c: AIStreamChunk) => void) => void | Promise<void>)[] = []

  constructor(
    private native = true,
    id = 'fake',
    name = 'Fake'
  ) {
    super()
    this.id = id
    this.name = name
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
    opts: { enableTools?: boolean; planMode?: boolean; role?: AgentRole } = {}
  ): Promise<StreamEvent[]> {
    const chunks: StreamEvent[] = []
    await mid.streamMessage(
      { messages: [{ role: 'user', content: 'list the vault' }], model: 'fake' },
      (c) => chunks.push(c),
      undefined,
      false, // useContext off — keep the test off the context pipeline
      opts.role ?? 'general',
      opts.enableTools ?? true,
      requestId,
      opts.planMode ?? false
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
    expect(first.tools).toHaveLength(9)
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
    expect(provider.calls[0].tools).toHaveLength(9)
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
    // P3: the audit trail records the abort as status 'cancelled'
    const logFile = path.join(vault, '.workspacegraph', 'logs', 'ai-events.jsonl')
    const endEvent = fs
      .readFileSync(logFile, 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { kind: string; status?: string })
      .find((e) => e.kind === 'stream_end')
    expect(endEvent?.status).toBe('cancelled')
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

  it('R0-2: read tools run in PARALLEL (both start before either resolves)', async () => {
    const provider = new ScriptedProvider(false)
    const mid = makeMid(provider)
    const fence = [
      '```wg-action',
      '{"tool":"search","args":{"query":"alpha"}}',
      '```',
      '```wg-action',
      '{"tool":"search","args":{"query":"beta"}}',
      '```'
    ].join('\n')
    provider.script.push((_req, onChunk) => {
      onChunk({ content: fence, done: false, model: 'fake' })
      onChunk({ content: '', done: true, model: 'fake' })
    })
    provider.script.push((_req, onChunk) => {
      onChunk({ content: 'Found.', done: false, model: 'fake' })
      onChunk({ content: '', done: true, model: 'fake' })
    })

    const started: string[] = []
    const resolvers: ((r: ToolResult) => void)[] = []
    const execSpy = vi.spyOn(AgentTools, 'executeTool').mockImplementation((action) => {
      started.push(action.tool)
      return new Promise<ToolResult>((resolve) => resolvers.push(resolve))
    })

    const runPromise = run(mid, 'req-par')
    try {
      // Let the loop dispatch the batch — both deferred reads must be in flight
      await new Promise((r) => setTimeout(r, 50))
      // Sequential execution would have started only the FIRST search until the
      // first resolved; parallelism starts both while neither has resolved
      expect(started).toEqual(['search', 'search'])
      expect(resolvers).toHaveLength(2)
      for (const resolve of resolvers) resolve({ ok: true, tool: 'search', result: [] })
      await runPromise
      expect(execSpy).toHaveBeenCalledTimes(2)
    } finally {
      // The file's afterEach does NOT restore mocks — a leaked deferred spy
      // would hang every later tool-loop test in this file
      execSpy.mockRestore()
    }
  })

  // ── Per-tool streaming events (P1-1) ────────────────────────────────────

  it('toolRun: read emits running → ok with the same runId + result preview', async () => {
    writeVaultNote('Knowledge/Note.md', '# Note\n\nIsi catatan untuk dibaca.')
    const provider = new ScriptedProvider(true)
    const mid = makeMid(provider)
    provider.script.push((_req, onChunk) => {
      onChunk({ content: '', done: false, model: 'fake' })
      onChunk({
        content: '',
        done: true,
        model: 'fake',
        toolCalls: [{ id: 'c1', name: 'read_note', arguments: '{"path":"Knowledge/Note.md"}' }]
      })
    })
    provider.script.push((_req, onChunk) => {
      onChunk({ content: 'Done.', done: false, model: 'fake' })
      onChunk({ content: '', done: true, model: 'fake' })
    })

    const chunks = await run(mid, 'req-run-ok')

    const running = chunks.find((c) => c.toolRun?.status === 'running')
    const ok = chunks.find((c) => c.toolRun?.status === 'ok')
    expect(running?.toolRun?.tool).toBe('read_note')
    expect(ok?.toolRun?.tool).toBe('read_note')
    // The completion event reuses the opening runId — the renderer updates in place
    expect(ok?.toolRun?.runId).toBe(running?.toolRun?.runId)
    // Detail previews the tool result (note content), truncated to one line
    expect(ok?.toolRun?.detail).toContain('Isi catatan')
  })

  it('toolRun: failed read emits running → error with the failure reason', async () => {
    const provider = new ScriptedProvider(true)
    const mid = makeMid(provider)
    provider.script.push((_req, onChunk) => {
      onChunk({ content: '', done: false, model: 'fake' })
      onChunk({
        content: '',
        done: true,
        model: 'fake',
        toolCalls: [{ id: 'c1', name: 'read_note', arguments: '{"path":"Missing.md"}' }]
      })
    })
    provider.script.push((_req, onChunk) => {
      onChunk({ content: 'Done.', done: false, model: 'fake' })
      onChunk({ content: '', done: true, model: 'fake' })
    })

    const chunks = await run(mid, 'req-run-err')

    const err = chunks.find((c) => c.toolRun?.status === 'error')
    expect(err?.toolRun?.tool).toBe('read_note')
    expect(err?.toolRun?.detail).toBeTruthy()
    expect(chunks.some((c) => c.toolStatus?.includes('✗ read_note'))).toBe(true)
  })

  it('toolRun: write proposal emits running → ok with proposal path detail', async () => {
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
            arguments: '{"path":"Knowledge/Run.md","content":"# Run"}'
          }
        ]
      })
    })

    const chunks = await run(mid, 'req-run-write')

    const running = chunks.find((c) => c.toolRun?.status === 'running')
    const ok = chunks.find((c) => c.toolRun?.status === 'ok')
    expect(running?.toolRun?.tool).toBe('create_note')
    expect(ok?.toolRun?.runId).toBe(running?.toolRun?.runId)
    expect(ok?.toolRun?.detail).toContain('Knowledge/Run.md')
  })

  it('toolRun: unknown fence tools emit an error run so the skip is visible', async () => {
    const provider = new ScriptedProvider(false)
    const mid = makeMid(provider)
    const fence = [
      '```wg-action',
      '{"tool":"hack_db","args":{}}',
      '```',
      '```wg-action',
      '{"tool":"list_dir","args":{}}',
      '```'
    ].join('\n')
    provider.script.push((_req, onChunk) => {
      onChunk({ content: fence, done: false, model: 'fake' })
      onChunk({ content: '', done: true, model: 'fake' })
    })
    provider.script.push((_req, onChunk) => {
      onChunk({ content: 'Done.', done: false, model: 'fake' })
      onChunk({ content: '', done: true, model: 'fake' })
    })

    const chunks = await run(mid, 'req-run-unknown')

    const skip = chunks.find((c) => c.toolRun?.status === 'error')
    expect(skip?.toolRun?.tool).toContain('hack_db')
    expect(skip?.toolRun?.detail).toContain('tidak dikenal')
  })

  // ── Token accounting (P1-runtime) ───────────────────────────────────────

  it('tokensUsed: provider without usage reporting gets a char estimate on the terminal done chunk', async () => {
    const provider = new ScriptedProvider(false)
    const mid = makeMid(provider)
    const text = 'Ini jawaban yang cukup panjang untuk estimasi token.'
    provider.script.push((_req, onChunk) => {
      onChunk({ content: text, done: false, model: 'fake' })
      onChunk({ content: '', done: true, model: 'fake' })
    })

    const chunks = await run(mid, 'req-tokens-est', { enableTools: false })

    // The estimate (≈ chars/4) lands once on the terminal done chunk — the
    // UI budget bar shows a real number instead of staying at 0
    const done = chunks.filter((c) => c.done).pop()
    expect(done?.tokensUsed).toBe(Math.ceil(text.length / 4))
    // No per-chunk deltas — one clean total, no double counting
    expect(chunks.filter((c) => !c.done && c.tokensUsed !== undefined)).toHaveLength(0)
  })

  it('tokensUsed: provider-reported usage passes through and the terminal done chunk stays clean', async () => {
    const provider = new ScriptedProvider(false)
    const mid = makeMid(provider)
    provider.script.push((_req, onChunk) => {
      onChunk({ content: 'A.', done: false, model: 'fake' })
      onChunk({ content: '', done: true, model: 'fake', tokensUsed: 1234 })
    })

    const chunks = await run(mid, 'req-tokens-reported', { enableTools: false })

    // The real total flows through on the forwarded provider chunk
    const forwarded = chunks.find((c) => c.tokensUsed === 1234)
    expect(forwarded).toBeDefined()
    // The terminal done chunk does NOT overwrite it with an estimate
    const done = chunks.filter((c) => c.done).pop()
    expect(done?.tokensUsed).toBeUndefined()
  })

  it('tokensUsed: estimate accumulates across tool rounds (fence loop)', async () => {
    const provider = new ScriptedProvider(false)
    const mid = makeMid(provider)
    const round1 = '```wg-action\n{"tool":"list_dir","args":{}}\n```'
    provider.script.push((_req, onChunk) => {
      onChunk({ content: round1, done: false, model: 'fake' })
      onChunk({ content: '', done: true, model: 'fake' })
    })
    provider.script.push((_req, onChunk) => {
      onChunk({ content: 'Selesai.', done: false, model: 'fake' })
      onChunk({ content: '', done: true, model: 'fake' })
    })

    const chunks = await run(mid, 'req-tokens-loop')

    // Both rounds' provider content counted once each → the grand total lands
    // on the terminal done chunk (this is the path Claude/Gemini/Ollama use)
    const done = chunks.filter((c) => c.done).pop()
    expect(done?.tokensUsed).toBe(Math.ceil(round1.length / 4) + Math.ceil('Selesai.'.length / 4))
  })

  // ── Context optimization (P1-4) ─────────────────────────────────────────

  it('P1-4: workspace context goes only to round 0; later rounds get the lean prompt', async () => {
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

    const chunks: StreamEvent[] = []
    await mid.streamMessage(
      { messages: [{ role: 'user', content: 'list the vault' }], model: 'fake' },
      (c) => chunks.push(c),
      undefined,
      true, // useContext ON — exercises the real context build path
      'general',
      true,
      'req-ctx-opt'
    )

    expect(provider.calls).toHaveLength(2)
    const r0 = provider.calls[0]
    const r1 = provider.calls[1]
    // Round 0 carries the full workspace context block + kernel
    expect(r0.systemPrompt).toContain('=== END OF WORKSPACE CONTEXT ===')
    expect(r0.systemPrompt).toContain('WorkspaceGraph AI Kernel')
    // Round 1 is lean: the kernel stays, the (large) context block is gone
    expect(r1.systemPrompt).not.toContain('=== END OF WORKSPACE CONTEXT ===')
    expect(r1.systemPrompt).toContain('WorkspaceGraph AI Kernel')
    // The savings are measured and reported on the terminal done chunk
    const done = chunks.filter((c) => c.done).pop()
    expect(done?.contextSavedTokens).toBeGreaterThan(0)
  })

  it('P1-4: fence mode keeps the wg-action protocol in the lean prompt', async () => {
    const provider = new ScriptedProvider(false)
    const mid = makeMid(provider)
    provider.script.push((_req, onChunk) => {
      onChunk({
        content: '```wg-action\n{"tool":"list_dir","args":{}}\n```',
        done: false,
        model: 'fake'
      })
      onChunk({ content: '', done: true, model: 'fake' })
    })
    provider.script.push((_req, onChunk) => {
      onChunk({ content: 'Selesai.', done: false, model: 'fake' })
      onChunk({ content: '', done: true, model: 'fake' })
    })

    const chunks: StreamEvent[] = []
    await mid.streamMessage(
      { messages: [{ role: 'user', content: 'list' }], model: 'fake' },
      (c) => chunks.push(c),
      undefined,
      true,
      'general',
      true,
      'req-ctx-fence'
    )

    // Round 1 must STILL speak the fence protocol (tool results come back
    // through it) while dropping the workspace context
    const r1 = provider.calls[1]
    expect(r1.systemPrompt).toContain('wg-action')
    expect(r1.systemPrompt).not.toContain('=== END OF WORKSPACE CONTEXT ===')
    // Multi-round fence loop reports savings too
    const done = chunks.filter((c) => c.done).pop()
    expect(done?.contextSavedTokens).toBeGreaterThan(0)
  })

  it('P1-4: single-round replies report no savings', async () => {
    const provider = new ScriptedProvider(true)
    const mid = makeMid(provider)
    provider.script.push((_req, onChunk) => {
      onChunk({ content: 'No tools.', done: false, model: 'fake' })
      onChunk({ content: '', done: true, model: 'fake' })
    })

    const chunks: StreamEvent[] = []
    await mid.streamMessage(
      { messages: [{ role: 'user', content: 'halo' }], model: 'fake' },
      (c) => chunks.push(c),
      undefined,
      true,
      'general',
      true,
      'req-ctx-single'
    )

    // One provider call → nothing was saved by trimming later rounds
    const done = chunks.filter((c) => c.done).pop()
    expect(done?.contextSavedTokens).toBeUndefined()
  })

  it('P1-4: max-rounds stream reports the full accumulated savings', async () => {
    const provider = new ScriptedProvider(true)
    const mid = makeMid(provider)
    // Every round asks for a tool → the loop runs to MAX_TOOL_ROUNDS (4)
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

    const chunks: StreamEvent[] = []
    await mid.streamMessage(
      { messages: [{ role: 'user', content: 'work' }], model: 'fake' },
      (c) => chunks.push(c),
      undefined,
      true,
      'general',
      true,
      'req-ctx-max'
    )

    expect(provider.calls).toHaveLength(4)
    const done = chunks.filter((c) => c.done).pop()
    expect(done?.content).toContain('max tool rounds reached')
    // 3 lean rounds → savings accumulate across all of them
    expect(done?.contextSavedTokens).toBeGreaterThan(0)
    // Every round past 0 used the lean prompt (context block absent)
    for (const call of provider.calls.slice(1)) {
      expect(call.systemPrompt).not.toContain('=== END OF WORKSPACE CONTEXT ===')
    }
  })

  // ── P1 per-role capabilities + pipeline orchestration ───────────────────

  it('P1: researcher role gets only read-only tools advertised (native path)', async () => {
    const provider = new ScriptedProvider(true)
    const mid = makeMid(provider)
    provider.script.push((_req, onChunk) => {
      onChunk({ content: 'No tools needed.', done: false, model: 'fake' })
      onChunk({ content: '', done: true, model: 'fake' })
    })

    const chunks: StreamEvent[] = []
    await mid.streamMessage(
      { messages: [{ role: 'user', content: 'riset' }], model: 'fake' },
      (c) => chunks.push(c),
      undefined,
      false,
      'researcher',
      true,
      'req-p1-researcher'
    )

    const sent = provider.calls[0]
    expect(sent.tools?.map((t) => t.function.name)).toEqual([
      'search',
      'read_note',
      'list_dir',
      'list_templates',
      'delegate_subagent'
    ])
    // Fence prompt (if used) would also be role-filtered — no writes advertised
    expect(sent.systemPrompt).not.toContain('write_note — args')
    const done = chunks.filter((c) => c.done).pop()
    expect(done?.done).toBe(true)
  })

  it('P1 guard: researcher calling a write tool gets a denied toolRun error + no proposal', async () => {
    writeVaultNote('Knowledge/Note.md', '# Note\n\nIsi.')
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
            arguments: '{"path":"Knowledge/Denied.md","content":"# X"}'
          }
        ]
      })
    })

    const chunks: StreamEvent[] = []
    await mid.streamMessage(
      { messages: [{ role: 'user', content: 'buat catatan' }], model: 'fake' },
      (c) => chunks.push(c),
      undefined,
      false,
      'researcher',
      true,
      'req-p1-deny'
    )

    // The denied write surfaced as an error toolRun with the role in the detail
    const err = chunks.find((c) => c.toolRun?.status === 'error')
    expect(err?.toolRun?.tool).toBe('create_note')
    expect(err?.toolRun?.detail).toContain('tidak diizinkan')
    expect(err?.toolRun?.detail).toContain('researcher')
    // No proposal was created; the write-only round stops cleanly
    const done = chunks.filter((c) => c.done).pop()
    expect(done?.proposals?.length ?? 0).toBe(0)
    expect(fs.existsSync(path.join(vault, 'Knowledge', 'Denied.md'))).toBe(false)
  })

  it('P1 pipeline: Research → Writer runs both stages, hands the summary over, single done', async () => {
    writeVaultNote('Knowledge/Note.md', '# Note\n\nFakta penting tentang X.')
    const provider = new ScriptedProvider(true)
    const mid = makeMid(provider)

    // Stage 1 — researcher: read_note, then produce the research summary
    provider.script.push((_req, onChunk) => {
      onChunk({ content: '', done: false, model: 'fake' })
      onChunk({
        content: '',
        done: true,
        model: 'fake',
        toolCalls: [{ id: 'r1', name: 'read_note', arguments: '{"path":"Knowledge/Note.md"}' }]
      })
    })
    provider.script.push((_req, onChunk) => {
      onChunk({ content: 'RINGKASAN RISET: X adalah Y.', done: false, model: 'fake' })
      onChunk({ content: '', done: true, model: 'fake' })
    })
    // Stage 2 — writer: propose a durable note (write-only round stops the loop)
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
            arguments: '{"path":"Knowledge/Summary.md","content":"# X\\n\\nY"}'
          }
        ]
      })
    })

    const chunks: StreamEvent[] = []
    await mid.streamPipeline(
      { messages: [{ role: 'user', content: 'Riset X lalu tulis ringkasannya' }], model: 'fake' },
      RESEARCH_TO_WRITER_STAGES,
      (c) => chunks.push(c),
      undefined,
      false,
      'req-pipeline'
    )

    // 3 provider calls: researcher round 0 + 1, then writer's write-only round
    expect(provider.calls).toHaveLength(3)
    const research = provider.calls[0]
    const writing = provider.calls[2]
    // Stage system prompts + role-scoped tool advertisement
    expect(research.systemPrompt).toContain('Stage 1/2')
    expect(research.systemPrompt).toContain('RESEARCH')
    expect(research.tools?.map((t) => t.function.name)).toEqual([
      'search',
      'read_note',
      'list_dir',
      'list_templates',
      'delegate_subagent'
    ])
    expect(writing.systemPrompt).toContain('Stage 2/2')
    expect(writing.tools?.map((t) => t.function.name)).toHaveLength(9)
    // Stage 2's messages carry the stage-1 summary as handoff context
    const stage2Last = writing.messages[writing.messages.length - 1]
    expect(stage2Last.role).toBe('user')
    expect(String(stage2Last.content)).toContain('RINGKASAN RISET')
    expect(String(stage2Last.content)).toContain('Hasil Stage 1')

    // Only ONE terminal done chunk (intermediate stages are suppressed)
    const done = chunks.filter((c) => c.done)
    expect(done).toHaveLength(1)
    // Citations from stage 1 + proposals from stage 2 accumulate on the final done
    expect(done[0].citations?.length).toBe(1)
    expect(done[0].proposals?.length).toBe(1)
    expect(done[0].proposals?.[0].relativePath).toContain('Summary.md')
    // The stage boundary status is visible to the UI
    expect(chunks.some((c) => c.toolStatus?.includes('Stage 1/2 done'))).toBe(true)
  })

  it('P1 pipeline: abort during stage 1 stops the pipeline before stage 2', async () => {
    writeVaultNote('Knowledge/Note.md', '# Note\n\nFakta.')
    const provider = new ScriptedProvider(true)
    const mid = makeMid(provider)
    // Stage 1 round 0 cancels mid-stream (like the user hitting Cancel)
    provider.script.push((_req, onChunk) => {
      onChunk({ content: 'sebagian riset', done: false, model: 'fake' })
      mid.cancelStream('req-pipeline-abort')
      onChunk({ content: ' dibuang', done: false, model: 'fake' })
      onChunk({ content: '', done: true, model: 'fake' })
    })
    // Stage 2 must NEVER run
    provider.script.push((_req, onChunk) => {
      onChunk({ content: 'SEHARUSNYA TIDAK MUNCUL', done: false, model: 'fake' })
      onChunk({ content: '', done: true, model: 'fake' })
    })

    const chunks: StreamEvent[] = []
    await mid.streamPipeline(
      { messages: [{ role: 'user', content: 'riset' }], model: 'fake' },
      RESEARCH_TO_WRITER_STAGES,
      (c) => chunks.push(c),
      undefined,
      false,
      'req-pipeline-abort'
    )

    // Only stage 1's single round ran; stage 2 never dispatched
    expect(provider.calls).toHaveLength(1)
    // Text before cancel kept, dropped text swallowed, pipeline ends cancelled
    expect(chunks.some((c) => c.content.includes('sebagian riset'))).toBe(true)
    expect(chunks.some((c) => c.content.includes('dibuang'))).toBe(false)
    const done = chunks.filter((c) => c.done).pop()
    expect(done?.content).toContain('cancelled')
  })

  it('P1 guard: fence-path researcher write denial surfaces as an error run', async () => {
    const provider = new ScriptedProvider(false) // fence fallback
    const mid = makeMid(provider)
    const fence =
      'Saya coba tulis.\n\n```wg-action\n{"tool":"write_note","args":{"path":"Knowledge/F.md","content":"# X"}}\n```'
    provider.script.push((_req, onChunk) => {
      onChunk({ content: fence, done: false, model: 'fake' })
      onChunk({ content: '', done: true, model: 'fake' })
    })
    provider.script.push((_req, onChunk) => {
      onChunk({ content: 'Selesai.', done: false, model: 'fake' })
      onChunk({ content: '', done: true, model: 'fake' })
    })

    const chunks: StreamEvent[] = []
    await mid.streamMessage(
      { messages: [{ role: 'user', content: 'tulis' }], model: 'fake' },
      (c) => chunks.push(c),
      undefined,
      false,
      'researcher',
      true,
      'req-p1-fence-deny'
    )

    // Denied write emits an error toolRun; no proposal reaches the dock
    const err = chunks.find((c) => c.toolRun?.status === 'error')
    expect(err?.toolRun?.tool).toBe('write_note')
    expect(err?.toolRun?.detail).toContain('tidak diizinkan')
    expect(fs.existsSync(path.join(vault, 'Knowledge', 'F.md'))).toBe(false)
  })

  it('P1 pipeline: empty stages emit a terminal error chunk', async () => {
    const provider = new ScriptedProvider(true)
    const mid = makeMid(provider)
    const chunks: StreamEvent[] = []
    await mid.streamPipeline(
      { messages: [{ role: 'user', content: 'x' }], model: 'fake' },
      [],
      (c) => chunks.push(c),
      undefined,
      false,
      'req-pipeline-empty'
    )
    const done = chunks.filter((c) => c.done).pop()
    expect(done?.error).toContain('tidak ada stage')
    expect(provider.calls).toHaveLength(0)
  })

  // ── Reasoning streaming (P2-4) ──────────────────────────────────────────

  it('P2-4: provider reasoning deltas pass through to stream chunks untouched', async () => {
    const provider = new ScriptedProvider(true)
    const mid = makeMid(provider)
    provider.script.push((_req, onChunk) => {
      onChunk({ content: '', done: false, model: 'fake', reasoning: 'Analisis dulu… ' })
      onChunk({ content: '', done: false, model: 'fake', reasoning: 'lanjut berpikir' })
      onChunk({ content: 'Jawaban akhir.', done: false, model: 'fake' })
      onChunk({ content: '', done: true, model: 'fake' })
    })

    const chunks = await run(mid, 'req-reasoning')

    const reasoning = chunks.map((c) => c.reasoning || '').join('')
    expect(reasoning).toContain('Analisis dulu')
    expect(reasoning).toContain('lanjut berpikir')
    // Chain-of-thought never bleeds into the answer content (it is not output)
    expect(chunks.some((c) => c.content.includes('Analisis dulu'))).toBe(false)
    const done = chunks.filter((c) => c.done).pop()
    expect(done?.done).toBe(true)
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

  // ── R1-2 provider failover ──────────────────────────────────────────────

  it('R1-2: terminal 429 on the active provider fails over to the next configured provider', async () => {
    const provA = new ScriptedProvider(true, 'prov-a', 'Prov A')
    const provB = new ScriptedProvider(true, 'prov-b', 'Prov B')
    const mid = new AIMiddleware({ providers: { 'prov-a': provA, 'prov-b': provB } })
    mid.setActiveProvider('prov-a')

    // Provider A fails terminally (429 — its own retry budget is spent)
    provA.script.push((_req, onChunk) => {
      onChunk({ content: '', done: true, model: 'prov-a', error: 'Grok API error 429: rate limit' })
    })
    // Provider B answers normally
    provB.script.push((_req, onChunk) => {
      onChunk({ content: 'Jawaban dari B.', done: false, model: 'prov-b' })
      onChunk({ content: '', done: true, model: 'prov-b' })
    })

    const chunks: StreamEvent[] = []
    await mid.streamMessage(
      { messages: [{ role: 'user', content: 'halo' }], model: 'prov-a' },
      (c) => chunks.push(c),
      undefined,
      false,
      'general',
      false,
      'req-failover'
    )

    // Both providers were tried, in order
    expect(provA.calls).toHaveLength(1)
    expect(provB.calls).toHaveLength(1)
    // The user saw the failover note and B's answer, but NOT A's raw error
    expect(chunks.some((c) => c.content.includes('failover: prov-a'))).toBe(true)
    expect(chunks.some((c) => c.content.includes('Jawaban dari B.'))).toBe(true)
    expect(chunks.some((c) => c.error === 'Grok API error 429: rate limit')).toBe(false)
    // The stream ended OK (B succeeded)
    const done = chunks.filter((c) => c.done).pop()
    expect(done?.error).toBeUndefined()
    expect(done?.done).toBe(true)

    // AI event log: a failover event with from→target
    const logFile = path.join(vault, '.workspacegraph', 'logs', 'ai-events.jsonl')
    const events = fs
      .readFileSync(logFile, 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map(
        (l) =>
          JSON.parse(l) as { kind: string; provider?: string; target?: string; status?: string }
      )
    const failover = events.find((e) => e.kind === 'failover')
    expect(failover?.provider).toBe('prov-a')
    expect(failover?.target).toBe('prov-b')
    // stream_end records the provider that ACTUALLY served
    const end = events.find((e) => e.kind === 'stream_end')
    expect(end?.provider).toBe('prov-b')
    expect(end?.status).toBe('ok')
    // The user's selection is restored after the stream
    expect(mid.getActiveProvider().id).toBe('prov-a')
  })

  it("R1-2: provider B also failing surfaces B's error (exhausted — no infinite loop)", async () => {
    const provA = new ScriptedProvider(true, 'prov-a', 'Prov A')
    const provB = new ScriptedProvider(true, 'prov-b', 'Prov B')
    const mid = new AIMiddleware({ providers: { 'prov-a': provA, 'prov-b': provB } })
    mid.setActiveProvider('prov-a')

    provA.script.push((_req, onChunk) => {
      onChunk({ content: '', done: true, model: 'prov-a', error: '429 rate limit' })
    })
    provB.script.push((_req, onChunk) => {
      onChunk({ content: '', done: true, model: 'prov-b', error: '502 Bad Gateway' })
    })

    const chunks: StreamEvent[] = []
    await mid.streamMessage(
      { messages: [{ role: 'user', content: 'halo' }], model: 'prov-a' },
      (c) => chunks.push(c),
      undefined,
      false,
      'general',
      false,
      'req-failover-both'
    )

    expect(provA.calls).toHaveLength(1)
    expect(provB.calls).toHaveLength(1)
    // Failover note emitted once; the terminal error is B's (last attempt)
    expect(chunks.filter((c) => c.content.includes('failover: prov-a')).length).toBe(1)
    const done = chunks.filter((c) => c.done).pop()
    expect(done?.error).toBe('502 Bad Gateway')
  })

  it('R1-2: non-terminal error (400) does NOT fail over — surfaces directly', async () => {
    const provA = new ScriptedProvider(true, 'prov-a', 'Prov A')
    const provB = new ScriptedProvider(true, 'prov-b', 'Prov B')
    const mid = new AIMiddleware({ providers: { 'prov-a': provA, 'prov-b': provB } })
    mid.setActiveProvider('prov-a')

    provA.script.push((_req, onChunk) => {
      onChunk({
        content: '',
        done: true,
        model: 'prov-a',
        error: '400 Bad Request: model not found'
      })
    })

    const chunks: StreamEvent[] = []
    await mid.streamMessage(
      { messages: [{ role: 'user', content: 'halo' }], model: 'prov-a' },
      (c) => chunks.push(c),
      undefined,
      false,
      'general',
      false,
      'req-failover-400'
    )

    // B never ran — a 400 is the caller's bug, retrying elsewhere wastes a call
    expect(provA.calls).toHaveLength(1)
    expect(provB.calls).toHaveLength(0)
    const done = chunks.filter((c) => c.done).pop()
    expect(done?.error).toContain('400')
    expect(chunks.some((c) => c.content.includes('failover: prov-a'))).toBe(false)
  })

  it('R1-2: no configured fallback → single-provider behavior, no note', async () => {
    const provA = new ScriptedProvider(true, 'prov-a', 'Prov A')
    const mid = new AIMiddleware({ providers: { 'prov-a': provA } })
    mid.setActiveProvider('prov-a')
    provA.script.push((_req, onChunk) => {
      onChunk({ content: '', done: true, model: 'prov-a', error: '429 rate limit' })
    })

    const chunks: StreamEvent[] = []
    await mid.streamMessage(
      { messages: [{ role: 'user', content: 'halo' }], model: 'prov-a' },
      (c) => chunks.push(c),
      undefined,
      false,
      'general',
      false,
      'req-failover-solo'
    )

    expect(provA.calls).toHaveLength(1)
    const done = chunks.filter((c) => c.done).pop()
    expect(done?.error).toContain('429')
    expect(chunks.some((c) => c.content.includes('failover:'))).toBe(false)
  })

  it('R1-2: user cancel during the first attempt never triggers failover', async () => {
    const provA = new ScriptedProvider(true, 'prov-a', 'Prov A')
    const provB = new ScriptedProvider(true, 'prov-b', 'Prov B')
    const mid = new AIMiddleware({ providers: { 'prov-a': provA, 'prov-b': provB } })
    mid.setActiveProvider('prov-a')
    provA.script.push((_req, onChunk) => {
      onChunk({ content: 'sebagian', done: false, model: 'prov-a' })
      mid.cancelStream('req-failover-cancel')
      onChunk({ content: '', done: true, model: 'prov-a' })
    })

    const chunks: StreamEvent[] = []
    await mid.streamMessage(
      { messages: [{ role: 'user', content: 'halo' }], model: 'prov-a' },
      (c) => chunks.push(c),
      undefined,
      false,
      'general',
      false,
      'req-failover-cancel'
    )

    // B never ran — the stream ended cancelled, not failed-over
    expect(provA.calls).toHaveLength(1)
    expect(provB.calls).toHaveLength(0)
    const done = chunks.filter((c) => c.done).pop()
    expect(done?.content).toContain('cancelled')
  })

  // ── R1-3 plan mode + sub-agent delegation ──────────────────────────────

  it('R1-3 plan mode: reads + create_plan advertised, create_plan stages a Planning proposal, stream stops', async () => {
    const provider = new ScriptedProvider(true)
    const mid = makeMid(provider)
    provider.script.push((_req, onChunk) => {
      onChunk({ content: 'Analisis: perlu API baru.', done: false, model: 'fake' })
      onChunk({
        content: '',
        done: true,
        model: 'fake',
        toolCalls: [
          {
            id: 'p1',
            name: 'create_plan',
            arguments: JSON.stringify({
              title: 'Rombak API',
              goal: 'Auto-discovery model',
              steps: ['Baca provider', 'Tulis modul']
            })
          }
        ]
      })
    })

    const chunks = await run(mid, 'req-plan', { planMode: true })

    // The native tools advertise reads + create_plan — never write_note / delegate
    const sent = provider.calls[0]
    expect(sent.tools?.map((t) => t.function.name)).toEqual([
      'search',
      'read_note',
      'list_dir',
      'list_templates',
      'create_plan'
    ])
    // The plan-mode behavioral contract rides the system prompt
    expect(sent.systemPrompt).toContain('PLAN MODE')
    // The proposal lands in the dock; the write-only round stops the stream
    const done = chunks.filter((c) => c.done).pop()
    expect(done?.proposals?.length).toBe(1)
    expect(done?.proposals?.[0].relativePath).toContain('Planning/Rombak API.md')
    expect(provider.calls).toHaveLength(1)
    expect(chunks.some((c) => c.content.includes('Analisis'))).toBe(true)
  })

  it('R1-3 plan mode: a fence write_note attempt is denied with a plan-mode error', async () => {
    const provider = new ScriptedProvider(false)
    const mid = makeMid(provider)
    const fence =
      '```wg-action\n{"tool":"write_note","args":{"path":"Knowledge/X.md","content":"# X"}}\n```'
    provider.script.push((_req, onChunk) => {
      onChunk({ content: fence, done: false, model: 'fake' })
      onChunk({ content: '', done: true, model: 'fake' })
    })

    const chunks = await run(mid, 'req-plan-deny', { planMode: true })

    const err = chunks.find((c) => c.toolRun?.status === 'error')
    expect(err?.toolRun?.tool).toBe('write_note')
    expect(err?.toolRun?.detail).toContain('plan mode')
    expect(fs.existsSync(path.join(vault, 'Knowledge', 'X.md'))).toBe(false)
  })

  it('R1-3 delegate: sub-agent runs a nested stream with its role, output feeds the parent', async () => {
    writeVaultNote('Knowledge/Note.md', '# Note\n\nFakta penting X.')
    const provider = new ScriptedProvider(true)
    const mid = makeMid(provider)
    // Parent round 0: delegate a researcher sub-task
    provider.script.push((_req, onChunk) => {
      onChunk({ content: 'Saya delegasikan riset.', done: false, model: 'fake' })
      onChunk({
        content: '',
        done: true,
        model: 'fake',
        toolCalls: [
          {
            id: 'd1',
            name: 'delegate_subagent',
            arguments: JSON.stringify({
              role: 'researcher',
              task: 'Baca Knowledge/Note.md lalu ringkas'
            })
          }
        ]
      })
    })
    // Nested sub-agent (researcher role): reads the note
    provider.script.push((_req, onChunk) => {
      onChunk({ content: '', done: false, model: 'fake' })
      onChunk({
        content: '',
        done: true,
        model: 'fake',
        toolCalls: [{ id: 'r1', name: 'read_note', arguments: '{"path":"Knowledge/Note.md"}' }]
      })
    })
    // Sub-agent round 1: answers with its result
    provider.script.push((_req, onChunk) => {
      onChunk({ content: 'SUBAGENT: X adalah Y.', done: false, model: 'fake' })
      onChunk({ content: '', done: true, model: 'fake' })
    })
    // Parent round 1: synthesizes using the delegate result
    provider.script.push((_req, onChunk) => {
      onChunk({ content: 'KESIMPULAN dari sub-agent: X adalah Y.', done: false, model: 'fake' })
      onChunk({ content: '', done: true, model: 'fake' })
    })

    const chunks = await run(mid, 'req-delegate')

    // 4 provider calls: parent r0, sub-agent r0+r1, parent r1
    expect(provider.calls).toHaveLength(4)
    // The sub-agent ran with the researcher role + NO delegate tool (no recursion)
    const sub = provider.calls[1]
    expect(sub.systemPrompt).toContain('Sub-agent')
    expect(sub.systemPrompt).toContain('researcher')
    expect(sub.tools?.map((t) => t.function.name)).toEqual([
      'search',
      'read_note',
      'list_dir',
      'list_templates'
    ])
    // The delegate result (sub-agent output) came back to the parent as a tool msg
    const parentRound2 = provider.calls[3]
    const toolMsg = parentRound2.messages.find((m) => m.role === 'tool')
    expect(String(toolMsg?.content)).toContain('SUBAGENT: X adalah Y')
    // The final answer includes the sub-agent's output
    expect(chunks.some((c) => c.content.includes('KESIMPULAN dari sub-agent: X adalah Y'))).toBe(
      true
    )
    // The tool-run trail shows the delegate as a visible ok run
    expect(
      chunks.some((c) => c.toolRun?.tool === 'delegate_subagent' && c.toolRun.status === 'ok')
    ).toBe(true)
  })

  it('R1-3 delegate: bad role or empty task fails the tool without a nested stream', async () => {
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
            id: 'd1',
            name: 'delegate_subagent',
            arguments: JSON.stringify({ role: 'mage', task: 'x' })
          }
        ]
      })
    })
    provider.script.push((_req, onChunk) => {
      onChunk({ content: 'Selesai.', done: false, model: 'fake' })
      onChunk({ content: '', done: true, model: 'fake' })
    })

    const chunks = await run(mid, 'req-delegate-bad')

    const err = chunks.find((c) => c.toolRun?.status === 'error')
    expect(err?.toolRun?.tool).toBe('delegate_subagent')
    expect(err?.toolRun?.detail).toContain('role tidak dikenal')
    // Only the parent's two rounds ran — no nested stream for a bad role
    expect(provider.calls).toHaveLength(2)
  })

  it("R1-3 delegate: a writer sub-agent's proposal bubbles to the parent dock", async () => {
    const provider = new ScriptedProvider(true)
    const mid = makeMid(provider)
    // Parent round 0: delegate the writing to a writer child
    provider.script.push((_req, onChunk) => {
      onChunk({ content: '', done: false, model: 'fake' })
      onChunk({
        content: '',
        done: true,
        model: 'fake',
        toolCalls: [
          {
            id: 'd1',
            name: 'delegate_subagent',
            arguments: JSON.stringify({
              role: 'writer',
              task: 'Buat catatan ringkasan di Knowledge/'
            })
          }
        ]
      })
    })
    // Sub-agent (writer): create_note → write-only round stops the sub stream
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
            arguments: '{"path":"Knowledge/Sub.md","content":"# Sub"}'
          }
        ]
      })
    })
    // Parent round 1: synthesizes
    provider.script.push((_req, onChunk) => {
      onChunk({ content: 'SELESAI.', done: false, model: 'fake' })
      onChunk({ content: '', done: true, model: 'fake' })
    })

    const chunks = await run(mid, 'req-delegate-prop')

    // The proposal created INSIDE the sub-agent reached the parent dock
    const done = chunks.filter((c) => c.done).pop()
    expect(done?.proposals?.length).toBe(1)
    expect(done?.proposals?.[0].relativePath).toContain('Knowledge/Sub.md')
    // The sub proposal was also surfaced live as a chunk during the round
    expect(chunks.some((c) => (c.proposals?.length ?? 0) > 0 && !c.done)).toBe(true)
    expect(provider.calls).toHaveLength(3)
  })

  it('R1-3 plan mode: a delegate attempt is denied without spawning a sub-agent', async () => {
    const provider = new ScriptedProvider(false)
    const mid = makeMid(provider)
    const fence =
      '```wg-action\n{"tool":"delegate_subagent","args":{"role":"writer","task":"x"}}\n```'
    provider.script.push((_req, onChunk) => {
      onChunk({ content: fence, done: false, model: 'fake' })
      onChunk({ content: '', done: true, model: 'fake' })
    })
    provider.script.push((_req, onChunk) => {
      onChunk({ content: 'Selesai.', done: false, model: 'fake' })
      onChunk({ content: '', done: true, model: 'fake' })
    })

    const chunks = await run(mid, 'req-plan-delegate', { planMode: true })

    // The delegate was blocked at the gate — no nested stream ran
    const err = chunks.find((c) => c.toolRun?.status === 'error')
    expect(err?.toolRun?.tool).toBe('delegate_subagent')
    expect(err?.toolRun?.detail).toContain('plan mode')
    expect(provider.calls).toHaveLength(2)
  })

  // ── R0-1 MCP integration ────────────────────────────────────────────────

  it('R0-1: MCP tools run through the loop (read parallel + write direct), schemas advertised, results zipped', async () => {
    const serverFile = path.join(vault, 'mcp-server.cjs')
    fs.writeFileSync(serverFile, MCP_SERVER_SRC, 'utf-8')
    await mcpManager.saveServers(
      [
        {
          id: 'test',
          name: 'Test',
          transport: 'stdio',
          command: process.execPath,
          args: [serverFile],
          env: { NODE_PATH: path.resolve(__dirname, '../../..', 'node_modules') },
          enabled: true,
          allowWriteTools: true
        }
      ],
      vault
    )
    try {
      await mcpManager.ensureConnected(['test'])

      const provider = new ScriptedProvider(true)
      const mid = makeMid(provider)
      // Round 1: one read MCP tool + one write MCP tool
      provider.script.push((_req, onChunk) => {
        onChunk({ content: '', done: false, model: 'fake' })
        onChunk({
          content: '',
          done: true,
          model: 'fake',
          toolCalls: [
            {
              id: 'mc1',
              name: 'mcp__test__count_words',
              arguments: '{"text":"a b c"}'
            },
            { id: 'mc2', name: 'mcp__test__write_file', arguments: '{"path":"x"}' }
          ]
        })
      })
      provider.script.push((_req, onChunk) => {
        onChunk({ content: 'Selesai.', done: false, model: 'fake' })
        onChunk({ content: '', done: true, model: 'fake' })
      })

      const chunks = await run(mid, 'req-mcp')

      // MCP schemas ride the native tools array for a write-capable role
      expect(provider.calls).toHaveLength(2)
      const r0 = provider.calls[0]
      expect(r0.tools?.some((t) => t.function.name === 'mcp__test__count_words')).toBe(true)
      expect(r0.tools?.some((t) => t.function.name === 'mcp__test__write_file')).toBe(true)

      // Both results zip back 1:1 with the call ids
      const second = provider.calls[1]
      const toolMsgs = second.messages.filter((m) => m.role === 'tool')
      expect(toolMsgs).toHaveLength(2)
      expect(toolMsgs[0].tool_call_id).toBe('mc1')
      expect(String(toolMsgs[0].content)).toContain('3')
      expect(toolMsgs[1].tool_call_id).toBe('mc2')
      expect(String(toolMsgs[1].content)).toContain('wrote x')

      // Tool-run trail: read completed in its batch, write got its own ok run
      const readRun = chunks.find(
        (c) => c.toolRun?.tool === 'mcp__test__count_words' && c.toolRun.status === 'ok'
      )
      expect(readRun?.toolRun?.detail).toContain('3')
      expect(
        chunks.some((c) => c.toolRun?.tool === 'mcp__test__write_file' && c.toolRun.status === 'ok')
      ).toBe(true)
      const done = chunks.filter((c) => c.done).pop()
      expect(done?.done).toBe(true)
    } finally {
      await mcpManager.disconnectAll()
    }
  }, 30000)

  // ── R1-1 auto context compaction ────────────────────────────────────────

  it('R1-1: a long history is compacted into a [Compacted] block before the provider call', async () => {
    const provider = new ScriptedProvider(true)
    const mid = makeMid(provider)
    provider.script.push((_req, onChunk) => {
      onChunk({ content: 'Jawaban setelah kompaksi.', done: false, model: 'fake' })
      onChunk({ content: '', done: true, model: 'fake' })
    })

    const chunks: StreamEvent[] = []
    const messages: AIMessage[] = [{ role: 'user', content: 'Topik awal riset' }]
    for (let i = 0; i < 60; i++) {
      messages.push({ role: 'assistant', content: `jawaban ${i} ` + 'y'.repeat(1200) })
      messages.push({ role: 'user', content: `pertanyaan ${i} ` + 'y'.repeat(1200) })
    }
    await mid.streamMessage(
      { messages, model: 'fake' },
      (c) => chunks.push(c),
      undefined,
      false,
      'general',
      false,
      'req-compact'
    )

    // The provider received the folded history (block first, recent tail intact)
    const sent = provider.calls[0]
    expect(String(sent.messages[0].content)).toContain('[Compacted]')
    expect(String(sent.messages[0].content)).toContain('Topik awal riset')
    expect(sent.messages.length).toBeLessThan(messages.length)
    // The recent tail (last 8) survived byte-for-byte
    expect(sent.messages.slice(-8)).toEqual(messages.slice(-8))
    // The UI saw the compaction note + toolStatus
    expect(chunks.some((c) => c.content.includes('context di-compact'))).toBe(true)
    expect(chunks.some((c) => c.toolStatus?.includes('Context compacted'))).toBe(true)
  })

  it('R1-1: the provider-reported ModelInfo.contextWindow drives the budget (small window → compacts early)', async () => {
    const provider = new ScriptedProvider(true)
    // A tiny real context window: the static family map would say 32k, but the
    // provider's cached listModels must win and trigger compaction far earlier.
    const listSpy = vi
      .spyOn(provider, 'listModels')
      .mockResolvedValue([{ id: 'fake', name: 'Fake', contextWindow: 4000 }])
    const mid = makeMid(provider)
    provider.script.push((_req, onChunk) => {
      onChunk({ content: 'Ok.', done: false, model: 'fake' })
      onChunk({ content: '', done: true, model: 'fake' })
    })

    // ~3.75k tokens — over the tiny window's 80% (3.2k) but far under 32k's
    const messages: AIMessage[] = []
    for (let i = 0; i < 15; i++) {
      messages.push({ role: 'user', content: `pertanyaan ${i} ` + 'y'.repeat(1000) })
    }
    await mid.streamMessage(
      { messages, model: 'fake' },
      () => {
        /* ignore */
      },
      undefined,
      false,
      'general',
      false,
      'req-compact-window'
    )

    try {
      expect(String(provider.calls[0].messages[0].content)).toContain('[Compacted]')
      expect(listSpy).toHaveBeenCalled()
    } finally {
      listSpy.mockRestore()
    }
  })

  it('R1-1: a short history reaches the provider untouched (no compaction)', async () => {
    const provider = new ScriptedProvider(true)
    const mid = makeMid(provider)
    provider.script.push((_req, onChunk) => {
      onChunk({ content: 'Ok.', done: false, model: 'fake' })
      onChunk({ content: '', done: true, model: 'fake' })
    })

    const chunks: StreamEvent[] = []
    const messages: AIMessage[] = [
      { role: 'user', content: 'hai' },
      { role: 'assistant', content: 'halo' },
      { role: 'user', content: 'apa kabar?' }
    ]
    await mid.streamMessage(
      { messages, model: 'fake' },
      (c) => chunks.push(c),
      undefined,
      false,
      'general',
      false,
      'req-nocompact'
    )

    expect(provider.calls[0].messages).toEqual(messages)
    expect(chunks.some((c) => c.content.includes('context di-compact'))).toBe(false)
  })

  it('R0-1: advertised-but-disconnected MCP tool errors as not-connected, never "unknown tool skipped"', async () => {
    // No server registered — the mcp__ name must still classify as KNOWN so
    // executeTool produces the accurate "tidak terhubung" error instead of the
    // misleading unknown-tool skip path.
    const provider = new ScriptedProvider(true)
    const mid = makeMid(provider)
    provider.script.push((_req, onChunk) => {
      onChunk({ content: '', done: false, model: 'fake' })
      onChunk({
        content: '',
        done: true,
        model: 'fake',
        toolCalls: [{ id: 'mcx', name: 'mcp__ghost__read', arguments: '{}' }]
      })
    })
    provider.script.push((_req, onChunk) => {
      onChunk({ content: 'Ok.', done: false, model: 'fake' })
      onChunk({ content: '', done: true, model: 'fake' })
    })

    const chunks = await run(mid, 'req-mcp-ghost')

    expect(chunks.some((c) => c.content.includes('unknown tools skipped'))).toBe(false)
    const err = chunks.find((c) => c.toolRun?.status === 'error')
    expect(err?.toolRun?.tool).toBe('mcp__ghost__read')
    expect(err?.toolRun?.detail).toMatch(/tidak terhubung/)
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

describe('executeToolWithTimeout (P1-runtime)', () => {
  it('resolves the tool result when the tool finishes in time', async () => {
    const spy = vi.spyOn(AgentTools, 'executeTool').mockResolvedValue({ ok: true, result: ['a'] })
    try {
      const r = await executeToolWithTimeout({ tool: 'list_dir', args: {} })
      expect(r).toEqual({ ok: true, result: ['a'] })
    } finally {
      spy.mockRestore()
    }
  })

  it('returns a timeout error result when a tool hangs', async () => {
    vi.useFakeTimers()
    try {
      const spy = vi
        .spyOn(AgentTools, 'executeTool')
        .mockImplementation(() => new Promise<ToolResult>(() => {}))
      const p = executeToolWithTimeout({ tool: 'list_dir', args: {} })
      await vi.advanceTimersByTimeAsync(EXECUTE_TOOL_TIMEOUT_MS + 5)
      const r = await p
      expect(r.ok).toBe(false)
      expect(r.error).toContain('timeout')
      spy.mockRestore()
    } finally {
      vi.useRealTimers()
    }
  })

  it('surfaces a rejected tool as an error result (never throws out of the loop)', async () => {
    const spy = vi.spyOn(AgentTools, 'executeTool').mockRejectedValue(new Error('disk exploded'))
    try {
      const r = await executeToolWithTimeout({ tool: 'read_note', args: {} })
      expect(r.ok).toBe(false)
      expect(r.error).toContain('disk exploded')
    } finally {
      spy.mockRestore()
    }
  })

  it('P3: a stream writes stream_start + stream_end events to the JSONL audit log', async () => {
    // This describe has no vault — open one so logAIEvent has a target
    const v = fs.mkdtempSync(path.join(tmpdir(), 'wg-mid-audit-'))
    workspaceEngine.openWorkspace(v)
    try {
      const provider = new ScriptedProvider(false)
      const mid = new AIMiddleware({ providers: { fake: provider } })
      mid.setActiveProvider('fake')
      provider.script.push((_req, onChunk) => {
        onChunk({ content: 'Halo.', done: false, model: 'fake' })
        onChunk({ content: '', done: true, model: 'fake' })
      })

      const chunks: StreamEvent[] = []
      await mid.streamMessage(
        { messages: [{ role: 'user', content: 'halo' }], model: 'fake' },
        (c) => chunks.push(c),
        undefined,
        false,
        'general',
        false,
        'req-audit'
      )

      const file = path.join(v, '.workspacegraph', 'logs', 'ai-events.jsonl')
      expect(fs.existsSync(file)).toBe(true)
      const events = fs
        .readFileSync(file, 'utf-8')
        .split('\n')
        .filter(Boolean)
        .map(
          (l) =>
            JSON.parse(l) as { kind: string; status?: string; provider?: string; model?: string }
        )
      const start = events.find((e) => e.kind === 'stream_start')
      const end = events.find((e) => e.kind === 'stream_end')
      expect(start).toBeDefined()
      expect(start?.provider).toBe('fake')
      expect(start?.status).toBe('started')
      expect(end).toBeDefined()
      expect(end?.status).toBe('ok')
      expect(end?.model).toBe('fake')
    } finally {
      workspaceEngine.closeWorkspace()
      fs.rmSync(v, { recursive: true, force: true })
    }
  })
})

describe('AIMiddleware.refreshProviderModels (model discovery refresh)', () => {
  it('busts the cache and returns the fresh model list', async () => {
    const provider = new ScriptedProvider()
    // Spy on listModels (returns real data) + clearModelCache (order matters)
    const models: ModelInfo[] = [{ id: 'm1', name: 'Model 1', contextWindow: 128000, free: true }]
    const listSpy = vi.spyOn(provider, 'listModels').mockResolvedValue(models)
    const clearSpy = vi.spyOn(provider, 'clearModelCache')
    const mid = new AIMiddleware({ providers: { fake: provider } })

    const res = await mid.refreshProviderModels('fake')
    expect(res.ok).toBe(true)
    expect(res.models).toEqual(models)
    // The cache bust ran BEFORE the fetch so a fresh list is guaranteed
    expect(clearSpy).toHaveBeenCalledOnce()
    expect(clearSpy.mock.invocationCallOrder[0]).toBeLessThan(listSpy.mock.invocationCallOrder[0])
  })

  it('returns an error for an unknown provider', async () => {
    const mid = new AIMiddleware({ providers: {} })
    const res = await mid.refreshProviderModels('nope')
    expect(res.ok).toBe(false)
    expect(res.models).toEqual([])
    expect(res.error).toContain('nope')
  })
})

describe('AIMiddleware.getAllProvidersStatus progress push (per-provider spinner)', () => {
  it('invokes onProgress once per provider with its resolved status', async () => {
    const provider = new ScriptedProvider()
    const mid = new AIMiddleware({ providers: { fake: provider } })
    const models: ModelInfo[] = [{ id: 'm1', name: 'Model 1' }]
    vi.spyOn(provider, 'listModels').mockResolvedValue(models)

    // Stub the network so the 6 real providers resolve fast+deterministic
    // (no key → fetchers return [] anyway; this just guarantees it).
    const origFetch = globalThis.fetch
    globalThis.fetch = (async () => ({ ok: false, json: async () => ({}) })) as typeof fetch
    try {
      const progress: string[] = []
      const statuses = await mid.getAllProvidersStatus((s) => progress.push(s.id))

      // The fake provider's status was pushed with its real model list
      expect(progress).toContain('fake')
      // Every pushed id also landed in the final batch (no phantom providers)
      for (const id of progress) expect(statuses.some((s) => s.id === id)).toBe(true)
      const fake = statuses.find((s) => s.id === 'fake')
      expect(fake?.name).toBe('Fake')
      expect(fake?.models).toEqual(models)
    } finally {
      globalThis.fetch = origFetch
    }
  })

  it('works without a callback (full array only)', async () => {
    const mid = new AIMiddleware({ providers: {} })
    const origFetch = globalThis.fetch
    globalThis.fetch = (async () => ({ ok: false, json: async () => ({}) })) as typeof fetch
    try {
      const statuses = await mid.getAllProvidersStatus()
      expect(Array.isArray(statuses)).toBe(true)
      expect(statuses.length).toBeGreaterThan(0)
    } finally {
      globalThis.fetch = origFetch
    }
  })
})
