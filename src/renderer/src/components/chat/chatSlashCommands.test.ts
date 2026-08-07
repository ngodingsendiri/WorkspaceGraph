import { describe, it, expect, vi } from 'vitest'
import {
  SLASH_COMMANDS,
  filterSlashCommands,
  findSlashCommand,
  requestComposerCommand,
  consumeComposerCommand
} from './chatSlashCommands'

describe('SLASH_COMMANDS (P2-3)', () => {
  it('exposes the required commands', () => {
    const names = SLASH_COMMANDS.map((c) => c.name)
    expect(names).toContain('/compact')
    expect(names).toContain('/learn')
    expect(names).toContain('/plan')
  })

  it('every command has a non-empty label and template', () => {
    for (const c of SLASH_COMMANDS) {
      expect(c.label.trim().length).toBeGreaterThan(0)
      expect(c.template.trim().length).toBeGreaterThan(0)
    }
  })
})

describe('filterSlashCommands (P2-3)', () => {
  it('returns everything for an empty query', () => {
    expect(filterSlashCommands(SLASH_COMMANDS, '')).toHaveLength(SLASH_COMMANDS.length)
    expect(filterSlashCommands(SLASH_COMMANDS, ' ')).toHaveLength(SLASH_COMMANDS.length)
  })

  it('matches by case-insensitive prefix', () => {
    expect(filterSlashCommands(SLASH_COMMANDS, '/pl').map((c) => c.name)).toEqual(['/plan'])
    expect(filterSlashCommands(SLASH_COMMANDS, '/PLA').map((c) => c.name)).toEqual(['/plan'])
    expect(filterSlashCommands(SLASH_COMMANDS, '/c').map((c) => c.name)).toContain('/compact')
  })

  it('returns empty when nothing matches', () => {
    expect(filterSlashCommands(SLASH_COMMANDS, '/zzz')).toHaveLength(0)
  })
})

describe('global palette bridge (P2-5)', () => {
  it('findSlashCommand resolves by exact token', () => {
    expect(findSlashCommand('/plan')?.name).toBe('/plan')
    expect(findSlashCommand('/plan')?.template.length).toBeGreaterThan(0)
    expect(findSlashCommand('/nope')).toBeUndefined()
  })

  it('requestComposerCommand stashes the request and broadcasts an event', () => {
    const dispatch = vi.fn<(e: Event) => boolean>()
    const prevWindow = (globalThis as unknown as { window?: unknown }).window
    ;(globalThis as unknown as { window?: unknown }).window = {
      dispatchEvent: dispatch
    } as unknown as Window
    try {
      requestComposerCommand('/compact')
      // Stash is immediately consumable by the (soon-mounted) panel listener
      expect(consumeComposerCommand()?.name).toBe('/compact')
      expect(consumeComposerCommand()).toBeNull()
      // Broadcast carries the command token for the mounted-listener path
      expect(dispatch).toHaveBeenCalledTimes(1)
      const ev = dispatch.mock.calls[0]?.[0] as CustomEvent<string> | undefined
      expect(ev?.type).toBe('wg:composer-command')
      expect(ev?.detail).toBe('/compact')
    } finally {
      ;(globalThis as unknown as { window?: unknown }).window = prevWindow
    }
  })

  it('requestComposerCommand ignores unknown tokens (no stash, no event)', () => {
    const dispatch = vi.fn<(e: Event) => boolean>()
    const prevWindow = (globalThis as unknown as { window?: unknown }).window
    ;(globalThis as unknown as { window?: unknown }).window = {
      dispatchEvent: dispatch
    } as unknown as Window
    try {
      requestComposerCommand('/nope')
      expect(consumeComposerCommand()).toBeNull()
      expect(dispatch).not.toHaveBeenCalled()
    } finally {
      ;(globalThis as unknown as { window?: unknown }).window = prevWindow
    }
  })
})
