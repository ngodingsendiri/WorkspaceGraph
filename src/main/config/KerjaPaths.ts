/**
 * Default paths for Diskominfo work vault (Obsidian-compatible).
 * Source of truth remains Markdown on disk — same as Obsidian.
 */
import fs from 'fs'
import path from 'path'

/** Nested Obs vault (Home, Harian, Sidebrain, Pegawai, …) */
export const DEFAULT_KERJA_VAULT = 'D:\\Obs\\Obs'

/** Parent folder sometimes opened by mistake */
export const KERJA_VAULT_CANDIDATES = [
  'D:\\Obs\\Obs',
  'D:\\Obs',
  'C:\\Users\\code\\Documents\\Obs',
  'C:\\Users\\code\\Obsidian\\Obs'
]

/** Subpaths relative to vault root (skill obsidian-kerja) */
export const KERJA_REL = {
  home: '00 Home.md',
  dailyDir: '02 Harian',
  kerjaan: '03 Kerjaan',
  arsip: '04 Arsip',
  pegawai: '05 Pegawai',
  pegawaiDb: '05 Pegawai\\00 Daftar Pegawai.md',
  sop: '06 SOP & Pola',
  referensi: '07 Referensi',
  sidebrain: '08 Sidebrain',
  sidebrainIndex: '08 Sidebrain\\00 Index Sidebrain.md',
  templates: '99 Templates',
  zData: 'Z:\\1. DATA PEGAWAI',
  zSurat: 'Z:\\2. SURAT'
} as const

export function resolveKerjaVault(): string | null {
  for (const p of KERJA_VAULT_CANDIDATES) {
    if (!fs.existsSync(p)) continue
    // Prefer folder that has Obsidian home or Sidebrain
    const home = path.join(p, '00 Home.md')
    const side = path.join(p, '08 Sidebrain')
    const obsidian = path.join(p, '.obsidian')
    if (fs.existsSync(home) || fs.existsSync(side) || fs.existsSync(obsidian)) {
      return p
    }
  }
  // Fallback first existing candidate
  for (const p of KERJA_VAULT_CANDIDATES) {
    if (fs.existsSync(p)) return p
  }
  return null
}

export function isKerjaVault(rootPath: string | null | undefined): boolean {
  if (!rootPath) return false
  const n = rootPath.replace(/\//g, '\\').toLowerCase()
  return (
    n.includes('\\obs\\obs') ||
    n.endsWith('\\obs') ||
    fs.existsSync(path.join(rootPath, '00 Home.md')) ||
    fs.existsSync(path.join(rootPath, '08 Sidebrain'))
  )
}

/** Paths AI/context should prioritize (relative, lowercased match) */
export const KERJA_CONTEXT_PRIORITY = [
  '08 sidebrain',
  '06 sop',
  '99 templates',
  '00 home',
  '05 pegawai',
  '03 kerjaan',
  '02 harian',
  'rules/',
  'sop/',
  'templates/',
  'prompt/'
]
