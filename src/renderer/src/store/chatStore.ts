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
  applyProposal: (id: string) => Promise<{ ok: boolean; error?: string }>
  rejectProposal: (id: string) => Promise<void>
  saveCurrentChat: () => Promise<void>
  loadChat: (id: string) => Promise<void>
  ensureConversationId: () => Promise<string>
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
    const historyForApi = [...prior, userMsg]
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .filter((m) => m.content.trim().length > 0)
      .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }))

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
                  toolStatus: chunk.toolStatus || m.toolStatus
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
    }
  },

  clearHistory: () =>
    set({
      messages: [],
      pendingProposals: [],
      conversationId: null,
      lastToolStatus: ''
    }),

  applyProposal: async (id: string) => {
    const res = await window.api.applyWriteProposal(id)
    if (res.ok) {
      set((state) => ({
        pendingProposals: state.pendingProposals.map((p) =>
          p.id === id ? { ...p, status: 'applied' } : p
        ),
        messages: state.messages.map((m) => ({
          ...m,
          proposals: m.proposals?.map((p) => (p.id === id ? { ...p, status: 'applied' } : p))
        }))
      }))
    }
    return res
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
      }))
    }))
  },

  saveCurrentChat: async () => {
    const { messages, agentRole, conversationId } = get()
    if (messages.length === 0) return
    const id = conversationId || (await window.api.newChatId())
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
  }
}))
