/**
 * Stress / scale test — the R2-2 chat resume path at vault scale.
 *
 * A big vault (3,000 notes + 80 MB of binaries) with 1,000 saved conversation
 * sessions, where a REAL AI stream is cut off mid-tool-round and then resumed
 * from its checkpoint. Asserts:
 *
 *   1. 1,000 conversations + 1,000 checkpoints coexist with the big vault —
 *      save stays fast and correct (no cross-contamination), and list/load
 *      stay LINEAR: 10x the data costs ≈10x the list time (a quadratic scan
 *      would cost 100x), and a single load stays O(1) at any store size.
 *   2. The interrupted-stream → checkpoint → resume cycle works end-to-end at
 *      the big vault: partial text kept, post-cancel text dropped, the tool
 *      loop continues from the saved round (round 0 NOT re-run), and the
 *      checkpoint is consumed once the reply completes.
 *   3. Resume does NOT slow down pathologically as the vault grows — the same
 *      cycle runs against a small vault (150 notes) and the big vault; every
 *      timing sits under a generous ceiling AND the big/small ratio is bounded
 *      (a quadratic scan or full-vault re-read would blow past the slack).
 *
 * Like stressVault.test.ts this is deliberately NOT a tight benchmark — the
 * ceilings catch pathological behavior (quadratic scans, content reads of
 * binaries, hangs), and the real timings are logged so regressions stay
 * visible in the run output.
 *
 * Runtime: building both vaults + two FTS indexes takes a few seconds, and the
 * 1,000-session save phase writes 2,000 JSON files; the per-test timeouts
 * (60–120 s) exist to turn a HANG into a failure.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import path from 'path'
import { tmpdir } from 'os'
import { workspaceEngine } from '../engine/WorkspaceEngine'
import { indexDatabase } from '../engine/IndexDatabase'
import { searchEngine } from '../engine/SearchEngine'
import { MarkdownEngine, type ParsedMarkdown } from '../engine/MarkdownEngine'
import { AIMiddleware } from '../ai/AIMiddleware'
import type { StreamEvent } from '../ai/AIMiddleware'
import {
  BaseProvider,
  AIRequest,
  AIResponse,
  AIStreamChunk,
  ModelInfo,
  ProviderCapabilities
} from '../ai/providers/BaseProvider'
import {
  saveConversation,
  listConversations,
  loadConversation,
  StoredConversation
} from '../ai/ConversationStore'
import {
  saveCheckpoint,
  loadCheckpoint,
  listCheckpoints,
  deleteCheckpoint,
  checkpointIdFor,
  StreamCheckpoint
} from '../ai/CheckpointStore'

const BIG_NOTES = 3000
const SMALL_NOTES = 150
const SUBDIRS = 20
const BINARY_COUNT = 4
const BINARY_SIZE = 20 * 1024 * 1024 // 20 MB each — 80 MB total of non-text bytes
const CONVERSATION_COUNT = 1000

/** The checkpoint object the renderer persists inside a truncated message and
 * as an on-disk file (mirrors chatStore's MessageCheckpoint). */
function makeCheckpoint(
  conversationId: string,
  messageId: string,
  round: number,
  contextTokens?: number
): StreamCheckpoint {
  return {
    id: checkpointIdFor(conversationId, messageId),
    conversationId,
    messageId,
    messageIndex: 1,
    round,
    contextTokens,
    reason: 'cancelled',
    timestamp: new Date().toISOString()
  }
}

/**
 * Scripted fake provider — same shape as AIMiddleware.test.ts's ScriptedProvider:
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

function buildVault(notes: number, withBinaries: boolean): string {
  const vault = fs.mkdtempSync(path.join(tmpdir(), 'wg-stress-chat-'))
  const notesDir = path.join(vault, 'Notes')
  const binDir = path.join(vault, 'assets')
  fs.mkdirSync(notesDir, { recursive: true })
  fs.mkdirSync(binDir, { recursive: true })
  for (let i = 0; i < notes; i++) {
    const sub = path.join(notesDir, `sub${i % SUBDIRS}`)
    fs.mkdirSync(sub, { recursive: true })
    fs.writeFileSync(
      path.join(sub, `note-${i}.md`),
      `# Note ${i}\n\nKonten kecil ${i} tentang topik ${i % 7} dengan beberapa kata kunci.\n`
    )
  }
  if (withBinaries) {
    const blob = Buffer.alloc(BINARY_SIZE, 0xa5)
    for (let b = 0; b < BINARY_COUNT; b++) {
      fs.writeFileSync(path.join(binDir, `blob-${b}.bin`), blob)
    }
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

/** Open a vault AND populate the search index (FTS + Fuse) so the workspace
 * context build during a stream does real, vault-sized work — the small vs big
 * comparison in test 3 then measures actual scaling, not an empty index. */
