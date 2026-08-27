import React, { useEffect, useState, useRef } from 'react'
import { useEditorStore } from '../../store/editorStore'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { Icon } from '../ui/Icons'

interface SearchResultItem {
  id: string
  title: string
  path: string
  relativePath: string
  preview?: string
  matchedField: string
}

export const SearchModal: React.FC<{ isOpen: boolean; onClose: () => void }> = ({
  isOpen,
  onClose
}) => {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResultItem[]>([])
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState<string | null>(null)
  const openTab = useEditorStore((s) => s.openTab)
  const setActiveView = useWorkspaceStore((s) => s.setActiveView)
  const inputRef = useRef<HTMLInputElement>(null)
  const itemRefs = useRef<(HTMLDivElement | null)[]>([])

  // Reset selection + focus when the modal opens.
  useEffect(() => {
    if (!isOpen) return
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reset-on-open pattern
    setSelectedIndex(0)
    setTimeout(() => inputRef.current?.focus(), 0)
  }, [isOpen])

  // Keep keyboard selection visible
  useEffect(() => {
    itemRefs.current[selectedIndex]?.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex, results])

  // Prefill from dashboard (tags / orphan)
  useEffect(() => {
    const onPrefill = (e: Event): void => {
      const detail = (e as CustomEvent).detail as string
      if (typeof detail === 'string') setQuery(detail)
    }
    window.addEventListener('search:prefill', onPrefill)
    return () => window.removeEventListener('search:prefill', onPrefill)
  }, [])

  useEffect(() => {
    if (!isOpen) return
    let cancelled = false
    const fetchResults = async (): Promise<void> => {
      setSearching(true)
      setSearchError(null)
      try {
        if (!query.trim()) {
          const recent = await window.api.getRecentNotes(12)
          if (!cancelled) setResults(recent || [])
        } else {
          const searched = await window.api.searchQuery({ query, limit: 20 })
          // M6b PLG-1: merge plugin search-provider results (sandboxed JS).
          let merged: SearchResultItem[] = searched || []
          try {
            const providers = await window.api.getPluginSearchProviders()
            if (providers && providers.length > 0) {
              const extra = await Promise.all(
                providers.map(async (p) => {
                  const r = await window.api.runPluginSearchProvider(
                    p.pluginId,
                    p.id,
                    query,
                    5
                  )
                  const rows = Array.isArray(r?.result) ? (r.result as SearchResultItem[]) : []
                  return rows.map((row) => ({
                    ...row,
                    id: `plugin:${p.pluginId}:${row.id ?? row.path ?? row.title}`,
                    matchedField: row.matchedField || `plugin:${p.name}`
                  }))
                })
              )
              merged = [...merged, ...extra.flat()].slice(0, 30)
            }
          } catch {
            /* plugin search is best-effort — never blocks local results */
          }
          if (!cancelled) setResults(merged)
        }
      } catch (err) {
        if (!cancelled) {
          setResults([])
          setSearchError(err instanceof Error ? err.message : 'Pencarian gagal')
        }
      } finally {
        if (!cancelled) setSearching(false)
      }
    }
    const t = setTimeout(fetchResults, 80)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [query, isOpen])

  const handleSelect = async (item: SearchResultItem): Promise<void> => {
    await openTab(item.path)
    setActiveView('editor')
    onClose()
    setQuery('')
  }

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelectedIndex((prev) => (prev + 1) % Math.max(1, results.length))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelectedIndex((prev) => (prev - 1 + results.length) % Math.max(1, results.length))
    } else if (e.key === 'Enter' && results[selectedIndex]) {
      e.preventDefault()
      handleSelect(results[selectedIndex])
    } else if (e.key === 'Escape') {
      onClose()
    }
  }

  if (!isOpen) return null

  return (
    <div className="search-overlay" onClick={onClose}>
      <div className="search-modal" onClick={(e) => e.stopPropagation()}>
        <div className="search-input-wrap">
          <Icon name="search" size={18} style={{ color: 'var(--text-muted)' }} />
          {searching && <span className="search-spinner" aria-label="Mencari…" />}
          <input
            ref={inputRef}
            className="search-input"
            placeholder="Cari · #tag · orphan:true · backlink:Judul · path:… (Esc)"
            value={query}
            role="combobox"
            aria-expanded={results.length > 0}
            aria-controls="search-results-list"
            aria-activedescendant={
              results[selectedIndex] ? `search-opt-${selectedIndex}` : undefined
            }
            aria-label="Pencarian catatan"
            onChange={(e) => {
              setQuery(e.target.value)
              setSelectedIndex(0)
            }}
            onKeyDown={handleKeyDown}
            autoFocus
          />
        </div>

        <div
          id="search-results-list"
          className="search-results"
          role="listbox"
          aria-label="Hasil pencarian"
        >
          {searchError ? (
            <div
              style={{
                padding: 'var(--space-6)',
                textAlign: 'center',
                color: 'var(--color-error)'
              }}
            >
              <div style={{ marginBottom: 'var(--space-2)' }}>Pencarian gagal: {searchError}</div>
              <button
                className="btn btn-sm btn-surface"
                onClick={() => {
                  setSearchError(null)
                  setQuery((q) => q)
                }}
              >
                Coba lagi
              </button>
            </div>
          ) : results.length === 0 ? (
            <div
              style={{ padding: 'var(--space-6)', textAlign: 'center', color: 'var(--text-muted)' }}
            >
              {query.trim() ? 'Tidak ada hasil.' : 'Belum ada catatan terbaru.'}
            </div>
          ) : (
            results.map((item, idx) => (
              <div
                key={item.id + item.path}
                ref={(el) => {
                  itemRefs.current[idx] = el
                }}
                id={`search-opt-${idx}`}
                role="option"
                aria-selected={idx === selectedIndex}
                className={`search-result-item ${idx === selectedIndex ? 'selected' : ''}`}
                onClick={() => handleSelect(item)}
                onMouseEnter={() => setSelectedIndex(idx)}
              >
                <div className="search-result-icon">
                  <Icon name="file" size={14} />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="search-result-title truncate">{item.title}</div>
                  <div className="search-result-path truncate">{item.relativePath}</div>
                  {item.preview && <div className="search-result-preview">{item.preview}</div>}
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  )
}
