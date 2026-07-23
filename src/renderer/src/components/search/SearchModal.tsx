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
  const openTab = useEditorStore((s) => s.openTab)
  const setActiveView = useWorkspaceStore((s) => s.setActiveView)
  const inputRef = useRef<HTMLInputElement>(null)
  const itemRefs = useRef<(HTMLDivElement | null)[]>([])

  useEffect(() => {
    if (!isOpen) return
    setSelectedIndex(0)
    setTimeout(() => inputRef.current?.focus(), 0)
  }, [isOpen])

  // Keep keyboard selection visible
  useEffect(() => {
    itemRefs.current[selectedIndex]?.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex, results])

  // Prefill from dashboard (tags / orphan)
  useEffect(() => {
    const onPrefill = (e: Event) => {
      const detail = (e as CustomEvent).detail as string
      if (typeof detail === 'string') setQuery(detail)
    }
    window.addEventListener('search:prefill', onPrefill)
    return () => window.removeEventListener('search:prefill', onPrefill)
  }, [])

  useEffect(() => {
    if (!isOpen) return
    let cancelled = false
    const fetchResults = async () => {
      try {
        if (!query.trim()) {
          const recent = await window.api.getRecentNotes(12)
          if (!cancelled) setResults(recent || [])
        } else {
          const searched = await window.api.searchQuery({ query, limit: 20 })
          if (!cancelled) setResults(searched || [])
        }
      } catch {
        if (!cancelled) setResults([])
      }
    }
    const t = setTimeout(fetchResults, 80)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [query, isOpen])

  const handleSelect = async (item: SearchResultItem) => {
    await openTab(item.path)
    setActiveView('editor')
    onClose()
    setQuery('')
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
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
          <input
            ref={inputRef}
            className="search-input"
            placeholder="Search · #tag · orphan:true · backlink:Title · path:… (Esc)"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setSelectedIndex(0)
            }}
            onKeyDown={handleKeyDown}
            autoFocus
          />
        </div>

        <div className="search-results">
          {results.length === 0 ? (
            <div
              style={{ padding: 'var(--space-6)', textAlign: 'center', color: 'var(--text-muted)' }}
            >
              {query.trim() ? 'No matches found.' : 'No recent notes yet.'}
            </div>
          ) : (
            results.map((item, idx) => (
              <div
                key={item.id + item.path}
                ref={(el) => {
                  itemRefs.current[idx] = el
                }}
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
