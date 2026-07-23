import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import CodeMirror from '@uiw/react-codemirror'
import type { ReactCodeMirrorRef } from '@uiw/react-codemirror'
import { EditorView } from '@codemirror/view'
import { useEditorStore, normPath } from '../../store/editorStore'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { BacklinksPanel } from './BacklinksPanel'
import { LocalGraphView } from '../graph/LocalGraphView'
import { Icon } from '../ui/Icons'
import { getActiveMode, subscribeThemePreferenceChange, type ThemeMode } from '../../utils/theme'
import {
  livePreviewExtension,
  setLivePreviewOpenHandler
} from './livePreviewExtension'

/**
 * Minimal editor chrome. No @codemirror/lang-markdown here —
 * lezer markdown parse of dense tables was hanging the renderer on open.
 * Plain text + our Live Preview decorations (headings/wiki) is enough.
 */
/** Cache themes — recreating EditorView.theme each memo rebuild still thrashs CM facets */
const noteShellThemeCache = new Map<boolean, ReturnType<typeof EditorView.theme>>()
function makeNoteShellTheme(dark: boolean) {
  const hit = noteShellThemeCache.get(dark)
  if (hit) return hit
  const theme = EditorView.theme(
    {
      '&': {
        backgroundColor: 'var(--bg-app)',
        color: 'var(--note-text)'
      },
      '.cm-content': {
        caretColor: 'var(--note-caret)',
        fontFamily: "'Inter', var(--font-text), sans-serif",
        fontSize: 'var(--note-font-size)',
        lineHeight: 'var(--note-line-height)',
        color: 'var(--note-text)'
      },
      '.cm-cursor, .cm-dropCursor': {
        borderLeftColor: 'var(--note-caret)'
      },
      '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': {
        backgroundColor: 'var(--note-selection) !important'
      },
      '.cm-activeLine': {
        backgroundColor: 'var(--note-active-line)'
      },
      '.cm-gutters': {
        display: 'none'
      }
    },
    { dark }
  )
  noteShellThemeCache.set(dark, theme)
  return theme
}

function noteTemplate(title: string): string {
  const now = new Date().toISOString().split('T')[0]
  return `---
title: ${title}
type: knowledge
created: ${now}
updated: ${now}
tags: []
---

# ${title}

`
}

