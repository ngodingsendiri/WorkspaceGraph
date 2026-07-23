import { ipcMain, dialog, BrowserWindow, shell } from 'electron'
import fs from 'fs'
import crypto from 'crypto'
import { workspaceEngine } from '../engine/WorkspaceEngine'
import { markdownEngine } from '../engine/MarkdownEngine'
import { graphEngine } from '../engine/GraphEngine'
import { searchEngine } from '../engine/SearchEngine'
import { indexDatabase } from '../engine/IndexDatabase'
import { domainEngine } from '../engine/DomainEngine'
import { templateEngine } from '../engine/TemplateEngine'
import path from 'path'
import { fileWatcher, type FileChangeEvent } from '../engine/FileWatcher'
import { aiMiddleware } from '../ai/AIMiddleware'
import { applyProposal, rejectProposal, listPendingProposals, getProposal } from '../ai/AgentTools'
import {
  saveConversation,
  listConversations,
  loadConversation,
  newConversationId,
  type StoredConversation
} from '../ai/ConversationStore'
import { automationEngine } from '../engine/AutomationEngine'
import { pluginHost } from '../plugin/PluginHost'
import { InternalAPI } from '../api/InternalAPI'
import { readPermissions } from '../security/Permissions'
import { assertPathInVault } from '../security/PathSandbox'
import { isEncryptedForm } from '../security/SecretsStore'
import {
  resolveKerjaVault,
  isKerjaVault,
  KERJA_REL,
  DEFAULT_KERJA_VAULT
} from '../config/KerjaPaths'
import type { ParsedMarkdown } from '../engine/MarkdownEngine'
// Static import — dynamic require('../engine/GraphLayoutStore') fails at runtime after electron-vite
// bundles main into out/main/index.js (MODULE_NOT_FOUND)
import {
  readGraphSettingsFromAppSettings,
  loadGraphLayout,
  saveGraphLayout,
  loadGraphViews,
  upsertGraphView,
  deleteGraphView,
  mergeGraphSettings
} from '../engine/GraphLayoutStore'

function coerceDateStr(val: unknown): string {
  if (val == null || val === '') return ''
  if (val instanceof Date) return val.toISOString()
  if (typeof val === 'number') return new Date(val).toISOString()
  return String(val)
}

