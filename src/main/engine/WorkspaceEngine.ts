import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { app } from 'electron'
// Static import so electron-vite bundles SecretsStore into out/main/index.js
// (dynamic require('../security/SecretsStore') broke at runtime: module not found)
import { protectSettingsSecrets, revealSettingsSecrets } from '../security/SecretsStore'

const SETTINGS_VERSION = 1

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
  const lower = path.relative(rootPath, filePath).toLowerCase().replace(/\\/g, '/')
  if (lower.startsWith('knowledge') || lower.includes('/knowledge/')) return 'knowledge'
  if (lower.startsWith('projects') || lower.includes('/projects/')) return 'project'
  if (lower.startsWith('tasks') || lower.includes('/tasks/')) return 'task'
  if (lower.startsWith('daily') || lower.includes('/daily/')) return 'daily'
  if (lower.startsWith('templates') || lower.includes('/templates/')) return 'template'
  if (lower.startsWith('documents') || lower.includes('/documents/')) return 'document'
  if (lower.startsWith('people') || lower.includes('/people/')) return 'people'
  if (lower.startsWith('sop') || lower.includes('/sop/')) return 'sop'
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

function countFiles(files: WorkspaceFile[]): { files: number; folders: number; notes: number } {
  let fileCount = 0
  let folderCount = 0
  let noteCount = 0
  for (const f of files) {
    if (f.isDirectory) {
      folderCount++
      if (f.children) {
        const sub = countFiles(f.children)
        fileCount += sub.files
        folderCount += sub.folders
        noteCount += sub.notes
      }
    } else {
      fileCount++
      if (f.extension === '.md') noteCount++
    }
  }
  return { files: fileCount, folders: folderCount, notes: noteCount }
}

/** Escape special regex chars so a raw title is safe inside RegExp() */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export class WorkspaceEngine {
  private state: WorkspaceState = {
    isOpen: false,
    rootPath: null,
    config: null,
    files: [],
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
    try {
      if (fs.existsSync(filePath)) {
        this.recentWorkspaces = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
      }
    } catch {
      this.recentWorkspaces = []
    }
  }

  private saveRecentWorkspaces(): void {
    const filePath = path.join(this.configDir, 'recent.json')
    fs.writeFileSync(filePath, JSON.stringify(this.recentWorkspaces, null, 2))
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

    let config: WorkspaceConfig
    if (fs.existsSync(configPath)) {
      config = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
      config.lastOpenedAt = new Date().toISOString()
      config.path = resolvedPath
    } else {
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
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2))

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
      totalNotes: counts.notes
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
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { templateEngine } = require('./TemplateEngine') as typeof import('./TemplateEngine')
      templateEngine.seedBuiltinToVault(workspacePath)
    } catch (err) {
      console.error('Failed to seed templates:', err)
    }
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
      totalNotes: 0
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

  readFile(filePath: string): { content: string; mtime: number } {
    const stats = fs.statSync(filePath)
    const content = fs.readFileSync(filePath, 'utf-8')
    return { content, mtime: stats.mtimeMs }
  }

  writeFile(filePath: string, content: string): void {
    const dir = path.dirname(filePath)
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }
    fs.writeFileSync(filePath, content, 'utf-8')
  }

  deleteFile(filePath: string): void {
    if (fs.existsSync(filePath)) {
      const stats = fs.statSync(filePath)
      if (stats.isDirectory()) {
        fs.rmSync(filePath, { recursive: true })
      } else {
        fs.unlinkSync(filePath)
      }
    }
  }

  createFile(filePath: string, content = ''): void {
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
    const walk = (dir: string) => {
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
   * Scan all vault Markdown files and rewrite [[oldTitle]] → [[newTitle]].
   * Returns the list of absolute paths that were modified.
   */
  updateLinksInVault(oldTitle: string, newTitle: string): string[] {
    if (!oldTitle || !newTitle || oldTitle === newTitle) return []
    // Match [[OldTitle]], [[OldTitle|alias]], [[OldTitle#heading]], [[OldTitle#heading|alias]]
    const pattern = new RegExp(
      `\\[\\[${escapeRegex(oldTitle)}((?:#[^\\]|]*)?)?(\\|[^\\]]*)?\\]\\]`,
      'gi'
    )
    const affected: string[] = []
    for (const filePath of this.getAllMarkdownPaths()) {
      let raw: string
      try {
        raw = fs.readFileSync(filePath, 'utf-8')
      } catch {
        continue
      }
      if (!pattern.test(raw)) continue
      pattern.lastIndex = 0
      const updated = raw.replace(pattern, (_match, heading, alias) => {
        const h = heading || ''
        const a = alias || ''
        return `[[${newTitle}${h}${a}]]`
      })
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
    if (path.resolve(oldPath) === path.resolve(newPath)) return { renamedLinks: 0, affectedFiles: [] }
    if (fs.existsSync(newPath)) {
      throw new Error(`Target already exists: ${newPath}`)
    }
    const dir = path.dirname(newPath)
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }

    // Auto-update WikiLinks in vault before renaming the file on disk
    let affectedFiles: string[] = []
    const shouldUpdateLinks = opts?.updateLinks !== false
    if (shouldUpdateLinks && oldPath.toLowerCase().endsWith('.md')) {
      const oldTitle = path.basename(oldPath, '.md')
      const newTitle = path.basename(newPath, '.md')
      affectedFiles = this.updateLinksInVault(oldTitle, newTitle)
    }

    fs.renameSync(oldPath, newPath)
    return { renamedLinks: affectedFiles.length, affectedFiles }
  }

  // Settings migration system
  private migrateSettings(raw: Record<string, unknown>): Record<string, unknown> {
    const version = (raw.version as number) || 0
    if (version >= SETTINGS_VERSION) return raw

    let migrated = { ...raw }
    
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

  getSettings(): Record<string, unknown> {
    const settingsPath = this.getSettingsPath()
    try {
      if (fs.existsSync(settingsPath)) {
        const raw = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as Record<string, unknown>
        const migrated = this.migrateSettings(raw)
        // If version changed, save migrated version
        if ((raw.version as number) !== SETTINGS_VERSION) {
          this.saveSettings(migrated)
        }
        return revealSettingsSecrets(migrated)
      }
    } catch (err) {
      console.error('[WorkspaceEngine] getSettings failed:', err)
    }
    return { version: SETTINGS_VERSION }
  }

  /** Raw settings as stored on disk (encrypted secrets) */
  getSettingsRaw(): Record<string, unknown> {
    const settingsPath = this.getSettingsPath()
    try {
      if (fs.existsSync(settingsPath)) {
        const raw = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as Record<string, unknown>
        return this.migrateSettings(raw)
      }
    } catch {}
    return {}
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
