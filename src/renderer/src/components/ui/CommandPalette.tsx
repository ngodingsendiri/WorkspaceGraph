/**
 * Command Palette (F-3) — Ctrl+P opens it, Ctrl+K stays quick-search.
 * Action registry covers views, creation, panels, graph commands and plugin commands.
 * Press '?' inside to flip to the keyboard-shortcuts reference (also Ctrl+Shift+?).
 */
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { Icon, type IconName } from './Icons'
import { toast } from './Toast'

type PaletteMode = 'commands' | 'shortcuts'

interface PaletteAction {
  id: string
  group: string
  title: string
  keywords?: string
  icon: IconName
  shortcut?: string
  run: () => void
}

const VIEW_ACTIONS: PaletteAction[] = [
  {
    id: 'view-dashboard',
    group: 'Tampilan',
    title: 'Dashboard',
    icon: 'dashboard',
    run: () => useWorkspaceStore.getState().setActiveView('dashboard')
  },
  {
    id: 'view-editor',
    group: 'Tampilan',
    title: 'Editor',
    icon: 'note',
    run: () => useWorkspaceStore.getState().setActiveView('editor')
  },
  {
    id: 'view-graph',
    group: 'Tampilan',
    title: 'Graph',
    icon: 'graph',
    run: () => useWorkspaceStore.getState().setActiveView('graph')
  },
  {
    id: 'view-settings',
    group: 'Tampilan',
    title: 'Pengaturan',
    icon: 'settings',
    run: () => useWorkspaceStore.getState().setActiveView('settings')
  },
  {
    id: 'open-search',
    group: 'Tampilan',
    title: 'Cari catatan (quick switcher)',
    keywords: 'search find pencarian',
    icon: 'search',
    shortcut: 'Ctrl+K',
    run: () => window.dispatchEvent(new Event('wg:open-search'))
  },
  {
    id: 'new-note',
    group: 'Buat',
    title: 'Note baru',
    keywords: 'create note catatan',
    icon: 'plus',
    shortcut: 'Ctrl+N',
    run: () => window.dispatchEvent(new Event('wg:new-note'))
  },
  {
    id: 'new-daily',
    group: 'Buat',
    title: 'Catatan harian (Daily)',
    keywords: 'daily note jurnal',
    icon: 'daily',
    shortcut: 'Ctrl+Shift+D',
    run: () => window.dispatchEvent(new Event('wg:new-daily'))
  },
  {
    id: 'new-template',
    group: 'Buat',
    title: 'Note dari template',
    keywords: 'template create',
    icon: 'template',
    shortcut: 'Ctrl+Shift+N',
    run: () => window.dispatchEvent(new Event('wg:open-template'))
  },
  {
    id: 'toggle-sidebar',
    group: 'Panel',
    title: 'Sembunyikan/Tampilkan sidebar',
    icon: 'sidebar',
    shortcut: 'Ctrl+B',
    run: () => useWorkspaceStore.getState().toggleSidebar()
  },
  {
    id: 'toggle-chat',
    group: 'Panel',
    title: 'Sembunyikan/Tampilkan panel AI',
    icon: 'panelRight',
    shortcut: 'Ctrl+J',
    run: () => useWorkspaceStore.getState().toggleAIChat()
  },
  {
    id: 'toggle-split',
    group: 'Panel',
    title: 'Split view editor + graph',
    icon: 'split',
    run: () => window.dispatchEvent(new Event('wg:toggle-split'))
  },
  {
    id: 'graph-fit',
    group: 'Graph',
    title: 'Graph: sesuaikan tampilan',
    icon: 'fitScreen',
    shortcut: 'F',
    run: () => window.dispatchEvent(new CustomEvent('wg:graph-command', { detail: 'fit' }))
  },
  {
    id: 'graph-export',
    group: 'Graph',
    title: 'Graph: ekspor PNG',
    icon: 'save',
    shortcut: 'E',
    run: () => window.dispatchEvent(new CustomEvent('wg:graph-command', { detail: 'export-png' }))
  },
  {
    id: 'graph-save-layout',
    group: 'Graph',
    title: 'Graph: simpan layout',
    icon: 'save',
    shortcut: 'S',
    run: () => window.dispatchEvent(new CustomEvent('wg:graph-command', { detail: 'save-layout' }))
  },
  {
    id: 'graph-reheat',
    group: 'Graph',
    title: 'Graph: susun ulang (re-layout)',
    icon: 'sync',
    shortcut: 'R',
    run: () => window.dispatchEvent(new CustomEvent('wg:graph-command', { detail: 'reheat' }))
  },
  {
    id: 'graph-panel',
    group: 'Graph',
    title: 'Graph: buka/tutup panel filter',
    icon: 'settings',
    shortcut: 'P',
    run: () => window.dispatchEvent(new CustomEvent('wg:graph-command', { detail: 'toggle-panel' }))
  }
]

