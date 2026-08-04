import { create } from 'zustand'

export interface CitationItem {
  title: string
  path: string
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

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp: string
  citations?: CitationItem[]
  proposals?: WriteProposalItem[]
  toolStatus?: string
  /** Total tokens used by this completion (provider-reported, streaming). */
  tokensUsed?: number
  /** Estimated tokens injected as workspace context for this reply. */
  contextTokens?: number
}

export interface ProviderItem {
  id: string
  name: string
  connected: boolean
  configured?: boolean
  defaultModel?: string
  error?: string
  models: { id: string; name: string }[]
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
  pendingProposals: WriteProposalItem[]
  conversationId: string | null
  activeStreamId: string | null
  lastToolStatus: string

  fetchProviders: () => Promise<void>
  setActiveProvider: (providerId: string) => Promise<void>
  setSelectedModel: (modelId: string) => void
  setAgentRole: (role: AgentRole) => void
  setUseContext: (use: boolean) => void
  setEnableTools: (use: boolean) => void
  sendMessage: (text: string, activeFilePath?: string) => Promise<void>
  cancelStream: () => Promise<void>
  clearHistory: () => void
  applyProposal: (id: string) => Promise<{ ok: boolean; error?: string; path?: string }>
  rejectProposal: (id: string) => Promise<void>
  saveCurrentChat: () => Promise<void>
  loadChat: (id: string) => Promise<void>
  /** Delete a saved conversation file (keeps current session untouched unless same id). */
  deleteChat: (id: string) => Promise<{ ok: boolean; error?: string }>
  /** Re-send the last user message after an error (retry). */
  retryLastMessage: (activeFilePath?: string) => Promise<void>
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
  selectedModelId: 'grok-4.5',
  agentRole: 'general',
  isGenerating: false,
  useContext: true,
  enableTools: true,
  pendingProposals: [],
  conversationId: null,
  activeStreamId: null,
  lastToolStatus: '',
  lastKernelStatus: '',

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
        if (!ok) {
          selectedModelId = found.defaultModel || found.models[0].id
        }
      }
      set({ providers, activeProviderId, selectedModelId })
    } catch (err) {
      console.error('Failed to fetch AI providers:', err)
    }
  },

  setActiveProvider: async (providerId: string) => {
    await window.api.setActiveAIProvider(providerId)
    const { providers } = get()
    const found = providers.find((p) => p.id === providerId)
    const firstModel = found?.defaultModel || found?.models[0]?.id || ''
    set({ activeProviderId: providerId, selectedModelId: firstModel })
  },

  setSelectedModel: (modelId: string) => set({ selectedModelId: modelId }),
  setAgentRole: (role: AgentRole) => set({ agentRole: role }),
  setUseContext: (use: boolean) => set({ useContext: use }),
  setEnableTools: (use: boolean) => set({ enableTools: use }),

  ensureConversationId: async () => {
    let id = get().conversationId
    if (!id) {
      id = await window.api.newChatId()
      set({ conversationId: id })
    }
    return id
  },

  sendMessage: async (text: string, activeFilePath?: string) => {
    if (!text.trim()) return

    await get().ensureConversationId()

    const userMsg: ChatMessage = {
      id: Math.random().toString(36).slice(2),
      role: 'user',
      content: text,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    }

    const assistantMsgId = Math.random().toString(36).slice(2)
    const assistantMsg: ChatMessage = {
      id: assistantMsgId,
      role: 'assistant',
      content: '',
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      citations: [],
      proposals: []
    }

    const prior = get().messages
    set({
      messages: [...prior, userMsg, assistantMsg],
      isGenerating: true,
      lastToolStatus: ''
    })

    const { selectedModelId, activeProviderId, useContext, agentRole, enableTools } = get()
    const historyForApi = buildHistoryWindow(prior, {
      role: 'user',
      content: text
    })

    const requestPayload = {
      model: selectedModelId,
      messages: historyForApi
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
                return {
                  ...m,
                  content,
                  citations: chunk.citations || m.citations,
                  proposals: mergeProposals(m.proposals, chunk.proposals as WriteProposalItem[]),
                  toolStatus: chunk.toolStatus || m.toolStatus,
                  // Tool loops are separate completions — accumulate so the shown
                  // count is the total, not just the last round.
                  tokensUsed:
                    chunk.tokensUsed !== undefined && m.tokensUsed !== undefined
                      ? m.tokensUsed + chunk.tokensUsed
                      : chunk.tokensUsed ?? m.tokensUsed,
                  contextTokens: chunk.contextTokens ?? m.contextTokens
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
        enableTools
      )
      set({ activeStreamId: streamId })
    } catch (err) {
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
      set({ isGenerating: false, activeStreamId: null, lastToolStatus: 'Cancelled' })
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
      // A stream could still be running (programmatic clear) — drop its state so
      // the UI doesn't stay "generating" and Cancel doesn't target a dead id.
      isGenerating: false,
      activeStreamId: null
    }),

  applyProposal: async (id: string) => {
    try {
      const res = await window.api.applyWriteProposal(id)
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
          citations: m.citations
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
    set({
      conversationId: conv.id,
      messages: (conv.messages || []).map((m: ChatMessage) => ({
        ...m,
        proposals: []
      })),
      agentRole: (conv.agentRole as AgentRole) || get().agentRole
    })
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
    if (idx >= 0) set({ messages: msgs.slice(0, idx + 1) })
    await get().sendMessage(lastUser.content, activeFilePath)
  }
}))
