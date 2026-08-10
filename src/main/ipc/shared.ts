import { BrowserWindow } from 'electron'
import fs from 'fs'
import crypto from 'crypto'
import path from 'path'
import { workspaceEngine, isTrashPath } from '../engine/WorkspaceEngine'
import { markdownEngine } from '../engine/MarkdownEngine'
import { graphEngine } from '../engine/GraphEngine'
import { searchEngine } from '../engine/SearchEngine'
import { indexDatabase } from '../engine/IndexDatabase'
import { domainEngine } from '../engine/DomainEngine'
import { fileWatcher, type FileChangeEvent } from '../engine/FileWatcher'
import { aiMiddleware } from '../ai/AIMiddleware'
import { embeddingEngine } from '../ai/EmbeddingEngine'
import { automationEngine } from '../engine/AutomationEngine'
import { readPermissions } from '../security/Permissions'
import type { ParsedMarkdown } from '../engine/MarkdownEngine'

export function coerceDateStr(val: unknown): string {
  if (val == null || val === '') return ''
  if (val instanceof Date) return val.toISOString()
  if (typeof val === 'number') return new Date(val).toISOString()
  return String(val)
}

export function stampMtime(parsed: ParsedMarkdown, filePath: string): ParsedMarkdown {
  try {
    const mtime = fs.statSync(filePath).mtime.toISOString()
    const fm = coerceDateStr(parsed.frontmatter.updated) || coerceDateStr(parsed.frontmatter.date)
    // Prefer newer of frontmatter date vs filesystem mtime (recent notes accuracy)
    parsed.frontmatter.updated = !fm || mtime > fm ? mtime : fm
  } catch {
    /* ignore */
  }
  return parsed
}

export function requireOpenVault(): string {
  const root = workspaceEngine.getState().rootPath
  if (!root) throw new Error('No workspace open')
  return root
}

const ATTACH_EXTS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.svg',
  '.bmp',
  '.pdf',
  '.mp3',
  '.mp4',
  '.wav',
  '.webm',
  '.zip',
  '.csv',
  '.json',
  '.xlsx',
  '.docx',
  '.pptx',
  '.txt'
])

function collectVaultFiles(fileTree: ReturnType<typeof workspaceEngine.refreshFiles>): {
  mdFiles: string[]
  attachments: { path: string; relativePath: string; extension: string }[]
} {
  const mdFiles: string[] = []
  const attachments: { path: string; relativePath: string; extension: string }[] = []
  function walk(files: typeof fileTree): void {
    for (const f of files) {
      // Never index .trash items (deleted files awaiting restore/empty)
      if (isTrashPath(f.path)) continue
      if (f.isDirectory && f.children) {
        walk(f.children)
      } else if (!f.isDirectory) {
        const ext = (f.extension || '').toLowerCase()
        if (ext === '.md') mdFiles.push(f.path)
        else if (ATTACH_EXTS.has(ext) || (ext && ext !== '.md')) {
          // Prefer known types; still allow other non-md (capped later in engine)
          attachments.push({
            path: f.path,
            relativePath: f.relativePath || f.name,
            extension: ext
          })
        }
      }
    }
  }
  walk(fileTree)
  return { mdFiles, attachments }
}

export function filePathId(filePath: string): string {
  // Must match MarkdownEngine.generateId (sha256 path, 24 hex)
  const key = filePath.replace(/\\/g, '/').toLowerCase()
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 24)
}

export async function syncWorkspaceData(rootPath: string): Promise<void> {
  const fileTree = workspaceEngine.refreshFiles()
  const { mdFiles, attachments } = collectVaultFiles(fileTree)

  const parsedFiles: ParsedMarkdown[] = []
  for (const filePath of mdFiles) {
    try {
      const { content: raw } = workspaceEngine.readFile(filePath)
      const parsed = stampMtime(markdownEngine.parseFile(filePath, raw, rootPath), filePath)
      parsedFiles.push(parsed)
    } catch {
      /* skip unreadable */
    }
  }

  // Build wiki + co-tag star edges; UI defaults hide tag edges (Obsidian-like)
  graphEngine.buildFromParsedFiles(parsedFiles, true)
  // Attachments after notes so [[file.png]] resolves to real nodes
  graphEngine.setAttachments(
    attachments.map((a) => ({
      id: filePathId(a.path),
      path: a.path,
      relativePath: a.relativePath,
      title: a.path.split(/[/\\]/).pop() || a.relativePath
    }))
  )
  domainEngine.setParsedFiles(parsedFiles)
  // Ensure SQLite FTS cache is open before buildIndex writes rebuild
  if (!indexDatabase.isOpen()) {
    indexDatabase.open(rootPath)
  }
  await searchEngine.buildIndex(parsedFiles)
  searchEngine.setOrphanIds(graphEngine.getOrphanNodeIds())
}

