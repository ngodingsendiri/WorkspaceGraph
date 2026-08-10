/**
 * Fence-aware markdown code segmentation (WA-3/4/5/10).
 *
 * Splits markdown into `code` segments (GFM fenced blocks with ``` or ~~~,
 * plus inline `code`) and `text` segments. Shared by:
 *  - MarkdownEngine: wiki-link / tag / heading extraction + HTML rendering
 *  - WorkspaceEngine: link-rewrite during rename must never touch code
 *
 * Rules follow GFM/Obsidian:
 *  - fenced blocks open with ``` or ~~~ (up to 3 leading spaces), close with
 *    the SAME marker; different markers do not close each other
 *  - inline `code` spans are code
 *  - unclosed fences are left as text (parity with the renderer's behavior)
 */

export interface MarkdownSegment {
  type: 'code' | 'text'
  raw: string
}

// Fence alternatives first so a ``` opening is never treated as inline code.
// The lazy body stops at the first occurrence of the SAME closing marker.
const FENCE_OR_INLINE = /(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]+`)/g

/** Split markdown into alternating text/code segments (order preserved). */
export function splitCodeSegments(content: string): MarkdownSegment[] {
  const segments: MarkdownSegment[] = []
  let last = 0
  let m: RegExpExecArray | null
  FENCE_OR_INLINE.lastIndex = 0
  while ((m = FENCE_OR_INLINE.exec(content)) !== null) {
    if (m.index > last) {
      segments.push({ type: 'text', raw: content.slice(last, m.index) })
    }
    segments.push({ type: 'code', raw: m[0] })
    last = m.index + m[0].length
  }
  if (last < content.length) {
    segments.push({ type: 'text', raw: content.slice(last) })
  }
  return segments
}

/** Replace every code segment (fenced + inline) with same-length spaces. */
export function stripCodeRegions(content: string): string {
  let out = ''
  for (const seg of splitCodeSegments(content)) {
    out += seg.type === 'code' ? ' '.repeat(seg.raw.length) : seg.raw
  }
  return out
}

/**
 * True when the line opens or closes a fence (``` or ~~~). Used by line-based
 * scanners (headings) to skip everything inside a code block.
 */
export function fenceMarkerOf(line: string): '```' | '~~~' | null {
  const m = /^\s*(```|~~~)/.exec(line)
  return (m?.[1] as '```' | '~~~' | undefined) ?? null
}
