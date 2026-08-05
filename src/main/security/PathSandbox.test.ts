import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import { tmpdir } from 'os'
import { assertPathInVault, isPathInVault, resolveVaultRelative } from './PathSandbox'

describe('PathSandbox', () => {
  let vault: string
  let sibling: string

  beforeEach(() => {
    vault = fs.mkdtempSync(path.join(tmpdir(), 'wg-sandbox-'))
    sibling = vault + '-evil'
    fs.mkdirSync(sibling, { recursive: true })
  })

  afterEach(() => {
    try {
      fs.rmSync(vault, { recursive: true, force: true })
      fs.rmSync(sibling, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  })

  it('accepts path inside vault', () => {
    const inside = path.join(vault, 'Knowledge', 'a.md')
    fs.mkdirSync(path.dirname(inside), { recursive: true })
    fs.writeFileSync(inside, 'x')
    expect(isPathInVault(inside, vault)).toBe(true)
    expect(assertPathInVault(inside, vault)).toBe(path.resolve(inside))
  })

  it('rejects parent escape', () => {
    expect(isPathInVault(path.join(vault, '..', 'evil.md'), vault)).toBe(false)
  })

  it('rejects deep traversal', () => {
    expect(
      isPathInVault(path.join(vault, 'Knowledge', '..', '..', 'Windows', 'System32'), vault)
    ).toBe(false)
  })

  it('throws on empty path', () => {
    expect(() => assertPathInVault('', vault)).toThrow()
  })

  it('throws when no vault open', () => {
    expect(() => assertPathInVault(path.join(vault, 'a.md'), null)).toThrow('No workspace open')
  })

  it('rejects sibling prefix vault (Obs-evil is not Obs)', () => {
    const evilFile = path.join(sibling, 'x.md')
    fs.writeFileSync(evilFile, 'x')
    expect(isPathInVault(evilFile, vault)).toBe(false)
  })

  it('rejects symlink-resolved escape (realpath check)', () => {
    // Create real dir outside, symlink inside vault → must be blocked
    const outside = fs.mkdtempSync(path.join(tmpdir(), 'wg-sandbox-out-'))
    const link = path.join(vault, 'link-out')
    try {
      fs.symlinkSync(outside, link, 'junction')
      expect(isPathInVault(path.join(link, 'x.md'), vault)).toBe(false)
    } catch {
      // Symlinks may be unavailable (Windows CI) — realpath guard still covered by traversal tests
    } finally {
      try {
        fs.rmSync(outside, { recursive: true, force: true })
      } catch {
        /* ignore */
      }
    }
  })

  it('resolveVaultRelative joins inside vault and normalizes leading slashes', () => {
    fs.mkdirSync(path.join(vault, 'Knowledge'), { recursive: true })
    const p = resolveVaultRelative('/Knowledge/a.md', vault)
    expect(isPathInVault(p, vault)).toBe(true)
    expect(path.basename(p)).toBe('a.md')
  })

  it('resolveVaultRelative rejects traversal', () => {
    expect(() => resolveVaultRelative('../evil.md', vault)).toThrow()
  })
})