export function syncSingleFile(filePath: string, rootPath: string): void {
  if (isTrashPath(filePath)) return
  const lower = filePath.toLowerCase()
  if (lower.endsWith('.md')) {
    try {
      const { content: raw } = workspaceEngine.readFile(filePath)
      const parsed = stampMtime(markdownEngine.parseFile(filePath, raw, rootPath), filePath)
      graphEngine.updateNodeAndEdges(parsed)
      searchEngine.addToIndex(parsed)
      searchEngine.setOrphanIds(graphEngine.getOrphanNodeIds())
    } catch (err) {
      console.error(`Failed to sync single file: ${filePath}`, err)
    }
    return
  }
  // Non-md: lightweight upsert (no full attachment rebuild)
  try {
    const ext = path.extname(filePath).toLowerCase()
    if (!ext || ext === '.md') return
    const rel = path.relative(rootPath, filePath).replace(/\\/g, '/')
    graphEngine.upsertAttachment({
      id: filePathId(filePath),
      path: filePath,
      relativePath: rel,
      title: path.basename(filePath)
    })
    searchEngine.setOrphanIds(graphEngine.getOrphanNodeIds())
  } catch (err) {
    console.error(`Failed to sync attachment: ${filePath}`, err)
  }
}

export function refreshDomainFromDisk(rootPath: string): void {
  try {
    const fileTree = workspaceEngine.getState().files
    const mdFiles: string[] = []
    function collectMd(files: typeof fileTree): void {
      for (const f of files) {
        if (isTrashPath(f.path)) continue
        if (f.isDirectory && f.children) collectMd(f.children)
        else if (!f.isDirectory && f.extension === '.md') mdFiles.push(f.path)
      }
    }
    collectMd(fileTree)
    // If tree stale, use refresh
    if (mdFiles.length === 0) {
      const refreshed = workspaceEngine.refreshFiles()
      collectMd(refreshed)
    }
    const parsedFiles: ParsedMarkdown[] = []
    for (const fp of mdFiles) {
      try {
        const { content: raw } = workspaceEngine.readFile(fp)
        parsedFiles.push(stampMtime(markdownEngine.parseFile(fp, raw, rootPath), fp))
      } catch {
        /* skip */
      }
    }
    domainEngine.setParsedFiles(parsedFiles)
  } catch {
    /* ignore */
  }
}

export function handleFileRemove(filePath: string): void {
  const node = graphEngine.getNodeByPath(filePath)
  if (!node) {
    // Attachment may exist only in registry
    if (!filePath.toLowerCase().endsWith('.md')) {
      graphEngine.removeAttachment(filePath)
      searchEngine.setOrphanIds(graphEngine.getOrphanNodeIds())
    }
    return
  }
  if (node.isAttachment) {
    graphEngine.removeAttachment(node.id)
  } else {
    graphEngine.removeNode(node.id)
    if (filePath.toLowerCase().endsWith('.md')) {
      searchEngine.removeFromIndex(node.id)
    }
  }
  searchEngine.setOrphanIds(graphEngine.getOrphanNodeIds())
}

/**
 * WA-2: cascade removal when a whole FOLDER disappears (unlinkDir / file:delete
 * on a directory). Children have their own nodes — a single-file removal would
 * leave them stale in graph/search/embeddings until a full rebuild.
 */
export function handleDirRemove(dirPath: string): void {
  const prefix = dirPath.replace(/\\/g, '/').toLowerCase()
  // Collect affected .md paths BEFORE removal (search + embedding need them).
  const mdPaths: string[] = []
  for (const n of graphEngine.getGraphData().nodes) {
    const p = (n.path || '').replace(/\\/g, '/').toLowerCase()
    if (p === prefix || p.startsWith(prefix + '/')) {
      if (n.path.toLowerCase().endsWith('.md')) mdPaths.push(n.path)
    }
  }
  graphEngine.removeNodesUnderPath(dirPath)
  for (const fp of mdPaths) {
    searchEngine.removeFromIndex(filePathId(fp))
    embeddingEngine.removeFile(fp)
  }
  searchEngine.setOrphanIds(graphEngine.getOrphanNodeIds())
}

let emitTimeout: NodeJS.Timeout | null = null
export function debounceEmit(): void {
  if (emitTimeout) clearTimeout(emitTimeout)
  emitTimeout = setTimeout(() => {
    // Broadcast to ALL windows — getFocusedWindow() is null when focus is on DevTools/other apps
    const state = workspaceEngine.getState()
    const graph = graphEngine.getGraphData()
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue
      win.webContents.send('workspace:updated', state)
      win.webContents.send('graph:updated', graph)
    }
  }, 1000)
}

