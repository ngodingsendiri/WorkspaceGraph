import React, { useState, useEffect, useRef, useCallback, memo } from 'react'
import { useWorkspaceStore, FileItem } from '../../store/workspaceStore'
import { useEditorStore, normPath } from '../../store/editorStore'
import { TemplatePicker } from '../systems/TemplatePicker'
import { Icon } from '../ui/Icons'

interface FileTreeItemProps {
  item: FileItem
  depth?: number
  /** Precomputed normPath of active note — avoid per-node editor store subscription */
  activeNormPath: string | null
  onOpenFile: (filePath: string) => void
  onContextMenu: (e: React.MouseEvent, item: FileItem) => void
}

function noteTemplate(title: string, type = 'note'): string {
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

const FileTreeItemNode = memo(function FileTreeItemNode({
  item,
  depth = 0,
  activeNormPath,
  onOpenFile,
  onContextMenu
}: FileTreeItemProps) {
  const [isOpen, setIsOpen] = useState(depth < 2)
  const isActive = Boolean(activeNormPath && normPath(item.path) === activeNormPath)

  const handleClick = () => {
    if (item.isDirectory) {
      setIsOpen(!isOpen)
    } else {
      onOpenFile(item.path)
    }
  }

  return (
    <div>
      <div
        className={`file-tree-item ${isActive ? 'active' : ''}`}
        style={{ '--depth': depth } as React.CSSProperties}
        onClick={handleClick}
        onContextMenu={(e) => onContextMenu(e, item)}
      >
        {item.isDirectory ? (
          <Icon
            name="chevronRight"
            size={14}
            style={{
              transform: isOpen ? 'rotate(90deg)' : 'none',
              transition: 'transform 0.12s ease',
              opacity: 0.7
            }}
          />
        ) : (
          <Icon name="file" size={14} style={{ opacity: 0.65 }} />
        )}
        <span className="truncate">{item.name}</span>
      </div>

      {item.isDirectory && isOpen && item.children && (
        <div>
          {item.children.map((child) => (
            <FileTreeItemNode
              key={child.path}
              item={child}
              depth={depth + 1}
              activeNormPath={activeNormPath}
              onOpenFile={onOpenFile}
              onContextMenu={onContextMenu}
            />
          ))}
        </div>
      )}
    </div>
  )
})

interface CtxMenu {
  x: number
  y: number
  item: FileItem
}

export const Sidebar: React.FC<{ onOpenSearch: () => void }> = ({ onOpenSearch }) => {
  const { files, rootPath, setActiveView, activeView, fetchState } = useWorkspaceStore()
  const openTab = useEditorStore((s) => s.openTab)
  // Only re-render tree highlight when active path changes — not on every keystroke
  const activeNormPath = useEditorStore((s) => {
    const tab = s.tabs.find((t) => t.id === s.activeTabId)
    return tab?.path ? normPath(tab.path) : null
  })
  const onOpenFile = useCallback(
    (filePath: string) => {
      void openTab(filePath)
      setActiveView('editor')
    },
    [openTab, setActiveView]
  )
  const [ctx, setCtx] = useState<CtxMenu | null>(null)
  const [tplOpen, setTplOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!ctx) return
    const close = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setCtx(null)
    }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [ctx])

  const handleNewNote = async (folderPath?: string) => {
    if (!rootPath) return
    const base = folderPath || `${rootPath}${rootPath.includes('\\') ? '\\' : '/'}Knowledge`
    const stamp = Date.now().toString().slice(-4)
    const title = `Note-${stamp}`
    const filePath = `${base}${base.includes('\\') ? '\\' : '/'}${title}.md`
    await window.api.createFile(filePath, noteTemplate(title, 'knowledge'))
    await fetchState()
    await openTab(filePath)
    setActiveView('editor')
    setCtx(null)
  }

  const handleNewFolder = async (parentPath?: string) => {
    if (!rootPath) return
    const name = window.prompt('Nama folder baru:')
    if (!name?.trim()) return
    const base = parentPath || rootPath
    const sep = base.includes('\\') ? '\\' : '/'
    await window.api.createFolder(`${base}${sep}${name.trim()}`)
    await fetchState()
    setCtx(null)
  }

  const handleRename = async (item: FileItem) => {
    const next = window.prompt('Rename:', item.name)
    if (!next?.trim() || next === item.name) {
      setCtx(null)
      return
    }
    const sep = item.path.includes('\\') ? '\\' : '/'
    const parent = item.path.split(/[/\\]/).slice(0, -1).join(sep)
    const newPath = `${parent}${sep}${next.trim()}`
    await window.api.renameFile(item.path, newPath)
    await fetchState()
    setCtx(null)
  }

  const handleDelete = async (item: FileItem) => {
    const ok = window.confirm(
      `Hapus "${item.name}"?${item.isDirectory ? ' (termasuk isinya)' : ''}`
    )
    if (!ok) {
      setCtx(null)
      return
    }
    await window.api.deleteFile(item.path)
    await fetchState()
    setCtx(null)
  }

  const onContextMenu = (e: React.MouseEvent, item: FileItem) => {
    e.preventDefault()
    e.stopPropagation()
    setCtx({ x: e.clientX, y: e.clientY, item })
  }

  const onTreeBackgroundContext = (e: React.MouseEvent) => {
    e.preventDefault()
    if (!rootPath) return
    setCtx({
      x: e.clientX,
      y: e.clientY,
      item: {
        id: 'root',
        name: 'Vault',
        path: rootPath,
        relativePath: '',
        type: 'other',
        extension: '',
        size: 0,
        createdAt: '',
        updatedAt: '',
        isDirectory: true
      }
    })
  }

  return (
    <div className="sidebar">
      <div className="sidebar-header" style={{ justifyContent: 'space-between' }}>
        <span
          style={{
            fontSize: 'var(--text-xs)',
            fontWeight: 'var(--weight-semibold)',
            color: 'var(--text-muted)',
            textTransform: 'uppercase',
            letterSpacing: '0.08em'
          }}
        >
          {rootPath ? rootPath.split(/[/\\]/).pop() : 'Vault'}
        </span>
      </div>

      <div className="sidebar-nav">
        <button
          className={`nav-item ${activeView === 'dashboard' ? 'active' : ''}`}
          onClick={() => setActiveView('dashboard')}
        >
          <Icon name="dashboard" size={16} />
          Dashboard
        </button>

        <button
          className={`nav-item ${activeView === 'editor' ? 'active' : ''}`}
          onClick={() => setActiveView('editor')}
        >
          <Icon name="note" size={16} />
          Editor
        </button>

        <button
          className={`nav-item ${activeView === 'graph' ? 'active' : ''}`}
          onClick={() => setActiveView('graph')}
        >
          <Icon name="graph" size={16} />
          Graph View
        </button>

        <button className="nav-item" onClick={onOpenSearch}>
          <Icon name="search" size={16} />
          Search (Ctrl+K)
        </button>
      </div>

      <div className="sidebar-content">
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '0 var(--space-3) var(--space-2)'
          }}
        >
          <span className="section-title" style={{ padding: 0 }}>
            Files
          </span>
          <div style={{ display: 'flex', gap: 2 }}>
            <button
              className="btn btn-ghost btn-sm btn-icon"
              onClick={() => setTplOpen(true)}
              data-tooltip="From template (Ctrl+Shift+N)"
            >
              <Icon name="template" size={15} />
            </button>
            <button
              className="btn btn-ghost btn-sm btn-icon"
              onClick={() => handleNewNote()}
              data-tooltip="New Note (Ctrl+N)"
            >
              <Icon name="plus" size={15} />
            </button>
          </div>
        </div>

        <div className="file-tree" onContextMenu={onTreeBackgroundContext}>
          {files.map((item) => (
            <FileTreeItemNode
              key={item.path}
              item={item}
              activeNormPath={activeNormPath}
              onOpenFile={onOpenFile}
              onContextMenu={onContextMenu}
            />
          ))}
        </div>
      </div>

      <div className="sidebar-footer">
        <button
          className={`nav-item ${activeView === 'settings' ? 'active' : ''}`}
          onClick={() => setActiveView('settings')}
        >
          <Icon name="settings" size={16} />
          Settings
        </button>
      </div>

      <TemplatePicker open={tplOpen} onClose={() => setTplOpen(false)} />

      {ctx && (
        <div
          ref={menuRef}
          className="ctx-menu"
          style={{ position: 'fixed', left: ctx.x, top: ctx.y, zIndex: 9999 }}
          onContextMenu={(e) => e.preventDefault()}
        >
          {ctx.item.isDirectory && (
            <>
              <button type="button" onClick={() => handleNewNote(ctx.item.path)}>
                New note here
              </button>
              <button type="button" onClick={() => handleNewFolder(ctx.item.path)}>
                New folder
              </button>
            </>
          )}
          {ctx.item.id !== 'root' && (
            <>
              <button type="button" onClick={() => handleRename(ctx.item)}>
                Rename
              </button>
              <button type="button" className="danger" onClick={() => handleDelete(ctx.item)}>
                Delete
              </button>
            </>
          )}
          {ctx.item.id === 'root' && (
            <button type="button" onClick={() => handleNewNote()}>
              New note in Knowledge
            </button>
          )}
        </div>
      )}
    </div>
  )
}
