import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useChatStore, ToolRun, WriteProposalItem } from './chatStore'

/** Minimal window.api surface used by chatStore actions. */
type MockFn = ReturnType<typeof vi.fn>
function mockWindowApi(): Record<string, MockFn> {
  const api: Record<string, MockFn> = {
    getAIProviders: vi.fn().mockResolvedValue([]),
    getSettings: vi.fn().mockResolvedValue({}),
    setActiveAIProvider: vi.fn().mockResolvedValue(true),
    newChatId: vi.fn().mockResolvedValue('20260804_120000_abcd'),
    streamAIMessage: vi.fn(),
    saveChat: vi.fn().mockResolvedValue({ ok: true }),
    loadChat: vi.fn().mockResolvedValue(null),
    deleteChat: vi.fn().mockResolvedValue({ ok: true }),
    cancelAIStream: vi.fn().mockResolvedValue(true),
    applyWriteProposal: vi.fn().mockResolvedValue({ ok: true }),
    rejectWriteProposal: vi.fn().mockResolvedValue({ ok: true }),
    listWriteProposals: vi.fn().mockResolvedValue([]),
    ensureAiMemory: vi.fn().mockResolvedValue({ ok: true, created: [] }),
    listAiMemory: vi.fn().mockResolvedValue({ files: [], core: [] })
  }
  ;(globalThis as unknown as { window: unknown }).window = { api }
  return api
}

function msg(
  id: string,
  role: 'user' | 'assistant',
  content: string
): { id: string; role: 'user' | 'assistant'; content: string; timestamp: string } {
  return { id, role, content, timestamp: '12:00' }
}

beforeEach(() => {
  useChatStore.setState({
    messages: [],
    conversationId: null,
    isGenerating: false,
    activeStreamId: null,
    pendingProposals: [],
    lastToolStatus: '',
    lastKernelStatus: '',
    // P1-3: store default is now 'auto' — reset so tests never leak a pick
    selectedModelId: 'auto',
    // P3-1: follow-up mode must not leak between tests
    followUpMessageId: null
  })
})

describe('chatStore delete/save race', () => {
  it('deleteChat waits for an in-flight save (no same-id resurrection)', async () => {
    const api = mockWindowApi()
    let resolveSave: (v: unknown) => void = () => {}
    api.saveChat.mockImplementation(() => new Promise((r) => (resolveSave = r)))
    useChatStore.setState({
      conversationId: 'conv1',
      messages: [msg('u1', 'user', 'halo')]
    })
    const saveP = useChatStore.getState().saveCurrentChat()
    const delP = useChatStore.getState().deleteChat('conv1')
    await Promise.resolve()
    // Delete must block until the pending save settles.
    expect(api.deleteChat).not.toHaveBeenCalled()
    resolveSave({ ok: true })
    await saveP
    await delP
    expect(api.saveChat).toHaveBeenCalledTimes(1)
    expect(api.deleteChat).toHaveBeenCalledTimes(1)
    // Delete landed after the write — the file was removed after saving, so the
    // deleted chat cannot be resurrected by the in-flight save.
    const saveOrder = api.saveChat.mock.invocationCallOrder[0]
    const delOrder = api.deleteChat.mock.invocationCallOrder[0]
    expect(delOrder).toBeGreaterThan(saveOrder)
  })

  it('tombstone blocks a save under a deleted id (stale stream-done closure)', async () => {
    const api = mockWindowApi()
    useChatStore.setState({
      conversationId: 'conv1',
      messages: [msg('u1', 'user', 'halo')]
    })
    await useChatStore.getState().deleteChat('conv1')
    // A stale handler still holds the old conversationId — re-set it to simulate
    // the closure, then the save must no-op (file was deleted).
    useChatStore.setState({ conversationId: 'conv1' })
    await useChatStore.getState().saveCurrentChat()
    expect(api.saveChat).not.toHaveBeenCalled()
  })

  it('still saves chats that were never deleted', async () => {
    const api = mockWindowApi()
    useChatStore.setState({
      conversationId: 'conv2',
      messages: [msg('u1', 'user', 'halo')]
    })
    await useChatStore.getState().saveCurrentChat()
    expect(api.saveChat).toHaveBeenCalledTimes(1)
  })
})

