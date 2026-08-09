/**
 * LIVE end-to-end verification of the R2-2 resume flow — the exact user path:
 *   1. User asks a question with tools ON → the stream runs a REAL tool round.
 *   2. Mid round 1 the user clicks Cancel → cancelStream stamps the resume
 *      checkpoint (round + contextTokens) and the partial transcript persists
 *      to disk (restart-safe).
 *   3. User clicks "Lanjutkan" → resumeStream continues from the saved round:
 *      round 0 is NOT re-run (no duplicated tool work, exactly one new
 *      provider call), the partial answer is appended to exactly once (no
 *      duplicated content), the truncation markers never leak in, and the
 *      on-disk checkpoint is consumed once the reply completes.
 *
 * Unlike stressChat.test.ts (middleware-only), this drives the RENDERER store
 * (chatStore) wired to the REAL AIMiddleware + REAL tool execution (list_dir
 * against a real vault) + REAL CheckpointStore / ConversationStore on disk.
 * Only the provider "network" is scripted (no API key needed): a fake provider
 * replays round 0 (partial text + a list_dir tool call) and round 1 (partial
 * text, then a sentinel chunk that triggers the store's cancelStream — exactly
 * what the Cancel button does; everything after it is dropped like the real
 * renderer drops the listener on cancel).
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import path from 'path'
import { tmpdir } from 'os'
import { workspaceEngine } from '../engine/WorkspaceEngine'
import { indexDatabase } from '../engine/IndexDatabase'
import { searchEngine } from '../engine/SearchEngine'
import { MarkdownEngine, type ParsedMarkdown } from '../engine/MarkdownEngine'
import { AIMiddleware, type StreamEvent } from '../ai/AIMiddleware'
import {
  BaseProvider,
  AIRequest,
  AIResponse,
  AIStreamChunk,
  ModelInfo,
  ProviderCapabilities
} from '../ai/providers/BaseProvider'
import {
  saveCheckpoint,
  loadCheckpoint,
  deleteCheckpoint,
  checkpointIdFor
} from '../ai/CheckpointStore'
import { loadConversation, saveConversation, newConversationId } from '../ai/ConversationStore'
import { useChatStore } from '../../renderer/src/store/chatStore'

const NOTES = 150

/**
 * Scripted fake provider — same shape as AIMiddleware.test.ts / stressChat:
 * records every request and replays a per-call script of stream chunks. No
 * network; the tool loop is driven deterministically by scripted toolCalls.
 */
class ScriptedProvider extends BaseProvider {
  readonly id = 'fake'
  readonly name = 'Fake'
  readonly capabilities: ProviderCapabilities = {
    chat: true,
    streaming: true,
    vision: false,
    toolCalling: true,
    embeddings: false
  }

  calls: AIRequest[] = []
  script: ((req: AIRequest, onChunk: (c: AIStreamChunk) => void) => void | Promise<void>)[] = []

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

function buildVault(): string {
  const vault = fs.mkdtempSync(path.join(tmpdir(), 'wg-resume-live-'))
  const notesDir = path.join(vault, 'Notes')
  fs.mkdirSync(notesDir, { recursive: true })
  for (let i = 0; i < NOTES; i++) {
    const sub = path.join(notesDir, `sub${i % 10}`)
    fs.mkdirSync(sub, { recursive: true })
    fs.writeFileSync(
      path.join(sub, `note-${i}.md`),
      `# Note ${i}\n\nKonten kecil ${i} tentang topik ${i % 5} dengan beberapa kata kunci.\n`
    )
  }
  return vault
}

function parseVaultFiles(vault: string): ParsedMarkdown[] {
  const markdown = new MarkdownEngine()
  const files: ParsedMarkdown[] = []
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === '.workspacegraph') continue
        walk(abs)
      } else if (entry.name.toLowerCase().endsWith('.md')) {
        try {
          files.push(markdown.parseFile(abs, fs.readFileSync(abs, 'utf-8'), vault))
        } catch {
          /* skip unreadable */
        }
      }
    }
  }
  walk(vault)
  return files
}

/**
 * Wire the renderer store's window.api to the REAL main-process pieces: the
 * middleware (with the scripted provider), the on-disk CheckpointStore and
 * ConversationStore. streamAIMessage maps the renderer call signature onto
 * the middleware's, returns a stream id, and pushes the stream promise so the
 * test can wait for the async stream to finish (the store itself is
 * fire-and-forget, like the real renderer).
 */