export const MarkdownEditor: React.FC = () => {
  // Split subscriptions so typing (content change) does not re-render tab strip logic
  // more than needed; actions are stable refs from zustand.
  const tabs = useEditorStore((s) => s.tabs)
  const activeTabId = useEditorStore((s) => s.activeTabId)
  const surfaceMode = useEditorStore((s) => s.surfaceMode)
  const showInspector = useEditorStore((s) => s.showInspector)
  const updateContent = useEditorStore((s) => s.updateContent)
  const scheduleSave = useEditorStore((s) => s.scheduleSave)
  const flushSave = useEditorStore((s) => s.flushSave)
  const closeTab = useEditorStore((s) => s.closeTab)
  const setActiveTab = useEditorStore((s) => s.setActiveTab)
  const toggleSourceMode = useEditorStore((s) => s.toggleSourceMode)
  const toggleInspector = useEditorStore((s) => s.toggleInspector)
  const openTab = useEditorStore((s) => s.openTab)
  const { rootPath, fetchState, setActiveView } = useWorkspaceStore()
  const [cmTheme, setCmTheme] = useState<ThemeMode>(() => getActiveMode())
  const [formatOpen, setFormatOpen] = useState(false)
  const formatMenuRef = useRef<HTMLDivElement | null>(null)

  const activeTab = tabs.find((t) => t.id === activeTabId)
  const cmRef = useRef<ReactCodeMirrorRef>(null)
  const isLive = surfaceMode === 'live'
  /**
   * Safe string for CM — never pass undefined (crashes controlled editor).
   * Content is already LF-normalized on open; only re-normalize if \r sneaks in.
   */
  const rawContent = typeof activeTab?.content === 'string' ? activeTab.content : ''
  const editorValue =
    rawContent.includes('\r')
      ? rawContent.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
      : rawContent

  /**
   * Freeze "big note" decision at tab switch — do NOT recompute on every keystroke.
   * Recreating CM extensions each length change reconfigured the whole editor (lag/hang feel).
   */
  const lpEnabled = useMemo(() => {
    const tab = useEditorStore.getState().tabs.find((t) => t.id === activeTabId)
    const v = typeof tab?.content === 'string' ? tab.content : ''
    if (!v) return true
    const lines = v.split('\n').length
    return v.length <= 6_000 && lines <= 200
  }, [activeTabId])

  useEffect(() => subscribeThemePreferenceChange(setCmTheme), [])

  useEffect(() => {
    setLivePreviewOpenHandler(async (target) => {
      const path = await window.api.resolveWikiLink(target)
      if (path) {
        await openTab(path)
        setActiveView('editor')
      }
    })
    return () => setLivePreviewOpenHandler(null)
  }, [openTab, setActiveView])

  // Close format menu on outside click
  useEffect(() => {
    if (!formatOpen) return
    const onDown = (e: MouseEvent) => {
      if (formatMenuRef.current && !formatMenuRef.current.contains(e.target as Node)) {
        setFormatOpen(false)
      }
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [formatOpen])

  // Flush dirty notes on unmount / leave editor
  useEffect(() => {
    return () => {
      void flushSave()
    }
  }, [flushSave])

  const cmExtensions = useMemo(() => {
    const dark = cmTheme !== 'light'
    // Minimal extensions only — markdown() lezer hang on pegawai tables
    const base = [makeNoteShellTheme(dark), EditorView.lineWrapping]
    // Live Preview for notes that were small when opened
    if (isLive && lpEnabled) base.push(...livePreviewExtension())
    return base
  }, [isLive, cmTheme, lpEnabled])

  const handleChange = (value: string) => {
    if (!activeTabId) return
    updateContent(activeTabId, value)
    // Per-tab debounce — switching tabs no longer cancels other saves
    scheduleSave(activeTabId, 700)
  }

  const insertText = (before: string, after = '') => {
    if (!activeTabId || !activeTab) return
    const view = cmRef.current?.view
    if (view) {
      const { from, to } = view.state.selection.main
      const selected = view.state.sliceDoc(from, to)
      const insert = before + selected + after
      const cursor = from + before.length + selected.length
      view.dispatch({
        changes: { from, to, insert },
        selection: { anchor: cursor }
      })
      updateContent(activeTabId, view.state.doc.toString())
      scheduleSave(activeTabId, 400)
      view.focus()
      return
    }
    const base = typeof activeTab.content === 'string' ? activeTab.content : ''
    updateContent(activeTabId, `${base}${before}${after}`)
    scheduleSave(activeTabId, 400)
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey
      if (mod && e.key.toLowerCase() === 's') {
        e.preventDefault()
        if (activeTabId) void flushSave(activeTabId)
      }
      // Ctrl+\ toggle live / source (Obsidian-like source mode)
      if (mod && e.key === '\\') {
        e.preventDefault()
        toggleSourceMode()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [activeTabId, flushSave, toggleSourceMode])

  // Focus editor when switching tabs (not on every keystroke)
  useEffect(() => {
    const t = window.setTimeout(() => cmRef.current?.view?.focus(), 30)
    return () => clearTimeout(t)
  }, [activeTabId])

  const jumpHeading = useCallback(
    (text: string, level: number) => {
      const view = cmRef.current?.view
      if (!view || !activeTab) return
      const body = typeof activeTab.content === 'string' ? activeTab.content : ''
      const lines = body.split('\n')
      const prefix = '#'.repeat(Math.max(1, Math.min(6, level))) + ' '
      let pos = 0
      for (const line of lines) {
        if (line.startsWith(prefix) && line.slice(prefix.length).trim() === text) {
          const anchor = Math.min(pos + line.length, view.state.doc.length)
          view.dispatch({
            selection: { anchor },
            scrollIntoView: true
          })
          view.focus()
          return
        }
        pos += line.length + 1
      }
    },
    [activeTab]
  )

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

  if (!activeTab) {
    return (
      <div className="empty-state editor-empty">
        <Icon name="note" size={40} style={{ opacity: 0.35 }} />
        <p className="editor-empty-title">Belum ada note terbuka</p>
        <p className="editor-empty-hint">
          Pilih file di sidebar, atau buka cepat dengan pencarian.
        </p>
        <div className="editor-empty-actions">
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={() => void createNewNote()}
          >
            <Icon name="plus" size={14} />
            New note
          </button>
          <button
            type="button"
            className="btn btn-surface btn-sm"
            onClick={() => window.dispatchEvent(new Event('wg:open-search'))}
          >
            <Icon name="search" size={14} />
            Search (Ctrl+K)
          </button>
        </div>
      </div>
    )
  }

  // Case-insensitive strip of vault root (Windows paths)
  let relPath = activeTab.path
  if (rootPath) {
    const nRoot = normPath(rootPath).replace(/\/$/, '')
    const nPath = normPath(activeTab.path)
    if (nPath.startsWith(nRoot + '/') || nPath.startsWith(nRoot + '\\') || nPath === nRoot) {
      relPath = activeTab.path.slice(rootPath.length).replace(/^[\\/]+/, '')
    } else if (nPath.startsWith(nRoot)) {
      relPath = activeTab.path.slice(rootPath.length).replace(/^[\\/]+/, '')
    }
  }
  const pathParts = relPath.split(/[/\\]/).filter(Boolean)

  return (
    <div className={`editor-container surface-${surfaceMode}`}>
      <div className="main-tabs" role="tablist">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            role="tab"
            aria-selected={tab.id === activeTabId}
            className={`tab ${tab.id === activeTabId ? 'active' : ''} ${tab.isDirty ? 'dirty' : ''}`}
            onClick={() => setActiveTab(tab.id)}
            title={tab.path}
          >
            <span className="tab-title">
              {tab.title}
              {tab.isDirty ? <span className="tab-dirty-dot" aria-label="unsaved" /> : null}
            </span>
            <button
              type="button"
              className="tab-close"
              aria-label={`Close ${tab.title}`}
              onClick={(e) => {
                e.stopPropagation()
                closeTab(tab.id)
              }}
            >
              <Icon name="close" size={12} />
            </button>
          </div>
        ))}
      </div>

      <div className="editor-toolbar">
        <div className="editor-breadcrumb" title={activeTab.path}>
          {pathParts.map((part, i) => (
            <React.Fragment key={`${part}-${i}`}>
              {i > 0 && <span className="bc-sep">/</span>}
              <span className={i === pathParts.length - 1 ? 'bc-current' : 'bc-part'}>{part}</span>
            </React.Fragment>
          ))}
        </div>

        <div className="editor-toolbar-actions">
          <span className={`mode-chip ${isLive ? 'view' : 'edit'}`} title="Ctrl+\\ ganti">
            {isLive ? 'Live' : 'Source'}
          </span>

          <div className="format-menu-wrap" ref={formatMenuRef}>
            <button
              type="button"
              className={`btn btn-ghost btn-sm btn-icon ${formatOpen ? 'active' : ''}`}
              onClick={() => setFormatOpen((v) => !v)}
              data-tooltip="Format"
              aria-expanded={formatOpen}
            >
              <Icon name="heading" size={14} />
            </button>
            {formatOpen && (
              <div className="format-menu" role="menu">
                <button
                  type="button"
                  onClick={() => {
                    insertText('**', '**')
                    setFormatOpen(false)
                  }}
                >
                  <Icon name="bold" size={14} /> Bold
                </button>
                <button
                  type="button"
                  onClick={() => {
                    insertText('*', '*')
                    setFormatOpen(false)
                  }}
                >
                  <Icon name="italic" size={14} /> Italic
                </button>
                <button
                  type="button"
                  onClick={() => {
                    insertText('# ')
                    setFormatOpen(false)
                  }}
                >
                  <Icon name="heading" size={14} /> Heading
                </button>
                <button
                  type="button"
                  onClick={() => {
                    insertText('[[', ']]')
                    setFormatOpen(false)
                  }}
                >
                  <Icon name="link" size={14} /> WikiLink
                </button>
                <button
                  type="button"
                  onClick={() => {
                    insertText('- [ ] ')
                    setFormatOpen(false)
                  }}
                >
                  <Icon name="check" size={14} /> Task
                </button>
                <button
                  type="button"
                  onClick={() => {
                    insertText('```\n', '\n```')
                    setFormatOpen(false)
                  }}
                >
                  <Icon name="code" size={14} /> Code
                </button>
                <button
                  type="button"
                  onClick={() => {
                    insertText('> ')
                    setFormatOpen(false)
                  }}
                >
                  <Icon name="quote" size={14} /> Quote
                </button>
              </div>
            )}
          </div>

          <button
            type="button"
            className={`btn btn-surface btn-sm ${!isLive ? 'active' : ''}`}
            onClick={toggleSourceMode}
            data-tooltip={
              isLive
                ? 'Source mode — tampilkan semua syntax (Ctrl+\\)'
                : 'Live Preview — sembunyikan syntax (Ctrl+\\)'
            }
          >
            {isLive ? 'Source' : 'Live'}
          </button>

          <button
            type="button"
            className={`btn btn-ghost btn-sm btn-icon ${showInspector ? 'active' : ''}`}
            onClick={toggleInspector}
            data-tooltip={showInspector ? 'Sembunyikan inspector' : 'Inspector'}
            aria-pressed={showInspector}
          >
            <Icon name="panelRight" size={14} />
          </button>
        </div>
      </div>

      <div className="editor-body">
        <div className="editor-main-pane">
          <div className="editor-source-pane">
            {/* key includes surfaceMode so Live/Source decoration plugins re-attach cleanly */}
            <CodeMirror
              key={`${activeTab.id}-${surfaceMode}-${cmTheme}`}
              ref={cmRef}
              value={editorValue}
              height="100%"
              // critical: theme={undefined} — do NOT pass "dark" (loads oneDark → red titles)
              theme="none"
              extensions={cmExtensions}
              onChange={handleChange}
              basicSetup={{
                lineNumbers: false,
                foldGutter: false,
                highlightActiveLine: true,
                bracketMatching: false,
                autocompletion: false,
                highlightSelectionMatches: false,
                syntaxHighlighting: false,
                // Keep default setup tiny — less work on mount
                history: true,
                drawSelection: true,
                dropCursor: false,
                allowMultipleSelections: false,
                indentOnInput: false,
                closeBrackets: false,
                rectangularSelection: false,
                crosshairCursor: false,
                highlightActiveLineGutter: false
              }}
              className={`wg-codemirror wg-codemirror-live ${isLive ? 'is-live' : 'is-source'}`}
              style={{ height: '100%' }}
            />
          </div>
        </div>

        {showInspector && (
          <aside className="editor-inspector">
            <BacklinksPanel onJumpHeading={jumpHeading} />
          </aside>
        )}
      </div>

      {/* Obsidian-like local graph dock under the note */}
      <LocalGraphView />
    </div>
  )
}