describe('chatStore refreshProposals (P-B2 restart hydration)', () => {
  it('hydrates pendingProposals from persisted disk proposals', async () => {
    const api = mockWindowApi()
    api.listWriteProposals.mockResolvedValue([
      {
        id: 'p1',
        tool: 'create_note',
        absolutePath: 'C:/v/Knowledge/A.md',
        relativePath: 'Knowledge/A.md',
        content: '# A',
        mode: 'create',
        preview: '# A',
        status: 'pending',
        createdAt: '2026-08-06T00:00:00.000Z'
      },
      // Applied proposals from disk must NOT re-enter the dock
      {
        id: 'p2',
        tool: 'write_note',
        absolutePath: 'C:/v/Knowledge/B.md',
        relativePath: 'Knowledge/B.md',
        content: '# B',
        mode: 'overwrite',
        preview: '# B',
        status: 'applied',
        createdAt: '2026-08-06T00:00:00.000Z'
      }
    ])
    await useChatStore.getState().refreshProposals()
    const pending = useChatStore.getState().pendingProposals
    expect(pending).toHaveLength(1)
    expect(pending[0].id).toBe('p1')
  })

  it('keeps the dock unchanged when the IPC call fails', async () => {
    const api = mockWindowApi()
    api.listWriteProposals.mockRejectedValue(new Error('no vault'))
    useChatStore.setState({
      pendingProposals: [
        {
          id: 'live',
          tool: 'create_note',
          absolutePath: '',
          relativePath: 'Knowledge/Live.md',
          content: '',
          mode: 'create',
          preview: 'live',
          status: 'pending',
          createdAt: ''
        }
      ]
    })
    await useChatStore.getState().refreshProposals()
    expect(useChatStore.getState().pendingProposals.map((p) => p.id)).toEqual(['live'])
  })
})

describe('chatStore vision (P-A2)', () => {
  it('sendMessage with images: user message carries them + payload includes images', async () => {
    const api = mockWindowApi()
    api.streamAIMessage.mockImplementation(
      (_payload: unknown, cb: (c: Record<string, unknown>) => void) => {
        cb({ content: '', done: true })
        return 'stream-1'
      }
    )
    const img = { mimeType: 'image/png', dataBase64: 'aGVsbG8=', name: 'x.png' }

    await useChatStore.getState().sendMessage('Apa isi gambar ini?', undefined, [img])

    const s = useChatStore.getState()
    // The user message in the UI carries the image for the thumbnail
    const userMsg = s.messages.find((m) => m.role === 'user')
    expect(userMsg?.images).toEqual([img])
    // The IPC payload sends images only for the current prompt (no history re-send)
    expect(api.streamAIMessage).toHaveBeenCalledTimes(1)
    const payload = api.streamAIMessage.mock.calls[0][0]
    expect(payload.images).toEqual([img])
    expect(payload.messages).toEqual([{ role: 'user', content: 'Apa isi gambar ini?' }])
  })

  it('sendMessage without images: payload has no images field', async () => {
    const api = mockWindowApi()
    api.streamAIMessage.mockImplementation(
      (_payload: unknown, cb: (c: Record<string, unknown>) => void) => {
        cb({ content: '', done: true })
        return 'stream-1'
      }
    )

    await useChatStore.getState().sendMessage('halo')

    const payload = api.streamAIMessage.mock.calls[0][0]
    expect(payload.images).toBeUndefined()
    expect(useChatStore.getState().messages.find((m) => m.role === 'user')?.images).toBeUndefined()
  })
})

