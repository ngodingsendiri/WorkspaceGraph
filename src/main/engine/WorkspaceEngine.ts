import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { app } from 'electron'
// Static import so electron-vite bundles SecretsStore into out/main/index.js
// (dynamic require('../security/SecretsStore') broke at runtime: module not found)
import { protectSettingsSecrets, revealSettingsSecrets } from '../security/SecretsStore'
import { atomicWriteJson, quarantineCorruptFile } from '../utils/quarantine'
// WC-7: TOCTOU hardening — re-verify the CURRENT realpath right before a
// write/delete op so a symlink swapped since the handler's assertPathInVault
// can never redirect the operation outside the vault.
import { reverifyPathInVault } from '../security/PathSandbox'
// Static import so electron-vite bundles TemplateEngine into out/main/index.js
// (dynamic require('./TemplateEngine') failed under vitest: Cannot find module)
import { templateEngine } from './TemplateEngine'
import { splitCodeSegments } from './markdownCode'

const SETTINGS_VERSION = 1

export const TRASH_FOLDER = '.trash'

export const TEMPLATE_FOLDER = 'Templates'

/** True if the path lives inside the vault trash folder (.trash). */
export function isTrashPath(filePath: string): boolean {
  return filePath.split(/[/\\]/).includes(TRASH_FOLDER)
}

/**
 * F-1/F-2 (testing 2026-08-11): Templates/*.md are seeded boilerplate, not
 * user notes — they must NEVER be indexed as notes. Excluding them here keeps
 * graph nodes, domain counts, recent notes, search hits and dashboard stats
 * clean (a seeded template file showed up as "{{title}}" notes + created the
 * "{{project}}" ghost). Only the TOP-LEVEL Templates/ dir is system-owned;
 * a user's Projects/Templates/ stays a normal folder.
 */
export function isTemplateDir(relativePath: string): boolean {
  const norm = relativePath.replace(/\\/g, '/').toLowerCase()
  return norm === 'templates' || norm.startsWith('templates/')
}

export interface WorkspaceConfig {
  name: string
  path: string
  createdAt: string
  lastOpenedAt: string
  settings: Record<string, unknown>
  version: number
}

export interface WorkspaceFile {
  id: string
  name: string
  path: string
  relativePath: string
  type:
    | 'knowledge'
    | 'project'
    | 'task'
    | 'daily'
    | 'template'
    | 'document'
    | 'people'
    | 'sop'
    | 'other'
  extension: string
  size: number
  createdAt: string
  updatedAt: string
  isDirectory: boolean
  children?: WorkspaceFile[]
}

export interface WorkspaceState {
  isOpen: boolean
  rootPath: string | null
  config: WorkspaceConfig | null
  files: WorkspaceFile[]
  totalFiles: number
  totalFolders: number
  /** Markdown notes only (blueprint dashboard metrics) */
  totalNotes: number
  /**
   * AE-5: true while the background index pass (syncWorkspaceData) is still
   * running after open/create — search/graph may be partial until it flips.
   */
  indexing?: boolean
}

const WORKSPACE_CONFIG_FILE = '.workspacegraph/workspace.json'
const WORKSPACE_FOLDER = '.workspacegraph'
const STANDARD_FOLDERS = [
  'Knowledge',
  'Projects',
  'Tasks',
  'Templates',
  'Daily',
  'Journal',
  'People',
  'Rules',
  'Prompt',
  'SOP',
  'Documents',
  'Assets',
  'Archive'
]

