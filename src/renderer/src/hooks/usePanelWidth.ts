import { useCallback, useEffect, useRef, useState } from 'react'

export interface PanelDrag {
  width: number
  /** Attach to a drag handle (div). Caller must pass the measure function at hook creation. */
  onHandleMouseDown: (e: React.MouseEvent) => void
  resizing: boolean
}

/**
 * Draggable panel width with localStorage persistence.
 *
 * `measure(clientX)` must translate the pointer X into the desired width:
 *   - sidebar (left edge pinned): (x) => x
 *   - chat (right edge pinned):   (x) => window.innerWidth - x
 */
export function usePanelWidth(
  storageKey: string,
  defaultWidth: number,
  min: number,
  max: number,
  measure: (clientX: number) => number
): PanelDrag {
  const [width, setWidth] = useState<number>(() => {
    try {
      const raw = localStorage.getItem(storageKey)
      if (raw !== null) {
        const v = Number(raw)
        if (Number.isFinite(v) && v >= min && v <= max) return v
      }
    } catch {
      /* storage unavailable */
    }
    return defaultWidth
  })
  const [resizing, setResizing] = useState(false)
  const draggingRef = useRef(false)
  const measureRef = useRef(measure)
  measureRef.current = measure

  useEffect(() => {
    const onMove = (e: MouseEvent): void => {
      if (!draggingRef.current) return
      const next = Math.min(max, Math.max(min, Math.round(measureRef.current(e.clientX))))
      setWidth(next)
    }
    const onUp = (): void => {
      if (!draggingRef.current) return
      draggingRef.current = false
      setResizing(false)
      document.body.classList.remove('wg-resizing')
      try {
        localStorage.setItem(storageKey, String(width))
      } catch {
        /* ignore */
      }
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [min, max, storageKey, width])

  const onHandleMouseDown = useCallback((e: React.MouseEvent): void => {
    e.preventDefault()
    draggingRef.current = true
    setResizing(true)
    document.body.classList.add('wg-resizing')
  }, [])

  return { width, onHandleMouseDown, resizing }
}