describe('chatStore reasoning streaming (P2-4)', () => {
  it('accumulates reasoning deltas into the assistant message, separate from content', async () => {
    const api = mockWindowApi()
    api.streamAIMessage.mockImplementation(
      (_payload: unknown, cb: (c: Record<string, unknown>) => void) => {
        cb({ content: '', done: false, reasoning: 'Langkah 1 ' })
        cb({ content: '', done: false, reasoning: 'Langkah 2' })
        cb({ content: 'Jawaban', done: true })
        return 'stream-1'
      }
    )

    await useChatStore.getState().sendMessage('berpikir')

    const asst = useChatStore.getState().messages.find((m) => m.role === 'assistant')
    expect(asst?.reasoning).toBe('Langkah 1 Langkah 2')
    // Reasoning is NOT part of the answer text
    expect(asst?.content).toBe('Jawaban')
  })

  it('saveCurrentChat persists reasoning so a restored chat keeps its thinking block', async () => {
    const api = mockWindowApi()
    useChatStore.setState({
      conversationId: 'conv-reason',
      messages: [
        msg('u1', 'user', 'berpikir'),
        { ...msg('a1', 'assistant', 'Jawaban'), reasoning: 'Pertimbangan A dan B' }
      ]
    })

    await useChatStore.getState().saveCurrentChat()

    const payload = api.saveChat.mock.calls[0][0]
    const saved = (payload.messages as Record<string, unknown>[]).find((m) => m.id === 'a1')
    expect(saved?.reasoning).toBe('Pertimbangan A dan B')
  })
})

describe('chatStore rephrase (P-C1)', () => {
  it('rephraseMessage truncates at the target assistant message and re-sends a rewrite prompt', async () => {
    const api = mockWindowApi()
    api.streamAIMessage.mockImplementation(
      (_payload: unknown, cb: (c: Record<string, unknown>) => void) => {
        cb({ content: '', done: true })
        return 'stream-1'
      }
    )
    useChatStore.setState({
      messages: [
        msg('u1', 'user', 'Jelaskan graph'),
        { ...msg('a1', 'assistant', 'Jawaban lama'), id: 'a1' },
        msg('u2', 'user', 'Pertanyaan lanjutan')
      ]
    })

    await useChatStore.getState().rephraseMessage('a1')

    // Messages before the target stay; the target + everything after is gone
    const s = useChatStore.getState()
    const userMsgs = s.messages.filter((m) => m.role === 'user')
    expect(s.messages.find((m) => m.id === 'a1')).toBeUndefined()
    expect(userMsgs).toHaveLength(2) // original 'u1' + the rephrase prompt
    // The rephrase prompt quotes the original content
    const prompt = userMsgs[1].content
    expect(prompt).toContain('Tulis ulang jawaban berikut')
    expect(prompt).toContain('Jawaban lama')
    // Sent through the normal stream path
    const payload = api.streamAIMessage.mock.calls[0][0]
    expect(payload.messages[payload.messages.length - 1].content).toContain('Jawaban lama')
  })

  it('rephraseMessage no-ops on unknown id, empty content, or while generating', async () => {
    const api = mockWindowApi()
    api.streamAIMessage.mockImplementation(() => 'stream-1')
    useChatStore.setState({ messages: [msg('u1', 'user', 'halo')], isGenerating: true })

    await useChatStore.getState().rephraseMessage('nope')
    expect(api.streamAIMessage).not.toHaveBeenCalled()

    useChatStore.setState({ isGenerating: false })
    await useChatStore.getState().rephraseMessage('nope')
    expect(api.streamAIMessage).not.toHaveBeenCalled()
  })
})

