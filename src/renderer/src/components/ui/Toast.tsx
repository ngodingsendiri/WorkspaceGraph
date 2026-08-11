/**
 * Lightweight Toast notification system.
 * No dependencies — uses a Zustand store + a singleton <Toaster> component.
 * Styling lives in globals.css (.toast-host / .toast) so dark & light themes
 * both follow the design tokens.
 *
 * Usage:
 *   import { toast } from "../components/ui/Toast"
 *   toast("Selesai!", { variant: "success", duration: 3000 })
 *
 *   // Mount once in App root:
 *   <Toaster />
 */

import { useEffect } from 'react'
import { create } from 'zustand'
import { Icon, type IconName } from './Icons'

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
// eslint-disable-next-line react-refresh/only-export-components -- imperative toast API, not a component
export function toast(message: string, opts?: { variant?: ToastVariant; duration?: number }): void {
  const id = Math.random().toString(36).slice(2)
  useToastStore.getState().add({
    id,
    message,
    variant: opts?.variant ?? 'info',
    duration: opts?.duration ?? 3500
  })
}

const VARIANT_ICON: Record<ToastVariant, IconName> = {
  info: 'info',
  success: 'checkCircle',
  warning: 'warning',
  error: 'cancel'
}

function ToastEntry({ item }: { item: ToastItem }): React.JSX.Element {
  const remove = useToastStore((s) => s.remove)
  useEffect(() => {
    const t = setTimeout(() => remove(item.id), item.duration)
    return () => clearTimeout(t)
  }, [item.id, item.duration, remove])

  return (
    <div
      role="status"
      aria-live="polite"
      className={`toast toast-${item.variant}`}
      onClick={() => remove(item.id)}
      title="Klik untuk menutup"
    >
      <span className="toast-icon">
        <Icon name={VARIANT_ICON[item.variant]} size={16} />
      </span>
      <span className="toast-msg">{item.message}</span>
      <span className="toast-close">
        <Icon name="close" size={12} />
      </span>
    </div>
  )
}

/** Mount once in App root to render toast notifications */
export function Toaster(): React.JSX.Element {
  const items = useToastStore((s) => s.items)
  return (
    <div
      className="toast-host"
      aria-label="Notifications"
      style={{ pointerEvents: items.length > 0 ? 'auto' : 'none' }}
    >
      {items.map((item) => (
        <ToastEntry key={item.id} item={item} />
      ))}
    </div>
  )
}
