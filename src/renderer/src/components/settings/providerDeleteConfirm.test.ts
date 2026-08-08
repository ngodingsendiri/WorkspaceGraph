import { describe, it, expect, vi } from 'vitest'
import {
  buildProviderDeleteConfirm,
  confirmProviderDelete,
  type ConfirmRequest
} from './providerDeleteConfirm'

/**
 * Component test for the provider-delete confirmation gate (node env, no
 * jsdom): the dialog request builder is the component's confirmation
 * contract — the SettingsView wires its result straight into confirmDialog,
 * so the message/labels/flow asserted here are exactly what a user sees and
 * what decides proceed-vs-abort.
 */
describe('providerDeleteConfirm', () => {
  it('always opens as a danger-styled confirmation (never a plain click)', () => {
    const req = buildProviderDeleteConfirm({ id: 'gemini', name: 'Gemini', hasKey: false })
    expect(req.danger).toBe(true)
    expect(req.okLabel).toBe('Hapus')
    expect(req.cancelLabel).toBe('Batal')
  })

  it('warns that the saved API key is deleted permanently when a key exists', () => {
    const req: ConfirmRequest = buildProviderDeleteConfirm({
      id: 'gemini',
      name: 'Gemini',
      hasKey: true
    })
    expect(req.title).toBe('Hapus provider Gemini?')
    expect(req.message).toContain('gemini')
    expect(req.message).toContain('permanen')
    expect(req.message).toContain('penyimpanan aman')
  })

  it('uses a plain removal message when no key is stored (e.g. Ollama)', () => {
    const req = buildProviderDeleteConfirm({ id: 'ollama', name: 'Ollama', hasKey: false })
    expect(req.title).toBe('Hapus provider Ollama?')
    expect(req.message).toContain('dihapus dari daftar')
    // No key → no permanent-key warning (which would be a lie for Ollama)
    expect(req.message).not.toContain('permanen')
  })

  it('falls back to the id for the title when the name is blank/whitespace', () => {
    const req = buildProviderDeleteConfirm({ id: 'my-mistral', name: '   ', hasKey: false })
    expect(req.title).toBe('Hapus provider my-mistral?')
  })

  it('gate: a confirmed dialog returns true and carries the request built from the def', async () => {
    const seen: ConfirmRequest[] = []
    const ok = await confirmProviderDelete(
      async (req) => {
        seen.push(req)
        return true
      },
      { id: 'gemini', name: 'Gemini', hasKey: true }
    )
    expect(ok).toBe(true)
    expect(seen).toHaveLength(1)
    expect(seen[0].danger).toBe(true)
    expect(seen[0].okLabel).toBe('Hapus')
    expect(seen[0].message).toContain('permanen')
  })

  it('gate: a declined dialog aborts the deletion (returns false, no request leak)', async () => {
    const confirm = vi.fn().mockResolvedValue(false)
    const ok = await confirmProviderDelete(confirm, {
      id: 'gemini',
      name: 'Gemini',
      hasKey: true
    })
    expect(ok).toBe(false)
    expect(confirm).toHaveBeenCalledTimes(1)
  })
})
