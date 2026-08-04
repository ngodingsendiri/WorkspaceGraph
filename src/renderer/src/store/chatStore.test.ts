import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useChatStore } from './chatStore'

/** Minimal window.api surface used by chatStore actions. */
function mockWindowApi() {
  const api = {
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
    ensureAiMemory: vi.fn().mockResolvedValue({ ok: true, created: [] }),
    listAiMemory: vi.fn().mockResolvedValue({ files: [], core: [] })
  }
  ;(globalThis as unknown as { window: unknown }).window = { api }
  return api
}

function msg(id: string, role: 'user' | 'assistant', content: string) {
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
    lastKernelStatus: ''
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
    expect(sendSpy).toHaveBeenCalledWith('kedua', undefined)
    sendSpy.mockRestore()
  })
})
