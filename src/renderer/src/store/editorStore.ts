import { create } from 'zustand'
import { useWorkspaceStore } from './workspaceStore'

export interface TabItem {
  id: string
  title: string
  path: string
  content: string
  isDirty: boolean
  html?: string
}

/**
 * live  = Obsidian Live Preview (default): always edit, syntax hidden until caret
 * source = raw markdown, all markers visible
 */
export type EditorSurfaceMode = 'live' | 'source'

export interface EditorStore {
  tabs: TabItem[]
  activeTabId: string | null
  surfaceMode: EditorSurfaceMode
  showInspector: boolean
  /** legacy alias: true when live */
  showPreview: boolean
  backlinks: { title: string; path: string }[]
  outgoing: { title: string; path: string }[]

  openTab: (filePath: string) => Promise<void>
  closeTab: (tabId: string) => void
  setActiveTab: (tabId: string) => void
  updateContent: (tabId: string, content: string) => void
  saveTab: (tabId: string) => Promise<void>
  /** Schedule debounced save for a tab (does not cancel other tabs) */
  scheduleSave: (tabId: string, delayMs?: number) => void
  /** Flush pending debounced save for one tab or all (skips clean tabs) */
  flushSave: (tabId?: string) => Promise<void>
  setSurfaceMode: (mode: EditorSurfaceMode) => void
  toggleSourceMode: () => void
  toggleInspector: () => void
  setShowInspector: (v: boolean) => void
  /** @deprecated use toggleSourceMode */
  togglePreview: () => void
  /** @deprecated no-op kept for old imports */
  enterEditMode: () => void
  /** @deprecated no-op kept for old imports */
  exitEditMode: () => Promise<void>
  getActiveTab: () => TabItem | undefined
  refreshLinks: (filePath: string) => Promise<void>
  refreshPreview: (tabId: string) => Promise<void>
}

async function renderHtml(content: string): Promise<string> {
  try {
    return await window.api.renderMarkdown(content)
  } catch {
    return ''
  }
}

/** Per-tab debounce — typing in tab B must not cancel pending save for tab A */
const saveTimers = new Map<string, ReturnType<typeof setTimeout>>()
/** Serialize concurrent saveTab for the same id (flush + debounce race) */
const saveInflight = new Map<string, Promise<void>>()

function clearSaveTimer(tabId: string): boolean {
  const t = saveTimers.get(tabId)
  if (t) {
    clearTimeout(t)
    saveTimers.delete(tabId)
    return true
  }
  return false
}

export const normPath = (p: string): string => p.replace(/\\/g, '/').toLowerCase()

/** Serialize openTab — rapid multi-open was racing and dropping tabs / crashing UI */
let openTabChain: Promise<void> = Promise.resolve()

/**
 * Close-tab may write in background after UI remove. Open of same path must wait
 * so we never read stale disk and never let an older close-write clobber a new edit.
 */
const pendingCloseWrites = new Map<string, Promise<void>>()

function goEditor(): void {
  try {
    useWorkspaceStore.getState().setActiveView('editor')
  } catch {
    /* store may not be ready in tests */
  }
}

function extractRaw(fileData: { rawContent?: string; content?: string }): string {
  let raw = ''
  if (typeof fileData.rawContent === 'string') raw = fileData.rawContent
  else if (typeof fileData.content === 'string') raw = fileData.content
  // Normalize Windows CRLF so CM line metrics / decorations stay stable
  return raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
}

async function awaitPendingCloseWrite(filePath: string): Promise<void> {
  const key = normPath(filePath)
  const p = pendingCloseWrites.get(key)
  if (p) {
    try {
      await p
    } catch {
      /* write error already logged */
    }
  }
}

