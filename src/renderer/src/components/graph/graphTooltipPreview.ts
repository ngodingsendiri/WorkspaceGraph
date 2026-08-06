/**
 * P1-3: tooltip note-content preview.
 *
 * Obsidian's hover tooltip shows the first lines of the note body. This module
 * turns a note's markdown into a short plain-text preview and caches it per
 * note so a hover sweep never re-reads the same file from disk.
 *
 * Two pure helpers (`markdownToPlainText`, `previewLines`) are kept separate
 * from the async cache so they are trivially unit-testable.
 */
export const PREVIEW_MAX_LINES = 3
export const PREVIEW_MAX_CHARS = 180

/**
 * Strip markdown markup into plain text (Obsidian-ish preview fidelity):
 * code fences/inline code, images (dropped entirely), wiki-links & md links
 * (keep the display text), headings, blockquotes, emphasis, HTML tags.
 * Line breaks are preserved so `previewLines` can pick the first paragraph.
 */
export function markdownToPlainText(md: string): string {
  return (
    md
      .replace(/\r\n?/g, '\n')
      // Collapse a fenced block to just its body (one pass so the opening
      // fence can never double-match the closing one)
      .replace(/^```[^\n]*\n([\s\S]*?)^```\s*$/gm, (_m, body: string) => body)
      .replace(/`([^`\n]*)`/g, '$1') // inline code — keep its text (Obsidian renders it)
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g, '$1')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/^#{1,6}\s+/gm, '')
      .replace(/^>\s?/gm, '')
      .replace(/^---+\s*$/gm, '') // hr line only
      .replace(/\*\*|__|~~/g, '')
      .replace(/(^|\s)[*_]([^*_\n]+)[*_](?=$|\s)/gm, '$1$2')
      .replace(/<[^>]+>/g, '')
      .replace(/[ \t]+\n/g, '\n')
      // Collapse 3+ line breaks to a single blank line (removing an hr line or a
      // code fence leaves two adjacent blank lines that read as a huge gap)
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  )
}

/** First `maxLines` non-empty lines, each trimmed, total capped at `maxChars`. */
export function previewLines(
  text: string,
  maxLines = PREVIEW_MAX_LINES,
  maxChars = PREVIEW_MAX_CHARS
): string {
  const lines: string[] = []
  let used = 0
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    const room = maxChars - used
    if (room <= 0) break
    lines.push(line.length > room ? line.slice(0, room) : line)
    used += Math.min(line.length, room)
    if (lines.length >= maxLines) break
  }
  return lines.join('\n').trim()
}

export interface TooltipNodeLike {
  id: string
  path: string
  type: string
  isGhost?: boolean
  isTag?: boolean
  isAttachment?: boolean
}

export interface TooltipPreviewSource {
  read(path: string): Promise<{ content: string } | null>
}

/**
 * Per-note preview cache: dedupes in-flight reads and evicts oldest entries
 * (Map insertion order) once the cap is hit. `invalidate()` drops everything —
 * wired to graph-updated events so edited notes are re-read on the next hover.
 */
export class TooltipPreviewCache {
  private cache = new Map<string, string>()
  private inflight = new Map<string, Promise<string | null>>()
  /** Bumped by invalidate() — stale in-flight reads must not re-populate */
  private gen = 0

  constructor(
    private source: TooltipPreviewSource,
    private maxEntries = 100
  ) {}

  get(node: TooltipNodeLike): Promise<string | null> {
    // Ghosts (unresolved wikilinks), tags and attachments have no note body
    if (node.isGhost || node.isTag || node.isAttachment || node.type !== 'note') {
      return Promise.resolve(null)
    }
    const key = node.path
    const hit = this.cache.get(key)
    if (hit !== undefined) return Promise.resolve(hit)
    const pending = this.inflight.get(key)
    if (pending) return pending
    const gen = this.gen

    const p = this.source
      .read(key)
      .then((res) => {
        this.inflight.delete(key)
        // A graph update invalidated the cache while we were reading — the
        // result is pre-edit content and must not overwrite the fresh state
        if (!res || gen !== this.gen) return null
        const text = previewLines(markdownToPlainText(res.content))
        if (!text) return null
        // Re-insert to refresh LRU order, then evict the oldest entry past cap
        this.cache.delete(key)
        this.cache.set(key, text)
        if (this.cache.size > this.maxEntries) {
          const oldest = this.cache.keys().next().value
          if (oldest !== undefined) this.cache.delete(oldest)
        }
        return text
      })
      .catch(() => {
        this.inflight.delete(key)
        return null
      })
    this.inflight.set(key, p)
    return p
  }

  invalidate(): void {
    this.gen++
    this.cache.clear()
  }
}
