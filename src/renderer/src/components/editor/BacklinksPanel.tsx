import React, { useMemo } from 'react'
import { useEditorStore } from '../../store/editorStore'
import { headingSlug } from './MarkdownPreview'

/** Quiet inspector — outline + backlinks / outgoing (Obsidian-like) */
export const BacklinksPanel: React.FC<{
  onJumpHeading?: (text: string, level: number) => void
}> = ({ onJumpHeading }) => {
  const backlinks = useEditorStore((s) => s.backlinks)
  const outgoing = useEditorStore((s) => s.outgoing)
  const openTab = useEditorStore((s) => s.openTab)
  const active = useEditorStore((s) => s.tabs.find((t) => t.id === s.activeTabId))

  const headings = useMemo(() => {
    if (!active?.content) return [] as { level: number; text: string }[]
    let body = active.content
    if (body.startsWith('---')) {
      const end = body.indexOf('\n---', 3)
      if (end !== -1) body = body.slice(end + 4)
    }
    const list: { level: number; text: string }[] = []
    for (const line of body.split('\n')) {
      const m = line.match(/^(#{1,6})\s+(.+)$/)
      if (m) list.push({ level: m[1].length, text: m[2].trim() })
    }
    return list
  }, [active?.content])

  return (
    <div className="backlinks-panel">
      <div className="inspector-head">
        <span className="section-title" style={{ padding: 0, margin: 0 }}>
          Inspector
        </span>
      </div>

      <div className="inspector-body">
        <div className="inspector-label">Outline ({headings.length})</div>
        {headings.length === 0 ? (
          <div className="inspector-empty">No headings</div>
        ) : (
          headings.map((h, i) => (
            <button
              type="button"
              key={`${h.level}-${i}-${h.text}`}
              className="inspector-outline-item"
              style={{ paddingLeft: 8 + (h.level - 1) * 10 }}
              title={h.text}
              onClick={() => onJumpHeading?.(h.text, h.level)}
            >
              {h.text}
            </button>
          ))
        )}

        <div className="inspector-label" style={{ marginTop: 14 }}>
          Backlinks ({backlinks.length})
        </div>
        {backlinks.length === 0 ? (
          <div className="inspector-empty">No backlinks</div>
        ) : (
          backlinks.map((b) => (
            <button
              key={b.path}
              type="button"
              className="nav-item inspector-link"
              onClick={() => openTab(b.path)}
            >
              {b.title}
            </button>
          ))
        )}

        <div className="inspector-label" style={{ marginTop: 12 }}>
          Outgoing ({outgoing.length})
        </div>
        {outgoing.length === 0 ? (
          <div className="inspector-empty">No outgoing links</div>
        ) : (
          outgoing.map((b) => (
            <button
              key={b.path}
              type="button"
              className="nav-item inspector-link"
              onClick={() => openTab(b.path)}
            >
              {b.title}
            </button>
          ))
        )}

        {active && (
          <div className="inspector-meta" title={active.path}>
            {headingSlug(active.title)} · {active.isDirty ? 'unsaved' : 'saved'}
          </div>
        )}
      </div>
    </div>
  )
}
