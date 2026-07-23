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
import { SearchModal } from '../search/SearchModal'
import { SettingsView } from '../settings/SettingsView'
import { TemplatePicker } from '../systems/TemplatePicker'
import { Icon } from '../ui/Icons'
import { ErrorBoundary } from '../ui/ErrorBoundary'
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

  // Apply light/dark theme as early as possible (localStorage then settings.json)
  useEffect(() => {
    void bootTheme()
    // Keep CodeMirror / system preference in sync when OS theme flips
    return subscribeThemePreferenceChange(() => {
      /* data-theme already applied by observer path for preference storage */
    })
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
    const sep = rootPath.includes('\\') ? '\\' : '/'
    const filePath = `${rootPath}${sep}Daily${sep}${today}.md`
    const content = `---
title: ${today}
type: daily
date: ${today}
---

# ${today}

## Today's Focus


## Notes


## Tasks

- [ ] 

`
    await window.api.createFile(filePath, content)
    await fetchState()
    await openTab(filePath)
    setActiveView('editor')
  }, [rootPath, fetchState, openTab, setActiveView])

  // Open search from empty-editor CTA etc.
  useEffect(() => {
    const openSearch = () => setIsSearchOpen(true)
    window.addEventListener('wg:open-search', openSearch)
    return () => window.removeEventListener('wg:open-search', openSearch)
  }, [])

  // Keyboard shortcuts (Obsidian-like)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey
      if (!mod) return
      const key = e.key.toLowerCase()

      if (key === 'k' || key === 'p') {
        e.preventDefault()
        setIsSearchOpen((prev) => !prev)
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
    setActiveView
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
                data-tooltip="Toggle Sidebar"
                aria-label="Toggle sidebar"
              >
                <Icon name="sidebar" size={14} />
              </button>
              <button
                type="button"
                className={`btn btn-ghost btn-sm btn-icon ${showAIChat ? 'active' : ''}`}
                onClick={toggleAIChat}
                data-tooltip="Toggle AI Panel"
                aria-label="Toggle AI panel"
              >
                <Icon name="panelRight" size={14} />
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
          ) : activeView === 'dashboard' ? (
            <DashboardView onOpenSearch={() => setIsSearchOpen(true)} />
          ) : activeView === 'editor' ? (
            <ErrorBoundary label="Editor">
              <MarkdownEditor />
            </ErrorBoundary>
          ) : activeView === 'graph' ? (
            <ErrorBoundary label="Graph">
              <GraphCanvas />
            </ErrorBoundary>
          ) : activeView === 'settings' ? (
            <SettingsView />
          ) : (
            <WelcomeScreen />
          )}
        </div>

        {isOpen && showAIChat && <ChatPanel />}
      </div>

      {isOpen && <StatusBar />}

      <SearchModal isOpen={isSearchOpen} onClose={() => setIsSearchOpen(false)} />
      <TemplatePicker open={isTemplateOpen} onClose={() => setIsTemplateOpen(false)} />
    </div>
  )
}