function setupLiveBridge(
  mid: AIMiddleware,
  streams: Promise<void>[]
): Record<string, ReturnType<typeof vi.fn>> {
  const api: Record<string, ReturnType<typeof vi.fn>> = {
    getAIProviders: vi.fn().mockResolvedValue([]),
    getSettings: vi.fn().mockResolvedValue({}),
    setActiveAIProvider: vi.fn().mockResolvedValue(true),
    newChatId: vi.fn().mockImplementation(async () => newConversationId()),
    streamAIMessage: vi.fn(),
    saveChat: vi.fn().mockImplementation(async (conv) => saveConversationLoose(conv)),
    loadChat: vi.fn().mockImplementation(async (id) => loadConversation(id)),
    deleteChat: vi.fn().mockResolvedValue({ ok: true }),
    cancelAIStream: vi.fn().mockImplementation(async (id: string) => {
      mid.cancelStream(id)
      return true
    }),
    applyWriteProposal: vi.fn().mockResolvedValue({ ok: true }),
    rejectWriteProposal: vi.fn().mockResolvedValue({ ok: true }),
    listWriteProposals: vi.fn().mockResolvedValue([]),
    promoteToKnowledge: vi.fn().mockResolvedValue({ ok: true, proposal: null }),
    ensureAiMemory: vi.fn().mockResolvedValue({ ok: true, created: [] }),
    listAiMemory: vi.fn().mockResolvedValue({ files: [], core: [] }),
    saveCheckpoint: vi.fn().mockImplementation(async (cp) => saveCheckpoint(cp)),
    listCheckpoints: vi.fn().mockResolvedValue([]),
    loadCheckpoint: vi.fn().mockImplementation(async (id) => loadCheckpoint(id)),
    deleteCheckpoint: vi.fn().mockImplementation(async (id) => deleteCheckpoint(id))
  }
  let reqCounter = 0
  api.streamAIMessage.mockImplementation(
    (
      payload: { messages: unknown[]; model?: string },
      cb: (c: Record<string, unknown>) => void,
      activeFilePath?: string,
      useContext?: boolean,
      agentRole?: string,
      enableTools?: boolean,
      planMode?: boolean,
      resumeFrom?: { round: number; contextTokens?: number }
    ) => {
      const requestId = `live-${++reqCounter}`
      let dropped = false
      const p = mid.streamMessage(
        { messages: payload.messages as AIRequest['messages'], model: payload.model },
        (chunk: StreamEvent) => {
          if (dropped) return
          // The real Cancel drops the renderer listener — mimic that: the
          // sentinel chunk triggers store.cancelStream() (the Cancel button
          // path) and everything after it never reaches the transcript.
          if (typeof chunk.content === 'string' && chunk.content.includes('CANCEL_NOW')) {
            dropped = true
            void useChatStore.getState().cancelStream()
            return
          }
          cb({ ...chunk })
        },
        activeFilePath,
        useContext,
        (agentRole || 'general') as never,
        enableTools,
        requestId,
        planMode,
        resumeFrom
      )
      streams.push(p)
      return requestId
    }
  )
  ;(globalThis as unknown as { window: unknown }).window = { api }
  return api
}

/** saveConversation without importing the store's exact return type in the mock. */
function saveConversationLoose(conv: unknown): { ok: boolean } {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return saveConversation(conv as any)
}