/** Paths we just wrote ourselves — skip chokidar double-sync (same file ~ms later). */
const selfWriteIgnore = new Map<string, number>()
export function markSelfWrite(filePath: string): void {
  selfWriteIgnore.set(filePath.replace(/\\/g, '/').toLowerCase(), Date.now())
}
function isSelfWriteEcho(filePath: string, windowMs = 2500): boolean {
  const key = filePath.replace(/\\/g, '/').toLowerCase()
  const t = selfWriteIgnore.get(key)
  if (t == null) return false
  if (Date.now() - t > windowMs) {
    selfWriteIgnore.delete(key)
    return false
  }
  return true
}

/** Shared attach for open + create vault (prevents create without live reindex) */
export function attachFileWatcher(folderPath: string): void {
  fileWatcher.start(folderPath)
  fileWatcher.removeAllListeners('change')
  // WA-1: an EventEmitter that emit('error') with NO listener throws (uncaught
  // exception → main crash). Chokidar errors (permission denied, disk I/O) must
  // be logged, never fatal — attach a default listener after every start.
  fileWatcher.removeAllListeners('error')
  fileWatcher.on('error', (err) => {
    console.error('[FileWatcher] chokidar error:', err)
  })
  fileWatcher.on('change', (event: FileChangeEvent) => {
    if (isTrashPath(event.path)) {
      debounceEmit()
      return
    }
    if (event.type === 'add' || event.type === 'change') {
      // file:write already ran syncSingleFile — chokidar echo would double-parse + rebuild edges
      if (isSelfWriteEcho(event.path)) {
        debounceEmit()
        return
      }
      syncSingleFile(event.path, folderPath)
      // Keep embedding index in sync (only .md files)
      if (event.path.toLowerCase().endsWith('.md')) {
        embeddingEngine.reindexFile(event.path).catch(() => {})
      }
      const perms = readPermissions(workspaceEngine.getSettings())
      if (perms.automation && automationEngine.isEnabled()) {
        automationEngine.handleEvent(
          event.type === 'add' ? 'file_created' : 'file_updated',
          event.path
        )
      }
    } else if (event.type === 'unlink' || event.type === 'unlinkDir') {
      // WA-2: a deleted folder must cascade to every child node, not just the
      // folder path (which has no graph node of its own).
      if (event.type === 'unlinkDir') handleDirRemove(event.path)
      else handleFileRemove(event.path)
      embeddingEngine.removeFile(event.path)
      const perms = readPermissions(workspaceEngine.getSettings())
      if (perms.automation && automationEngine.isEnabled()) {
        automationEngine.handleEvent('file_deleted', event.path)
      }
    } else if (event.type === 'addDir') {
      debounceEmit()
      return
    }
    debounceEmit()
  })
}

export function loadSettingsIntoProviders(): void {
  const settings = workspaceEngine.getSettings() as {
    ai?: Record<
      string,
      {
        apiKey?: string
        baseUrl?: string
        defaultModel?: string
        backend?: string
        useCliSession?: string | boolean
      }
    >
    activeProvider?: string
  }
  if (settings.ai) {
    for (const [providerId, cfg] of Object.entries(settings.ai)) {
      try {
        // Never pass empty apiKey — that would wipe an in-memory key after Save
        const patch: {
          apiKey?: string
          baseUrl?: string
          defaultModel?: string
          backend?: string
          useCliSession?: boolean
        } = {}
        if (cfg.apiKey && cfg.apiKey.trim()) patch.apiKey = cfg.apiKey.trim()
        if (cfg.baseUrl) patch.baseUrl = cfg.baseUrl
        if (cfg.defaultModel) patch.defaultModel = cfg.defaultModel
        if (cfg.backend) patch.backend = cfg.backend
        // Migrate broken CLI proxy → official API (proxy 426 for non-CLI)
        if (providerId === 'grok') {
          if (!patch.baseUrl || patch.baseUrl.includes('cli-chat-proxy')) {
            patch.baseUrl = 'https://api.x.ai/v1'
            patch.backend = 'chat'
          }
          if (cfg.useCliSession === '1' || cfg.useCliSession === true || !!cfg.apiKey) {
            patch.useCliSession = true
          }
        }
        if (Object.keys(patch).length > 0) {
          aiMiddleware.configureProvider(providerId, patch)
        }
      } catch {
        /* provider may not exist */
      }
    }
  }
  if (settings.activeProvider) {
    try {
      aiMiddleware.setActiveProvider(settings.activeProvider)
    } catch {
      /* ignore */
    }
  } else if (settings.ai?.grok?.apiKey) {
    try {
      aiMiddleware.setActiveProvider('grok')
    } catch {
      /* ignore */
    }
  }
}
