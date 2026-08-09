/**
 * Self-healing persistence helpers shared by the stores (settings, recent,
 * chats, proposals, index).
 *
 * - `quarantineCorruptFile` moves an unreadable file aside (rename → copy+unlink
 *   fallback for Windows handle locks) so the store recovers while the corrupt
 *   data is preserved for inspection — never silently destroyed, never backing
 *   up the same file on every read.
 * - `atomicWriteJson` writes to a .tmp sibling then renames over the target, so
 *   a crash mid-write leaves the previous file intact AND a .tmp recovery
 *   source behind (consumed by the loaders' fallback chains).
 */
import fs from 'fs'

export function quarantineCorruptFile(filePath: string): string | null {
  const aside = `${filePath}.corrupt-${Date.now()}`
  try {
    fs.renameSync(filePath, aside)
    return aside
  } catch {
    /* file may be held open (Windows) — fall through to copy+unlink */
  }
  try {
    fs.copyFileSync(filePath, aside)
    try {
      fs.rmSync(filePath, { force: true })
    } catch {
      /* original stays; the next open retries the recovery */
    }
    return aside
  } catch {
    return null
  }
}

export function atomicWriteJson(filePath: string, data: unknown): void {
  const tmp = filePath + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8')
  fs.renameSync(tmp, filePath)
}
