/**
 * Path sandbox — confine all file ops to open vault (least privilege)
 */
import fs from 'fs'
import path from 'path'

function assertLexicallyInVault(resolved: string, root: string): void {
  const rel = path.relative(root, resolved)
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('Path outside vault rejected')
  }
}

function realPathForTarget(resolved: string): string {
  if (fs.existsSync(resolved)) return fs.realpathSync.native(resolved)

  let current = path.dirname(resolved)
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current)
    if (parent === current) return resolved
    current = parent
  }
  return path.join(fs.realpathSync.native(current), path.relative(current, resolved))
}

export function assertPathInVault(filePath: string, vaultRoot: string | null | undefined): string {
  if (!vaultRoot) throw new Error('No workspace open')
  if (!filePath || typeof filePath !== 'string') throw new Error('Invalid path')

  const root = path.resolve(vaultRoot)
  const resolved = path.resolve(filePath)
  assertLexicallyInVault(resolved, root)

  const realRoot = fs.existsSync(root) ? fs.realpathSync.native(root) : root
  const realTarget = realPathForTarget(resolved)
  assertLexicallyInVault(realTarget, realRoot)
  return resolved
}

export function isPathInVault(filePath: string, vaultRoot: string | null | undefined): boolean {
  try {
    assertPathInVault(filePath, vaultRoot)
    return true
  } catch {
    return false
  }
}

/**
 * WC-7 — TOCTOU hardening. `assertPathInVault` verifies a path once, but a
 * symlink inside the vault can be swapped by another process between that
 * check and the actual fs operation. Call this immediately BEFORE a
 * write/delete op so the target's CURRENT realpath (deepest existing ancestor
 * resolved) is still inside the vault at operation time. Returns the resolved
 * path, or throws when the path now escapes.
 */
export function reverifyPathInVault(
  filePath: string,
  vaultRoot: string | null | undefined
): string {
  if (!vaultRoot) throw new Error('No workspace open')
  if (!filePath || typeof filePath !== 'string') throw new Error('Invalid path')
  const root = path.resolve(vaultRoot)
  const resolved = path.resolve(filePath)
  const realRoot = fs.existsSync(root) ? fs.realpathSync.native(root) : root
  const realTarget = realPathForTarget(resolved)
  assertLexicallyInVault(realTarget, realRoot)
  return resolved
}

export function resolveVaultRelative(relativePath: string, vaultRoot: string): string {
  const clean = relativePath.replace(/^[/\\]+/, '')
  return assertPathInVault(path.join(vaultRoot, clean), vaultRoot)
}
