import React, { useEffect, useState, useCallback } from 'react'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { useEditorStore } from '../../store/editorStore'
import { Sidebar } from './Sidebar'
import { StatusBar } from './StatusBar'
import { WelcomeScreen } from '../welcome/WelcomeScreen'
import { DashboardView } from '../dashboard/DashboardView'
import { MarkdownEditor } from '../editor/MarkdownEditor'
import { GraphCanvas } from '../graph/GraphCanvas'
import { ChatPanel } from '../chat/ChatPanel'
import { ViewKeepAlive } from './ViewKeepAlive'
import { SearchModal } from '../search/SearchModal'
import { SettingsView } from '../settings/SettingsView'
import { TemplatePicker } from '../systems/TemplatePicker'
import { CommandPalette } from '../ui/CommandPalette'
import { Icon } from '../ui/Icons'
import { ErrorBoundary } from '../ui/ErrorBoundary'
import { toast, Toaster } from '../ui/Toast'
import { bootTheme, subscribeThemePreferenceChange } from '../../utils/theme'

function noteTemplate(title: string, type = 'knowledge'): string {
  const now = new Date().toISOString().split('T')[0]
  return `---
title: ${title}
type: ${type}
created: ${now}
updated: ${now}
tags: []
---

# ${title}

`
}