const SHORTCUT_ROWS: { group: string; rows: [string, string][] }[] = [
  {
    group: 'Umum',
    rows: [
      ['Ctrl+K', 'Cari catatan (quick switcher)'],
      ['Ctrl+P', 'Command palette ini'],
      ['Ctrl+Shift+?', 'Daftar pintasan ini'],
      ['Ctrl+B', 'Sembunyikan/tampilkan sidebar'],
      ['Ctrl+J', 'Sembunyikan/tampilkan panel AI']
    ]
  },
  {
    group: 'Buat & simpan',
    rows: [
      ['Ctrl+N', 'Note baru'],
      ['Ctrl+Shift+N', 'Note dari template'],
      ['Ctrl+Shift+D', 'Catatan harian'],
      ['Ctrl+S', 'Simpan note aktif'],
      ['Ctrl+E', 'Buka view editor']
    ]
  },
  {
    group: 'Editor',
    rows: [
      ['Ctrl+\\', 'Ganti Live / Source mode'],
      ['Ctrl+klik wiki', 'Buka link di tab baru']
    ]
  },
  {
    group: 'Graph',
    rows: [
      ['F', 'Sesuaikan tampilan (fit)'],
      ['R', 'Susun ulang layout'],
      ['S', 'Simpan layout'],
      ['E', 'Ekspor PNG'],
      ['P', 'Buka/tutup panel filter'],
      ['/', 'Fokus pencarian graph'],
      ['Esc', 'Hapus pilihan/fokus'],
      ['Ctrl+klik', 'Pilih beberapa node'],
      ['Ctrl+A', 'Pilih semua'],
      ['Ctrl+C', 'Salin [[link]] node terpilih'],
      ['O', 'Buka note terpilih'],
      ['Shift+klik ×2', 'Cari path antar node'],
      ['Alt+klik', 'Fokus tetangga']
    ]
  }
]

