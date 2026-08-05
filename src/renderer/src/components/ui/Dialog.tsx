/**
 * Lightweight custom dialog system — Obsidian-clean replacement for
 * native `window.confirm` / `window.prompt` / `window.alert`.
 *
 * Usage:
 *   import { confirmDialog, promptDialog, alertDialog } from "../ui/Dialog"
 *   const ok = await confirmDialog({ title: "Hapus file?", message: "...", danger: true, okLabel: "Hapus" })
 *   const name = await promptDialog({ title: "Nama folder", initialValue: "Untitled" })
 *
 * Mount <DialogHost /> once in the App root (next to <Toaster />).
 */
import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Icon, type IconName } from './Icons'

export interface DialogOptions {
  title: string
  message?: string
  danger?: boolean
  okLabel?: string
  cancelLabel?: string
}

export interface PromptOptions extends DialogOptions {
  initialValue?: string
  placeholder?: string
}

interface ActiveDialog {
  mode: 'confirm' | 'prompt' | 'alert'
  options: DialogOptions
  initialValue?: string
  placeholder?: string
  resolve: (value: boolean | string | null) => void
}

let active: ActiveDialog | null = null
const listeners = new Set<() => void>()

function notify(): void {
  for (const l of listeners) l()
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

function getSnapshot(): ActiveDialog | null {
  return active
}

function close(value: boolean | string | null): void {
  const d = active
  active = null
  notify()
  d?.resolve(value)
}

function openDialog(
  mode: ActiveDialog['mode'],
  options: DialogOptions
): Promise<boolean | string | null> {
  return new Promise((resolve) => {
    active = { mode, options, resolve }
    notify()
  })
}

/** Promise-based replacement for window.confirm — resolves true/false. */
// eslint-disable-next-line react-refresh/only-export-components -- imperative dialog API, not a component
export function confirmDialog(options: DialogOptions): Promise<boolean> {
  return openDialog('confirm', options) as Promise<boolean>
}

/** Promise-based replacement for window.alert — resolves after user clicks OK. */
// eslint-disable-next-line react-refresh/only-export-components -- imperative dialog API, not a component
export function alertDialog(options: DialogOptions): Promise<void> {
  return openDialog('alert', options).then(() => undefined)
}

/** Promise-based replacement for window.prompt — resolves string, or null on cancel. */
// eslint-disable-next-line react-refresh/only-export-components -- imperative dialog API, not a component
export function promptDialog(options: PromptOptions): Promise<string | null> {
  return new Promise((resolve) => {
    active = {
      mode: 'prompt',
      options,
      initialValue: options.initialValue,
      placeholder: options.placeholder,
      resolve: resolve as (v: boolean | string | null) => void
    }
    notify()
  })
}

function DialogView({ dialog }: { dialog: ActiveDialog }): React.JSX.Element {
  const [value, setValue] = useState(dialog.initialValue ?? '')
  const inputRef = useRef<HTMLInputElement>(null)
  const okRef = useRef<HTMLButtonElement>(null)
  const { options, mode } = dialog
  const isPrompt = mode === 'prompt'

  useEffect(() => {
    const t = window.setTimeout(() => {
      if (isPrompt) inputRef.current?.focus()
      else okRef.current?.focus()
    }, 20)
    return () => window.clearTimeout(t)
  }, [isPrompt, dialog])

  const cancel = (): void => close(isPrompt ? null : false)
  const submit = (): void => {
    if (isPrompt) close(value)
    else close(true)
  }

  const headIcon: IconName = options.danger ? 'warning' : mode === 'alert' ? 'info' : 'check'

  return (
    <div
      className="wg-dialog-overlay"
      onClick={cancel}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault()
          cancel()
        }
      }}
    >
      <div
        className="wg-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={options.title}
        onClick={(e) => e.stopPropagation()}
      >
        <div className={`wg-dialog-head ${options.danger ? 'danger' : ''}`}>
          <Icon name={headIcon} size={18} />
          <span className="wg-dialog-title">{options.title}</span>
        </div>

        {options.message && <p className="wg-dialog-msg">{options.message}</p>}

        {isPrompt && (
          <input
            ref={inputRef}
            className="input wg-dialog-input"
            value={value}
            placeholder={dialog.placeholder}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                submit()
              }
            }}
            autoFocus
          />
        )}

        <div className="wg-dialog-actions">
          {mode !== 'alert' && (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={cancel}
              autoFocus={!isPrompt}
            >
              {options.cancelLabel || 'Batal'}
            </button>
          )}
          <button
            ref={okRef}
            type="button"
            className={`btn btn-sm ${options.danger ? 'btn-danger' : 'btn-primary'}`}
            onClick={submit}
          >
            {options.okLabel || (mode === 'alert' ? 'OK' : isPrompt ? 'OK' : 'Konfirmasi')}
          </button>
        </div>
      </div>
    </div>
  )
}

/** Mount once in the app root to render dialogs. */
export function DialogHost(): React.JSX.Element | null {
  const dialog = useSyncExternalStore(subscribe, getSnapshot)
  if (!dialog) return null
  return <DialogView key={dialog.options.title} dialog={dialog} />
}

export default DialogHost
