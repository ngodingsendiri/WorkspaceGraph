import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useChatStore } from './chatStore'

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
    // P-A2: retry re-sends the original images (third arg) even when none attached
    expect(sendSpy).toHaveBeenCalledWith('kedua', undefined, undefined)
    sendSpy.mockRestore()
  })
})
