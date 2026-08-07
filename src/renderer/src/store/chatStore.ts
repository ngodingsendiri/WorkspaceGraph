import { create } from 'zustand'
import { AUTO_MODEL, isAutoModel } from '../components/chat/chatModelPicker'
import { followUpPreamble } from '../components/chat/chatFollowUp'

export interface CitationItem {
  title: string
  path: string
}

/** Post-generation grounding check from AIMiddleware (⚠ = weak evidence). */
export interface CitationVerification {
  path: string
  title: string
  supported: boolean
  score: number
}

/** An image attached to a chat message (vision, P-A2). */
export interface ImageAttachment {
  mimeType: string
  dataBase64: string
  name?: string
}

export interface WriteProposalItem {
  id: string
  tool: string
  absolutePath: string
  relativePath: string
  content: string
  mode: string
  preview: string
  status: string
  createdAt: string
}

/**
 * One tool invocation in the assistant message's tool trail (P1-1).
 * `running` opens the run; `ok` / `error` closes it. `detail` is the result
 * preview shown when the pill is expanded. A run stuck on `running` when the
 * stream ends (abort/timeout) is closed as `error` with detail 'interrupted'.
 */
export interface ToolRun {
  runId: string
  tool: string
  status: 'running' | 'ok' | 'error'
  detail?: string
  round?: number
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp: string
  citations?: CitationItem[]
  proposals?: WriteProposalItem[]
  images?: ImageAttachment[]
  toolStatus?: string
  /** Structured per-tool trail — collapsible pills in the bubble (P1-1). */
  toolRuns?: ToolRun[]
  /** Total tokens used by this completion (provider-reported, streaming). */
  tokensUsed?: number
  /** Estimated tokens injected as workspace context for this reply. */
  contextTokens?: number
  /** P1-4: tokens saved by sending the workspace context only in round 0 of a
   * multi-round tool loop (context estimate × rounds beyond the first). */
  contextSavedTokens?: number
  /** P2-4: streaming chain-of-thought from reasoning models, shown as a
   * collapsible "Berpikir" block (never part of the answer content). */
  reasoning?: string
  /** Per-citation grounding check emitted with the final done chunk. */
  verifications?: CitationVerification[]
  /** P3-2: this user message was a follow-up — id of the assistant message
   * whose proposals seeded its prompt (persisted so Regenerate re-arms). */
  followUpFrom?: string
}

export interface ProviderItem {
  id: string
  name: string
  connected: boolean
  configured?: boolean
  defaultModel?: string
  error?: string
  models: { id: string; name: string; contextWindow?: number; ownedBy?: string; free?: boolean }[]
}

export type AgentRole = 'general' | 'writer' | 'researcher' | 'curator' | 'planner'

export interface ChatStore {
  messages: ChatMessage[]
  providers: ProviderItem[]
  activeProviderId: string
  selectedModelId: string
  agentRole: AgentRole
  isGenerating: boolean
  useContext: boolean
  enableTools: boolean
  /** R1-3: plan mode — write tools blocked, only analysis → steps → create_plan. */
  planMode: boolean
  pendingProposals: WriteProposalItem[]
  conversationId: string | null
  activeStreamId: string | null
  lastToolStatus: string
  /** P3-1: follow-up mode — source assistant message whose proposals should
   * seed the next prompt (consumed by sendMessage, cleared on session reset). */
  followUpMessageId: string | null