describe('chatStore auto model (P1-3)', () => {
  const grokProvider = {
    id: 'grok',
    name: 'Grok',
    connected: true,
    configured: true,
    defaultModel: 'grok-4.5',
    models: [{ id: 'grok-4.5', name: 'Grok 4.5' }]
  }
  const ollamaProvider = {
    id: 'ollama',
    name: 'Ollama',
    connected: true,
    configured: true,
    models: [{ id: 'llama3', name: 'Llama 3' }]
  }

  it('sendMessage resolves auto to undefined so the middleware picks the provider default', async () => {
    const api = mockWindowApi()
    api.streamAIMessage.mockImplementation(
      (_payload: unknown, cb: (c: Record<string, unknown>) => void) => {
        cb({ content: '', done: true })
        return 'stream-1'
      }
    )
    useChatStore.setState({ selectedModelId: 'auto' })

    await useChatStore.getState().sendMessage('halo')

    const payload = api.streamAIMessage.mock.calls[0][0]
    expect(payload.model).toBeUndefined()
  })

  it('sendMessage passes a concrete model through untouched', async () => {
    const api = mockWindowApi()
    api.streamAIMessage.mockImplementation(
      (_payload: unknown, cb: (c: Record<string, unknown>) => void) => {
        cb({ content: '', done: true })
        return 'stream-1'
      }
    )
    useChatStore.setState({ selectedModelId: 'grok-4.5' })

    await useChatStore.getState().sendMessage('halo')

    expect(api.streamAIMessage.mock.calls[0][0].model).toBe('grok-4.5')
  })

  it('fetchProviders never clobbers an explicit auto choice', async () => {
    const api = mockWindowApi()
    api.getAIProviders.mockResolvedValue([grokProvider])
    useChatStore.setState({ selectedModelId: 'auto' })

    await useChatStore.getState().fetchProviders()

    expect(useChatStore.getState().selectedModelId).toBe('auto')
  })

  it('setActiveProvider keeps auto when the current pick is auto', async () => {
    mockWindowApi()
    useChatStore.setState({ providers: [grokProvider, ollamaProvider], selectedModelId: 'auto' })

    await useChatStore.getState().setActiveProvider('ollama')

    expect(useChatStore.getState().activeProviderId).toBe('ollama')
    expect(useChatStore.getState().selectedModelId).toBe('auto')
  })

  it('setActiveProvider resolves a concrete pick to the new provider default', async () => {
    mockWindowApi()
    useChatStore.setState({
      providers: [grokProvider, ollamaProvider],
      selectedModelId: 'grok-4.5'
    })

    await useChatStore.getState().setActiveProvider('ollama')

    expect(useChatStore.getState().selectedModelId).toBe('llama3')
  })
})

describe('chatStore per-tool trail (P1-1)', () => {
  const run = (id: string, status: ToolRun['status'], tool = 'list_dir'): ToolRun => ({
    runId: id,
    tool,
    status,
    round: 0
  })

  it('accumulates toolRun events: new runs append, same runId updates in place', async () => {
    const api = mockWindowApi()
    api.streamAIMessage.mockImplementation(
      (_payload: unknown, cb: (c: Record<string, unknown>) => void) => {
        cb({ content: '', done: false, toolRun: run('tr1', 'running') })
        cb({ content: '', done: false, toolRun: run('tr2', 'running', 'read_note') })
        cb({ content: '', done: false, toolRun: { ...run('tr1', 'ok'), detail: '3 items' } })
        cb({ content: '', done: true, toolRun: { ...run('tr2', 'ok'), detail: 'note body' } })
        return 'stream-1'
      }
    )

    await useChatStore.getState().sendMessage('jalankan tools')

    const asst = useChatStore.getState().messages.find((m) => m.role === 'assistant')
    expect(asst?.toolRuns).toHaveLength(2)
    // tr1 was updated in place — no duplicate entry, ok status + detail landed
    const t1 = asst?.toolRuns?.find((r) => r.runId === 'tr1')
    expect(t1?.status).toBe('ok')
    expect(t1?.detail).toBe('3 items')
    const t2 = asst?.toolRuns?.find((r) => r.runId === 'tr2')
    expect(t2?.status).toBe('ok')
    expect(t2?.detail).toBe('note body')
  })

  it('done chunk closes out runs still stuck on running (abort/timeout)', async () => {
    const api = mockWindowApi()
    api.streamAIMessage.mockImplementation(
      (_payload: unknown, cb: (c: Record<string, unknown>) => void) => {
        cb({ content: '', done: false, toolRun: run('tr1', 'running') })
        cb({ content: '', done: true })
        return 'stream-1'
      }
    )

    await useChatStore.getState().sendMessage('jalan')

    const asst = useChatStore.getState().messages.find((m) => m.role === 'assistant')
    const t1 = asst?.toolRuns?.find((r) => r.runId === 'tr1')
    expect(t1?.status).toBe('error')
    expect(t1?.detail).toBe('interrupted')
  })

  it('cancelStream marks the in-flight running run as interrupted', async () => {
    const api = mockWindowApi()
    api.streamAIMessage.mockImplementation(() => 'stream-1')
    api.cancelAIStream.mockResolvedValue(true)
    useChatStore.setState({
      activeStreamId: 'stream-1',
      isGenerating: true,
      messages: [
        msg('u1', 'user', 'jalan'),
        { ...msg('a1', 'assistant', ''), toolRuns: [run('tr1', 'running')] }
      ]
    })

    await useChatStore.getState().cancelStream()

    const asst = useChatStore.getState().messages.find((m) => m.id === 'a1')
    expect(asst?.toolRuns?.[0].status).toBe('error')
    expect(asst?.toolRuns?.[0].detail).toBe('interrupted')
  })

  it('saveCurrentChat persists token stats (P2-1)', async () => {
    const api = mockWindowApi()
    useChatStore.setState({
      conversationId: 'conv-p21',
      messages: [
        msg('u1', 'user', 'jalan'),
        { ...msg('a1', 'assistant', 'selesai'), tokensUsed: 450, contextTokens: 1200 }
      ]
    })

    await useChatStore.getState().saveCurrentChat()

    const payload = api.saveChat.mock.calls[0][0]
    const saved = (payload.messages as Record<string, unknown>[]).find((m) => m.id === 'a1')
    expect(saved?.tokensUsed).toBe(450)
    expect(saved?.contextTokens).toBe(1200)
  })

  it('saveCurrentChat persists the tool trail', async () => {
    const api = mockWindowApi()
    // Unique id — `deletedChatIds` is module-scoped and earlier tests tombstone 'conv1'
    useChatStore.setState({
      conversationId: 'conv-p11',
      messages: [
        msg('u1', 'user', 'jalan'),
        { ...msg('a1', 'assistant', 'selesai'), toolRuns: [run('tr1', 'ok')] }
      ]
    })

    await useChatStore.getState().saveCurrentChat()

    const payload = api.saveChat.mock.calls[0][0]
    const saved = (payload.messages as Record<string, unknown>[]).find((m) => m.id === 'a1')
    expect(saved?.toolRuns).toEqual([run('tr1', 'ok')])
  })
})