function stampMtime(parsed: ParsedMarkdown, filePath: string): ParsedMarkdown {
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

function requireOpenVault(): string {
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
  function walk(files: typeof fileTree) {
    for (const f of files) {
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

function filePathId(filePath: string): string {
  // Must match MarkdownEngine.generateId (sha256 path, 24 hex)
  const key = filePath.replace(/\\/g, '/').toLowerCase()
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 24)
}

function syncWorkspaceData(rootPath: string): void {
  const fileTree = workspaceEngine.refreshFiles()
  const { mdFiles, attachments } = collectVaultFiles(fileTree)

  const parsedFiles: ParsedMarkdown[] = []
  for (const filePath of mdFiles) {
    try {
      const raw = workspaceEngine.readFile(filePath)
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
  searchEngine.buildIndex(parsedFiles)
  searchEngine.setOrphanIds(graphEngine.getOrphanNodeIds())
}

function syncSingleFile(filePath: string, rootPath: string): void {
  const lower = filePath.toLowerCase()
  if (lower.endsWith('.md')) {
    try {
      const raw = workspaceEngine.readFile(filePath)
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

function refreshDomainFromDisk(rootPath: string): void {
  try {
    const fileTree = workspaceEngine.getState().files
    const mdFiles: string[] = []
    function collectMd(files: typeof fileTree) {
      for (const f of files) {
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
        const raw = workspaceEngine.readFile(fp)
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

function handleFileRemove(filePath: string): void {
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

let emitTimeout: NodeJS.Timeout | null = null
function debounceEmit() {
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
function markSelfWrite(filePath: string): void {
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
function attachFileWatcher(folderPath: string): void {
  fileWatcher.start(folderPath)
  fileWatcher.removeAllListeners('change')
  fileWatcher.on('change', (event: FileChangeEvent) => {
    if (event.type === 'add' || event.type === 'change') {
      // file:write already ran syncSingleFile — chokidar echo would double-parse + rebuild edges
      if (isSelfWriteEcho(event.path)) {
        debounceEmit()
        return
      }
      syncSingleFile(event.path, folderPath)
      const perms = readPermissions(workspaceEngine.getSettings())
      if (perms.automation && automationEngine.isEnabled()) {
        automationEngine.handleEvent(
          event.type === 'add' ? 'file_created' : 'file_updated',
          event.path
        )
      }
    } else if (event.type === 'unlink' || event.type === 'unlinkDir') {
      handleFileRemove(event.path)
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

function loadSettingsIntoProviders(): void {
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

export function registerIPCHandlers(): void {
  loadSettingsIntoProviders()

  // --- Dialog Handlers ---
  ipcMain.handle('dialog:openFolder', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory']
    })
    if (!result.canceled && result.filePaths.length > 0) {
      return result.filePaths[0]
    }
    return null
  })

  /** Resolve Diskominfo / Obsidian kerja vault (default D:\Obs\Obs) */
  ipcMain.handle('kerja:resolveVault', async () => {
    const resolved = resolveKerjaVault()
    return {
      path: resolved,
      defaultPath: DEFAULT_KERJA_VAULT,
      exists: Boolean(resolved && fs.existsSync(resolved)),
      isKerja: resolved ? isKerjaVault(resolved) : false,
      rel: KERJA_REL
    }
  })

  ipcMain.handle('kerja:openVault', async () => {
    const resolved = resolveKerjaVault()
    if (!resolved) {
      return { ok: false, error: `Vault kerja tidak ditemukan. Diharapkan: ${DEFAULT_KERJA_VAULT}` }
    }
    indexDatabase.close()
    graphEngine.clear()
    searchEngine.clear()
    domainEngine.clear()
    const state = workspaceEngine.openWorkspace(resolved)
    const root = state.rootPath || resolved
    indexDatabase.open(root)
    syncWorkspaceData(root)
    attachFileWatcher(root)
    const perms = readPermissions(workspaceEngine.getSettings())
    automationEngine.load(root)
    automationEngine.setEnabled(perms.automation)
    pluginHost.setAllowed(perms.plugins)
    pluginHost.load(root)
    if (perms.automation) automationEngine.handleEvent('workspace_opened')
    // Remember as preferred
    const settings = workspaceEngine.getSettings() as Record<string, unknown>
    settings.defaultVault = root
    settings.kerjaMode = true
    workspaceEngine.saveSettings(settings)
    return { ok: true, state }
  })

  // --- Workspace Handlers ---
  ipcMain.handle('workspace:open', async (_, folderPath: string) => {
    if (!folderPath || typeof folderPath !== 'string') {
      throw new Error('Invalid workspace path')
    }
    indexDatabase.close()
    graphEngine.clear()
    searchEngine.clear()
    domainEngine.clear()
    const state = workspaceEngine.openWorkspace(folderPath)
    const root = state.rootPath
    if (!root) throw new Error('Failed to open workspace')
    indexDatabase.open(root)
    syncWorkspaceData(root)
    attachFileWatcher(root)
    const perms = readPermissions(workspaceEngine.getSettings())
    automationEngine.load(root)
    automationEngine.setEnabled(perms.automation)
    pluginHost.setAllowed(perms.plugins)
    pluginHost.load(root)
    if (perms.automation) {
      automationEngine.handleEvent('workspace_opened')
    }
    return state
  })

  ipcMain.handle(
    'workspace:create',
    async (_, { parentPath, name }: { parentPath: string; name: string }) => {
      if (!parentPath || !name || typeof parentPath !== 'string' || typeof name !== 'string') {
        throw new Error('Invalid parent path or workspace name')
      }
      // Reject path separators in name to avoid nested create surprises
      if (/[/\\]/.test(name) || name === '.' || name === '..') {
        throw new Error('Invalid workspace name')
      }
      const state = workspaceEngine.createWorkspace(parentPath, name)
      if (state.rootPath) {
        indexDatabase.close()
        graphEngine.clear()
        searchEngine.clear()
        domainEngine.clear()
        indexDatabase.open(state.rootPath)
        syncWorkspaceData(state.rootPath)
        attachFileWatcher(state.rootPath)
        const perms = readPermissions(workspaceEngine.getSettings())
        automationEngine.load(state.rootPath)
        automationEngine.setEnabled(perms.automation)
        pluginHost.setAllowed(perms.plugins)
        pluginHost.load(state.rootPath)
      }
      return state
    }
  )

  ipcMain.handle('workspace:close', async () => {
    fileWatcher.stop()
    indexDatabase.close()
    automationEngine.unload()
    pluginHost.unload()
    graphEngine.clear()
    searchEngine.clear()
    domainEngine.clear()
    workspaceEngine.closeWorkspace()
    return true
  })

  ipcMain.handle('workspace:getState', async () => {
    return workspaceEngine.getState()
  })

  ipcMain.handle('workspace:getRecent', async () => {
    return workspaceEngine.getRecentWorkspaces()
  })

  // --- File Handlers (path sandbox) ---
  /** Open any vault file (attachments) with OS default app — sandboxed to vault. */
  ipcMain.handle('file:openExternal', async (_, filePath: string) => {
    const root = requireOpenVault()
    assertPathInVault(filePath, root)
    if (!fs.existsSync(filePath)) {
      return { ok: false, error: 'File not found' }
    }
    const err = await shell.openPath(filePath)
    if (err) return { ok: false, error: err }
    return { ok: true }
  })

  ipcMain.handle('file:read', async (_, filePath: string) => {
    const root = requireOpenVault()
    assertPathInVault(filePath, root)
    const raw = workspaceEngine.readFile(filePath)
    const state = workspaceEngine.getState()
    // light:true — no wiki/heading scan, no HTML. Opening notes must stay snappy.
    const parsed = markdownEngine.parseFile(filePath, raw, state.rootPath || '', {
      light: true
    })
    return { ...parsed, html: '' }
  })

  ipcMain.handle('markdown:render', async (_, content: string) => {
    try {
      if (typeof content !== 'string') return ''
      // Cap size so a pathological note cannot freeze the main process
      const capped = content.length > 500_000 ? content.slice(0, 500_000) : content
      // Strip frontmatter for preview body if present (LF-normalized inside engine)
      let body = capped
      if (body.startsWith('---')) {
        const end = body.indexOf('\n---', 3)
        if (end !== -1) body = body.slice(end + 4)
        else {
          // CRLF frontmatter close: \r\n---
          const endCr = body.indexOf('\r\n---', 3)
          if (endCr !== -1) body = body.slice(endCr + 5)
        }
      }
      return markdownEngine.renderToHtml(body)
    } catch (err) {
      console.error('markdown:render failed:', err)
      return '<p><em>Preview failed</em></p>'
    }
  })

  ipcMain.handle(
    'file:write',
    async (_, { filePath, content }: { filePath: string; content: string }) => {
      const root = requireOpenVault()
      assertPathInVault(filePath, root)
      if (typeof content !== 'string' || content.length > 5_000_000) {
        throw new Error('Invalid or oversized file content')
      }
      workspaceEngine.writeFile(filePath, content)
      const state = workspaceEngine.getState()
      if (state.rootPath) {
        markSelfWrite(filePath)
        syncSingleFile(filePath, state.rootPath)
        debounceEmit()
      }
      return true
    }
  )

  ipcMain.handle('file:delete', async (_, filePath: string) => {
    const root = requireOpenVault()
    assertPathInVault(filePath, root)
    workspaceEngine.deleteFile(filePath)
    handleFileRemove(filePath)
    debounceEmit()
    return true
  })

  ipcMain.handle(
    'file:create',
    async (_, { filePath, content }: { filePath: string; content?: string }) => {
      const root = requireOpenVault()
      assertPathInVault(filePath, root)
      if (content !== undefined && (typeof content !== 'string' || content.length > 5_000_000)) {
        throw new Error('Invalid or oversized file content')
      }
      workspaceEngine.createFile(filePath, content || '')
      const state = workspaceEngine.getState()
      if (state.rootPath) {
        markSelfWrite(filePath)
        syncSingleFile(filePath, state.rootPath)
        debounceEmit()
      }
      return true
    }
  )

  ipcMain.handle('file:createFolder', async (_, folderPath: string) => {
    const root = requireOpenVault()
    assertPathInVault(folderPath, root)
    workspaceEngine.createFolder(folderPath)
    debounceEmit()
    return true
  })

  ipcMain.handle(
    'file:rename',
    async (_, { oldPath, newPath }: { oldPath: string; newPath: string }) => {
      const root = requireOpenVault()
      assertPathInVault(oldPath, root)
      assertPathInVault(newPath, root)
      workspaceEngine.renameFile(oldPath, newPath)
      const state = workspaceEngine.getState()
      if (state.rootPath) {
        markSelfWrite(newPath)
        handleFileRemove(oldPath)
        syncSingleFile(newPath, state.rootPath)
        debounceEmit()
      }
      return true
    }
  )

  // --- Graph Handlers ---
  ipcMain.handle('graph:getData', async () => {
    return graphEngine.getGraphData()
  })

  ipcMain.handle('graph:getNeighbors', async (_, nodeId: string, depth?: number) => {
    return graphEngine.getNeighbors(nodeId, depth ?? 1)
  })

  /** Phase 4: shortest path between two notes (wiki graph). */
  ipcMain.handle(
    'graph:getPath',
    async (
      _,
      opts: {
        fromIdOrPath: string
        toIdOrPath: string
        includeTagEdges?: boolean
        maxDepth?: number
      }
    ) => {
      if (!opts?.fromIdOrPath || !opts?.toIdOrPath) return null
      return graphEngine.findShortestPath(opts.fromIdOrPath, opts.toIdOrPath, {
        includeTagEdges: opts.includeTagEdges,
        maxDepth: opts.maxDepth
      })
    }
  )

  /** Phase 4: neighborhood ids for focus highlight (includes center). */
  ipcMain.handle(
    'graph:getNeighborhood',
    async (_, opts: { nodeIdOrPath: string; depth?: number; includeTagEdges?: boolean }) => {
      if (!opts?.nodeIdOrPath) return null
      return graphEngine.getNeighborhoodIds(opts.nodeIdOrPath, opts.depth ?? 1, {
        includeTagEdges: opts.includeTagEdges
      })
    }
  )

  /** Local graph subgraph (center + neighbors). Phase 0 foundation for Obsidian-like local view. */
  ipcMain.handle(
    'graph:getLocal',
    async (_, opts: { nodeIdOrPath: string; depth?: number; includeTagEdges?: boolean }) => {
      if (!opts?.nodeIdOrPath) return null
      return graphEngine.getLocalGraph(opts.nodeIdOrPath, opts.depth ?? 1, {
        includeTagEdges: opts.includeTagEdges
      })
    }
  )

  ipcMain.handle('graph:getOrphans', async () => {
    const ids = graphEngine.getOrphanNodeIds()
    return {
      ids,
      nodes: ids.map((id) => graphEngine.getNodeById(id)).filter(Boolean),
      count: ids.length
    }
  })

  ipcMain.handle('graph:getHubs', async (_, minDegree?: number) => {
    const settings = workspaceEngine.getSettings()
    const gs = readGraphSettingsFromAppSettings(settings)
    const thr = minDegree ?? gs.filters.hubDegreeThreshold
    const nodes = graphEngine.getHubNodes(thr)
    return {
      minDegree: thr,
      ids: nodes.map((n) => n.id),
      nodes,
      count: nodes.length
    }
  })

  ipcMain.handle('graph:getLayout', async () => {
    const root = workspaceEngine.getState().rootPath
    return loadGraphLayout(root)
  })

  ipcMain.handle(
    'graph:saveLayout',
    async (
      _,
      payload: {
        nodes?: Record<string, { x: number; y: number; pinned?: boolean }>
        camera?: { x: number; y: number; k: number } | null
        replaceAll?: boolean
        cameraOnly?: boolean
      }
    ) => {
      const root = workspaceEngine.getState().rootPath
      return saveGraphLayout(
        root,
        {
          nodes: payload?.nodes || {},
          camera: payload?.camera
        },
        { replaceAll: payload?.replaceAll, cameraOnly: payload?.cameraOnly }
      )
    }
  )

  ipcMain.handle('graph:getSettings', async () => {
    return readGraphSettingsFromAppSettings(workspaceEngine.getSettings())
  })

  /** Phase 5: saved graph views (vault .workspacegraph/graph-views.json) */
  ipcMain.handle('graph:listViews', async () => {
    const root = workspaceEngine.getState().rootPath
    return loadGraphViews(root)
  })

  ipcMain.handle(
    'graph:saveView',
    async (
      _,
      payload: {
        id?: string
        name: string
        snapshot: Record<string, unknown>
      }
    ) => {
      const root = workspaceEngine.getState().rootPath
      return upsertGraphView(root, {
        id: payload?.id,
        name: payload?.name || '',
        snapshot: (payload?.snapshot || {}) as never
      })
    }
  )

  ipcMain.handle('graph:deleteView', async (_, id: string) => {
    const root = workspaceEngine.getState().rootPath
    return deleteGraphView(root, id)
  })

  ipcMain.handle('graph:saveSettings', async (_, partial: Record<string, unknown>) => {
    const settings = workspaceEngine.getSettings() as Record<string, unknown>
    const current = readGraphSettingsFromAppSettings(settings)
    const pf = (partial?.forces || {}) as Record<string, number>
    const pd = (partial?.display || {}) as Record<string, boolean | number>
    const pfil = (partial?.filters || {}) as Record<string, number | string>
    const pg = Array.isArray(partial?.groups) ? partial.groups : undefined
    const merged = mergeGraphSettings({
      forces: { ...current.forces, ...pf },
      display: { ...current.display, ...pd },
      filters: { ...current.filters, ...pfil },
      groups: (pg ?? current.groups) as never
    })
    settings.graph = merged
    workspaceEngine.saveSettings(settings)
    return merged
  })

  ipcMain.handle('graph:filterByType', async (_, types: string[]) => {
    return graphEngine.filterByType(types as never)
  })

  ipcMain.handle('graph:filterByTag', async (_, tag: string) => {
    return graphEngine.filterByTag(tag)
  })

  ipcMain.handle('graph:getBacklinks', async (_, nodeIdOrPath: string) => {
    const nodeId = graphEngine.resolveNodeId(nodeIdOrPath)
    if (!nodeId) return { nodes: [], edges: [] }
    return graphEngine.getBacklinks(nodeId)
  })

  ipcMain.handle('graph:getOutgoing', async (_, nodeIdOrPath: string) => {
    const nodeId = graphEngine.resolveNodeId(nodeIdOrPath)
    if (!nodeId) return { nodes: [], edges: [] }
    return graphEngine.getOutgoingLinks(nodeId)
  })

  ipcMain.handle('graph:resolveLink', async (_, target: string) => {
    return graphEngine.resolveTitleToPath(target)
  })

  // --- Search Handlers ---
  ipcMain.handle('search:query', async (_, options) => {
    return searchEngine.search(options)
  })

  ipcMain.handle('search:recentNotes', async (_, limit: number) => {
    return searchEngine.getRecentFiles(limit)
  })

  ipcMain.handle('search:byTag', async (_, tag: string) => {
    return searchEngine.searchByTag(tag)
  })

  ipcMain.handle('search:getTags', async () => {
    return searchEngine.getAllTags()
  })

  ipcMain.handle('search:getStats', async () => {
    return searchEngine.getIndexStats()
  })

  ipcMain.handle('search:rebuildIndex', async () => {
    const state = workspaceEngine.getState()
    if (!state.rootPath) {
      return { ok: false, error: 'No workspace open', count: 0 }
    }
    if (!indexDatabase.isOpen()) {
      indexDatabase.open(state.rootPath)
    }
    // Full rescan from disk → memory + sqlite
    syncWorkspaceData(state.rootPath)
    const stats = searchEngine.getIndexStats()
    return {
      ok: true,
      count: stats.sqlite.count || stats.memoryCount,
      path: stats.sqlite.path,
      lastRebuild: stats.sqlite.lastRebuild
    }
  })

  // --- AI Handlers ---
  ipcMain.handle('ai:getProviders', async () => {
    return aiMiddleware.getAllProvidersStatus()
  })

  ipcMain.handle('ai:testProvider', async (_, providerId?: string) => {
    return aiMiddleware.testProvider(providerId)
  })

  /** Import Grok CLI session (X account login via `grok` CLI) into WorkspaceGraph */
  ipcMain.handle('ai:importGrokCli', async () => {
    try {
      const res = aiMiddleware.importGrokFromCli()
      if (!res.ok || !res.apiKey) {
        return { ok: false, error: res.error || 'Import gagal' }
      }

      const settings = workspaceEngine.getSettings() as Record<string, unknown>
      const ai = { ...((settings.ai as Record<string, Record<string, string>>) || {}) }
      ai.grok = {
        apiKey: res.apiKey,
        // Official API (cli-chat-proxy returns 426 for non-CLI clients)
        baseUrl: res.baseUrl || 'https://api.x.ai/v1',
        defaultModel: res.model || 'grok-4.5',
        backend: res.backend || 'chat',
        useCliSession: '1'
      }
      settings.ai = ai
      settings.activeProvider = 'grok'
      const savedPath = workspaceEngine.saveSettings(settings)
      loadSettingsIntoProviders()
      return {
        ok: true,
        email: res.email,
        model: res.model,
        baseUrl: res.baseUrl,
        path: savedPath
      }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle(
    'ai:configure',
    async (_, { providerId, apiKey, baseUrl, defaultModel, backend }) => {
      try {
        // Configure in-memory first (plaintext key)
        const patch: {
          apiKey?: string
          baseUrl?: string
          defaultModel?: string
          backend?: string
        } = {}
        if (apiKey !== undefined && String(apiKey).trim()) patch.apiKey = String(apiKey).trim()
        if (baseUrl !== undefined) patch.baseUrl = baseUrl
        if (defaultModel !== undefined) patch.defaultModel = defaultModel
        if (backend !== undefined) patch.backend = backend
        aiMiddleware.configureProvider(providerId, patch)

        // Persist — merge onto existing decrypted settings then encrypt on disk
        const settings = workspaceEngine.getSettings() as Record<string, unknown>
        const ai = { ...((settings.ai as Record<string, Record<string, string>>) || {}) }
        const prev = { ...(ai[providerId] || {}) }
        if (patch.apiKey) prev.apiKey = patch.apiKey
        if (patch.baseUrl !== undefined) prev.baseUrl = patch.baseUrl
        if (patch.defaultModel !== undefined) prev.defaultModel = patch.defaultModel
        if (patch.backend !== undefined) (prev as Record<string, string>).backend = patch.backend
        ai[providerId] = prev
        settings.ai = ai
        const savedPath = workspaceEngine.saveSettings(settings)

        // Reload OTHER fields only — do not wipe key with failed decrypt
        loadSettingsIntoProviders()

        return { ok: true, path: savedPath }
      } catch (err) {
        console.error('[ai:configure] failed:', err)
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  ipcMain.handle('ai:setActiveProvider', async (_, providerId: string) => {
    aiMiddleware.setActiveProvider(providerId)
    const settings = workspaceEngine.getSettings() as Record<string, unknown>
    settings.activeProvider = providerId
    workspaceEngine.saveSettings(settings)
    return true
  })

  ipcMain.handle(
    'ai:sendMessage',
    async (_, { request, activeFilePath, useContext, agentRole }) => {
      const perms = readPermissions(workspaceEngine.getSettings())
      if (!perms.aiAccess) {
        throw new Error('AI access disabled in Settings → Security.')
      }
      if (activeFilePath) assertPathInVault(activeFilePath, requireOpenVault())
      return aiMiddleware.sendMessage(request, activeFilePath, useContext, agentRole)
    }
  )

  ipcMain.handle(
    'ai:streamMessage',
    async (
      event,
      {
        requestId,
        request,
        activeFilePath,
        useContext,
        agentRole,
        enableTools
      }: {
        requestId: string
        request: unknown
        activeFilePath?: string
        useContext?: boolean
        agentRole?: string
        enableTools?: boolean
      }
    ) => {
      const perms = readPermissions(workspaceEngine.getSettings())
      if (!perms.aiAccess) {
        const win = BrowserWindow.fromWebContents(event.sender)
        win?.webContents.send(`ai:stream:${requestId}`, {
          content: '**Error:** AI access disabled in Settings → Security.',
          done: true,
          error: 'AI access disabled in Settings → Security.'
        })
        return
      }
      if (activeFilePath) assertPathInVault(activeFilePath, requireOpenVault())
      const toolsAllowed = Boolean(enableTools) && perms.aiTools
      const win = BrowserWindow.fromWebContents(event.sender)
      const send = (chunk: unknown) => {
        if (win && !win.isDestroyed()) {
          win.webContents.send(`ai:stream:${requestId}`, chunk)
        }
      }
      try {
        await aiMiddleware.streamMessage(
          request as never,
          send,
          activeFilePath,
          useContext,
          (agentRole as never) || 'general',
          toolsAllowed,
          requestId
        )
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        send({
          content: `\n\n**Error:** ${msg}`,
          done: true,
          error: msg
        })
      }
    }
  )

  ipcMain.handle('ai:cancelStream', async (_, requestId: string) => {
    aiMiddleware.cancelStream(requestId)
    return true
  })

  ipcMain.handle('ai:applyProposal', async (_, proposalId: string) => {
    const result = applyProposal(proposalId)
    if (result.ok && result.path) {
      const state = workspaceEngine.getState()
      if (state.rootPath) {
        syncSingleFile(result.path, state.rootPath)
        debounceEmit()
      }
    }
    return result
  })

  ipcMain.handle('ai:rejectProposal', async (_, proposalId: string) => {
    return { ok: rejectProposal(proposalId) }
  })

  ipcMain.handle('ai:listProposals', async () => {
    return listPendingProposals()
  })

  ipcMain.handle('ai:getProposal', async (_, proposalId: string) => {
    return getProposal(proposalId) || null
  })

  // --- Chat persistence (cache under .workspacegraph/chats) ---
  ipcMain.handle('chat:save', async (_, conv: StoredConversation) => {
    if (!conv.id) conv.id = newConversationId()
    conv.updatedAt = new Date().toISOString()
    if (!conv.createdAt) conv.createdAt = conv.updatedAt
    return saveConversation(conv)
  })

  ipcMain.handle('chat:list', async () => {
    return listConversations(40)
  })

  ipcMain.handle('chat:load', async (_, id: string) => {
    return loadConversation(id)
  })

  ipcMain.handle('chat:newId', async () => {
    return newConversationId()
  })

  // --- Templates (Phase 4) ---
  ipcMain.handle('template:list', async () => {
    const root = workspaceEngine.getState().rootPath
    return templateEngine.listTemplates(root).map((t) => ({
      id: t.id,
      name: t.name,
      kind: t.kind,
      description: t.description,
      defaultFolder: t.defaultFolder,
      sourcePath: t.sourcePath,
      builtin: t.builtin
    }))
  })

  ipcMain.handle(
    'template:render',
    async (_, { templateId, vars }: { templateId: string; vars?: Record<string, string> }) => {
      const root = workspaceEngine.getState().rootPath
      const content = templateEngine.renderById(templateId, root, vars || {})
      const tpl = templateEngine.getTemplate(templateId, root)
      return {
        content,
        template: tpl
          ? { id: tpl.id, kind: tpl.kind, defaultFolder: tpl.defaultFolder, name: tpl.name }
          : null
      }
    }
  )

  ipcMain.handle(
    'template:createNote',
    async (
      _,
      {
        templateId,
        title,
        folder,
        extraVars
      }: { templateId: string; title: string; folder?: string; extraVars?: Record<string, string> }
    ) => {
      const state = workspaceEngine.getState()
      if (!state.rootPath) return { ok: false, error: 'No workspace open' }
      const tpl = templateEngine.getTemplate(templateId, state.rootPath)
      if (!tpl) return { ok: false, error: 'Template not found' }

      const safeTitle = (title || 'Untitled').replace(/[<>:"/\\|?*]/g, '-').trim() || 'Untitled'
      const content = templateEngine.render(tpl.body, {
        title: safeTitle,
        filename: safeTitle,
        workspace: path.basename(state.rootPath),
        ...(extraVars || {})
      })

      const destFolder = folder || tpl.defaultFolder
      const root = assertPathInVault(state.rootPath, state.rootPath)
      let fileName = `${safeTitle}.md`
      if (tpl.kind === 'daily') {
        const d = extraVars?.date || new Date().toISOString().split('T')[0]
        fileName = `${d}.md`
      }
      const filePath = assertPathInVault(path.join(root, destFolder, fileName), root)
      if (fs.existsSync(filePath)) {
        return { ok: false, error: `File exists: ${destFolder}/${fileName}`, path: filePath }
      }
      workspaceEngine.createFile(filePath, content)
      syncSingleFile(filePath, state.rootPath)
      debounceEmit()
      return {
        ok: true,
        path: filePath,
        relativePath: `${destFolder}/${fileName}`.replace(/\\/g, '/')
      }
    }
  )

  ipcMain.handle('template:seed', async () => {
    const root = workspaceEngine.getState().rootPath
    if (!root) return { ok: false, error: 'No workspace open', count: 0 }
    const n = templateEngine.seedBuiltinToVault(root)
    debounceEmit()
    return { ok: true, count: n }
  })

  // --- Domain overview (Phase 4) ---
  ipcMain.handle('domain:overview', async () => {
    const root = workspaceEngine.getState().rootPath
    if (root) refreshDomainFromDisk(root)
    return domainEngine.getOverview()
  })

  ipcMain.handle('domain:list', async (_, type: string) => {
    return domainEngine.listByType(type as never)
  })

  // --- Automation ---
  ipcMain.handle('automation:get', async () => {
    return {
      enabled: automationEngine.isEnabled(),
      config: automationEngine.getConfig(),
      logs: automationEngine.getLogs(40)
    }
  })

  ipcMain.handle('automation:save', async (_, config: unknown) => {
    const perms = readPermissions(workspaceEngine.getSettings())
    if (!perms.automation) return { ok: false, error: 'Automation permission disabled' }
    automationEngine.save(config as never)
    return { ok: true }
  })

  ipcMain.handle('automation:setEnabled', async (_, enabled: boolean) => {
    automationEngine.setEnabled(Boolean(enabled))
    return true
  })

  ipcMain.handle('automation:runRule', async (_, ruleId: string) => {
    const perms = readPermissions(workspaceEngine.getSettings())
    if (!perms.automation) return { ok: false, error: 'Automation permission disabled' }
    return automationEngine.runManual(ruleId)
  })

  // --- Plugins ---
  ipcMain.handle('plugins:list', async () => {
    return InternalAPI.getPlugins()
  })

  ipcMain.handle('plugins:commands', async () => {
    return InternalAPI.getPluginCommands()
  })

  ipcMain.handle('plugins:reload', async () => {
    const root = workspaceEngine.getState().rootPath
    if (!root) return { ok: false }
    const perms = readPermissions(workspaceEngine.getSettings())
    pluginHost.setAllowed(perms.plugins)
    pluginHost.load(root)
    return { ok: true, count: pluginHost.list().length }
  })

  // --- Platform API health ---
  ipcMain.handle('api:health', async () => {
    return InternalAPI.health()
  })

  ipcMain.handle('security:status', async () => {
    const settings = workspaceEngine.getSettings()
    const raw = workspaceEngine.getSettingsRaw()
    const ai = (raw.ai || {}) as Record<string, { apiKey?: string }>
    const keyStatus: Record<string, string> = {}
    for (const [id, cfg] of Object.entries(ai)) {
      if (!cfg?.apiKey) keyStatus[id] = 'empty'
      else if (isEncryptedForm(cfg.apiKey)) keyStatus[id] = 'encrypted'
      else if (String(cfg.apiKey).startsWith('plain:')) keyStatus[id] = 'plaintext-fallback'
      else keyStatus[id] = 'legacy-plaintext'
    }
    return {
      permissions: readPermissions(settings),
      secrets: keyStatus,
      encryptionAvailable: (() => {
        try {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const { safeStorage } = require('electron')
          return safeStorage.isEncryptionAvailable()
        } catch {
          return false
        }
      })()
    }
  })

  // --- Settings Handlers ---
  ipcMain.handle('settings:get', async () => {
    return workspaceEngine.getSettings()
  })

  ipcMain.handle('settings:save', async (_, settings: Record<string, unknown>) => {
    workspaceEngine.saveSettings(settings)
    const perms = readPermissions(settings)
    automationEngine.setEnabled(perms.automation)
    pluginHost.setAllowed(perms.plugins)
    loadSettingsIntoProviders()
    return true
  })
}