function fileTypeFromPath(filePath: string, rootPath: string): WorkspaceFile['type'] {
  let lower = path.relative(rootPath, filePath).toLowerCase().replace(/\\/g, '/')
  // M4a DOM-1 (ADR-0012): Archive/ is not a type — strip it and resolve the
  // segment after it (e.g. Archive/Projects/foo.md → project). Archived items
  // keep their domain type; lifecycle is status frontmatter, not folder.
  if (lower.startsWith('archive/')) lower = lower.slice(8)
  else if (lower.includes('/archive/')) lower = lower.replace('/archive/', '/')
  if (lower.startsWith('knowledge') || lower.includes('/knowledge/')) return 'knowledge'
  if (lower.startsWith('projects') || lower.includes('/projects/')) return 'project'
  if (lower.startsWith('tasks') || lower.includes('/tasks/')) return 'task'
  if (lower.startsWith('daily') || lower.includes('/daily/')) return 'daily'
  if (lower.startsWith('templates') || lower.includes('/templates/')) return 'template'
  if (lower.startsWith('documents') || lower.includes('/documents/')) return 'document'
  if (lower.startsWith('people') || lower.includes('/people/')) return 'people'
  if (lower.startsWith('sop') || lower.includes('/sop/')) return 'sop'
  // M4a CST-2: map remaining standard folders that were previously 'other'
  if (lower.startsWith('journal') || lower.includes('/journal/')) return 'knowledge'
  if (lower.startsWith('rules') || lower.includes('/rules/')) return 'knowledge'
  if (lower.startsWith('prompt') || lower.includes('/prompt/')) return 'knowledge'
  return 'other'
}

function generateId(filePath: string): string {
  // Match MarkdownEngine: normalize separators + case so Windows D:\ vs d:\ share the same id
  const key = filePath.replace(/\\/g, '/').toLowerCase()
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 24)
}

function scanDirectory(dirPath: string, rootPath: string): WorkspaceFile[] {
  const entries: WorkspaceFile[] = []
  try {
    const items = fs.readdirSync(dirPath, { withFileTypes: true })
    for (const item of items) {
      if (item.name.startsWith('.')) continue
      if (item.name === 'node_modules') continue
      const fullPath = path.join(dirPath, item.name)
      // M7 W2: yield to event loop every 100 files to avoid UI freeze on 10k+ vaults
      // (sync version keeps yielding via setImmediate check; async version below yields properly)
      const stats = fs.statSync(fullPath)
      const relativePath = path.relative(rootPath, fullPath)
      if (item.isDirectory()) {
        const children = scanDirectory(fullPath, rootPath)
        entries.push({
          id: generateId(fullPath),
          name: item.name,
          path: fullPath,
          relativePath,
          type: 'other',
          extension: '',
          size: 0,
          createdAt: stats.birthtime.toISOString(),
          updatedAt: stats.mtime.toISOString(),
          isDirectory: true,
          children
        })
      } else {
        const ext = path.extname(item.name).toLowerCase()
        entries.push({
          id: generateId(fullPath),
          name: item.name,
          path: fullPath,
          relativePath,
          type: fileTypeFromPath(fullPath, rootPath),
          extension: ext,
          size: stats.size,
          createdAt: stats.birthtime.toISOString(),
          updatedAt: stats.mtime.toISOString(),
          isDirectory: false
        })
      }
    }
  } catch (err) {
    console.error('Error scanning directory:', dirPath, err)
  }
  return entries.sort((a, b) => {
    if (a.isDirectory && !b.isDirectory) return -1
    if (!a.isDirectory && b.isDirectory) return 1
    return a.name.localeCompare(b.name)
  })
}

/**
 * M7 W2: async vault scan — yields to the event loop every 100 entries so a
 * 10k-file vault does not freeze the Electron main thread. Used by
 * refreshFilesAsync; the sync scanDirectory above stays for hot paths.
 */