export const useEditorStore = create<EditorStore>((set, get) => ({
  tabs: [],
  activeTabId: null,
  surfaceMode: 'live',
  showInspector: false,
  showPreview: true,
  backlinks: [],
  outgoing: [],

  openTab: async (filePath: string) => {
    const run = async (): Promise<void> => {
      if (!filePath || typeof filePath !== 'string') return
      const target = filePath

      // Finish any in-flight close-save for this path before read
      await awaitPendingCloseWrite(target)

      const existing = get().tabs.find((t) => normPath(t.path) === normPath(target))
      if (existing) {
        // Never await save on open — flush can block main via markdown:render (CRLF hang history)
        const prev = get().activeTabId
        if (prev && prev !== existing.id) void get().flushSave(prev)

        // Switch tab immediately so UI feels snappy; reload disk in background if clean
        set({ activeTabId: existing.id })
        goEditor()
        window.setTimeout(() => {
          void get().refreshLinks(
            get().tabs.find((t) => t.id === existing.id)?.path || existing.path
          )
        }, 0)

        if (!existing.isDirty) {
          void (async () => {
            try {
              await awaitPendingCloseWrite(target)
              const fileData = await window.api.readFile(target)
              // Tab may have been closed / dirtied while loading
              const cur = get().tabs.find((t) => t.id === existing.id)
              if (!cur || cur.isDirty) return
              const raw = extractRaw(fileData) || cur.content
              const nextTitle = fileData.title || cur.title
              const nextPath = fileData.filePath || cur.path
              // Skip set if nothing changed — avoids CodeMirror scroll jump / flicker
              if (
                cur.content === raw &&
                cur.title === nextTitle &&
                normPath(cur.path) === normPath(nextPath)
              ) {
                return
              }
              set({
                tabs: get().tabs.map((t) =>
                  t.id === existing.id
                    ? {
                        ...t,
                        content: raw,
                        title: nextTitle,
                        path: nextPath,
                        html: '',
                        isDirty: false
                      }
                    : t
                )
              })
            } catch (err) {
              console.error('openTab reload failed:', target, err)
            }
          })()
        }
        return
      }

      try {
        const fileData = await window.api.readFile(target)
        const raw = extractRaw(fileData)
        const newTab: TabItem = {
          id: fileData.id || target,
          title: fileData.title || target.split(/[/\\]/).pop() || 'Untitled',
          path: fileData.filePath || target,
          content: raw,
          html: typeof fileData.html === 'string' ? fileData.html : '',
          isDirty: false
        }

        // Re-check after await — another open may have added this path
        const again = get().tabs.find(
          (t) => t.id === newTab.id || normPath(t.path) === normPath(newTab.path)
        )
        if (again) {
          set({ activeTabId: again.id })
          goEditor()
          void get().refreshLinks(again.path)
          return
        }

        // Don't block open on flush — save previous in background
        const prev = get().activeTabId
        if (prev) void get().flushSave(prev)

        set((state) => ({
          tabs: [
            ...state.tabs.filter(
              (t) => t.id !== newTab.id && normPath(t.path) !== normPath(newTab.path)
            ),
            newTab
          ],
          activeTabId: newTab.id
        }))
        // Show editor immediately — never await heavy work on open
        goEditor()
        // Defer graph links so first paint isn't competing with CM init
        window.setTimeout(() => {
          void get().refreshLinks(newTab.path)
        }, 0)
      } catch (err) {
        console.error('Failed to read file into editor:', target, err)
      }
    }

    const next = openTabChain.then(run, run)
    openTabChain = next.then(
      () => undefined,
      () => undefined
    )
    await next
  },

  closeTab: (tabId: string) => {
    /**
     * Remove from UI immediately, then save snapshot in background.
     * Old flow awaited writeFile first — race: user reopens same path, then
     * close finished and deleted the newly opened tab (same id).
     */
    const tabToClose = get().tabs.find((t) => t.id === tabId)
    if (!tabToClose) return

    const hadTimer = clearSaveTimer(tabId)
    const snapshotPath = tabToClose.path
    const snapshotContent = tabToClose.content
    const shouldSave = tabToClose.isDirty || hadTimer

    const { tabs, activeTabId } = get()
    const newTabs = tabs.filter((t) => t.id !== tabId)
    let nextActiveId = activeTabId
    if (activeTabId === tabId) {
      nextActiveId = newTabs.length > 0 ? newTabs[newTabs.length - 1].id : null
    }
    set({
      tabs: newTabs,
      activeTabId: nextActiveId,
      ...(nextActiveId ? {} : { backlinks: [], outgoing: [] })
    })
    if (nextActiveId) {
      const next = newTabs.find((t) => t.id === nextActiveId)
      if (next) void get().refreshLinks(next.path)
    }

    if (shouldSave) {
      const key = normPath(snapshotPath)
      const writePromise = (async () => {
        try {
          // If user already reopened and typed, do not clobber newer dirty buffer
          const live = get().tabs.find((t) => normPath(t.path) === key)
          if (live?.isDirty && live.content !== snapshotContent) {
            return
          }
          await window.api.writeFile(snapshotPath, snapshotContent)
        } catch (err) {
          console.error('closeTab save failed:', snapshotPath, err)
        }
      })().finally(() => {
        if (pendingCloseWrites.get(key) === writePromise) {
          pendingCloseWrites.delete(key)
        }
      })
      pendingCloseWrites.set(key, writePromise)
    }
  },

  setActiveTab: (tabId: string) => {
    const prev = get().activeTabId
    if (prev && prev !== tabId) void get().flushSave(prev)
    set({ activeTabId: tabId })
    const tab = get().tabs.find((t) => t.id === tabId)
    if (tab) void get().refreshLinks(tab.path)
  },

  updateContent: (tabId: string, content: string) => {
    if (typeof content !== 'string') return
    const cur = get().tabs.find((t) => t.id === tabId)
    if (!cur) return
    // Skip no-op sets (same string + already dirty) — avoids extra React tree churn
    if (cur.content === content) {
      if (cur.isDirty) return
      set({
        tabs: get().tabs.map((t) => (t.id === tabId ? { ...t, isDirty: true } : t))
      })
      return
    }
    set({
      tabs: get().tabs.map((t) => (t.id === tabId ? { ...t, content, isDirty: true } : t))
    })
  },

  scheduleSave: (tabId: string, delayMs = 700) => {
    clearSaveTimer(tabId)
    const timer = setTimeout(() => {
      saveTimers.delete(tabId)
      void get().saveTab(tabId)
    }, delayMs)
    saveTimers.set(tabId, timer)
  },

  flushSave: async (tabId?: string) => {
    if (tabId) {
      const hadTimer = clearSaveTimer(tabId)
      const tab = get().tabs.find((t) => t.id === tabId)
      if (!tab) return
      if (!tab.isDirty && !hadTimer) return
      await get().saveTab(tabId)
      return
    }
    const timed = [...saveTimers.keys()]
    for (const id of timed) clearSaveTimer(id)
    const dirtyIds = new Set([
      ...timed,
      ...get()
        .tabs.filter((t) => t.isDirty)
        .map((t) => t.id)
    ])
    await Promise.all([...dirtyIds].map((id) => get().saveTab(id)))
  },

  saveTab: async (tabId: string) => {
    // Chain concurrent saves for same tab (Ctrl+S during debounced save)
    const prev = saveInflight.get(tabId) || Promise.resolve()
    const run = prev
      .catch(() => undefined)
      .then(async () => {
        const tab = get().tabs.find((t) => t.id === tabId)
        if (!tab) return
        const snapshot = tab.content
        if (typeof snapshot !== 'string') return
        // Already clean and no pending timer work
        if (!tab.isDirty && !saveTimers.has(tabId)) return
        try {
          await window.api.writeFile(tab.path, snapshot)
          // Live Preview does not use pre-rendered HTML — skip markdown:render on save
          set({
            tabs: get().tabs.map((t) => {
              if (t.id !== tabId) return t
              // Typed during await → keep dirty
              if (t.content !== snapshot) return { ...t }
              return { ...t, isDirty: false, html: t.html || '' }
            })
          })
          if (get().activeTabId === tabId) {
            void get().refreshLinks(tab.path)
          }
        } catch (err) {
          console.error('saveTab failed:', tab.path, err)
        }
      })
      .finally(() => {
        if (saveInflight.get(tabId) === run) saveInflight.delete(tabId)
      })
    saveInflight.set(tabId, run)
    await run
  },

  setSurfaceMode: (mode) => set({ surfaceMode: mode, showPreview: mode === 'live' }),

  toggleSourceMode: () => {
    const next = get().surfaceMode === 'live' ? 'source' : 'live'
    set({ surfaceMode: next, showPreview: next === 'live' })
  },

  toggleInspector: () => set((s) => ({ showInspector: !s.showInspector })),
  setShowInspector: (v) => set({ showInspector: v }),

  togglePreview: () => get().toggleSourceMode(),
  enterEditMode: () => {
    /* live preview is always editable */
  },
  exitEditMode: async () => {
    const id = get().activeTabId
    if (id) await get().flushSave(id)
  },

  getActiveTab: () => {
    const { tabs, activeTabId } = get()
    return tabs.find((t) => t.id === activeTabId)
  },

  refreshLinks: async (filePath: string) => {
    const req = filePath
    try {
      const [back, out] = await Promise.all([
        window.api.getBacklinks(filePath),
        window.api.getOutgoingLinks(filePath)
      ])
      // Drop stale responses if user switched notes during await
      const active = get().getActiveTab()
      if (!active || normPath(active.path) !== normPath(req)) return

      set({
        backlinks: (back?.nodes || []).map((n: { title: string; path: string }) => ({
          title: n.title,
          path: n.path
        })),
        outgoing: (out?.nodes || []).map((n: { title: string; path: string }) => ({
          title: n.title,
          path: n.path
        }))
      })
    } catch {
      const active = get().getActiveTab()
      if (active && normPath(active.path) === normPath(req)) {
        set({ backlinks: [], outgoing: [] })
      }
    }
  },

  refreshPreview: async (tabId: string) => {
    const tab = get().tabs.find((t) => t.id === tabId)
    if (!tab) return
    // Optional HTML preview — never block UI; tolerate empty on failure
    try {
      const html = await renderHtml(tab.content)
      if (!get().tabs.some((t) => t.id === tabId)) return
      set({
        tabs: get().tabs.map((t) => (t.id === tabId ? { ...t, html } : t))
      })
    } catch (err) {
      console.warn('refreshPreview failed:', err)
    }
  }
}))