describe('LIVE resume flow — cancel mid-tool-round → Lanjutkan (renderer store + real middleware)', () => {
  let vault: string

  beforeAll(() => {
    vault = buildVault()
    workspaceEngine.openWorkspace(vault)
    indexDatabase.open(vault)
    searchEngine.clear()
    return searchEngine.buildIndex(parseVaultFiles(vault))
  }, 60_000)

  afterAll(() => {
    try {
      workspaceEngine.closeWorkspace()
    } catch {
      /* ignore */
    }
    try {
      indexDatabase.close()
    } catch {
      /* ignore */
    }
    try {
      fs.rmSync(vault, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  })

  it('cancel mid-tool-round → Lanjutkan → content appended exactly once, round 0 NOT re-run, fast', async () => {
    const provider = new ScriptedProvider()
    const mid = new AIMiddleware({ providers: { fake: provider } })
    mid.setActiveProvider('fake')
    const streams: Promise<void>[] = []
    const api = setupLiveBridge(mid, streams)
    // Fresh session
    useChatStore.setState({
      messages: [],
      conversationId: null,
      isGenerating: false,
      activeStreamId: null,
      activeAssistantMsgId: null,
      activeStreamRound: 0,
      pendingProposals: [],
      lastToolStatus: ''
    })

    // Round 0: partial answer + a REAL list_dir tool call → the tool executes,
    // the round advances to 1.
    provider.script.push((_req, onChunk) => {
      onChunk({ content: 'Analisis awal: vault berisi catatan. ', done: false, model: 'fake' })
      onChunk({
        content: '',
        done: true,
        model: 'fake',
        toolCalls: [{ id: 'call_0', name: 'list_dir', arguments: '{}' }]
      })
    })
    // Round 1: more partial text, then the sentinel that triggers the Cancel
    // click mid-stream — post-cancel chunks must be dropped by the bridge.
    provider.script.push((_req, onChunk) => {
      onChunk({ content: 'Lanjutan round 1: ', done: false, model: 'fake' })
      onChunk({ content: 'CANCEL_NOW', done: false, model: 'fake' })
      onChunk({ content: ' INI HARUS DIBUANG ', done: false, model: 'fake' })
      onChunk({ content: '', done: true, model: 'fake' })
    })

    // ── Send + cancel mid round 1 (the Cancel button path) ──
    const tSend0 = Date.now()
    await useChatStore.getState().sendMessage('analisis vault')
    await Promise.all(streams)
    // Let cancelStream's post-await side effects (stamp + persist) settle.
    await new Promise((r) => setTimeout(r, 20))
    const tInterrupt = Date.now() - tSend0

    const s = useChatStore.getState()
    const asst = s.messages.find((m) => m.role === 'assistant')
    expect(asst).toBeDefined()
    // Partial text kept; post-cancel text + the sentinel + the marker never leak in
    expect(asst!.content).toContain('Analisis awal')
    expect(asst!.content).toContain('Lanjutan round 1')
    expect(asst!.content).not.toContain('HARUS DIBUANG')
    expect(asst!.content).not.toContain('CANCEL_NOW')
    expect(asst!.content).not.toContain('*(cancelled)*')
    // The cancel stamped the resume checkpoint — round 1 = mid tool round
    expect(asst!.checkpoint?.reason).toBe('cancelled')
    expect(asst!.checkpoint?.round).toBe(1)
    expect(s.isGenerating).toBe(false)
    expect(api.cancelAIStream).toHaveBeenCalledTimes(1)
    // Round 0 ran a REAL tool that closed as ok
    expect(asst!.toolRuns?.some((r) => r.tool === 'list_dir' && r.status === 'ok')).toBe(true)
    // The on-disk checkpoint exists (restart-safe "Lanjutkan")
    const cpId = checkpointIdFor(s.conversationId || 'anon', asst!.id)
    expect(loadCheckpoint(cpId)?.round).toBe(1)
    expect(api.saveCheckpoint).toHaveBeenCalledTimes(1)
    // The partial transcript persisted to disk too
    const savedTrunc = loadConversation(s.conversationId || '')
    expect(savedTrunc?.messages.find((m) => m.id === asst!.id)?.content).toContain(
      'Lanjutan round 1'
    )

    // ── User clicks "Lanjutkan" ──
    provider.script.push((_req, onChunk) => {
      onChunk({ content: 'Selesai: resume tuntas. ', done: false, model: 'fake' })
      onChunk({ content: '', done: true, model: 'fake' })
    })
    const callsBefore = provider.calls.length // 2 (round 0 + round 1)
    const tResume0 = Date.now()
    await useChatStore.getState().resumeStream(asst!.id)
    await Promise.all(streams)
    await new Promise((r) => setTimeout(r, 20))
    const tResume = Date.now() - tResume0

    // Resume = exactly ONE new provider call → round 0 was NOT re-run (no
    // duplicated tool work, no duplicated content).
    expect(provider.calls.length).toBe(callsBefore + 1)

    const final = useChatStore.getState().messages.find((m) => m.id === asst!.id)
    expect(final!.content).toContain('Selesai: resume tuntas')
    // No duplication: the round-0 partial answer appears EXACTLY once
    expect(final!.content.match(/Analisis awal/g) || []).toHaveLength(1)
    expect(final!.content).not.toContain('*(cancelled)*')
    expect(final!.content).not.toContain('HARUS DIBUANG')
    expect(final!.content).not.toContain('CANCEL_NOW')
    // Completed → checkpoint cleared on the message AND on disk
    expect(final!.checkpoint).toBeUndefined()
    expect(loadCheckpoint(cpId)).toBeNull()
    expect(api.deleteCheckpoint).toHaveBeenCalledTimes(1)
    // The completed transcript persisted to disk
    const savedFinal = loadConversation(useChatStore.getState().conversationId || '')
    expect(savedFinal?.messages.find((m) => m.id === asst!.id)?.content).toContain(
      'Selesai: resume tuntas'
    )

    // eslint-disable-next-line no-console
    console.log(`[resume-live] interrupt=${tInterrupt}ms resume=${tResume}ms`)
    expect(tResume).toBeLessThan(2_000)
  }, 60_000)
})
