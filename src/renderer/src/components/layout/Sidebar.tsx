import React, { useState, useEffect, useRef, useCallback, memo } from 'react'
import { useWorkspaceStore, FileItem } from '../../store/workspaceStore'
import { useEditorStore, normPath } from '../../store/editorStore'
import { TemplatePicker } from '../systems/TemplatePicker'
import { Icon } from '../ui/Icons'
import { toast } from '../ui/Toast'
import { alertDialog, confirmDialog, promptDialog } from '../ui/Dialog'
import { usePanelWidth } from '../../hooks/usePanelWidth'

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
  const isInTrash = item.relativePath.startsWith('.trash')

  const handleClick = (): void => {
    if (item.isDirectory) {
      setIsOpen(!isOpen)
    } else {
      onOpenFile(item.path)
    }
  }

  return (
    <div>
      <div
        className={`file-tree-item ${isActive ? 'active' : ''} ${isInTrash ? 'is-trash' : ''}`}
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
          <Icon name={isInTrash ? 'trash' : 'file'} size={14} style={{ opacity: 0.65 }} />
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

const NavGroup: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <div className="nav-group">
    <div className="nav-group-title">{title}</div>
    {children}
  </div>
)

export const Sidebar: React.FC<{ onOpenSearch: () => void }> = ({ onOpenSearch }) => {
  const { files, rootPath, setActiveView, activeView, fetchState } = useWorkspaceStore()
  const {
    width: sidebarWidth,
    onHandleMouseDown: sidebarResize,
    resizing
  } = usePanelWidth('wg.sidebarWidth', 260, 200, 480, (x) => x)
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
  const [trashEnabled, setTrashEnabled] = useState(true)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    window.api
      .getSettings()
      .then((s) => {
        if (s && typeof s === 'object' && 'trashEnabled' in s)
          setTrashEnabled(s.trashEnabled !== false)
      })
      .catch(() => {})
  }, [])

  useEffect(() => {
    if (!ctx) return
    const close = (e: MouseEvent): void => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setCtx(null)
    }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [ctx])

  const handleNewNote = async (folderPath?: string): Promise<void> => {
    if (!rootPath) return
    const base = folderPath || `${rootPath}${rootPath.includes('\\') ? '\\' : '/'}Knowledge`
    const stamp = Date.now().toString().slice(-4)
    const title = `Note-${stamp}`
    const filePath = `${base}${base.includes('\\') ? '\\' : '/'}${title}.md`
    // M4a DOM-11: detect folder → use the matching template/type instead of
    // always 'knowledge' (otherwise Projects/Tasks/People notes are
    // misclassified as knowledge/other in DomainEngine).
    const lowerBase = base.toLowerCase().replace(/\\/g, '/')
    let templateId: string | null = null
    let noteType = 'knowledge'
    if (lowerBase.includes('/projects')) {
      templateId = 'builtin-project'
      noteType = 'project'
    } else if (lowerBase.includes('/tasks')) {
      templateId = 'builtin-task'
      noteType = 'task'
    } else if (lowerBase.includes('/people')) {
      templateId = 'builtin-people'
      noteType = 'people'
    } else if (lowerBase.includes('/daily')) {
      templateId = 'builtin-daily'
      noteType = 'daily'
    } else if (lowerBase.includes('/documents')) {
      templateId = 'builtin-document'
      noteType = 'document'
    } else if (lowerBase.includes('/sop')) {
      templateId = 'builtin-sop'
      noteType = 'sop'
    }
    if (templateId) {
      try {
        const res = await window.api.createFromTemplate({ templateId, title })
        if (res.ok && res.path) {
          // Move to the requested folder if template created elsewhere
          const expectedDir = base.replace(/\\/g, '/').toLowerCase()
          const actualDir = res.path.replace(/\\/g, '/').toLowerCase()
          if (!actualDir.startsWith(expectedDir)) {
            const newPath = `${base}${base.includes('\\') ? '\\' : '/'}${title}.md`
            try {
              await window.api.createFile(newPath, await window.api.readFile(res.path).then((d: { content: string }) => d.content))
            } catch {
              /* fallback: open template location */
              await fetchState()
              await openTab(res.path)
              setActiveView('editor')
              setCtx(null)
              return
            }
          }
          await fetchState()
          await openTab(res.path)
          setActiveView('editor')
          setCtx(null)
          return
        }
      } catch {
        /* fallback to direct create */
      }
    }
    await window.api.createFile(filePath, noteTemplate(title, noteType))
    await fetchState()
    await openTab(filePath)
    setActiveView('editor')
    setCtx(null)
  }

  const handleNewFolder = async (parentPath?: string): Promise<void> => {
    if (!rootPath) return
    const name = await promptDialog({
      title: 'Folder baru',
      message: 'Nama folder baru:',
      placeholder: 'Nama folder'
    })
    if (!name?.trim()) return
    const clean = name.trim()
    // Reject path segments that would create nested escapes (../, a/b, …)
    if (/[/\\]/.test(clean) || clean === '.' || clean === '..') {
      await alertDialog({
        title: 'Nama tidak valid',
        message: 'Nama folder tidak boleh mengandung / \\ atau ..'
      })
      return
    }
    const base = parentPath || rootPath
    const sep = base.includes('\\') ? '\\' : '/'
    try {
      await window.api.createFolder(`${base}${sep}${clean}`)
      await fetchState()
    } catch (err) {
      await alertDialog({
        title: 'Gagal membuat folder',
        message: err instanceof Error ? err.message : String(err)
      })
    }
    setCtx(null)
  }

  const handleRename = async (item: FileItem): Promise<void> => {
    const next = await promptDialog({
      title: 'Ubah nama',
      message: 'Nama baru:',
      initialValue: item.name,
      placeholder: 'Nama baru'
    })
    if (!next?.trim() || next === item.name) {
      setCtx(null)
      return
    }
    const clean = next.trim()
    if (/[/\\]/.test(clean) || clean === '.' || clean === '..') {
      await alertDialog({
        title: 'Nama tidak valid',
        message: 'Nama tidak boleh mengandung / \\ atau ..'
      })
      setCtx(null)
      return
    }
    const sep = item.path.includes('\\') ? '\\' : '/'
    const parent = item.path.split(/[/\\]/).slice(0, -1).join(sep)
    const newPath = `${parent}${sep}${clean}`
    try {
      const result = await window.api.renameFile(item.path, newPath)
      // Show WikiLink update toast if any links were updated
      if (result && typeof result === 'object' && result.renamedLinks > 0) {
        toast(
          `✏️ Rename selesai — ${result.renamedLinks} WikiLink diperbarui di ${result.affectedFiles.length} file`,
          { variant: 'success', duration: 5000 }
        )
      }
      // Update open tab path if this file was open
      const editor = useEditorStore.getState()
      const open = editor.tabs.find((t) => normPath(t.path) === normPath(item.path))
      if (open) {
        useEditorStore.setState({
          tabs: editor.tabs.map((t) =>
            t.id === open.id
              ? { ...t, path: newPath, title: clean.replace(/\.md$/i, '') || t.title }
              : t
          )
        })
      }
      await fetchState()
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), { variant: 'error' })
    }
    setCtx(null)
  }

  const handleDelete = async (item: FileItem, permanent = false): Promise<void> => {
    const ok = await confirmDialog({
      title: permanent ? 'Hapus permanen?' : 'Hapus?',
      message: permanent
        ? `Hapus "${item.name}" secara permanen? Tidak bisa dipulihkan.`
        : trashEnabled
          ? `Pindahkan "${item.name}" ke .trash?${item.isDirectory ? ' (termasuk isinya)' : ''} Bisa dipulihkan nanti.`
          : `Hapus "${item.name}"?${item.isDirectory ? ' (termasuk isinya)' : ''}`,
      danger: true,
      okLabel: permanent ? 'Hapus permanen' : trashEnabled ? 'Pindah ke trash' : 'Hapus'
    })
    if (!ok) {
      setCtx(null)
      return
    }
    try {
      // Discard editor tabs first (cancels autosave) so delete is not undone by a late write
      useEditorStore.getState().discardTabsUnder(item.path)
      const result = await window.api.deleteFile(item.path)
      await fetchState()
      if (result && typeof result === 'object' && result.trashed) {
        toast('🗑 Dipindah ke .trash — klik kanan di sana untuk pulihkan', { variant: 'success' })
      }
    } catch (err) {
      await alertDialog({
        title: 'Gagal menghapus',
        message: err instanceof Error ? err.message : String(err)
      })
    }
    setCtx(null)
  }

  const handleRestore = async (item: FileItem): Promise<void> => {
    try {
      const result = await window.api.restoreFile(item.path)
      await fetchState()
      if (result && typeof result === 'object' && result.path) {
        toast(`↩️ Dipulihkan ke ${result.path.split(/[/\\]/).pop()}`, { variant: 'success' })
      }
    } catch (err) {
      await alertDialog({
        title: 'Gagal memulihkan',
        message: err instanceof Error ? err.message : String(err)
      })
    }
    setCtx(null)
  }

  const handleEmptyTrash = async (item: FileItem): Promise<void> => {
    const ok = await confirmDialog({
      title: 'Kosongkan trash?',
      message: 'Semua file di .trash akan dihapus permanen. Tidak bisa dipulihkan.',
      danger: true,
      okLabel: 'Kosongkan'
    })
    if (!ok) {
      setCtx(null)
      return
    }
    try {
      useEditorStore.getState().discardTabsUnder(item.path)
      const result = await window.api.emptyTrash()
      await fetchState()
      toast(
        `🧹 Trash dikosongkan (${result && typeof result === 'object' ? (result.count ?? 0) : 0} file)`
      )
    } catch (err) {
      await alertDialog({
        title: 'Gagal mengosongkan trash',
        message: err instanceof Error ? err.message : String(err)
      })
    }
    setCtx(null)
  }

  const onContextMenu = (e: React.MouseEvent, item: FileItem): void => {
    e.preventDefault()
    e.stopPropagation()
    setCtx({ x: e.clientX, y: e.clientY, item })
  }

  const onTreeBackgroundContext = (e: React.MouseEvent): void => {
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
    <div
      className={`sidebar ${resizing ? 'is-resizing' : ''}`}
      style={{ '--sidebar-w': `${sidebarWidth}px` } as React.CSSProperties}
    >
      <div
        className="wg-resize-handle wg-resize-handle--right"
        onMouseDown={sidebarResize}
        role="separator"
        aria-orientation="vertical"
        aria-label="Ubah lebar sidebar"
      />
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
        <NavGroup title="Utama">
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
            Graph
          </button>
        </NavGroup>

        <NavGroup title="Alat">
          <button className="nav-item" onClick={onOpenSearch}>
            <Icon name="search" size={16} />
            Cari (Ctrl+K)
          </button>
          <button
            className="nav-item"
            onClick={() => window.dispatchEvent(new Event('wg:open-palette'))}
          >
            <Icon name="command" size={16} />
            Palette (Ctrl+P)
          </button>
        </NavGroup>
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
            File
          </span>
          <div style={{ display: 'flex', gap: 2 }}>
            <button
              className="btn btn-ghost btn-sm btn-icon"
              onClick={() => setTplOpen(true)}
              data-tooltip="Dari template (Ctrl+Shift+N)"
            >
              <Icon name="template" size={15} />
            </button>
            <button
              className="btn btn-ghost btn-sm btn-icon"
              onClick={() => handleNewNote()}
              data-tooltip="Note baru (Ctrl+N)"
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
        <NavGroup title="Sistem">
          <button
            className={`nav-item ${activeView === 'settings' ? 'active' : ''}`}
            onClick={() => setActiveView('settings')}
          >
            <Icon name="settings" size={16} />
            Pengaturan
          </button>
        </NavGroup>
      </div>

      <TemplatePicker open={tplOpen} onClose={() => setTplOpen(false)} />

      {ctx && (
        <div
          ref={menuRef}
          className="ctx-menu"
          style={{ position: 'fixed', left: ctx.x, top: ctx.y, zIndex: 9999 }}
          onContextMenu={(e) => e.preventDefault()}
        >
          {(() => {
            const isTrashRoot = ctx.item.name === '.trash' && ctx.item.isDirectory
            const isInTrash = ctx.item.relativePath.startsWith('.trash')
            if (isTrashRoot) {
              return (
                <button
                  type="button"
                  className="danger"
                  onClick={() => void handleEmptyTrash(ctx.item)}
                >
                  Kosongkan trash
                </button>
              )
            }
            if (isInTrash) {
              return (
                <>
                  <button type="button" onClick={() => handleRestore(ctx.item)}>
                    Pulihkan
                  </button>
                  <button
                    type="button"
                    className="danger"
                    onClick={() => handleDelete(ctx.item, true)}
                  >
                    Hapus permanen
                  </button>
                </>
              )
            }
            return (
              <>
                {ctx.item.isDirectory && (
                  <>
                    <button type="button" onClick={() => handleNewNote(ctx.item.path)}>
                      Note baru di sini
                    </button>
                    <button type="button" onClick={() => handleNewFolder(ctx.item.path)}>
                      Folder baru
                    </button>
                  </>
                )}
                {ctx.item.id !== 'root' && (
                  <>
                    <button type="button" onClick={() => handleRename(ctx.item)}>
                      Ubah nama
                    </button>
                    <button type="button" className="danger" onClick={() => handleDelete(ctx.item)}>
                      Hapus
                    </button>
                  </>
                )}
                {ctx.item.id === 'root' && (
                  <button type="button" onClick={() => handleNewNote()}>
                    Note baru di Knowledge
                  </button>
                )}
              </>
            )
          })()}
        </div>
      )}
    </div>
  )
}
