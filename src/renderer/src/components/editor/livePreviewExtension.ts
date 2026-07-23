/**
 * Obsidian-like Live Preview for CodeMirror 6.
 *
 * IMPORTANT (CM6 rule): block decorations MUST NOT come from ViewPlugin —
 * they throw RangeError "Block decorations may not be specified via plugins"
 * and crash the React editor. Tables use inline line-replace widgets instead.
 *
 * Decorations are best-effort: builder failures return empty set.
 */
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  WidgetType,
  type ViewUpdate
} from '@codemirror/view'
import { RangeSetBuilder } from '@codemirror/state'

function rangeActive(view: EditorView, from: number, to: number): boolean {
  for (const r of view.state.selection.ranges) {
    if (r.from < to && r.to > from) return true
    if (r.empty && r.head >= from && r.head <= to) return true
  }
  return false
}

function lineActive(view: EditorView, lineFrom: number, lineTo: number): boolean {
  for (const r of view.state.selection.ranges) {
    if (r.from <= lineTo && r.to >= lineFrom) return true
  }
  return false
}

type DecKind = 'replace' | 'mark'
type DecSpec = { from: number; to: number; deco: Decoration; kind: DecKind }

function hide(out: DecSpec[], from: number, to: number): void {
  if (to > from) out.push({ from, to, kind: 'replace', deco: Decoration.replace({}) })
}
function mark(out: DecSpec[], from: number, to: number, cls: string): void {
  if (to > from) out.push({ from, to, kind: 'mark', deco: Decoration.mark({ class: cls }) })
}

class WikiLinkWidget extends WidgetType {
  constructor(
    readonly label: string,
    readonly target: string,
    readonly from: number,
    readonly to: number
  ) {
    super()
  }
  eq(o: WikiLinkWidget): boolean {
    return (
      this.label === o.label &&
      this.target === o.target &&
      this.from === o.from &&
      this.to === o.to
    )
  }
  toDOM(): HTMLElement {
    const span = document.createElement('span')
    span.className = 'cm-lp-wiki'
    span.textContent = this.label
    span.title = `[[${this.target}]] · klik edit · Ctrl+klik buka`
    span.setAttribute('data-from', String(this.from))
    span.setAttribute('data-to', String(this.to))
    span.setAttribute('data-target', this.target)
    return span
  }
  ignoreEvent(e: Event): boolean {
    return e.type !== 'mousedown' && e.type !== 'click'
  }
}

function parseWikiInner(inner: string): { target: string; label: string } {
  const normalized = inner.replace(/\\\|/g, '|')
  const pipe = normalized.indexOf('|')
  let target = (pipe >= 0 ? normalized.slice(0, pipe) : normalized).trim()
  const alias = pipe >= 0 ? normalized.slice(pipe + 1).trim() : ''
  target = target
    .split('#')[0]
    .split('^')[0]
    .trim()
    .replace(/\\/g, '/')
    .replace(/\/+$/g, '')
  return { target, label: alias || target || inner }
}

export type WikiOpenHandler = (target: string) => void
let openHandler: WikiOpenHandler | null = null
export function setLivePreviewOpenHandler(fn: WikiOpenHandler | null): void {
  openHandler = fn
}