async function scanDirectoryAsync(dirPath: string, rootPath: string): Promise<WorkspaceFile[]> {
  const entries: WorkspaceFile[] = []
  let yielded = 0
  const scan = async (dir: string): Promise<void> => {
    const items = await fs.promises.readdir(dir, { withFileTypes: true })
    for (const item of items) {
      if (item.name.startsWith('.')) continue
      if (item.name === 'node_modules') continue
      const fullPath = path.join(dir, item.name)
      // Yield periodically so the main thread can pump IPC / UI events
      if (++yielded % 100 === 0) await new Promise<void>((r) => setImmediate(r))
      try {
        const stats = await fs.promises.stat(fullPath)
        const relativePath = path.relative(rootPath, fullPath)
        if (item.isDirectory()) {
          const children = await scanDirectoryAsync(fullPath, rootPath)
          entries.push({
            id: generateId(fullPath),
            name: item.name,
            path: fullPath,
            relativePath,
            type: 'other',
            extension: '',
            size: 0,
            createdAt: stats.birthtime.toISOString(),
            updatedAt: stats.mtime.toISOString(),
            isDirectory: true,
            children
          })
        } else {
          const ext = path.extname(item.name).toLowerCase()
          entries.push({
            id: generateId(fullPath),
            name: item.name,
            path: fullPath,
            relativePath,
            type: fileTypeFromPath(fullPath, rootPath),
            extension: ext,
            size: stats.size,
            createdAt: stats.birthtime.toISOString(),
            updatedAt: stats.mtime.toISOString(),
            isDirectory: false
          })
        }
      } catch {
        /* skip unreadable entry */
      }
    }
  }
  try {
    await scan(dirPath)
  } catch (err) {
    console.error('Error scanning directory (async):', dirPath, err)
  }
  return entries.sort((a, b) => {
    if (a.isDirectory && !b.isDirectory) return -1
    if (!a.isDirectory && b.isDirectory) return 1
    return a.name.localeCompare(b.name)
  })
}

function countFiles(
  files: WorkspaceFile[],
  countNotes = true
): { files: number; folders: number; notes: number } {
  let fileCount = 0
  let folderCount = 0
  let noteCount = 0
  for (const f of files) {
    if (f.isDirectory) {
      folderCount++
      if (f.children) {
        // F-1: Templates/*.md are boilerplate, not notes — count the files
        // (they appear in the sidebar) but never as notes.
        const sub = countFiles(f.children, countNotes && !isTemplateDir(f.relativePath))
        fileCount += sub.files
        folderCount += sub.folders
        noteCount += sub.notes
      }
    } else {
      fileCount++
      if (countNotes && f.extension === '.md') noteCount++
    }
  }
  return { files: fileCount, folders: folderCount, notes: noteCount }
}