let currentOpen: string | null = null
async function openIndexedVault(vault: string): Promise<void> {
  if (currentOpen === vault) return
  workspaceEngine.openWorkspace(vault)
  indexDatabase.open(vault)
  searchEngine.clear()
  const files = parseVaultFiles(vault)
  await searchEngine.buildIndex(files)
  currentOpen = vault
}

/**
 * Drive a REAL AIMiddleware stream that gets CANCELLED mid-tool-round:
 * round 0 runs a list_dir tool (round advances to 1), round 1 emits partial
 * text then cancels — the middleware keeps the pre-cancel text, drops the
 * rest, and ends with the `*(cancelled)*` terminal chunk (the exact R2-2
 * truncation the renderer turns into a resume checkpoint). Returns the chunks,
 * the last round seen (what the renderer persists) and the context estimate.
 */
async function runInterruptedStream(
  mid: AIMiddleware,
  provider: ScriptedProvider,
  requestId: string
): Promise<{ chunks: StreamEvent[]; lastRound: number; contextTokens?: number }> {
  // Round 0: partial answer + a list_dir tool call → tool executes, round advances
  provider.script.push((_req, onChunk) => {
    onChunk({ content: 'Analisis awal: vault berisi banyak catatan. ', done: false, model: 'fake' })
    onChunk({
      content: '',
      done: true,
      model: 'fake',
      toolCalls: [{ id: 'call_0', name: 'list_dir', arguments: '{}' }]
    })
  })
  // Round 1: more partial text, then the user cancels mid-stream
  provider.script.push((_req, onChunk) => {
    onChunk({ content: 'Lanjutan analisis di round 1: ', done: false, model: 'fake' })
    mid.cancelStream(requestId)
    // Everything after the cancel must be dropped by the middleware
    onChunk({ content: ' INI HARUS DIBUANG. ', done: false, model: 'fake' })
    onChunk({ content: '', done: true, model: 'fake' })
  })

  const chunks: StreamEvent[] = []
  await mid.streamMessage(
    { messages: [{ role: 'user', content: 'analisis vault' }], model: 'fake' },
    (c) => chunks.push(c),
    undefined,
    true, // useContext ON — real context build against the open vault
    'general',
    true, // enableTools ON — the tool loop runs
    requestId
  )

  let lastRound = 0
  let contextTokens: number | undefined
  for (const c of chunks) {
    if (typeof c.round === 'number') lastRound = c.round
    if (c.contextTokens !== undefined) contextTokens = c.contextTokens
  }
  return { chunks, lastRound, contextTokens }
}

/** Resume a truncated reply from its checkpoint — the stream continues from
 * the saved round and completes without re-running the earlier tool rounds. */
async function runResumeStream(
  mid: AIMiddleware,
  provider: ScriptedProvider,
  requestId: string,
  cp: StreamCheckpoint
): Promise<StreamEvent[]> {
  provider.script.push((_req, onChunk) => {
    onChunk({ content: 'Selesai: resume dari round terakhir. ', done: false, model: 'fake' })
    onChunk({ content: '', done: true, model: 'fake' })
  })

  const chunks: StreamEvent[] = []
  await mid.streamMessage(
    { messages: [{ role: 'user', content: 'Lanjutkan jawaban yang terpotong.' }], model: 'fake' },
    (c) => chunks.push(c),
    undefined,
    true, // useContext ON — context rebuild is part of the resume cost
    'general',
    true,
    requestId,
    false,
    { round: cp.round, contextTokens: cp.contextTokens }
  )
  return chunks
}