  fetchProviders: () => Promise<void>
  setActiveProvider: (providerId: string) => Promise<void>
  setSelectedModel: (modelId: string) => void
  setAgentRole: (role: AgentRole) => void
  setUseContext: (use: boolean) => void
  setEnableTools: (use: boolean) => void
  /** R1-3: toggle plan mode for the next stream (analysis → plan proposal). */
  setPlanMode: (on: boolean) => void
  sendMessage: (text: string, activeFilePath?: string, images?: ImageAttachment[]) => Promise<void>
  cancelStream: () => Promise<void>
  clearHistory: () => void
  /** Hydrate the proposal dock from persisted pending proposals (restart-safe). */
  refreshProposals: () => Promise<void>
  applyProposal: (
    id: string,
    content?: string
  ) => Promise<{ ok: boolean; error?: string; path?: string }>
  rejectProposal: (id: string) => Promise<void>
  /** P2: promote a chat answer into a Knowledge/ note proposal (with backlinks
   * to its citations). Returns the created proposal so the dock can hydrate. */
  promoteAnswer: (
    msgId: string,
    suggestedTitle?: string
  ) => Promise<{ ok: boolean; proposal?: WriteProposalItem; error?: string }>
  saveCurrentChat: () => Promise<void>
  loadChat: (id: string) => Promise<void>
  /** Delete a saved conversation file (keeps current session untouched unless same id). */
  deleteChat: (id: string) => Promise<{ ok: boolean; error?: string }>
  /** P3-1: arm (or cancel) composer follow-up mode for an assistant message. */
  setFollowUp: (messageId: string | null) => void
  /** Re-send the last user message after an error (retry). */
  retryLastMessage: (activeFilePath?: string) => Promise<void>
  /** Rewrite a completed assistant message in place (regenerate-style). */
  rephraseMessage: (msgId: string, activeFilePath?: string) => Promise<void>
  ensureConversationId: () => Promise<string>
  /** Scaffold AI Memory/ then run bootstrap agent prompt */
  learnWorkspace: (
    activeFilePath?: string
  ) => Promise<{ ok: boolean; error?: string; created?: string[] }>
  lastKernelStatus: string
}

function mergeProposals(
  existing: WriteProposalItem[] | undefined,
  incoming: WriteProposalItem[] | undefined
): WriteProposalItem[] {
  const map = new Map<string, WriteProposalItem>()
  for (const p of existing || []) map.set(p.id, p)
  for (const p of incoming || []) map.set(p.id, p)
  return Array.from(map.values())
}

/**
 * P1-1: a stream that ends (done chunk / user cancel) must never leave a tool
 * pill stuck on the live spinner — close any run still `running` as interrupted.
 */
function closeOutRunningRuns(toolRuns: ToolRun[] | undefined): ToolRun[] | undefined {
  if (!toolRuns?.some((r) => r.status === 'running')) return toolRuns
  return toolRuns.map((r) =>
    r.status === 'running' ? { ...r, status: 'error', detail: r.detail || 'interrupted' } : r
  )
}

/**
 * Bound the conversation history sent to the model — unlimited growth would
 * blow the context window and bill. Keep the last N user/assistant turns and
 * always include the current prompt. ~6 turns ≈ 12 messages ≈ safe for 8k ctx.
 */
const HISTORY_MAX_TURNS = 8
const HISTORY_MAX_CHARS = 60_000

/**
 * Conversations the user deleted this session. A stream's completion handler
 * fires `saveCurrentChat()` un-awaited — without this tombstone, a save that
 * fires AFTER the delete could re-create the chat file.
 */
const deletedChatIds = new Set<string>()
/** Latest saveCurrentChat invocation — deleteChat awaits it so the delete always
 * lands after any in-flight save (same-id resurrection race). */
let lastSavePromise: Promise<void> | null = null

export function buildHistoryWindow(
  messages: ChatMessage[],
  currentUser: { role: 'user'; content: string }
): { role: 'user' | 'assistant'; content: string }[] {
  const all: ChatMessage[] = [...messages, currentUser as ChatMessage]
  const trimmed = all.slice(-(HISTORY_MAX_TURNS * 2))
  const out: { role: 'user' | 'assistant'; content: string }[] = []
  let totalChars = 0
  // Always keep the newest user prompt even if total budget is tight
  for (let i = trimmed.length - 1; i >= 0; i--) {
    const m = trimmed[i]
    if (m.role !== 'user' && m.role !== 'assistant') continue
    const content = typeof m.content === 'string' ? m.content.trim() : ''
    if (!content) continue
    const isCurrent = i === trimmed.length - 1
    if (!isCurrent && totalChars + content.length > HISTORY_MAX_CHARS) continue
    totalChars += content.length
    out.unshift({ role: m.role as 'user' | 'assistant', content })
  }
  return out
}