describe('chatStore clearHistory', () => {
  it('resets generating state and active stream id', () => {
    mockWindowApi()
    useChatStore.setState({
      messages: [msg('u1', 'user', 'a')],
      isGenerating: true,
      activeStreamId: 'stream-1'
    })
    useChatStore.getState().clearHistory()
    const s = useChatStore.getState()
    expect(s.messages).toHaveLength(0)
    expect(s.isGenerating).toBe(false)
    expect(s.activeStreamId).toBeNull()
  })
})

describe('chatStore follow-up mode (P3-1)', () => {
  const proposal = {
    id: 'p1',
    tool: 'write_note',
    absolutePath: 'C:/v/Knowledge/A.md',
    relativePath: 'Knowledge/A.md',
    content: '# Konten baru',
    mode: 'overwrite',
    preview: '# Konten baru',
    status: 'pending',
    createdAt: '2026-08-06T00:00:00.000Z'
  }
  const mockStream = (api: Record<string, ReturnType<typeof vi.fn>>): void => {
    api.streamAIMessage.mockImplementation(
      (_payload: unknown, cb: (c: Record<string, unknown>) => void) => {
        cb({ content: '', done: true })
        return 'stream-1'
      }
    )
  }

  it('sendMessage prepends the proposal preamble to the API prompt and consumes the flag', async () => {
    const api = mockWindowApi()
    mockStream(api)
    useChatStore.setState({
      messages: [
        msg('u1', 'user', 'susun proposal'),
        { ...msg('a1', 'assistant', 'Saya usulkan perubahan'), proposals: [proposal] }
      ]
    })
    useChatStore.getState().setFollowUp('a1')
    expect(useChatStore.getState().followUpMessageId).toBe('a1')

    await useChatStore.getState().sendMessage('terapkan saja')

    // Consumed — a second send without re-arming is a plain question again
    expect(useChatStore.getState().followUpMessageId).toBeNull()
    const payload = api.streamAIMessage.mock.calls[0][0]
    const last = payload.messages[payload.messages.length - 1]
    expect(last.content).toContain('Konteks follow-up')
    expect(last.content).toContain('Knowledge/A.md')
    expect(last.content).toContain('terapkan saja')
    // Transcript stays clean — no preamble leaks into the visible user message
    const userMsg = useChatStore
      .getState()
      .messages.find((m) => m.role === 'user' && m.content === 'terapkan saja')
    expect(userMsg?.content).toBe('terapkan saja')
  })

  it('missing source message degrades to a plain send and still clears the flag', async () => {
    const api = mockWindowApi()
    mockStream(api)
    useChatStore.getState().setFollowUp('ghost')

    await useChatStore.getState().sendMessage('halo')

    const payload = api.streamAIMessage.mock.calls[0][0]
    expect(payload.messages[payload.messages.length - 1].content).toBe('halo')
    expect(useChatStore.getState().followUpMessageId).toBeNull()
  })

  it('clearHistory resets the armed follow-up', () => {
    mockWindowApi()
    useChatStore.getState().setFollowUp('a1')
    useChatStore.getState().clearHistory()
    expect(useChatStore.getState().followUpMessageId).toBeNull()
  })

  it('sendMessage stamps followUpFrom on the user message (P3-2 regenerate source)', async () => {
    const api = mockWindowApi()
    mockStream(api)
    useChatStore.setState({
      messages: [
        msg('u1', 'user', 'susun proposal'),
        { ...msg('a1', 'assistant', 'Saya usulkan perubahan'), proposals: [proposal] }
      ]
    })
    useChatStore.getState().setFollowUp('a1')

    await useChatStore.getState().sendMessage('lanjutkan')

    const userMsg = useChatStore
      .getState()
      .messages.find((m) => m.role === 'user' && m.content === 'lanjutkan')
    expect(userMsg?.followUpFrom).toBe('a1')
  })

  it('retryLastMessage re-arms the proposal context for a follow-up message (P3-2)', async () => {
    const api = mockWindowApi()
    mockStream(api)
    useChatStore.setState({
      messages: [
        msg('u1', 'user', 'susun proposal'),
        { ...msg('a1', 'assistant', 'Saya usulkan perubahan'), proposals: [proposal] }
      ]
    })
    // First send as a follow-up — the flag is consumed, the preamble injected
    useChatStore.getState().setFollowUp('a1')
    await useChatStore.getState().sendMessage('lanjutkan')
    expect(useChatStore.getState().followUpMessageId).toBeNull()

    // Regenerate the reply — must NOT lose the proposal context
    await useChatStore.getState().retryLastMessage()

    const payload = api.streamAIMessage.mock.calls[1][0]
    const last = payload.messages[payload.messages.length - 1]
    expect(last.content).toContain('Konteks follow-up')
    expect(last.content).toContain('Knowledge/A.md')
    expect(last.content).toContain('lanjutkan')
  })

  it('saveCurrentChat persists followUpFrom (P3-2 loaded-chat regenerate)', async () => {
    const api = mockWindowApi()
    useChatStore.setState({
      conversationId: 'conv-p32',
      messages: [
        msg('u1', 'user', 'susun proposal'),
        { ...msg('a1', 'assistant', 'jawaban'), proposals: [proposal] },
        { ...msg('u2', 'user', 'lanjutkan'), followUpFrom: 'a1' }
      ]
    })

    await useChatStore.getState().saveCurrentChat()

    const payload = api.saveChat.mock.calls[0][0]
    const saved = (payload.messages as Record<string, unknown>[]).find((m) => m.id === 'u2')
    expect(saved?.followUpFrom).toBe('a1')
    // Proposals are persisted too — without them the Follow-up button and the
    // regenerate preamble are dead on a restored session
    const savedAsst = (payload.messages as Record<string, unknown>[]).find((m) => m.id === 'a1')
    expect((savedAsst?.proposals as unknown[]).length).toBe(1)
  })

  it('loadChat keeps proposals so restored sessions still follow-up and re-arm (P3-2)', async () => {
    const api = mockWindowApi()
    api.loadChat.mockResolvedValue({
      id: 'conv-loaded',
      agentRole: 'general',
      messages: [
        msg('u1', 'user', 'susun proposal'),
        { ...msg('a1', 'assistant', 'jawaban'), proposals: [proposal] },
        { ...msg('u2', 'user', 'lanjutkan'), followUpFrom: 'a1' }
      ]
    })

    await useChatStore.getState().loadChat('conv-loaded')

    const msgs = useChatStore.getState().messages
    expect((msgs.find((m) => m.id === 'a1')?.proposals || []).length).toBe(1)
    expect(msgs.find((m) => m.id === 'u2')?.followUpFrom).toBe('a1')
  })
})