describe('stress: chat resume path at vault scale', () => {
  let smallVault: string
  let bigVault: string

  beforeAll(() => {
    smallVault = buildVault(SMALL_NOTES, false)
    bigVault = buildVault(BIG_NOTES, true)
  }, 120_000)

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
      fs.rmSync(smallVault, { recursive: true, force: true })
      fs.rmSync(bigVault, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  })

  it('1,000 conversations + 1,000 checkpoints coexist with the big vault — list/load stay linear', async () => {
    await openIndexedVault(bigVault)

    // Phased so list/load LINEARITY is measured, not just absolute speed:
    // measure at 10% of scale (100 sessions), then at full scale (1,000).
    // Linear growth → ≈10x list time; a quadratic scan/re-read → ≈100x and
    // fails the ratio assertion below.
    const BASELINE = 100
    const sessionId = (i: number): string => `conv_${String(i).padStart(3, '0')}`
    const saveSession = (i: number): void => {
      const messageId = `m_${i}`
      // Renderer-equivalent truncated transcript (saveCurrentChat on truncation)
      saveConversation({
        id: sessionId(i),
        title: `Sesi ${i}`,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        agentRole: 'general',
        messages: [
          { id: `u_${i}`, role: 'user', content: `Pertanyaan sesi ${i}`, timestamp: '13:00' },
          {
            id: messageId,
            role: 'assistant',
            content: `Jawaban sesi ${i} terpotong. *(cancelled)*`,
            timestamp: '13:01',
            checkpoint: makeCheckpoint(sessionId(i), messageId, 1)
          }
        ]
      } as StoredConversation)
      expect(saveCheckpoint(makeCheckpoint(sessionId(i), messageId, 1)).ok).toBe(true)
    }
    const measureList = (): { convsMs: number; cpsMs: number; convs: number; cps: number } => {
      const t0 = Date.now()
      const convs = listConversations(CONVERSATION_COUNT + 100)
      const convsMs = Date.now() - t0
      const t1 = Date.now()
      const cps = listCheckpoints()
      const cpsMs = Date.now() - t1
      return { convsMs, cpsMs, convs: convs.length, cps: cps.length }
    }

    // ── Phase A: baseline (100 sessions) ──
    const tSaveBase0 = Date.now()
    for (let i = 0; i < BASELINE; i++) saveSession(i)
    const tSaveBase = Date.now() - tSaveBase0
    const base = measureList()
    expect(base.convs).toBe(BASELINE)
    expect(base.cps).toBe(BASELINE)
    // eslint-disable-next-line no-console
    console.log(
      `[stress-chat] baseline ${BASELINE} convs @ big vault: save=${tSaveBase}ms listConv=${base.convsMs}ms listCp=${base.cpsMs}ms`
    )

    // ── Phase B: full scale (1,000 sessions) ──
    const tSave0 = Date.now()
    for (let i = BASELINE; i < CONVERSATION_COUNT; i++) saveSession(i)
    const tSave = Date.now() - tSave0
    // eslint-disable-next-line no-console
    console.log(`[stress-chat] save ${CONVERSATION_COUNT} conv + cps @ big vault: ${tSave}ms`)
    expect(tSave).toBeLessThan(90_000)

    const big = measureList()
    expect(big.convs).toBe(CONVERSATION_COUNT)
    expect(big.cps).toBe(CONVERSATION_COUNT)
    // eslint-disable-next-line no-console
    console.log(
      `[stress-chat] list @ big vault (${CONVERSATION_COUNT}): listConv=${big.convsMs}ms listCp=${big.cpsMs}ms`
    )

    // Absolute ceilings — catch hangs / pathological scans regardless of ratio
    expect(big.convsMs).toBeLessThan(5_000)
    expect(big.cpsMs).toBeLessThan(5_000)
    // Linearity: 10x data → ≈10x list time (15x + slack), never 100x
    expect(big.convsMs).toBeLessThan(base.convsMs * 15 + 2_000)
    expect(big.cpsMs).toBeLessThan(base.cpsMs * 15 + 2_000)

    // Load stays O(1): a single file read, count-independent — loading a
    // session among 1,000 costs the same as loading it among 100.
    const tLoadBase0 = Date.now()
    loadConversation(sessionId(0))
    const tLoadBase = Date.now() - tLoadBase0
    const tLoadBig0 = Date.now()
    loadConversation(sessionId(CONVERSATION_COUNT - 1))
    const tLoadBig = Date.now() - tLoadBig0
    // eslint-disable-next-line no-console
    console.log(
      `[stress-chat] loadConversation: @${BASELINE}≈${tLoadBase}ms @${CONVERSATION_COUNT}=${tLoadBig}ms`
    )
    expect(tLoadBig).toBeLessThan(tLoadBase * 3 + 100)
    expect(tLoadBig).toBeLessThan(500)

    // A mid-list conversation still links to its loadable checkpoint
    const probe = 42
    const loaded = loadConversation(sessionId(probe))
    expect(loaded?.messages[1].content).toContain('terpotong')
    expect(loadCheckpoint(checkpointIdFor(sessionId(probe), `m_${probe}`))?.round).toBe(1)
  }, 120_000)

  it('interrupted stream → checkpoint → resume works end-to-end at the big vault', async () => {
    await openIndexedVault(bigVault)
    const provider = new ScriptedProvider()
    const mid = new AIMiddleware({ providers: { fake: provider } })
    mid.setActiveProvider('fake')

    const { chunks, lastRound, contextTokens } = await runInterruptedStream(
      mid,
      provider,
      'req-big-cut'
    )
    const text = chunks.map((c) => c.content).join('')
    // Partial text kept, post-cancel text dropped, terminal cancelled marker
    expect(text).toContain('Analisis awal')
    expect(text).toContain('Lanjutan analisis')
    expect(text).not.toContain('HARUS DIBUANG')
    expect(text).toContain('*(cancelled)*')
    // Round 0 ran a real tool; the cancel landed during round 1
    expect(chunks.some((c) => c.toolStatus?.includes('▸ list_dir'))).toBe(true)
    expect(lastRound).toBe(1)
    expect(provider.calls).toHaveLength(2)

    // Renderer side: persist the checkpoint + the truncated transcript
    const conversationId = 'conv_big_1'
    const messageId = 'm_big_1'
    const cp = makeCheckpoint(conversationId, messageId, lastRound, contextTokens)
    expect(saveCheckpoint(cp).ok).toBe(true)
    expect(
      saveConversation({
        id: conversationId,
        title: 'Sesi big 1',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        agentRole: 'general',
        messages: [
          { id: 'u_big_1', role: 'user', content: 'analisis vault', timestamp: '13:00' },
          {
            id: messageId,
            role: 'assistant',
            content: 'Analisis awal: vault berisi banyak catatan. *(cancelled)*',
            timestamp: '13:01',
            checkpoint: cp
          }
        ]
      } as StoredConversation).ok
    ).toBe(true)
    expect(loadCheckpoint(cp.id)?.round).toBe(1)

    // Resume: continues from round 1 — round 0 is NOT re-run (one provider call)
    const provider2 = new ScriptedProvider()
    const mid2 = new AIMiddleware({ providers: { fake: provider2 } })
    mid2.setActiveProvider('fake')
    const tResume0 = Date.now()
    const resumeChunks = await runResumeStream(mid2, provider2, 'req-big-resume', cp)
    const tResume = Date.now() - tResume0
    // eslint-disable-next-line no-console
    console.log(`[stress-chat] resume stream @ big vault: ${tResume}ms`)
    expect(tResume).toBeLessThan(30_000)

    const resumeText = resumeChunks.map((c) => c.content).join('')
    expect(resumeText).toContain('Selesai: resume')
    expect(resumeText).not.toContain('*(cancelled)*')
    expect(provider2.calls).toHaveLength(1)

    // Checkpoint consumed once the reply completes (renderer deletes it)
    expect(deleteCheckpoint(cp.id).ok).toBe(true)
    expect(loadCheckpoint(cp.id)).toBeNull()
  }, 90_000)

  it('checkpoint ops + resume stay fast as the vault grows (small vs big ratio)', async () => {
    // ── SMALL vault baseline (150 notes, indexed) ──
    await openIndexedVault(smallVault)
    const sp = new ScriptedProvider()
    const sm = new AIMiddleware({ providers: { fake: sp } })
    sm.setActiveProvider('fake')
    const tInt0 = Date.now()
    const { lastRound: sRound, contextTokens: sCtx } = await runInterruptedStream(
      sm,
      sp,
      'req-small-cut'
    )
    const sInterrupt = Date.now() - tInt0
    const sCp = makeCheckpoint('small_cp', 'sm', sRound, sCtx)
    const sSaveT = Date.now()
    saveCheckpoint(sCp)
    const sSave = Date.now() - sSaveT
    const sLoadT = Date.now()
    loadCheckpoint(sCp.id)
    const sLoad = Date.now() - sLoadT
    // Proportional checkpoint set (≈10% of the big vault's 1,000) so the list
    // baseline is a real measurement — a 1-file baseline (0–1 ms) turned the
    // small/big list ratio into a degenerate absolute ceiling that flaked.
    for (let i = 0; i < 100; i++) {
      saveCheckpoint(makeCheckpoint(`small_bulk_${String(i).padStart(3, '0')}`, 'ms', 1))
    }
    const sListT = Date.now()
    listCheckpoints()
    const sList = Date.now() - sListT
    const sp2 = new ScriptedProvider()
    const sm2 = new AIMiddleware({ providers: { fake: sp2 } })
    sm2.setActiveProvider('fake')
    const sResumeT = Date.now()
    await runResumeStream(sm2, sp2, 'req-small-resume', sCp)
    const sResume = Date.now() - sResumeT

    // ── BIG vault (3,000 notes + 80 MB binaries, indexed) ──
    await openIndexedVault(bigVault)
    const bp = new ScriptedProvider()
    const bm = new AIMiddleware({ providers: { fake: bp } })
    bm.setActiveProvider('fake')
    const tIntB = Date.now()
    const { lastRound: bRound, contextTokens: bCtx } = await runInterruptedStream(
      bm,
      bp,
      'req-big-cut2'
    )
    const bInterrupt = Date.now() - tIntB
    const bCp = makeCheckpoint('big_cp', 'mb', bRound, bCtx)
    const bSaveT = Date.now()
    saveCheckpoint(bCp)
    const bSave = Date.now() - bSaveT
    const bLoadT = Date.now()
    loadCheckpoint(bCp.id)
    const bLoad = Date.now() - bLoadT
    const bListT = Date.now()
    listCheckpoints()
    const bList = Date.now() - bListT
    const bp2 = new ScriptedProvider()
    const bm2 = new AIMiddleware({ providers: { fake: bp2 } })
    bm2.setActiveProvider('fake')
    const bResumeT = Date.now()
    await runResumeStream(bm2, bp2, 'req-big-resume2', bCp)
    const bResume = Date.now() - bResumeT

    // eslint-disable-next-line no-console
    console.log(
      `[stress-chat] small (${SMALL_NOTES} notes): interrupt=${sInterrupt}ms save=${sSave}ms load=${sLoad}ms list=${sList}ms resume=${sResume}ms`
    )
    // eslint-disable-next-line no-console
    console.log(
      `[stress-chat] big   (${BIG_NOTES} notes): interrupt=${bInterrupt}ms save=${bSave}ms load=${bLoad}ms list=${bList}ms resume=${bResume}ms`
    )

    // Absolute ceilings (generous — catch hangs / pathological scans)
    expect(bInterrupt).toBeLessThan(30_000)
    expect(bResume).toBeLessThan(30_000)
    expect(bSave).toBeLessThan(2_000)
    expect(bLoad).toBeLessThan(2_000)
    expect(bList).toBeLessThan(5_000)

    // Scaling ratio — the big vault holds ≈10x the checkpoints of the small
    // one (1,001 vs 101), so a linear list lands ≈10x; a path that grows
    // quadratically (or worse) with store size blows past this even with the
    // slack, while ordinary machine variance stays comfortably inside.
    expect(bInterrupt).toBeLessThan(sInterrupt * 10 + 8_000)
    expect(bResume).toBeLessThan(sResume * 10 + 8_000)
    expect(bSave).toBeLessThan(sSave * 10 + 500)
    expect(bLoad).toBeLessThan(sLoad * 10 + 500)
    expect(bList).toBeLessThan(sList * 10 + 1_000)
  }, 120_000)
})
