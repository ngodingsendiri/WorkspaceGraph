/**
 * P1-2: cite-on-hover helpers for the chat citation chips.
 *
 * Reuses the graph's `TooltipPreviewCache` (readFile → markdownToPlainText →
 * first 3 lines / 180 chars, LRU + in-flight dedupe) so a hover sweep across
 * chips never re-reads the same note from disk. `citeTipPos` clamps the fixed
 * tooltip inside the viewport (chips near the right/left edge must not push
 * the preview off-screen).
 */
import { TooltipPreviewCache, type TooltipNodeLike } from '../graph/graphTooltipPreview'

export type CiteReadFn = (path: string) => Promise<{ content: string } | null>

/** Wire the shared preview cache to the app's file reader (window.api.readFile). */
export function makeCitePreviewCache(read: CiteReadFn): TooltipPreviewCache {
  return new TooltipPreviewCache({ read })
}

/** A citation chip always resolves to a markdown note for the cache lookup. */
export function citeNode(path: string): TooltipNodeLike {
  return { id: path, path, type: 'note' }
}

export interface CiteRect {
  left: number
  bottom: number
}

export interface CiteViewport {
  width: number
  height: number
}

/**
 * Tooltip anchor below the chip, clamped to the viewport so it never clips.
 * The tooltip is `position: fixed`, so all coordinates are viewport-relative.
 */
export function citeTipPos(
  rect: CiteRect,
  viewport: CiteViewport,
  opts: { gap?: number; maxWidth?: number; maxHeight?: number } = {}
): { x: number; y: number } {
  const gap = opts.gap ?? 6
  const maxWidth = opts.maxWidth ?? 280
  const maxHeight = opts.maxHeight ?? 220
  const x = Math.min(rect.left, Math.max(0, viewport.width - maxWidth - 8))
  const y = Math.min(rect.bottom + gap, Math.max(0, viewport.height - maxHeight - 8))
  return { x: Math.max(0, x), y: Math.max(0, y) }
}
