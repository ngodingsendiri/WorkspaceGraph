import React, { useEffect, useRef } from 'react'
import { useEditorStore } from '../../store/editorStore'

export const MarkdownPreview: React.FC<{
  html: string
  /** Click body (not wikilink) → enter edit */
  onRequestEdit?: () => void
  /** Scroll container for outline jump */
  scrollRef?: React.RefObject<HTMLDivElement | null>
}> = ({ html, onRequestEdit, scrollRef }) => {
  const ref = useRef<HTMLDivElement>(null)
  const openTab = useEditorStore((s) => s.openTab)

  useEffect(() => {
    const el = ref.current
    if (!el) return

    const onClick = async (e: MouseEvent) => {
      const target = e.target as HTMLElement

      // Wikilink → navigate (mode baca: label only, no [[ ]])
      const link = target.closest('.wiki-link') as HTMLElement | null
      if (link) {
        e.preventDefault()
        e.stopPropagation()
        const name = link.getAttribute('data-target')
        if (!name) return
        const path = await window.api.resolveWikiLink(name)
        if (path) await openTab(path)
        return
      }

      // Interactive bits — don't steal
      if (target.closest('a, button, input, textarea, pre, code')) return

      // Otherwise: enter edit (unified surface)
      onRequestEdit?.()
    }

    el.addEventListener('click', onClick)
    return () => el.removeEventListener('click', onClick)
  }, [openTab, html, onRequestEdit])

  return (
    <div
      className="preview-pane reading-pane"
      ref={scrollRef as React.RefObject<HTMLDivElement>}
      title="Klik teks untuk edit · klik [[link]] untuk buka"
    >
      <div
        ref={ref}
        className="md-content md-reading"
        dangerouslySetInnerHTML={{
          __html:
            html ||
            '<p class="md-empty-hint">Catatan kosong — klik di sini untuk mulai menulis…</p>'
        }}
      />
    </div>
  )
}

/** slug must match MarkdownEngine headingId */
export function headingSlug(raw: string): string {
  return (
    raw
      .trim()
      .toLowerCase()
      .replace(/[^\w\u00C0-\u024f\s-]/gi, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '') || 'h'
  )
}