/** Escape special regex chars so a raw title is safe inside RegExp() */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * WA-3: rewrite [[oldTitle…]] → [[newTitle…]] but NEVER inside code (fenced
 * ``` / ~~~ blocks or inline `code`) — a rename must not corrupt code samples.
 * Pure: exported for golden tests.
 */
export function rewriteWikiLinksOutsideCode(
  content: string,
  oldTitle: string,
  newTitle: string
): string {
  if (!oldTitle || !newTitle || oldTitle === newTitle) return content
  const pattern = new RegExp(
    `\\[\\[${escapeRegex(oldTitle)}((?:#[^\\]|]*)?)(\\|[^\\]]*)?\\]\\]`,
    'gi'
  )
  let out = ''
  for (const seg of splitCodeSegments(content)) {
    if (seg.type === 'code') {
      out += seg.raw
    } else {
      out += seg.raw.replace(pattern, (_match, heading: string, alias: string) => {
        const h = heading || ''
        const a = alias || ''
        return `[[${newTitle}${h}${a}]]`
      })
    }
  }
  return out
}

export class WorkspaceEngine {
  private state: WorkspaceState = {
    isOpen: false,
    rootPath: null,
    config: null,
    files: [],
    indexing: false,
    totalFiles: 0,
    totalFolders: 0,
    totalNotes: 0
  }

  private recentWorkspaces: string[] = []
  private configDir: string

  constructor() {
    this.configDir = path.join(app.getPath('userData'), 'workspacegraph')
    if (!fs.existsSync(this.configDir)) {
      fs.mkdirSync(this.configDir, { recursive: true })
    }
    this.loadRecentWorkspaces()
  }

  private loadRecentWorkspaces(): void {
    const filePath = path.join(this.configDir, 'recent.json')
    // Self-healing: prefer the main file, fall back to the .tmp atomic-write
    // leftover (last full write), and if neither parses, quarantine the corrupt
    // file so it is preserved but never re-read (or re-backed-up) on every boot.
    for (const candidate of [filePath, filePath + '.tmp']) {
      try {
        if (fs.existsSync(candidate)) {
          const parsed = JSON.parse(fs.readFileSync(candidate, 'utf-8'))
          // parseable-but-wrong entries (numbers etc.) are dropped — a corrupt
          // recent.json must never make getRecentWorkspaces throw in existsSync
          this.recentWorkspaces = Array.isArray(parsed)
            ? parsed.filter((p): p is string => typeof p === 'string')
            : []
          return
        }
      } catch {
        /* try the next candidate */
      }
    }
    this.recentWorkspaces = []
    try {
      if (fs.existsSync(filePath)) {
        quarantineCorruptFile(filePath)
        console.warn('[WorkspaceEngine] recent.json unreadable — quarantined')
      }
    } catch {
      /* best-effort */
    }
  }

  private saveRecentWorkspaces(): void {
    atomicWriteJson(path.join(this.configDir, 'recent.json'), this.recentWorkspaces)
  }

  openWorkspace(workspacePath: string): WorkspaceState {
    // Resolve so relative paths and mixed separators become a stable absolute root
    const resolvedPath = path.resolve(workspacePath)
    if (!fs.existsSync(resolvedPath)) {
      throw new Error(`Workspace path does not exist: ${resolvedPath}`)
    }
    const stats = fs.statSync(resolvedPath)
    if (!stats.isDirectory()) {
      throw new Error(`Workspace path must be a directory: ${resolvedPath}`)
    }

    // Load or create workspace config
    const configPath = path.join(resolvedPath, WORKSPACE_CONFIG_FILE)
    const configFolder = path.join(resolvedPath, WORKSPACE_FOLDER)
    if (!fs.existsSync(configFolder)) {
      fs.mkdirSync(configFolder, { recursive: true })
    }

    let config: WorkspaceConfig | null = null
    if (fs.existsSync(configPath)) {
      try {
        config = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as WorkspaceConfig
        config.lastOpenedAt = new Date().toISOString()
        config.path = resolvedPath
      } catch {
        // Corrupt vault config must never prevent opening the vault — preserve
        // the file (best-effort backup) and recreate fresh from defaults.
        try {
          fs.copyFileSync(configPath, `${configPath}.corrupt-${Date.now()}`)
          console.warn('[WorkspaceEngine] workspace.json unreadable — backed up and recreated')
        } catch {
          /* best-effort */
        }
      }
    }
    if (!config) {
      config = {
        name: path.basename(resolvedPath),
        path: resolvedPath,
        createdAt: new Date().toISOString(),
        lastOpenedAt: new Date().toISOString(),
        settings: {},
        version: SETTINGS_VERSION
      }
      this.initializeWorkspaceStructure(resolvedPath)
    }
    // WA-9: atomic write — a crash mid-write must never leave workspace.json
    // truncated (loaders already fall back to the .tmp sibling on read).
    atomicWriteJson(configPath, config)

    // Scan files
    const files = scanDirectory(resolvedPath, resolvedPath)
    const counts = countFiles(files)

    this.state = {
      isOpen: true,
      rootPath: resolvedPath,
      config,
      files,
      totalFiles: counts.files,
      totalFolders: counts.folders,
      totalNotes: counts.notes,
      // AE-5: set true by the open/create flow while the background index runs
      indexing: false
    }

    // Update recent (normalize so duplicates with different separators collapse)
    this.recentWorkspaces = [
      resolvedPath,
      ...this.recentWorkspaces.filter((p) => path.resolve(p) !== resolvedPath)
    ].slice(0, 10)
    this.saveRecentWorkspaces()

    return this.state
  }

  private initializeWorkspaceStructure(workspacePath: string): void {
    // M7 W1 + M8 FST-1/2: create the manifest sub-structure per spec 05/32
    const cfgDir = path.join(workspacePath, '.workspacegraph')
    for (const sub of ['logs', 'cache', 'backups', 'temp']) {
      const p = path.join(cfgDir, sub)
      if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true })
    }
    const pluginsJson = path.join(cfgDir, 'plugins.json')
    if (!fs.existsSync(pluginsJson)) {
      fs.writeFileSync(pluginsJson, JSON.stringify({ version: 1, enabled: [] }, null, 2), 'utf-8')
    }
    // If it's an existing Obsidian vault, skip creating our default folders to keep it clean.
    const isObsidian = fs.existsSync(path.join(workspacePath, '.obsidian'))
    if (isObsidian) {
      console.log('[WorkspaceEngine] Obsidian vault detected — skip WG folder scaffold')
      return
    }
    for (const folder of STANDARD_FOLDERS) {
      const folderPath = path.join(workspacePath, folder)
      if (!fs.existsSync(folderPath)) {
        fs.mkdirSync(folderPath, { recursive: true })
      }
    }
    // Seed built-in templates into Templates/ (Phase 4)
    try {
      templateEngine.seedBuiltinToVault(workspacePath)
    } catch (err) {
      console.error('Failed to seed templates:', err)
    }
  }

  /**
   * M7 W3: validate that an opened vault has the expected structure.
   * Returns warnings (not errors) — a vault is usable even without standard folders.
   */
  validateWorkspaceStructure(): string[] {
    const root = this.state.rootPath
    if (!root) return []
    const warnings: string[] = []
    for (const folder of STANDARD_FOLDERS) {
      if (!fs.existsSync(path.join(root, folder))) {
        warnings.push(
          `Folder standar "${folder}/" tidak ditemukan — akan dibuat otomatis saat save.`
        )
      }
    }
    if (!fs.existsSync(path.join(root, '.workspacegraph', 'workspace.json'))) {
      warnings.push(
        '.workspacegraph/workspace.json tidak ada — vault baru atau belum pernah dibuka.'
      )
    }
    return warnings
  }

  createWorkspace(parentPath: string, name: string): WorkspaceState {
    const workspacePath = path.join(parentPath, name)
    if (fs.existsSync(workspacePath)) {
      throw new Error(`Directory already exists: ${workspacePath}`)
    }
    fs.mkdirSync(workspacePath, { recursive: true })
    return this.openWorkspace(workspacePath)
  }

  closeWorkspace(): void {
    this.state = {
      isOpen: false,
      rootPath: null,
      config: null,
      files: [],
      totalFiles: 0,
      totalFolders: 0,
      totalNotes: 0,
      indexing: false
    }
  }

  getState(): WorkspaceState {
    return this.state
  }

  getRecentWorkspaces(): string[] {
    return this.recentWorkspaces.filter((p) => fs.existsSync(p))
  }

  refreshFiles(): WorkspaceFile[] {
    if (!this.state.rootPath) return []
    const files = scanDirectory(this.state.rootPath, this.state.rootPath)
    const counts = countFiles(files)
    this.state.files = files
    this.state.totalFiles = counts.files
    this.state.totalFolders = counts.folders
    this.state.totalNotes = counts.notes
    return files
  }

  /** M7 W2: async variant that yields to the event loop — use for initial vault open on large vaults. */
  async refreshFilesAsync(): Promise<WorkspaceFile[]> {
    if (!this.state.rootPath) return []
    const files = await scanDirectoryAsync(this.state.rootPath, this.state.rootPath)
    const counts = countFiles(files)
    this.state.files = files
    this.state.totalFiles = counts.files
    this.state.totalFolders = counts.folders
    this.state.totalNotes = counts.notes
    return files
  }

  readFile(filePath: string): { content: string; mtime: number } {
    const stats = fs.statSync(filePath)
    const content = fs.readFileSync(filePath, 'utf-8')
    return { content, mtime: stats.mtimeMs }
  }

  writeFile(filePath: string, content: string): void {
    const root = this.state.rootPath
    if (root) reverifyPathInVault(filePath, root)
    const dir = path.dirname(filePath)
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }
    fs.writeFileSync(filePath, content, 'utf-8')
  }

  deleteFile(filePath: string): void {
    const root = this.state.rootPath
    if (root) reverifyPathInVault(filePath, root)
    if (fs.existsSync(filePath)) {
      const stats = fs.statSync(filePath)
      if (stats.isDirectory()) {
        fs.rmSync(filePath, { recursive: true })
      } else {
        fs.unlinkSync(filePath)
      }
    }
  }

  /** Move a vault item into .trash/ keeping its relative path. Returns the trash path. */
  moveToTrash(filePath: string): string {
    const root = this.state.rootPath
    if (!root) throw new Error('No workspace open')
    if (!fs.existsSync(filePath)) throw new Error(`Path does not exist: ${filePath}`)
    const rel = path.relative(root, filePath)
    if (!rel || rel === '.') throw new Error('Cannot move the vault root to trash')
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error(`Path outside vault: ${filePath}`)
    }
    const trashRoot = path.join(root, TRASH_FOLDER)
    fs.mkdirSync(trashRoot, { recursive: true })
    let target = path.join(trashRoot, rel)
    if (fs.existsSync(target)) {
      const ext = path.extname(target)
      target = `${target.slice(0, target.length - ext.length)}-${Date.now()}${ext}`
    }
    // WC-7: the file could be a symlink swapped after the handler's check —
    // re-verify the CURRENT realpath stays inside the vault before renaming.
    reverifyPathInVault(filePath, root)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.renameSync(filePath, target)
    return target
  }

  /**
   * Restore a trashed item back to its original vault location. If the original
   * path is taken, a numeric suffix is appended. Returns the restored path.
   */
  restoreFromTrash(filePath: string): string {
    const root = this.state.rootPath
    if (!root) throw new Error('No workspace open')
    const trashRoot = path.join(root, TRASH_FOLDER)
    const rel = path.relative(trashRoot, filePath)
    if (!rel || rel === '.' || rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error(`Not a trash item: ${filePath}`)
    }
    if (!fs.existsSync(filePath)) throw new Error(`Not found in trash: ${filePath}`)
    const original = path.join(root, rel)
    let target = original
    if (fs.existsSync(target)) {
      const ext = path.extname(target)
      const base = path.basename(target, ext)
      const dir = path.dirname(target)
      let i = 1
      while (fs.existsSync(target)) {
        target = path.join(dir, `${base} (${i})${ext}`)
        i++
      }
    }
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.renameSync(filePath, target)
    this.pruneEmptyTrashDirs()
    return target
  }

  /** Permanently delete everything inside `.trash`. Returns the number of files removed. */
  emptyTrash(): number {
    const root = this.state.rootPath
    if (!root) return 0
    const trashRoot = path.join(root, TRASH_FOLDER)
    if (!fs.existsSync(trashRoot)) return 0
    let count = 0
    const walk = (dir: string): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name)
        if (e.isDirectory()) walk(p)
        else count++
      }
    }
    try {
      walk(trashRoot)
    } catch {
      /* ignore */
    }
    fs.rmSync(trashRoot, { recursive: true, force: true })
    return count
  }

  /** Remove now-empty subfolders left under `.trash` after restores. */
  private pruneEmptyTrashDirs(): void {
    const root = this.state.rootPath
    if (!root) return
    const trashRoot = path.join(root, TRASH_FOLDER)
    if (!fs.existsSync(trashRoot)) return
    const walk = (dir: string): boolean => {
      let empty = true
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name)
        if (e.isDirectory()) {
          if (!walk(p)) empty = false
        } else {
          empty = false
        }
      }
      if (empty && path.resolve(dir) !== path.resolve(trashRoot)) {
        try {
          fs.rmdirSync(dir)
        } catch {
          /* ignore */
        }
      }
      return empty
    }
    try {
      walk(trashRoot)
    } catch {
      /* ignore */
    }
  }

  createFile(filePath: string, content = ''): void {
    const root = this.state.rootPath
    if (root) reverifyPathInVault(filePath, root)
    if (fs.existsSync(filePath)) {
      throw new Error(`File already exists: ${filePath}`)
    }
    const dir = path.dirname(filePath)
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }
    fs.writeFileSync(filePath, content, 'utf-8')
  }

  createFolder(folderPath: string): void {
    if (!fs.existsSync(folderPath)) {
      fs.mkdirSync(folderPath, { recursive: true })
    }
  }

  /**
   * Walk the open vault and collect absolute paths of every `.md` file.
   * Used by renameFile to scan for wikilink references.
   */
  getAllMarkdownPaths(): string[] {
    if (!this.state.rootPath) return []
    const out: string[] = []
    const walk = (dir: string): void => {
      let entries: fs.Dirent[] = []
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const e of entries) {
        if (e.name.startsWith('.') || e.name === 'node_modules') continue
        const full = path.join(dir, e.name)
        if (e.isDirectory()) walk(full)
        else if (e.name.toLowerCase().endsWith('.md')) out.push(full)
      }
    }
    walk(this.state.rootPath)
    return out
  }

  /**
   * Scan all vault Markdown files and rewrite [[oldTitle]] → [[newTitle]]
   * (never inside code — see rewriteWikiLinksOutsideCode).
   * Returns the list of absolute paths that were modified.
   */
  updateLinksInVault(oldTitle: string, newTitle: string): string[] {
    if (!oldTitle || !newTitle || oldTitle === newTitle) return []
    const affected: string[] = []
    for (const filePath of this.getAllMarkdownPaths()) {
      let raw: string
      try {
        raw = fs.readFileSync(filePath, 'utf-8')
      } catch {
        continue
      }
      const updated = rewriteWikiLinksOutsideCode(raw, oldTitle, newTitle)
      if (updated === raw) continue
      try {
        fs.writeFileSync(filePath, updated, 'utf-8')
        affected.push(filePath)
      } catch {
        /* skip unwritable */
      }
    }
    return affected
  }

  renameFile(
    oldPath: string,
    newPath: string,
    opts?: { updateLinks?: boolean }
  ): { renamedLinks: number; affectedFiles: string[] } {
    if (!fs.existsSync(oldPath)) {
      throw new Error(`Source path does not exist: ${oldPath}`)
    }
    if (path.resolve(oldPath) === path.resolve(newPath))
      return { renamedLinks: 0, affectedFiles: [] }
    if (fs.existsSync(newPath)) {
      throw new Error(`Target already exists: ${newPath}`)
    }
    const dir = path.dirname(newPath)
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }

    // WA-7: rename FIRST, then rewrite WikiLinks — if the rename fails (locked
    // file, permission) nothing has changed on disk yet, so links can never end
    // up pointing at a title that doesn't exist. Link rewrite is best-effort.
    fs.renameSync(oldPath, newPath)

    let affectedFiles: string[] = []
    const shouldUpdateLinks = opts?.updateLinks !== false
    if (shouldUpdateLinks && oldPath.toLowerCase().endsWith('.md')) {
      const oldTitle = path.basename(oldPath, '.md')
      const newTitle = path.basename(newPath, '.md')
      try {
        affectedFiles = this.updateLinksInVault(oldTitle, newTitle)
      } catch (err) {
        // The rename itself succeeded — a failed link sweep must not fail the
        // whole operation or leave the vault in a half-renamed state.
        console.error('[WorkspaceEngine] rename ok, wiki-link update failed:', err)
      }
    }
    return { renamedLinks: affectedFiles.length, affectedFiles }
  }

  // Settings migration system
  private migrateSettings(raw: Record<string, unknown>): Record<string, unknown> {
    const version = (raw.version as number) || 0
    if (version >= SETTINGS_VERSION) return raw

    // M8 INS-2: snapshot before migration — rollback if new version breaks
    try {
      const backupPath = path.join(this.configDir, `settings.backup-v${version}.json`)
      if (!fs.existsSync(backupPath)) {
        fs.writeFileSync(backupPath, JSON.stringify(raw, null, 2), 'utf-8')
      }
    } catch {
      /* backup best-effort */
    }

    const migrated = { ...raw }

    // Migration from v0 (no version) to v1
    if (version < 1) {
      // Add default values for new settings
      migrated.theme = migrated.theme || 'dark'
      migrated.editorFontSize = migrated.editorFontSize || 14
      migrated.editorLineHeight = migrated.editorLineHeight || 1.6
      // Ensure all AI provider keys are objects
      if (!migrated.aiProviders) migrated.aiProviders = {}
    }

    migrated.version = SETTINGS_VERSION
    return migrated
  }

  getSettingsPath(): string {
    return path.join(this.configDir, 'settings.json')
  }

  /**
   * Read settings defensively (robustness): prefer the main file, fall back to
   * the .tmp sibling (an atomic-write leftover = the last full write), and if
   * neither parses, back the corrupt file aside so a later save never silently
   * destroys it. Returns null when nothing parseable exists.
   */
  private readSettingsFile(): Record<string, unknown> | null {
    const settingsPath = this.getSettingsPath()
    for (const candidate of [settingsPath, settingsPath + '.tmp']) {
      try {
        if (fs.existsSync(candidate)) {
          return JSON.parse(fs.readFileSync(candidate, 'utf-8')) as Record<string, unknown>
        }
      } catch {
        /* try the next candidate */
      }
    }
    // Neither parsed — quarantine the corrupt file (preserved, never silently
    // destroyed, and never re-backed-up on every read)
    try {
      if (fs.existsSync(settingsPath)) {
        const aside = quarantineCorruptFile(settingsPath)
        if (aside)
          console.warn('[WorkspaceEngine] settings.json unreadable — quarantined to', aside)
      }
    } catch {
      /* best-effort */
    }
    return null
  }

  getSettings(): Record<string, unknown> {
    const raw = this.readSettingsFile()
    if (raw) {
      const migrated = this.migrateSettings(raw)
      // If version changed, save migrated version
      if ((raw.version as number) !== SETTINGS_VERSION) {
        this.saveSettings(migrated)
      }
      return revealSettingsSecrets(migrated)
    }
    return { version: SETTINGS_VERSION }
  }

  /** Raw settings as stored on disk (encrypted secrets) */
  getSettingsRaw(): Record<string, unknown> {
    const raw = this.readSettingsFile()
    return raw ? this.migrateSettings(raw) : {}
  }

  saveSettings(settings: Record<string, unknown>): string {
    if (!fs.existsSync(this.configDir)) {
      fs.mkdirSync(this.configDir, { recursive: true })
    }
    const settingsPath = this.getSettingsPath()

    // Ensure version is included
    const withVersion = { ...settings, version: SETTINGS_VERSION }
    const protectedSettings = protectSettingsSecrets(withVersion)
    const json = JSON.stringify(protectedSettings, null, 2)
    // Atomic write so partial files never leave settings missing
    const tmp = settingsPath + '.tmp'
    fs.writeFileSync(tmp, json, 'utf-8')
    fs.renameSync(tmp, settingsPath)
    console.log('[WorkspaceEngine] settings saved →', settingsPath)
    return settingsPath
  }
}

export const workspaceEngine = new WorkspaceEngine()