export const CommandPalette: React.FC<{
  isOpen: boolean
  onClose: () => void
  initialMode?: PaletteMode
}> = ({ isOpen, onClose, initialMode = 'commands' }) => {
  const [query, setQuery] = useState('')
  const [mode, setMode] = useState<PaletteMode>(initialMode)
  const [selected, setSelected] = useState(0)
  const [pluginActions, setPluginActions] = useState<PaletteAction[]>([])
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!isOpen) return
    setQuery('')
    setMode(initialMode)
    setSelected(0)
    // Load plugin commands for discoverability (execution from UI not wired yet)
    if (window.api?.listPluginCommands) {
      void window.api
        .listPluginCommands()
        .then((cmds: { id?: string; name?: string; title?: string }[] | null) => {
          const list = (cmds || []).map((c) => ({
            id: `plugin-${c.id || c.name}`,
            group: 'Plugin',
            title: c.title || c.name || c.id || 'Perintah plugin',
            icon: 'command' as IconName,
            run: () =>
              toast(`Eksekusi perintah plugin dari UI belum tersedia: ${c.title || c.name}`, {
                variant: 'info'
              })
          }))
          setPluginActions(list)
        })
        .catch(() => setPluginActions([]))
    }
    const t = window.setTimeout(() => inputRef.current?.focus(), 10)
    return () => window.clearTimeout(t)
  }, [isOpen, initialMode])

  const actions = useMemo(() => [...VIEW_ACTIONS, ...pluginActions], [pluginActions])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return actions
    return actions.filter(
      (a) =>
        a.title.toLowerCase().includes(q) ||
        (a.keywords || '').toLowerCase().includes(q)
    )
  }, [actions, query])

  const grouped = useMemo(() => {
    const map = new Map<string, PaletteAction[]>()
    for (const a of filtered) {
      const arr = map.get(a.group)
      if (arr) arr.push(a)
      else map.set(a.group, [a])
    }
    return [...map.entries()]
  }, [filtered])

  useEffect(() => {
    setSelected(0)
  }, [query, mode])

  useEffect(() => {
    listRef.current?.querySelector('.cmd-item.selected')?.scrollIntoView({ block: 'nearest' })
  }, [selected])

  if (!isOpen) return null

  const flat = filtered

  const runAction = (a: PaletteAction): void => {
    onClose()
    a.run()
  }

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if (mode === 'shortcuts') {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      } else if (e.key === 'Backspace' && !query) {
        setMode('commands')
      } else if (e.key === '?') {
        setMode('commands')
      }
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelected((p) => (p + 1) % Math.max(1, flat.length))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelected((p) => (p - 1 + flat.length) % Math.max(1, flat.length))
    } else if (e.key === 'Enter' && flat[selected]) {
      e.preventDefault()
      runAction(flat[selected])
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    } else if (e.key === '?') {
      setMode('shortcuts')
      setQuery('')
    }
  }

  return (
    <div className="cmd-overlay" onClick={onClose}>
      <div className="cmd-palette" onClick={(e) => e.stopPropagation()}>
        <div className="cmd-input-wrap">
          <Icon
            name={mode === 'shortcuts' ? 'command' : 'search'}
            size={18}
            style={{ color: 'var(--text-muted)' }}
          />
          <input
            ref={inputRef}
            className="cmd-input"
            placeholder={
              mode === 'shortcuts'
                ? 'Pintasan keyboard — tekan ? untuk kembali ke perintah'
                : 'Ketik perintah atau aksi…'
            }
            value={mode === 'shortcuts' ? '' : query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            role="combobox"
            aria-expanded={mode === 'commands' && flat.length > 0}
            aria-label="Command palette"
            autoFocus
          />
        </div>

        {mode === 'shortcuts' ? (
          <div className="cmd-groups" role="list">
            {SHORTCUT_ROWS.map((g) => (
              <div key={g.group}>
                <div className="cmd-group-title">{g.group}</div>
                {g.rows.map(([kbd, desc]) => (
                  <div key={kbd + desc} className="cmd-item" role="listitem">
                    <span className="cmd-kbd" style={{ minWidth: 110, textAlign: 'right' }}>
                      {kbd}
                    </span>
                    <span className="cmd-item-title">{desc}</span>
                  </div>
                ))}
              </div>
            ))}
          </div>
        ) : flat.length === 0 ? (
          <div className="cmd-empty">Tidak ada perintah yang cocok dengan “{query}”.</div>
        ) : (
          <div className="cmd-groups" ref={listRef} role="listbox" aria-label="Perintah">
            {grouped.map(([group, items]) => (
              <div key={group}>
                <div className="cmd-group-title">{group}</div>
                {items.map((a) => {
                  const idx = filtered.indexOf(a)
                  return (
                    <button
                      key={a.id}
                      type="button"
                      role="option"
                      aria-selected={idx === selected}
                      className={`cmd-item ${idx === selected ? 'selected' : ''}`}
                      onMouseEnter={() => setSelected(idx)}
                      onClick={() => runAction(a)}
                    >
                      <Icon name={a.icon} size={15} />
                      <span className="cmd-item-title">{a.title}</span>
                      {a.shortcut && <span className="cmd-kbd">{a.shortcut}</span>}
                    </button>
                  )
                })}
              </div>
            ))}
          </div>
        )}

        <div className="cmd-footer">
          <span>↑↓ pilih · Enter jalankan · Esc tutup</span>
          <span>? pintasan</span>
        </div>
      </div>
    </div>
  )
}

export default CommandPalette
