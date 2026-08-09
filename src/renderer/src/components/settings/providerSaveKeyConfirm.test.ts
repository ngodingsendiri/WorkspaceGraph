import { describe, it, expect } from 'vitest'
import { buildRowSaveFlash } from './providerSaveKeyConfirm'

/**
 * Component test for the row-Save flash decision (node env, no jsdom): the
 * SettingsView wires buildRowSaveFlash straight into the Save handler's flash,
 * so what is asserted here is exactly what the user sees after clicking Save —
 * including the guarantee that a FAILED key persist is never reported as the
 * success "…tes otomatis…" flash.
 */
describe('providerSaveKeyConfirm — row Save flash decision', () => {
  const gemini = { id: 'gemini', name: 'Gemini' }

  it('no key typed → plain "disimpan", never the auto-verify flash', () => {
    const msg = buildRowSaveFlash(gemini, false, undefined)
    expect(msg).toContain('disimpan')
    expect(msg).not.toContain('tes otomatis')
    expect(msg).not.toContain('Gagal')
  })

  it('key typed + configure OK → "…disimpan — tes otomatis…" (auto-verify runs)', () => {
    const msg = buildRowSaveFlash(gemini, true, { ok: true })
    expect(msg).toContain('tes otomatis')
    expect(msg).not.toContain('Gagal')
  })

  it('KEY CONTRACT: configure FAILED → real error, NEVER "tes otomatis"', () => {
    const msg = buildRowSaveFlash(gemini, true, { ok: false, error: 'Provider not found' })
    expect(msg).toContain('Gagal menyimpan key')
    expect(msg).toContain('Provider not found')
    // The fake-success flash must be impossible in the failure branch
    expect(msg).not.toContain('tes otomatis')
    expect(msg).not.toContain('disimpan —')
  })

  it('configure outcome undefined (IPC rejected/aborted) → error flash, not success', () => {
    const msg = buildRowSaveFlash(gemini, true, undefined)
    expect(msg).toContain('Gagal menyimpan key')
    expect(msg).toContain('unknown')
    expect(msg).not.toContain('tes otomatis')
  })

  it('falls back to the id for the label when the name is blank/whitespace', () => {
    const msg = buildRowSaveFlash({ id: 'my-mistral', name: '   ' }, true, {
      ok: false,
      error: 'boom'
    })
    expect(msg).toContain('my-mistral')
    expect(msg).toContain('boom')
  })

  it('a later no-key re-save (edit def only) keeps the plain flash', () => {
    const msg = buildRowSaveFlash(gemini, false, { ok: true })
    expect(msg).toContain('disimpan')
    expect(msg).not.toContain('tes otomatis')
  })
})
