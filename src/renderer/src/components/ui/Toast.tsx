/**
 * Lightweight Toast notification system.
 * No dependencies — uses a Zustand store + a singleton <Toaster> component.
 *
 * Usage:
 *   // Show a toast anywhere:
 *   import { toast } from "@/components/ui/Toast"
 *   toast("Done!", { variant: "success", duration: 3000 })
 *
 *   // Mount once in App root:
 *   import { Toaster } from "@/components/ui/Toast"
 *   <Toaster />
 */

import { useEffect } from 'react'
import { create } from 'zustand'

export type ToastVariant = 'info' | 'success' | 'warning' | 'error'

export interface ToastItem {
  id: string
  message: string
  variant: ToastVariant
  duration: number
}

interface ToastStore {
  items: ToastItem[]
  add: (item: ToastItem) => void
  remove: (id: string) => void
}

const useToastStore = create<ToastStore>((set) => ({
  items: [],
  add: (item) => set((s) => ({ items: [...s.items.slice(-4), item] })),
  remove: (id) => set((s) => ({ items: s.items.filter((i) => i.id !== id) }))
}))

/** Show a toast notification from anywhere in the app */
export function toast(message: string, opts?: { variant?: ToastVariant; duration?: number }): void {
  const id = Math.random().toString(36).slice(2)
  useToastStore.getState().add({
    id,
    message,
    variant: opts?.variant ?? 'info',
    duration: opts?.duration ?? 3500
  })
}

function ToastEntry({ item }: { item: ToastItem }) {
  const remove = useToastStore((s) => s.remove)
  useEffect(() => {
    const t = setTimeout(() => remove(item.id), item.duration)
    return () => clearTimeout(t)
  }, [item.id, item.duration, remove])

  const colors: Record<ToastVariant, string> = {
    info: 'var(--accent, #6366f1)',
    success: 'var(--success, #22c55e)',
    warning: 'var(--warning, #f59e0b)',
    error: 'var(--error, #ef4444)'
  }
  const icons: Record<ToastVariant, string> = {
    info: 'ℹ️',
    success: '✅',
    warning: '⚠️',
    error: '❌'
  }

  return (
    <div
      role="status"
      aria-live="polite"
      onClick={() => remove(item.id)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        padding: '10px 16px',
        borderRadius: '8px',
        background: 'var(--surface-2, #1e1e2e)',
        border: `1px solid ${colors[item.variant]}44`,
        boxShadow: `0 4px 20px ${colors[item.variant]}22`,
        color: 'var(--text-primary, #cdd6f4)',
        fontSize: '13px',
        cursor: 'pointer',
        animation: 'toast-slide-in 0.2s ease',
        userSelect: 'none',
        maxWidth: '380px',
        wordBreak: 'break-word'
      }}
    >
      <span style={{ fontSize: '16px', flexShrink: 0 }}>{icons[item.variant]}</span>
      <span style={{ flex: 1 }}>{item.message}</span>
      <span style={{ opacity: 0.4, fontSize: '11px', flexShrink: 0 }}>✕</span>
    </div>
  )
}

/** Mount once in App root to render toast notifications */
export function Toaster() {
  const items = useToastStore((s) => s.items)
  return (
    <div
      aria-label="Notifications"
      style={{
        position: 'fixed',
        bottom: '20px',
        right: '20px',
        zIndex: 9999,
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
        pointerEvents: items.length > 0 ? 'auto' : 'none'
      }}
    >
      <style>{`
        @keyframes toast-slide-in {
          from { opacity: 0; transform: translateY(12px) scale(0.96); }
          to   { opacity: 1; transform: translateY(0) scale(1); }
        }
      `}</style>
      {items.map((item) => (
        <ToastEntry key={item.id} item={item} />
      ))}
    </div>
  )
}
