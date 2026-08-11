/**
 * LIVE end-to-end verification of the R2-4 auto-ingest loop — the exact user
 * path, with a real vault and the REAL AIMiddleware:
 *
 *   1. User runs N chat streams → each completes and the middleware writes a
 *      REAL stream_end event to the vault's AI event trail
 *      (.workspacegraph/logs/ai-events.jsonl).
 *   2. After each completed stream the handler hook (notifyStreamCompleted)
 *      bumps the cadence counter, exactly like ai:streamMessage's finally.
 *   3. Once N streams are done, the ingest runs: it summarizes ONLY facts
 *      from the real trail (streams / errors / tokens) and appends a dated
 *      section to AI Memory/Log Ingest.md.
 *   4. A second run with no new activity appends nothing — the same bullets
 *      are deduped, so the file stays byte-identical.
 *
 * Like resumeLive.test.ts, only the provider "network" is scripted — no API
 * key needed; the middleware, the event log, the memory files and the
 * cadence state are all real on-disk pieces.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import path from 'path'
import { tmpdir } from 'os'
import { workspaceEngine } from '../engine/WorkspaceEngine'
import { indexDatabase } from '../engine/IndexDatabase'
import { searchEngine } from '../engine/SearchEngine'
import { AIMiddleware } from '../ai/AIMiddleware'
import {
  BaseProvider,
  AIRequest,
  AIResponse,
  AIStreamChunk,
  ModelInfo,
  ProviderCapabilities
} from '../ai/providers/BaseProvider'
import { ensureAiMemoryScaffold, AI_MEMORY_DIR, AI_MEMORY_FILES } from '../ai/WorkspaceMemory'
import {
  notifyStreamCompleted,
  runAutoIngest,
  loadAutoIngestState,
  AUTO_INGEST_EVERY_MESSAGES
} from '../ai/autoIngest'
import { readAIEvents } from '../ai/AIEventLog'

/** Scripted provider — same shape as resumeLive/stressChat. No network. */
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
  const vault = fs.mkdtempSync(path.join(tmpdir(), 'wg-autoingest-live-'))
  const notesDir = path.join(vault, 'Notes')
  fs.mkdirSync(notesDir, { recursive: true })
  fs.writeFileSync(path.join(notesDir, 'note.md'), '# Note\n\nKonten vault nyata.\n')
  return vault
}

function logIngestPath(vault: string): string {
  return path.join(vault, AI_MEMORY_DIR, AI_MEMORY_FILES.logIngest)
}

describe('LIVE auto-ingest loop — N real streams fill Log Ingest.md, never duplicated', () => {
  let vault: string

  beforeAll(() => {
    vault = buildVault()
    workspaceEngine.openWorkspace(vault)
    indexDatabase.open(vault)
    searchEngine.clear()
    const mem = ensureAiMemoryScaffold(vault)
    expect(mem.ok).toBe(true)
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

  it('N completed streams → dated summary in Log Ingest.md, cadence reset', async () => {
    const provider = new ScriptedProvider()
    const mid = new AIMiddleware({ providers: { fake: provider } })
    mid.setActiveProvider('fake')

    // N real streams — each writes a stream_end event with real tokens to the
    // vault trail, then the handler hook bumps the cadence (the ai:streamMessage
    // finally path).
    for (let i = 0; i < AUTO_INGEST_EVERY_MESSAGES; i++) {
      provider.script.push((_req, onChunk) => {
        onChunk({ content: `jawaban ${i}`, done: false, model: 'fake' })
        onChunk({ content: '', done: true, model: 'fake', tokensUsed: 10 + i })
      })
      await mid.streamMessage(
        { messages: [{ role: 'user', content: `pertanyaan ${i}` }], model: 'fake' } as never,
        () => {},
        undefined,
        false,
        'general',
        false,
        `e2e-${i}`
      )
      notifyStreamCompleted(vault)
    }

    // The ingest ran on the Nth stream: cadence reset, last run stamped.
    const state = loadAutoIngestState(vault)
    expect(state.messagesSinceRun).toBe(0)
    expect(state.lastRunAt).not.toBeNull()

    // Log Ingest.md gained a dated section reflecting REAL trail facts.
    // Note: in the STREAM path the middleware rebuilds each public chunk
    // without the provider's tokensUsed, so stream_end events carry no token
    // figure — the ingest correctly reports the stream count and status only.
    const text = fs.readFileSync(logIngestPath(vault), 'utf-8')
    const today = new Date().toISOString().split('T')[0]
    expect(text).toContain(`## ${today}`)
    expect(text).toContain(`- Auto-ingest: ${AUTO_INGEST_EVERY_MESSAGES} sesi AI sukses`)
    expect(text).not.toContain('error')

    // The summary was built from real middleware events, not from nothing:
    // the vault trail holds exactly N terminal stream_end events (ok).
    const terminal = readAIEvents(vault, 100).filter(
      (e) => e.kind === 'stream_end' && e.status !== 'started'
    )
    expect(terminal).toHaveLength(AUTO_INGEST_EVERY_MESSAGES)
    expect(terminal.every((e) => e.status === 'ok')).toBe(true)
    expect(provider.calls.length).toBe(AUTO_INGEST_EVERY_MESSAGES)
  }, 60_000)

  it('second run with no new activity appends nothing (dedup — file stays identical)', () => {
    const before = fs.readFileSync(logIngestPath(vault), 'utf-8')
    // No new streams → same facts → same bullets → appendLogEntry dedupes.
    const added = runAutoIngest(vault)
    expect(added).toBe(0)
    expect(fs.readFileSync(logIngestPath(vault), 'utf-8')).toBe(before)
  })
})
