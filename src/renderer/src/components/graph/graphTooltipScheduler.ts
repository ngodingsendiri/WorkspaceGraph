/**
 * P1-2: hover-delay scheduler for the DOM tooltip.
 *
 * Obsidian shows its tooltip only after the cursor has *rested* on a node
 * (~250ms); a fast sweep across a dense graph must not flicker a tooltip per
 * node. This factory owns the whole lifecycle in one testable place:
 *
 *  - `hover(node, x, y)`   — arm/show/follow. Node change re-arms the timer.
 *  - `hover(null, x, y)`   — moved to empty space → hide immediately.
 *  - `leave()`             — pointer left the surface → cancel + hide.
 *  - `dispose()`           — unbind/unmount → cancel any pending timer.
 *
 * While the timer is pending, later moves on the same node refresh the stored
 * anchor so the tooltip pops at the cursor's final position. Once visible, the
 * cursor is followed via the `move` callback every pointermove.
 */
export const TOOLTIP_DELAY_MS = 250

export interface TooltipScheduler<N> {
  /** pointermove over the graph surface; pass null when no node is hit */
  hover(node: N | null, clientX: number, clientY: number): void
  /** pointer left the surface (or a gesture started) — cancel + hide */
  leave(): void
  /** permanent cleanup — drop any pending timer without touching visibility */
  dispose(): void
}

export interface TooltipSchedulerOptions<N> {
  delay?: number
  show: (node: N, clientX: number, clientY: number) => void
  move: (clientX: number, clientY: number) => void
  hide: () => void
  /** true while the tooltip is currently visible (used to decide follow vs arm) */
  isVisible: () => boolean
}

export function createTooltipScheduler<N>(opts: TooltipSchedulerOptions<N>): TooltipScheduler<N> {
  const delay = opts.delay ?? TOOLTIP_DELAY_MS
  let hoverId: string | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let pending: { node: N; clientX: number; clientY: number; id: string } | null = null

  const cancel = (): void => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    pending = null
  }

  const showNow = (): void => {
    timer = null
    const p = pending
    pending = null
    if (p) opts.show(p.node, p.clientX, p.clientY)
  }

  return {
    hover(node, clientX, clientY) {
      if (node == null) {
        // Empty space — drop any pending show, hide only if actually up
        hoverId = null
        cancel()
        if (opts.isVisible()) opts.hide()
        return
      }
      const id = (node as { id?: string }).id ?? null
      if (id == null) {
        // Node without an id — treat as empty space
        hoverId = null
        cancel()
        if (opts.isVisible()) opts.hide()
        return
      }
      if (id !== hoverId) {
        // Different node: hide a stale tooltip NOW (no-op when nothing is up —
        // fast sweeps never flicker), then re-arm the timer
        const wasVisible = opts.isVisible()
        hoverId = id
        cancel()
        if (wasVisible) opts.hide()
        pending = { node, clientX, clientY, id }
        timer = setTimeout(showNow, delay)
        return
      }
      if (opts.isVisible()) {
        // Tooltip is up — follow the cursor
        opts.move(clientX, clientY)
      } else if (pending) {
        // Timer still running — anchor the pop at the cursor's final position
        pending.clientX = clientX
        pending.clientY = clientY
      }
    },
    leave() {
      hoverId = null
      cancel()
      opts.hide()
    },
    dispose() {
      hoverId = null
      cancel()
    }
  }
}