export const useChatStore = create<ChatStore>((set, get) => ({
  messages: [],
  providers: [],
  activeProviderId: 'grok',
  // P1-3: 'auto' = follow the active provider's default model. sendMessage
  // resolves it to undefined so the middleware picks the provider default.
  selectedModelId: 'auto',
  agentRole: 'general',
  isGenerating: false,
  useContext: true,
  enableTools: true,
  planMode: false,
  pendingProposals: [],
  conversationId: null,
  activeStreamId: null,
  lastToolStatus: '',
  lastKernelStatus: '',
  followUpMessageId: null,

  fetchProviders: async () => {
    try {
      const providers = (await window.api.getAIProviders()) as ProviderItem[]
      // BUGFIX: sync chat activeProviderId with persisted settings (was stuck on default 'grok')
      let activeProviderId = get().activeProviderId
      try {
        const settings = (await window.api.getSettings()) as { activeProvider?: string } | null
        if (settings?.activeProvider && providers.some((p) => p.id === settings.activeProvider)) {
          activeProviderId = settings.activeProvider
        }
      } catch {
        /* keep current */
      }
      let selectedModelId = get().selectedModelId
      const found = providers.find((p) => p.id === activeProviderId)
      if (found?.models?.length) {
        const ok = found.models.some((m) => m.id === selectedModelId)
        // P1-3: 'auto' is a valid persistent choice — never clobber it with a
        // concrete model during the providers sync.
        if (!ok && !isAutoModel(selectedModelId)) {
          selectedModelId = found.defaultModel || found.models[0].id
        }
      }
      set({ providers, activeProviderId, selectedModelId })
    } catch (err) {
      console.error('Failed to fetch AI providers:', err)
    }
  },

  setActiveProvider: async (providerId: string) => {
    // IPC failure must not abort the local switch — the stream call re-aligns
    // the main process anyway (sendMessage re-sets active provider).
    try {
      await window.api.setActiveAIProvider(providerId)
    } catch {
      /* keep local state authoritative */
    }
    const { providers } = get()
    const found = providers.find((p) => p.id === providerId)
    const firstModel = found?.defaultModel || found?.models[0]?.id || ''
    // P1-3: Auto stays Auto across provider switches (the model follows the
    // new provider's default); a concrete pick keeps that concrete model.
    set({
      activeProviderId: providerId,
      selectedModelId: isAutoModel(get().selectedModelId) ? AUTO_MODEL : firstModel
    })
  },

  setSelectedModel: (modelId: string) => set({ selectedModelId: modelId }),
  setAgentRole: (role: AgentRole) => set({ agentRole: role }),
  setUseContext: (use: boolean) => set({ useContext: use }),
  setEnableTools: (use: boolean) => set({ enableTools: use }),
  setPlanMode: (on: boolean) => set({ planMode: on }),
  setFollowUp: (messageId: string | null) => set({ followUpMessageId: messageId }),

  ensureConversationId: async () => {
    let id = get().conversationId
    if (!id) {
      id = await window.api.newChatId()
      set({ conversationId: id })
    }
    return id
  },

  sendMessage: async (text: string, activeFilePath?: string, images?: ImageAttachment[]) => {
    if (!text.trim() && !images?.length) return

    await get().ensureConversationId()

    // P3-2: read BEFORE building the user message so the transcript can stamp
    // the follow-up source — Regenerate (retryLastMessage) re-arms from it.
    const followUpMessageId = get().followUpMessageId

    const userMsg: ChatMessage = {
      id: Math.random().toString(36).slice(2),
      role: 'user',
      content: text,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      ...(images?.length ? { images } : {}),
      ...(followUpMessageId ? { followUpFrom: followUpMessageId } : {})
    }

    const assistantMsgId = Math.random().toString(36).slice(2)
    const assistantMsg: ChatMessage = {
      id: assistantMsgId,
      role: 'assistant',
      content: '',
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      citations: [],
      proposals: [],
      toolRuns: []
    }

    const prior = get().messages
    set({
      messages: [...prior, userMsg, assistantMsg],
      isGenerating: true,
      lastToolStatus: ''
    })

    const { selectedModelId, activeProviderId, useContext, agentRole, enableTools, planMode } =
      get()
    // P3-1: follow-up mode — attach the source message's proposal list to the
    // API prompt (transcript keeps the user's clean text). Consumed here, so a
    // second send without re-arming is a plain question again.
    let apiText = text
    if (followUpMessageId) {
      set({ followUpMessageId: null })
      const src = prior.find((m) => m.id === followUpMessageId)
      const preamble = followUpPreamble(src?.proposals)
      if (preamble) apiText = `${preamble}\n\n${text}`
    }

    const historyForApi = buildHistoryWindow(prior, {
      role: 'user',
      content: apiText
    })

    const requestPayload = {
      // P1-3: 'auto' → undefined so the middleware fills the provider default
      model: isAutoModel(selectedModelId) ? undefined : selectedModelId,
      messages: historyForApi,
      // Vision (P-A2): only the CURRENT prompt carries images — re-sending
      // history images every turn would burn tokens for no context gain.
      ...(images?.length ? { images } : {})
    }

    try {
      // BUGFIX: always align main-process active provider with chat dropdown before stream
      try {
        await window.api.setActiveAIProvider(activeProviderId)
      } catch {
        /* continue — stream will error if provider missing */
      }
      const streamId = window.api.streamAIMessage(
        requestPayload,
        (chunk) => {
          set((state) => {
            const nextPending = mergeProposals(
              state.pendingProposals,
              (chunk.proposals as WriteProposalItem[]) || []
            ).filter((p) => p.status === 'pending' || !p.status)

            return {
              messages: state.messages.map((m) => {
                if (m.id !== assistantMsgId) return m
                let content = m.content + (chunk.content || '')
                // Avoid double "**Error:**" if middleware already injected it into content
                if (chunk.error && chunk.done) {
                  const already =
                    content.includes(chunk.error) ||
                    content.includes('**Error:**') ||
                    content.includes('*(cancelled)*')
                  if (!already) {
                    const errLine = `**Error:** ${chunk.error}`
                    content = content.trim() ? `${content}\n\n${errLine}` : errLine
                  }
                }
                // P1-1: accumulate per-tool lifecycle events into the trail —
                // updates match by runId (running → ok/error), new runs append.
                let toolRuns = m.toolRuns
                const incoming = chunk.toolRun as ToolRun | undefined
                if (incoming) {
                  const idx = (toolRuns || []).findIndex((r) => r.runId === incoming.runId)
                  toolRuns =
                    idx >= 0
                      ? toolRuns!.map((r, i) => (i === idx ? { ...r, ...incoming } : r))
                      : [...(toolRuns || []), incoming]
                }
                // A done chunk (abort/timeout/error) may close a run that never
                // got its ok/error event — never leave a stuck spinner pill.
                if (chunk.done) toolRuns = closeOutRunningRuns(toolRuns)
                return {
                  ...m,
                  content,
                  citations: chunk.citations || m.citations,
                  proposals: mergeProposals(m.proposals, chunk.proposals as WriteProposalItem[]),
                  toolStatus: chunk.toolStatus || m.toolStatus,
                  toolRuns,
                  // Tool loops are separate completions — accumulate so the shown
                  // count is the total, not just the last round.
                  tokensUsed:
                    chunk.tokensUsed !== undefined && m.tokensUsed !== undefined
                      ? m.tokensUsed + chunk.tokensUsed
                      : (chunk.tokensUsed ?? m.tokensUsed),
                  contextTokens: chunk.contextTokens ?? m.contextTokens,
                  contextSavedTokens: chunk.contextSavedTokens ?? m.contextSavedTokens,
                  // P2-4: reasoning arrives as incremental deltas — append
                  reasoning: (m.reasoning || '') + (chunk.reasoning || ''),
                  verifications: (chunk.verifications as CitationVerification[]) || m.verifications
                }
              }),
              isGenerating: !chunk.done,
              pendingProposals: nextPending,
              lastToolStatus: chunk.error || chunk.toolStatus || state.lastToolStatus,
              activeStreamId: chunk.done ? null : state.activeStreamId
            }
          })

          if (chunk.done) {
            void get().saveCurrentChat()
          }
        },
        activeFilePath,
        useContext,
        agentRole,
        enableTools,
        planMode
      )
      set({ activeStreamId: streamId })
    } catch (_err) {
      set((state) => ({
        messages: state.messages.map((m) =>
          m.id === assistantMsgId
            ? { ...m, content: 'Error: Failed to connect to AI provider.' }
            : m
        ),
        isGenerating: false,
        activeStreamId: null
      }))
    }
  },

  cancelStream: async () => {
    const id = get().activeStreamId
    if (id) {
      await window.api.cancelAIStream(id)
      set((state) => ({
        isGenerating: false,
        activeStreamId: null,
        lastToolStatus: 'Cancelled',
        // P1-1: cancel drops the renderer listener, so no done chunk arrives to
        // close out running tool pills — mark them interrupted here.
        messages: state.messages.map((m) =>
          m.toolRuns?.some((r) => r.status === 'running')
            ? { ...m, toolRuns: closeOutRunningRuns(m.toolRuns) }
            : m
        )
      }))
      // cancelAIStream drops the renderer listener immediately, so the main
      // process's trailing `*(cancelled)*` done chunk never reaches us — save the
      // partial transcript here so cancelled chats are still persisted.
      void get().saveCurrentChat()
    }
  },

  clearHistory: () =>
    set({
      messages: [],
      pendingProposals: [],
      conversationId: null,
      lastToolStatus: '',
      lastKernelStatus: '',
      followUpMessageId: null,
      // A stream could still be running (programmatic clear) — drop its state so
      // the UI doesn't stay "generating" and Cancel doesn't target a dead id.
      isGenerating: false,
      activeStreamId: null
    }),

  refreshProposals: async () => {
    try {
      const list = (await window.api.listWriteProposals()) as WriteProposalItem[]
      const pending = (Array.isArray(list) ? list : []).filter(
        (p) => p.status === 'pending' || !p.status
      )
      // Merge, never replace: a live stream proposal created between the IPC
      // request and this response must not be clobbered by the disk snapshot.
      set((state) => ({
        pendingProposals: mergeProposals(state.pendingProposals, pending).filter(
          (p) => p.status === 'pending' || !p.status
        )
      }))
    } catch {
      /* keep current dock on failure */
    }
  },

  applyProposal: async (id: string, content?: string) => {
    try {
      // P2-6: diff dialog may pass edited content to apply as-is
      const res = await window.api.applyWriteProposal(id, content)
      if (res.ok) {
        set((state) => ({
          pendingProposals: state.pendingProposals.map((p) =>
            p.id === id ? { ...p, status: 'applied' } : p
          ),
          messages: state.messages.map((m) => ({
            ...m,
            proposals: m.proposals?.map((p) => (p.id === id ? { ...p, status: 'applied' } : p))
          })),
          lastKernelStatus: res.path
            ? `Applied → reindexed · ${res.path.split(/[/\\]/).pop()}`
            : 'Applied + reindexed'
        }))
      } else {
        set({ lastKernelStatus: res.error || 'Apply failed' })
      }
      return res
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      set({ lastKernelStatus: error })
      return { ok: false, error }
    }
  },

  rejectProposal: async (id: string) => {
    await window.api.rejectWriteProposal(id)
    set((state) => ({
      pendingProposals: state.pendingProposals.map((p) =>
        p.id === id ? { ...p, status: 'rejected' } : p
      ),
      messages: state.messages.map((m) => ({
        ...m,
        proposals: m.proposals?.map((p) => (p.id === id ? { ...p, status: 'rejected' } : p))
      })),
      lastKernelStatus: 'Proposal rejected'
    }))
  },

  promoteAnswer: async (msgId: string, suggestedTitle?: string) => {
    const msg = get().messages.find((m) => m.id === msgId)
    if (!msg) return { ok: false, error: 'Pesan tidak ditemukan' }
    try {
      const res = await window.api.promoteToKnowledge(
        msg.content,
        msg.citations || [],
        suggestedTitle
      )
      if (res.ok && res.proposal) {
        const p = res.proposal as WriteProposalItem
        set((state) => ({
          // Dock + message trail both learn about the new pending proposal
          pendingProposals: mergeProposals(state.pendingProposals, [p]).filter(
            (x) => x.status === 'pending' || !x.status
          ),
          messages: state.messages.map((m) =>
            m.id === msgId ? { ...m, proposals: mergeProposals(m.proposals, [p]) } : m
          ),
          lastKernelStatus: `Proposal Knowledge/${p.relativePath.split('/').pop()} dibuat — Apply di panel`
        }))
      } else {
        set({ lastKernelStatus: res.error || 'Promosi gagal' })
      }
      return res
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      set({ lastKernelStatus: error })
      return { ok: false, error }
    }
  },

  learnWorkspace: async (activeFilePath?: string) => {
    try {
      const mem = await window.api.ensureAiMemory()
      if (!mem.ok) {
        set({ lastKernelStatus: mem.error || 'AI Memory scaffold failed' })
        return { ok: false, error: mem.error || 'scaffold failed' }
      }
      set({
        enableTools: true,
        useContext: true,
        agentRole: 'curator',
        lastKernelStatus:
          mem.created.length > 0
            ? `AI Memory scaffold · ${mem.created.length} file baru`
            : 'AI Memory siap · bootstrap agent…'
      })
      // Structured bootstrap prompt — agent uses tools to fill memory + densify graph
      const prompt = `Mode: **PELAJARI WORKSPACE** (bootstrap memori).

Tugas:
1. list_dir root (+ folder penting).
2. Baca AI Memory/00 Index.md dan catatan AI Memory lain.
3. Isi/perbarui via write_note atau append_note (proposal):
   - AI Memory/Cara Kerja.md
   - AI Memory/Aturan.md
   - AI Memory/Pola & Naming.md
   - AI Memory/Glossary.md
   - AI Memory/00 Index.md (wikilink domain)
   - AI Memory/Log Ingest.md (append log hari ini)
4. Pakai [[wikilink]] agar graph memadat.
5. Jangan invent data. Akhiri ringkasan + daftar proposal.

Mulai: list_dir "" lalu read_note "AI Memory/00 Index.md".`
      await get().sendMessage(prompt, activeFilePath)
      return { ok: true, created: mem.created }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      set({ lastKernelStatus: error })
      return { ok: false, error }
    }
  },

  saveCurrentChat: async () => {
    const run = (async () => {
      const { messages, agentRole, conversationId } = get()
      if (messages.length === 0) return
      const id = conversationId || (await window.api.newChatId())
      // Tombstone check — never resurrect a chat the user deleted this session.
      if (deletedChatIds.has(id)) return
      const title = messages.find((m) => m.role === 'user')?.content.slice(0, 60) || 'Conversation'
      await window.api.saveChat({
        id,
        title,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        agentRole,
        messages: messages.map((m) => ({
          id: m.id,
          role: m.role,
          content: m.content,
          timestamp: m.timestamp,
          citations: m.citations,
          verifications: m.verifications,
          images: m.images,
          toolRuns: m.toolRuns,
          // P2-1: persist token stats so a restored session keeps its budget bar
          tokensUsed: m.tokensUsed,
          contextTokens: m.contextTokens,
          contextSavedTokens: m.contextSavedTokens,
          reasoning: m.reasoning,
          // P3-2: keep the follow-up source so Regenerate on a restored session
          // still re-arms the proposal context
          followUpFrom: m.followUpFrom,
          // P3-2: proposals must survive save/load — the Follow-up button and
          // the regenerate preamble both read them off the message
          proposals: m.proposals
        }))
      })
      set({ conversationId: id })
    })()
    lastSavePromise = run
    await run
  },

  loadChat: async (id: string) => {
    const conv = await window.api.loadChat(id)
    if (!conv) return
    const msgs = (conv.messages || []).map((m: ChatMessage) => ({ ...m }))
    set({
      conversationId: conv.id,
      followUpMessageId: null,
      messages: msgs,
      agentRole: (conv.agentRole as AgentRole) || get().agentRole,
      // P2-7: the loaded chat owns the dock — drop the previous session's
      // proposals, then re-derive below from this chat's messages + disk.
      pendingProposals: []
    })
    // P2-7: restore the proposal dock. Disk (P-B2) is the fresher truth for
    // what is still pending; proposals carried in the loaded chat's messages
    // fill in the rest so a restored session shows its own dock. Applied /
    // rejected statuses never re-enter (filtered below).
    await get().refreshProposals()
    const fromMessages = msgs.flatMap((m) => m.proposals || [])
    set((state) => ({
      pendingProposals: mergeProposals(fromMessages, state.pendingProposals).filter(
        (p) => p.status === 'pending' || !p.status
      )
    }))
  },

  deleteChat: async (id: string) => {
    try {
      // Wait for any in-flight save so the delete always lands last — a pending
      // saveCurrentChat (stream done) must not re-write the file after deletion.
      await lastSavePromise?.catch(() => undefined)
      const res = await window.api.deleteChat(id)
      if (res?.ok) {
        // Tombstone so a saveCurrentChat that fires AFTER the delete cannot
        // write the file back under the same id.
        deletedChatIds.add(id)
        if (get().conversationId === id) {
          set({ conversationId: null, activeStreamId: null })
        }
      }
      return { ok: Boolean(res?.ok), error: res?.error }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      return { ok: false, error }
    }
  },

  retryLastMessage: async (activeFilePath?: string) => {
    if (get().isGenerating) return
    const lastUser = [...get().messages].reverse().find((m) => m.role === 'user')
    if (!lastUser || !lastUser.content.trim()) return
    // Drop the failed assistant reply so the retry starts from the same prompt.
    // Use lastIndexOf — duplicate ids (loaded history) must truncate at the LAST
    // occurrence, not the first.
    const msgs = get().messages
    const idx = msgs.map((m) => m.id).lastIndexOf(lastUser.id)
    if (idx >= 0) {
      // P3-2: the retried user message may have been a follow-up (its prompt
      // was seeded from an earlier assistant message's proposals, flag consumed
      // on send). Re-arm so the regenerated answer keeps that context.
      set({
        messages: msgs.slice(0, idx + 1),
        followUpMessageId: lastUser.followUpFrom ?? null
      })
    }
    // P-A2: re-send with the original images — a retry must not drop attachments
    await get().sendMessage(lastUser.content, activeFilePath, lastUser.images)
  },

  rephraseMessage: async (msgId: string, activeFilePath?: string) => {
    if (get().isGenerating) return
    const msgs = get().messages
    const idx = msgs.findIndex((m) => m.id === msgId && m.role === 'assistant')
    if (idx < 0) return
    // Cap the quoted original so rephrasing a huge answer can't blow the token
    // budget (a long multi-tool answer would otherwise be re-billed in full).
    const raw = (msgs[idx].content || '').trim()
    if (!raw) return
    const MAX_QUOTE = 8000
    const content = raw.length > MAX_QUOTE ? `${raw.slice(0, MAX_QUOTE)}\n…[terpotong]` : raw
    // Truncate everything from the target assistant message onward — the rewrite
    // replaces the original answer in place (messages before it stay intact).
    set({ messages: msgs.slice(0, idx), followUpMessageId: null })
    const prompt = [
      'Tulis ulang jawaban berikut dengan gaya berbeda (lebih ringkas, lebih detail, atau nada lain) tanpa mengubah fakta atau isi:',
      '',
      '> ' + content.replace(/\n/g, '\n> '),
      '',
      'Balas hanya dengan hasil tulis ulangnya.'
    ].join('\n')
    await get().sendMessage(prompt, activeFilePath)
  }
}))