describe('chatStore proposal dock sync (P2-7)', () => {
  const proposal = (id: string, status: string): WriteProposalItem => ({
    id,
    tool: 'write_note',
    absolutePath: `C:/v/Knowledge/${id}.md`,
    relativePath: `Knowledge/${id}.md`,
    content: '# Konten',
    mode: 'overwrite',
    preview: '# Konten',
    status,
    createdAt: '2026-08-06T00:00:00.000Z'
  })

  it('loadChat restores pending proposals from the loaded chat into the dock', async () => {
    const api = mockWindowApi()
    api.listWriteProposals.mockResolvedValue([]) // disk empty — messages are the source
    api.loadChat.mockResolvedValue({
      id: 'conv-restore',
      agentRole: 'general',
      messages: [
        msg('u1', 'user', 'susun proposal'),
        {
          ...msg('a1', 'assistant', 'jawaban'),
          proposals: [proposal('p-pending', 'pending'), proposal('p-applied', 'applied')]
        }
      ]
    })
    // The previous session's dock must NOT leak into the loaded chat
    useChatStore.setState({ pendingProposals: [proposal('old-dock', 'pending')] })

    await useChatStore.getState().loadChat('conv-restore')

    const ids = useChatStore.getState().pendingProposals.map((p) => p.id)
    expect(ids).toContain('p-pending')
    // Applied proposals never re-enter the dock; the old session's dock is gone
    expect(ids).not.toContain('p-applied')
    expect(ids).not.toContain('old-dock')
  })

  it('loadChat merges disk-pending proposals with message-carried ones (dedupe by id)', async () => {
    const api = mockWindowApi()
    api.listWriteProposals.mockResolvedValue([proposal('p-both', 'pending')])
    api.loadChat.mockResolvedValue({
      id: 'conv-restore2',
      agentRole: 'general',
      messages: [
        msg('u1', 'user', 'x'),
        {
          ...msg('a1', 'assistant', 'y'),
          // Same id on disk AND in the message → one dock entry; the message
          // also carries a proposal disk knows nothing about
          proposals: [proposal('p-both', 'pending'), proposal('p-msg', 'pending')]
        }
      ]
    })

    await useChatStore.getState().loadChat('conv-restore2')

    const ids = useChatStore
      .getState()
      .pendingProposals.map((p) => p.id)
      .sort()
    expect(ids).toEqual(['p-both', 'p-msg'])
  })
})

describe('chatStore retryLastMessage', () => {
  it('truncates at the LAST occurrence of a duplicate user id', async () => {
    mockWindowApi()
    useChatStore.setState({
      messages: [
        msg('u1', 'user', 'pertama'),
        msg('a1', 'assistant', 'jawaban 1'),
        msg('u1', 'user', 'kedua'),
        msg('a2', 'assistant', 'jawaban 2')
      ]
    })
    const sendSpy = vi
      .spyOn(useChatStore.getState(), 'sendMessage')
      .mockResolvedValue(undefined as never)
    await useChatStore.getState().retryLastMessage()
    const contents = useChatStore.getState().messages.map((m) => m.content)
    expect(contents).toEqual(['pertama', 'jawaban 1', 'kedua'])
    // P-A2: retry re-sends the original images (third arg) even when none attached
    expect(sendSpy).toHaveBeenCalledWith('kedua', undefined, undefined)
    sendSpy.mockRestore()
  })
})
