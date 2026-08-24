import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useEditorStore } from './editorStore'
import { useWorkspaceStore } from './workspaceStore'

/** Minimal window.api surface used by editorStore actions. */
function mockWindowApi(): Record<string, ReturnType<typeof vi.fn>> {
  const api: Record<string, ReturnType<typeof vi.fn>> = {
    readFile: vi.fn(),
    writeFile: vi.fn(),
    getBacklinks: vi.fn().mockResolvedValue({ nodes: [] }),
    getOutgoingLinks: vi.fn().mockResolvedValue({ nodes: [] }),
    renderMarkdown: vi.fn().mockResolvedValue('<p></p>')
  }
  ;(globalThis as unknown as { window: unknown }).window = { api }
  return api
}

describe('editorStore — save feedback (M1.1 / UI-4)', () => {
  let api: Record<string, ReturnType<typeof vi.fn>>

  beforeEach(() => {
    api = mockWindowApi()
    useEditorStore.setState({
      tabs: [],
      activeTabId: null,
      backlinks: [],
      outgoing: [],
      mergeDialog: null
    })
    vi.restoreAllMocks()
  })

  const mockReadFile = (title: string, content: string): void => {
    api.readFile.mockResolvedValue({
      title,
      filePath: `/vault/${title}.md`,
      id: title,
      content,
      rawContent: content
    })
  }

  it('menandai saveState=error saat writeFile gagal dan tetap dirty', async () => {
    mockReadFile('a', '# A')
    await useEditorStore.getState().openTab('/vault/a.md')

    api.writeFile.mockRejectedValue(new Error('disk full'))

    // simulate typing so save is attempted
    const tab = useEditorStore.getState().tabs[0]
    useEditorStore.getState().updateContent(tab.id, '# A edited')
    await useEditorStore.getState().saveTab(tab.id)

    const after = useEditorStore.getState().tabs[0]
    expect(after.saveState).toBe('error')
    expect(after.isDirty).toBe(true)
  })

  it('mengembalikan saveState=idle setelah save sukses', async () => {
    mockReadFile('b', '# B')
    await useEditorStore.getState().openTab('/vault/b.md')

    api.writeFile.mockResolvedValue({})
    const tab = useEditorStore.getState().tabs[0]
    useEditorStore.getState().updateContent(tab.id, '# B v2')
    await useEditorStore.getState().saveTab(tab.id)

    const after = useEditorStore.getState().tabs[0]
    expect(after.saveState).toBe('idle')
    expect(after.isDirty).toBe(false)
  })

  it('saveTab tidak menghitung tab bersih tanpa timer', async () => {
    mockReadFile('c', '# C')
    await useEditorStore.getState().openTab('/vault/c.md')
    const tab = useEditorStore.getState().tabs[0]
    // clean tab → saveTab harus no-op (writeFile tidak dipanggil)
    await useEditorStore.getState().saveTab(tab.id)
    expect(api.writeFile).not.toHaveBeenCalled()
  })
})

// Ensure workspaceStore is importable in this test env
void useWorkspaceStore