function collectInline(text: string, lineFrom: number, view: EditorView, out: DecSpec[]): void {
  let m: RegExpExecArray | null

  const wikiRe = /!?\[\[([^\]\n]+?)\]\]/g
  while ((m = wikiRe.exec(text))) {
    const from = lineFrom + m.index
    const to = from + m[0].length
    if (rangeActive(view, from, to)) continue
    const { target, label } = parseWikiInner(m[1])
    if (!label) continue
    out.push({
      from,
      to,
      kind: 'replace',
      deco: Decoration.replace({
        widget: new WikiLinkWidget(label, target, from, to),
        inclusive: false
      })
    })
  }

  const boldRe = /\*\*([^*\n]+?)\*\*/g
  while ((m = boldRe.exec(text))) {
    const from = lineFrom + m.index
    const to = from + m[0].length
    if (rangeActive(view, from, to)) continue
    hide(out, from, from + 2)
    mark(out, from + 2, to - 2, 'cm-lp-strong')
    hide(out, to - 2, to)
  }

  // single *italic* — avoid matching ** pairs (no catastrophic lookbehinds)
  const italRe = /\*([^*\n]+?)\*/g
  while ((m = italRe.exec(text))) {
    const idx = m.index
    if (text[idx - 1] === '*' || text[idx + m[0].length] === '*') continue
    if (text[idx + 1] === '*') continue
    const from = lineFrom + idx
    const to = from + m[0].length
    if (rangeActive(view, from, to)) continue
    hide(out, from, from + 1)
    mark(out, from + 1, to - 1, 'cm-lp-em')
    hide(out, to - 1, to)
  }

  const codeRe = /`([^`\n]+?)`/g
  while ((m = codeRe.exec(text))) {
    const from = lineFrom + m.index
    const to = from + m[0].length
    if (rangeActive(view, from, to)) continue
    hide(out, from, from + 1)
    mark(out, from + 1, to - 1, 'cm-lp-code')
    hide(out, to - 1, to)
  }

  const strikeRe = /~~([^~\n]+?)~~/g
  while ((m = strikeRe.exec(text))) {
    const from = lineFrom + m.index
    const to = from + m[0].length
    if (rangeActive(view, from, to)) continue
    hide(out, from, from + 2)
    mark(out, from + 2, to - 2, 'cm-lp-strike')
    hide(out, to - 2, to)
  }

  const hiRe = /==([^=\n]+?)==/g
  while ((m = hiRe.exec(text))) {
    const from = lineFrom + m.index
    const to = from + m[0].length
    if (rangeActive(view, from, to)) continue
    hide(out, from, from + 2)
    mark(out, from + 2, to - 2, 'cm-lp-highlight')
    hide(out, to - 2, to)
  }
}

/**
 * Safe RangeSet build — never throws to React.
 * Replaces must be non-overlapping and sorted; marks skip replace interiors.
 */
function buildSafe(specs: DecSpec[]): DecorationSet {
  const sorted = [...specs].sort((a, b) => {
    if (a.from !== b.from) return a.from - b.from
    // replaces before marks at same pos
    if (a.kind !== b.kind) return a.kind === 'replace' ? -1 : 1
    return a.to - b.to
  })

  // Merge non-overlapping replaces first
  const replaces: DecSpec[] = []
  let repEnd = -1
  for (const s of sorted) {
    if (s.kind !== 'replace') continue
    if (s.from < 0 || s.to <= s.from) continue
    if (s.from < repEnd) continue
    replaces.push(s)
    repEnd = s.to
  }

  const marks: DecSpec[] = []
  for (const s of sorted) {
    if (s.kind !== 'mark') continue
    if (s.from < 0 || s.to <= s.from) continue
    // skip if starts inside any replace
    let inside = false
    for (const r of replaces) {
      if (s.from >= r.from && s.from < r.to) {
        inside = true
        break
      }
    }
    if (inside) continue
    marks.push(s)
  }

  const all = [...replaces, ...marks].sort((a, b) => {
    if (a.from !== b.from) return a.from - b.from
    if (a.kind !== b.kind) return a.kind === 'replace' ? -1 : 1
    return a.to - b.to
  })

  const builder = new RangeSetBuilder<Decoration>()
  for (const s of all) {
    try {
      builder.add(s.from, s.to, s.deco)
    } catch {
      /* skip bad range — never throw */
    }
  }
  try {
    return builder.finish()
  } catch {
    return Decoration.none
  }
}

function collectDecos(view: EditorView): DecorationSet {
  try {
    const specs: DecSpec[] = []
    const doc = view.state.doc
    if (doc.length === 0) return Decoration.none
    // Hard cap — never hang the UI on dense notes
    if (doc.lines > 500 || doc.length > 20_000) return Decoration.none

    for (const vr of view.visibleRanges) {
      let pos = vr.from
      let guard = 0
      let linesDone = 0
      while (pos <= vr.to && guard++ < 8000 && linesDone < 120) {
        const line = doc.lineAt(Math.min(pos, doc.length))
        const text = line.text
        const lf = line.from
        const lt = line.to
        linesDone++

        // Skip heavy table rows (many pipes / long lines) — leave as plain text
        if (text.length > 400 || (text.match(/\|/g) || []).length >= 4) {
          if (line.number >= doc.lines) break
          pos = line.to + 1
          if (pos <= lf) break
          continue
        }

        const active = lineActive(view, lf, lt)

        if (!active) {
          if (text === '---' || text === '+++') {
            mark(specs, lf, lt, 'cm-lp-frontmatter-fence')
          }

          const hm = /^(#{1,6})(\s+)(.*)$/.exec(text)
          if (hm) {
            const hashEnd = lf + hm[1].length + hm[2].length
            hide(specs, lf, hashEnd)
            if (hm[3].length) mark(specs, hashEnd, lt, `cm-lp-h${hm[1].length}`)
          } else {
            const qm = /^(>+)(\s?)/.exec(text)
            if (qm) {
              hide(specs, lf, lf + qm[0].length)
              if (lt > lf + qm[0].length) mark(specs, lf + qm[0].length, lt, 'cm-lp-quote')
            }

            const lm = /^(\s*)([-*+])(\s+)/.exec(text)
            if (lm) {
              const ms = lf + lm[1].length
              hide(specs, ms, ms + 1)
            }
          }
        }

        collectInline(text, lf, view, specs)

        if (line.number >= doc.lines) break
        pos = line.to + 1
        if (pos <= lf) break
      }
    }

    return buildSafe(specs)
  } catch (err) {
    console.warn('[livePreview] decoration failed (safe fallback):', err)
    return Decoration.none
  }
}

const livePreviewPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    constructor(view: EditorView) {
      this.decorations = collectDecos(view)
    }
    update(u: ViewUpdate): void {
      // Avoid full recompute on every caret tick for medium docs
      if (u.docChanged || u.viewportChanged) {
        this.decorations = collectDecos(u.view)
        return
      }
      if (u.selectionSet && u.state.doc.lines <= 200) {
        this.decorations = collectDecos(u.view)
      }
    }
  },
  {
    decorations: (v) => v.decorations,
    eventHandlers: {
      mousedown(event, view) {
        try {
          const t = event.target as HTMLElement | null
          const el = t?.closest?.('.cm-lp-wiki') as HTMLElement | null
          if (!el) return false
          const from = Number(el.getAttribute('data-from'))
          const to = Number(el.getAttribute('data-to'))
          const target = el.getAttribute('data-target') || ''
          if (!Number.isFinite(from) || !Number.isFinite(to)) return false

          if (event.ctrlKey || event.metaKey) {
            event.preventDefault()
            openHandler?.(target)
            return true
          }
          event.preventDefault()
          const mid = Math.min(to - 2, Math.max(from, from + 2))
          view.dispatch({ selection: { anchor: mid }, scrollIntoView: true })
          view.focus()
          return true
        } catch {
          return false
        }
      }
    }
  }
)

const livePreviewTheme = EditorView.baseTheme({
  // Body inherits Obsidian-like --note-* tokens from CSS
  '&': { color: 'var(--note-text)' },
  // Headings: body color, sizes from --note-h* (lebih ringkas)
  '.cm-lp-h1': {
    fontSize: 'var(--note-h1-size, 1.45em)',
    fontWeight: '700',
    lineHeight: '1.3',
    color: 'var(--note-text)',
    letterSpacing: '-0.01em'
  },
  '.cm-lp-h2': {
    fontSize: 'var(--note-h2-size, 1.28em)',
    fontWeight: '700',
    lineHeight: '1.3',
    color: 'var(--note-text)',
    letterSpacing: '-0.01em'
  },
  '.cm-lp-h3': {
    fontSize: 'var(--note-h3-size, 1.15em)',
    fontWeight: '650',
    lineHeight: '1.35',
    color: 'var(--note-text)'
  },
  '.cm-lp-h4': {
    fontSize: 'var(--note-h4-size, 1.08em)',
    fontWeight: '650',
    color: 'var(--note-text)'
  },
  '.cm-lp-h5': {
    fontSize: 'var(--note-h5-size, 1.02em)',
    fontWeight: '600',
    color: 'var(--note-text)'
  },
  '.cm-lp-h6': {
    fontSize: 'var(--note-h6-size, 0.95em)',
    fontWeight: '600',
    color: 'var(--note-text)'
  },
  '.cm-lp-strong': { fontWeight: '700', color: 'var(--note-text)' },
  '.cm-lp-em': { fontStyle: 'italic' },
  '.cm-lp-strike': { textDecoration: 'line-through', opacity: '0.8' },
  '.cm-lp-highlight': {
    backgroundColor: 'var(--note-highlight)',
    borderRadius: '2px'
  },
  '.cm-lp-code': {
    fontFamily: 'var(--font-text, Inter, sans-serif)',
    fontSize: '0.92em',
    color: 'var(--note-text)',
    backgroundColor: 'var(--note-code-bg)',
    border: 'none',
    borderRadius: '3px',
    padding: '0 0.3em'
  },
  '.cm-lp-quote': {
    color: 'var(--note-blockquote-color)',
    fontStyle: 'italic',
    borderLeft: '3px solid var(--note-blockquote-border)',
    paddingLeft: '10px',
    backgroundColor: 'var(--note-blockquote-bg)'
  },
  // Wikilinks — soft accent, no loud underline (closer to Obsidian default)
  '.cm-lp-wiki': {
    color: 'var(--note-link)',
    cursor: 'pointer',
    textDecoration: 'none',
    borderBottom: 'none'
  },
  '.cm-lp-wiki:hover': {
    color: 'var(--note-link-hover)',
    textDecoration: 'underline',
    textUnderlineOffset: '2px'
  },
  '.cm-lp-frontmatter-fence': {
    opacity: '0.5',
    fontFamily: 'var(--font-text, Inter, sans-serif)',
    color: 'var(--note-text-muted)',
    fontSize: '0.9em'
  },
  '.cm-lp-table-wrap': {
    display: 'block',
    margin: '10px 0 14px',
    overflowX: 'auto',
    cursor: 'text',
    maxWidth: '100%',
    boxSizing: 'border-box'
  },
  '.cm-lp-table': {
    width: '100%',
    borderCollapse: 'collapse',
    fontSize: '0.95em',
    fontFamily: "'Inter', var(--font-text), system-ui, sans-serif",
    color: 'var(--note-text)',
    border: '1px solid var(--note-table-border)'
  },
  '.cm-lp-table th, .cm-lp-table td': {
    border: '1px solid var(--note-table-border)',
    padding: '7px 11px',
    textAlign: 'left',
    verticalAlign: 'top'
  },
  '.cm-lp-table th': {
    background: 'var(--note-table-header-bg)',
    fontWeight: '600',
    color: 'var(--note-heading)'
  },
  '.cm-lp-table td': {
    background: 'transparent'
  },
  '.cm-lp-table tr:hover td': {
    background: 'var(--bg-hover)'
  }
})

export function livePreviewExtension() {
  return [livePreviewPlugin, livePreviewTheme]
}