export const AppShell: React.FC = () => {
  const {
    isOpen,
    activeView,
    showSidebar,
    showAIChat,
    rootPath,
    toggleSidebar,
    toggleAIChat,
    fetchState,
    setActiveView
  } = useWorkspaceStore()
  // Selective subscribe — full useEditorStore() re-rendered entire shell on every keystroke
  const openTab = useEditorStore((s) => s.openTab)
  const flushSave = useEditorStore((s) => s.flushSave)
  const activeTabId = useEditorStore((s) => s.activeTabId)
  const [isSearchOpen, setIsSearchOpen] = useState(false)
  const [isTemplateOpen, setIsTemplateOpen] = useState(false)
  const [isPaletteOpen, setIsPaletteOpen] = useState(false)
  const [paletteMode, setPaletteMode] = useState<'commands' | 'shortcuts'>('commands')
  const [splitGraph, setSplitGraph] = useState(() => {
    try {
      return localStorage.getItem('wg.splitGraph') === '1'
    } catch {
      return false
    }
  })

  // Apply light/dark theme as early as possible (localStorage then settings.json)
  useEffect(() => {
    void bootTheme()
    // Keep CodeMirror / system preference in sync when OS theme flips
    return subscribeThemePreferenceChange(() => {
      /* data-theme already applied by observer path for preference storage */
    })
  }, [])

  // Plugin notifications (JS sandbox ui.notify) → toast
  useEffect(() => {
    if (!window.api?.onPluginNotify) return
    const unsub = window.api.onPluginNotify((payload) => {
      toast(payload?.message || 'Plugin', { variant: 'info', duration: 4000 })
    })
    return () => {
      try {
        unsub?.()
      } catch {
        /* ignore */
      }
    }
  }, [])

  // Smooth window drag-resize: freeze CSS transitions/animations while the
  // window is being resized so the UI tracks the drag without trailing effects
  useEffect(() => {
    let t: number | undefined
    const onResize = (): void => {
      document.body.classList.add('wg-window-resizing')
      if (t) window.clearTimeout(t)
      // Keep the freeze active until graph re-fit settles (~300ms), so
      // transitions don't pop mid-settle
      t = window.setTimeout(() => {
        document.body.classList.remove('wg-window-resizing')
      }, 300)
    }
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('resize', onResize)
      if (t) window.clearTimeout(t)
      document.body.classList.remove('wg-window-resizing')
    }
  }, [])

  useEffect(() => {
    void fetchState()
    if (!window.api?.onWorkspaceUpdated) {
      console.warn('[AppShell] preload API missing — UI still boots without vault IPC')
      return
    }
    const unsubscribe = window.api.onWorkspaceUpdated(() => {
      void fetchState()
    })
    return () => {
      try {
        unsubscribe?.()
      } catch {
        /* ignore */
      }
    }
  }, [fetchState])

  const createNewNote = useCallback(async () => {
    if (!rootPath) return
    const stamp = Date.now().toString().slice(-4)
    const title = `Note-${stamp}`
    const sep = rootPath.includes('\\') ? '\\' : '/'
    const filePath = `${rootPath}${sep}Knowledge${sep}${title}.md`
    await window.api.createFile(filePath, noteTemplate(title))
    await fetchState()
    await openTab(filePath)
    setActiveView('editor')
  }, [rootPath, fetchState, openTab, setActiveView])

  const createDailyNote = useCallback(async () => {
    if (!rootPath) return
    const today = new Date().toISOString().split('T')[0]
    try {
      const res = await window.api.createFromTemplate({
        templateId: 'builtin-daily',
        title: today
      })
      if (res.ok && res.path) {
        await fetchState()
        await openTab(res.path)
        setActiveView('editor')
        return
      }
      if (res.path) {
        await fetchState()
        await openTab(res.path)
        setActiveView('editor')
        return
      }
    } catch (err) {
      console.error('Daily note via template failed:', err)
    }
    // Fallback: manual creation
    const sep = rootPath.includes('\\') ? '\\' : '/'
    const filePath = `${rootPath}${sep}Daily${sep}${today}.md`
    try {
      await window.api.createFile(
        filePath,
        `---\ntitle: ${today}\ntype: daily\ndate: ${today}\n---\n\n# ${today}\n\n## Focus\n\n- [ ] \n`
      )
    } catch {
      /* already exists — open it */
    }
    await fetchState()
    await openTab(filePath)
    setActiveView('editor')
  }, [rootPath, fetchState, openTab, setActiveView])

  // Open search from empty-editor CTA etc.
  useEffect(() => {
    const openSearch = (): void => setIsSearchOpen(true)
    const openPalette = (): void => {
      setPaletteMode('commands')
      setIsPaletteOpen(true)
    }
    const openTemplate = (): void => setIsTemplateOpen(true)
    const newNote = (): undefined => void createNewNote()
    const newDaily = (): undefined => void createDailyNote()
    const toggleSplit = (): void => {
      setSplitGraph((v) => {
        const next = !v
        try {
          localStorage.setItem('wg.splitGraph', next ? '1' : '0')
        } catch {
          /* ignore */
        }
        return next
      })
    }
    window.addEventListener('wg:open-search', openSearch)
    window.addEventListener('wg:open-palette', openPalette)
    window.addEventListener('wg:open-template', openTemplate)
    window.addEventListener('wg:new-note', newNote)
    window.addEventListener('wg:new-daily', newDaily)
    window.addEventListener('wg:toggle-split', toggleSplit)
    return () => {
      window.removeEventListener('wg:open-search', openSearch)
      window.removeEventListener('wg:open-palette', openPalette)
      window.removeEventListener('wg:open-template', openTemplate)
      window.removeEventListener('wg:new-note', newNote)
      window.removeEventListener('wg:new-daily', newDaily)
      window.removeEventListener('wg:toggle-split', toggleSplit)
    }
  }, [createNewNote, createDailyNote])

  // Keyboard shortcuts (Obsidian-like)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent): void => {
      const mod = e.ctrlKey || e.metaKey
      if (!mod) return
      // Don't fire global shortcuts behind the open command palette
      if (isPaletteOpen) return
      const key = e.key.toLowerCase()

      if (key === 'k') {
        e.preventDefault()
        setIsSearchOpen((prev) => !prev)
      }
      if (key === 'p') {
        e.preventDefault()
        setPaletteMode('commands')
        setIsPaletteOpen(true)
      }
      if (key === '?' && e.shiftKey) {
        e.preventDefault()
        setPaletteMode('shortcuts')
        setIsPaletteOpen(true)
      }
      if (key === 'b') {
        e.preventDefault()
        toggleSidebar()
      }
      if (key === 'j') {
        e.preventDefault()
        toggleAIChat()
      }
      if (key === 'n' && isOpen && e.shiftKey) {
        e.preventDefault()
        setIsTemplateOpen(true)
        return
      }
      if (key === 'n' && isOpen) {
        e.preventDefault()
        createNewNote()
      }
      if (key === 'd' && isOpen && e.shiftKey) {
        e.preventDefault()
        createDailyNote()
      }
      if (key === 's' && activeTabId) {
        e.preventDefault()
        void flushSave(activeTabId)
      }
      if (key === 'e' && isOpen) {
        e.preventDefault()
        setActiveView('editor')
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [
    toggleSidebar,
    toggleAIChat,
    createNewNote,
    createDailyNote,
    isOpen,
    activeTabId,
    flushSave,
    setActiveView,
    isPaletteOpen
  ])

  return (
    <div className="app-shell">
      {/*
        Full-width surface matches Windows titleBarOverlay color.
        Inner uses env(titlebar-area-*) so min/max/close never collide with actions.
      */}
      <header className="app-titlebar">
        <div className="app-titlebar-inner">
          <div className="app-titlebar-brand">
            <span className="app-titlebar-logo" aria-hidden />
            <span className="app-titlebar-title" title={rootPath || 'WorkspaceGraph'}>
              WorkspaceGraph
              {isOpen && rootPath
                ? ` · ${
                    rootPath
                      .replace(/[/\\]+$/, '')
                      .split(/[/\\]/)
                      .pop() || ''
                  }`
                : ''}
            </span>
          </div>

          <div className="app-titlebar-drag" aria-hidden />

          {isOpen && (
            <div className="app-titlebar-actions">
              <button
                type="button"
                className={`btn btn-ghost btn-sm btn-icon ${showSidebar ? 'active' : ''}`}
                onClick={toggleSidebar}
                data-tooltip="Sembunyikan/Tampilkan sidebar"
                aria-label="Toggle sidebar"
              >
                <Icon name="sidebar" size={14} />
              </button>
              <button
                type="button"
                className={`btn btn-ghost btn-sm btn-icon ${showAIChat ? 'active' : ''}`}
                onClick={toggleAIChat}
                data-tooltip="Sembunyikan/Tampilkan panel AI"
                aria-label="Toggle AI panel"
              >
                <Icon name="panelRight" size={14} />
              </button>
              <button
                type="button"
                className={`btn btn-ghost btn-sm btn-icon titlebar-extra ${splitGraph ? 'active' : ''}`}
                onClick={() => window.dispatchEvent(new Event('wg:toggle-split'))}
                data-tooltip="Split editor + graph"
                aria-label="Split editor dan graph"
              >
                <Icon name="split" size={14} />
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-sm btn-icon"
                onClick={() => {
                  setPaletteMode('commands')
                  setIsPaletteOpen(true)
                }}
                data-tooltip="Command palette (Ctrl+P)"
                aria-label="Command palette"
              >
                <Icon name="command" size={14} />
              </button>
            </div>
          )}
        </div>
      </header>

      <div className="app-body">
        {isOpen && showSidebar && <Sidebar onOpenSearch={() => setIsSearchOpen(true)} />}

        <div className="main-content">
          {!isOpen || activeView === 'welcome' ? (
            <WelcomeScreen />
          ) : (
            /*
              P-2: keep-alive panes — every main view stays mounted and is only
              hidden. Navigating between views is a display toggle, not a
              remount, so the CodeMirror editor and graph canvas survive
              navigation (and their scroll/undo/camera state with them).
              The editor pane keeps MarkdownEditor's position stable so toggling
              split view doesn't remount it either.
            */
            <>
              <ViewKeepAlive active={activeView === 'dashboard'}>
                <DashboardView onOpenSearch={() => setIsSearchOpen(true)} />
              </ViewKeepAlive>
              <ViewKeepAlive active={activeView === 'editor'}>
                {/* Editor pane keeps MarkdownEditor at a stable position whether
                    or not split view is on, so toggling split never remounts the
                    editor (undo history, scroll, dirty buffers survive). */}
                <div className={`split-view ${splitGraph ? '' : 'split-view--solo'}`}>
                  <div className="split-pane split-pane--editor">
                    <ErrorBoundary label="Editor">
                      <MarkdownEditor />
                    </ErrorBoundary>
                  </div>
                  {splitGraph && (
                    <div className="split-pane split-pane--graph">
                      <ErrorBoundary label="Graph">
                        <GraphCanvas embedded />
                      </ErrorBoundary>
                    </div>
                  )}
                </div>
              </ViewKeepAlive>
              <ViewKeepAlive active={activeView === 'graph'}>
                <ErrorBoundary label="Graph">
                  <GraphCanvas />
                </ErrorBoundary>
              </ViewKeepAlive>
              <ViewKeepAlive active={activeView === 'settings'}>
                <SettingsView />
              </ViewKeepAlive>
            </>
          )}
        </div>

        {isOpen && showAIChat && <ChatPanel />}
      </div>

      {isOpen && <StatusBar />}

      <SearchModal isOpen={isSearchOpen} onClose={() => setIsSearchOpen(false)} />
      <TemplatePicker open={isTemplateOpen} onClose={() => setIsTemplateOpen(false)} />
      <CommandPalette
        isOpen={isPaletteOpen}
        onClose={() => setIsPaletteOpen(false)}
        initialMode={paletteMode}
      />
      <Toaster />
    </div>
  )
}
