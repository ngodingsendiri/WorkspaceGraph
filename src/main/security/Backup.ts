/**
 * Manual vault backup (M8.6 / SEC-2 + spec 32 Backups/).
 *
 * Copies the USER-DATA portion of the vault (all folders EXCEPT
 * .workspacegraph cache/logs — config JSONs are tiny and included) into
 * <vault>/.workspacegraph/backups/<timestamp>/ with a sha256 checksum file.
 *
 * Markdown = source of truth (Law 001) so a folder copy IS a complete
 * backup; index.db / logs are rebuildable caches and excluded to keep the
 * archive small. Restore = copy back (documented, not automated).
 */
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'

const BACKUP_DIR = 'backups'
/** Folders never worth copying: caches that rebuild from Markdown. */
const SKIP_IN_CONFIG = new Set(['logs', 'backups', 'cache', 'checkpoints'])
const MAX_FILE_BYTES = 20 * 1024 * 1024

export interface BackupResult {
  ok: boolean
  dir?: string
  files?: number
  bytes?: number
  checksum?: string
  error?: string
}

function hashFile(abs: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex')
}

/**
 * Copy every non-cache file of the vault into a timestamped backup dir and
 * write manifest.sha256 (one "hash  relpath" line per file). Bounded: skips
 * files > MAX_FILE_BYTES and hard-caps total entries to avoid runaway copies
 * on pathological vaults.
 */
export function createBackup(vaultRoot: string): BackupResult {
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const dest = path.join(vaultRoot, '.workspacegraph', BACKUP_DIR, stamp)
    fs.mkdirSync(dest, { recursive: true })

    let files = 0
    let bytes = 0
    const lines: string[] = []

    const walk = (src: string, rel: string): void => {
      if (files >= 20000) return
      for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
        if (entry.name.startsWith('.')) continue // .workspacegraph handled separately
        if (entry.name === 'node_modules') continue
        const s = path.join(src, entry.name)
        const r = rel ? `${rel}/${entry.name}` : entry.name
        if (entry.isDirectory()) {
          walk(s, r)
        } else {
          const st = fs.statSync(s)
          if (st.size > MAX_FILE_BYTES) continue
          const d = path.join(dest, r)
          fs.mkdirSync(path.dirname(d), { recursive: true })
          fs.copyFileSync(s, d)
          lines.push(`${hashFile(d)}  ${r}`)
          files++
          bytes += st.size
        }
      }
    }

    // 1) User data (everything except dot-dirs)
    walk(vaultRoot, '')

    // 2) .workspacegraph config (small JSONs) minus rebuildable caches
    const cfgDir = path.join(vaultRoot, '.workspacegraph')
    if (fs.existsSync(cfgDir)) {
      for (const entry of fs.readdirSync(cfgDir, { withFileTypes: true })) {
        if (SKIP_IN_CONFIG.has(entry.name.toLowerCase())) continue
        const s = path.join(cfgDir, entry.name)
        if (entry.isFile()) {
          const r = `.workspacegraph/${entry.name}`
          const d = path.join(dest, '.workspacegraph', entry.name)
          fs.copyFileSync(s, d)
          lines.push(`${hashFile(d)}  ${r}`)
          files++
          bytes += fs.statSync(s).size
        } else if (entry.isDirectory() && entry.name === 'plugins') {
          walk(s, `.workspacegraph/plugins`)
        }
      }
    }

    const checksum = crypto.createHash('sha256').update(lines.join('\n')).digest('hex')
    fs.writeFileSync(
      path.join(dest, 'manifest.sha256'),
      `${checksum}  *\n` + lines.sort().join('\n') + '\n',
      'utf-8'
    )
    return { ok: true, dir: dest, files, bytes, checksum }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** List existing backups (newest first). */
export function listBackups(vaultRoot: string): { name: string; dir: string; createdAt: string }[] {
  const dir = path.join(vaultRoot, '.workspacegraph', BACKUP_DIR)
  if (!fs.existsSync(dir)) return []
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => ({ name: e.name, dir: path.join(dir, e.name), createdAt: e.name }))
      .sort((a, b) => b.name.localeCompare(a.name))
  } catch {
    return []
  }
}
