import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

/**
 * Track in-flight AI streams so a stream that never emits `done` (provider hang
 * / main-process crash) cannot leak its IPC listener + channel forever.
 */
const STREAM_WATCHDOG_MS = 200_000 // above AIMiddleware's 180s timeout

type AiStreamChunkPayload = {
  content: string
  done: boolean
  citations?: { title: string; path: string }[]
  proposals?: unknown[]
  toolStatus?: string
  toolRun?: {
    runId: string
    tool: string
    status: 'running' | 'ok' | 'error'
    detail?: string
    round?: number
  }
  round?: number
  error?: string
  tokensUsed?: number
  contextTokens?: number
  costUsd?: number
}

const streamWatchdogs = new Map<
  string,
  {
    channel: string
    handler: (_: unknown, chunk: AiStreamChunkPayload) => void
    timer: ReturnType<typeof setTimeout>
  }
>()

function cleanupStream(requestId: string): void {
  const reg = streamWatchdogs.get(requestId)
  if (!reg) return
  clearTimeout(reg.timer)
  ipcRenderer.removeListener(reg.channel, reg.handler)
  streamWatchdogs.delete(requestId)
}

const api = {
  // Dialog
  openFolder: () => ipcRenderer.invoke('dialog:openFolder'),

  // Workspace
  openWorkspace: (folderPath: string) => ipcRenderer.invoke('workspace:open', folderPath),
  createWorkspace: (parentPath: string, name: string) =>
    ipcRenderer.invoke('workspace:create', { parentPath, name }),
  closeWorkspace: () => ipcRenderer.invoke('workspace:close'),
  getWorkspaceState: () => ipcRenderer.invoke('workspace:getState'),
  getRecentWorkspaces: () => ipcRenderer.invoke('workspace:getRecent'),
  onWorkspaceUpdated: (callback: (state: unknown) => void) => {
    const handler = (_: unknown, state: unknown): void => callback(state)
    ipcRenderer.on('workspace:updated', handler)
    return () => ipcRenderer.removeListener('workspace:updated', handler)
  },

  // Files
  readFile: (filePath: string) => ipcRenderer.invoke('file:read', filePath),
  writeFile: (filePath: string, content: string, expectedMtime?: number) =>
    ipcRenderer.invoke('file:write', { filePath, content, expectedMtime }),
  deleteFile: (filePath: string) => ipcRenderer.invoke('file:delete', filePath),
  restoreFile: (filePath: string) => ipcRenderer.invoke('file:restore', filePath),
  emptyTrash: () => ipcRenderer.invoke('file:emptyTrash'),
  createFile: (filePath: string, content?: string) =>
    ipcRenderer.invoke('file:create', { filePath, content }),
  createFolder: (folderPath: string) => ipcRenderer.invoke('file:createFolder', folderPath),
  renameFile: (oldPath: string, newPath: string) =>
    ipcRenderer.invoke('file:rename', { oldPath, newPath }),
  /** Open attachment / non-md with OS default app (vault-sandboxed) */
  openFileExternal: (filePath: string) => ipcRenderer.invoke('file:openExternal', filePath),

  // Graph
  getGraphData: () => ipcRenderer.invoke('graph:getData'),
  getGraphSkeleton: () => ipcRenderer.invoke('graph:getSkeleton'),
  getGraphNeighbors: (nodeId: string, depth?: number) =>
    ipcRenderer.invoke('graph:getNeighbors', nodeId, depth),
  getGraphPath: (opts: {
    fromIdOrPath: string
    toIdOrPath: string
    includeTagEdges?: boolean
    maxDepth?: number
  }) => ipcRenderer.invoke('graph:getPath', opts),
  getGraphNeighborhood: (opts: {
    nodeIdOrPath: string
    depth?: number
    includeTagEdges?: boolean
  }) => ipcRenderer.invoke('graph:getNeighborhood', opts),
  getLocalGraph: (opts: { nodeIdOrPath: string; depth?: number; includeTagEdges?: boolean }) =>
    ipcRenderer.invoke('graph:getLocal', opts),
  getGraphOrphans: () => ipcRenderer.invoke('graph:getOrphans'),
  getGraphHubs: (minDegree?: number) => ipcRenderer.invoke('graph:getHubs', minDegree),
  getGraphLayout: () => ipcRenderer.invoke('graph:getLayout'),
  saveGraphLayout: (payload: {
    nodes?: Record<string, { x: number; y: number; pinned?: boolean }>
    camera?: { x: number; y: number; k: number } | null
    replaceAll?: boolean
    cameraOnly?: boolean
  }) => ipcRenderer.invoke('graph:saveLayout', payload),
  getGraphSettings: () => ipcRenderer.invoke('graph:getSettings'),
  /** Save PNG (base64 data URL) via native save dialog in main process */
  saveGraphPng: (dataUrl: string, defaultName: string) =>
    ipcRenderer.invoke('graph:savePng', { dataUrl, defaultName }),
  saveGraphSettings: (partial: Record<string, unknown>) =>
    ipcRenderer.invoke('graph:saveSettings', partial),
  listGraphViews: () => ipcRenderer.invoke('graph:listViews'),
  saveGraphView: (payload: { id?: string; name: string; snapshot: Record<string, unknown> }) =>
    ipcRenderer.invoke('graph:saveView', payload),
  deleteGraphView: (id: string) => ipcRenderer.invoke('graph:deleteView', id),
  filterGraphByType: (types: string[]) => ipcRenderer.invoke('graph:filterByType', types),
  filterGraphByTag: (tag: string) => ipcRenderer.invoke('graph:filterByTag', tag),
  getBacklinks: (nodeIdOrPath: string) => ipcRenderer.invoke('graph:getBacklinks', nodeIdOrPath),
  getOutgoingLinks: (nodeIdOrPath: string) => ipcRenderer.invoke('graph:getOutgoing', nodeIdOrPath),
  resolveWikiLink: (target: string) => ipcRenderer.invoke('graph:resolveLink', target),
  onGraphUpdated: (callback: (data: unknown) => void) => {
    const handler = (_: unknown, data: unknown): void => callback(data)
    ipcRenderer.on('graph:updated', handler)
    return () => ipcRenderer.removeListener('graph:updated', handler)
  },

  // Search
  searchQuery: (options: unknown) => ipcRenderer.invoke('search:query', options),
  getRecentNotes: (limit: number) => ipcRenderer.invoke('search:recentNotes', limit),
  searchByTag: (tag: string) => ipcRenderer.invoke('search:byTag', tag),
  getTags: () => ipcRenderer.invoke('search:getTags'),
  getSearchStats: () => ipcRenderer.invoke('search:getStats'),
  rebuildSearchIndex: () => ipcRenderer.invoke('search:rebuildIndex'),

  // Markdown
  renderMarkdown: (content: string) => ipcRenderer.invoke('markdown:render', content),

  // AI
  getAIProviders: () => ipcRenderer.invoke('ai:getProviders'),
  /** Dynamic provider registry — the persisted provider defs (add/edit/delete). */
  getAIProviderConfigs: () => ipcRenderer.invoke('ai:getProviderConfigs'),
  saveAIProviderConfigs: (defs: unknown) => ipcRenderer.invoke('ai:saveProviderConfigs', defs),
  /** Reset ke provider bawaan: merge the six built-in seeds back into the def list. */
  resetAIProviderConfigs: () => ipcRenderer.invoke('ai:resetProviderConfigs'),
  /** Persist a model pick as the provider's default (chat picker → survives sessions). */
  setAIProviderDefaultModel: (providerId: string, modelId: string) =>
    ipcRenderer.invoke('ai:setProviderDefaultModel', providerId, modelId),
  /** Per-provider progress push while ai:getProviders is in flight (spinner). */
  onAIProviderStatus: (callback: (status: unknown) => void) => {
    const handler = (_: unknown, status: unknown): void => callback(status)
    ipcRenderer.on('ai:providerStatus', handler)
    return () => ipcRenderer.removeListener('ai:providerStatus', handler)
  },
  testAIProvider: (providerId?: string, overrides?: { apiKey?: string; baseUrl?: string }) =>
    ipcRenderer.invoke('ai:testProvider', providerId, overrides),
  refreshProviderModels: (providerId: string) =>
    ipcRenderer.invoke('ai:refreshProviderModels', providerId),
  importGrokCli: () => ipcRenderer.invoke('ai:importGrokCli'),
  getEmbeddingStatus: () => ipcRenderer.invoke('ai:embeddingStatus'),
  onEmbeddingProgress: (callback: (payload: unknown) => void) => {
    const handler = (_: unknown, payload: unknown): void => callback(payload)
    ipcRenderer.on('embedding:progress', handler)
    return () => ipcRenderer.removeListener('embedding:progress', handler)
  },
  configureAIProvider: (
    providerId: string,
    apiKey?: string,
    baseUrl?: string,
    defaultModel?: string,
    backend?: string
  ) => ipcRenderer.invoke('ai:configure', { providerId, apiKey, baseUrl, defaultModel, backend }),
  setActiveAIProvider: (providerId: string) =>
    ipcRenderer.invoke('ai:setActiveProvider', providerId),
  sendAIMessage: (
    request: unknown,
    activeFilePath?: string,
    useContext?: boolean,
    agentRole?: string
  ) => ipcRenderer.invoke('ai:sendMessage', { request, activeFilePath, useContext, agentRole }),
  streamAIMessage: (
    request: unknown,
    onChunk: (chunk: AiStreamChunkPayload) => void,
    activeFilePath?: string,
    useContext?: boolean,
    agentRole?: string,
    enableTools?: boolean,
    planMode?: boolean,
    /** R2-2: continue a truncated stream from its checkpoint round. */
    resumeFrom?: { round: number; contextTokens?: number }
  ) => {
    const requestId = Math.random().toString(36).slice(2)
    const channel = `ai:stream:${requestId}`
    const handler: (_: unknown, chunk: AiStreamChunkPayload) => void = (_, chunk) => {
      onChunk(chunk)
      if (chunk.done) cleanupStream(requestId)
    }
    ipcRenderer.on(channel, handler)
    // Watchdog: if main never sends `done` and never rejects (provider hang,
    // crash), drop the listener so IPC channels cannot leak across streams.
    const timer = setTimeout(() => cleanupStream(requestId), STREAM_WATCHDOG_MS)
    streamWatchdogs.set(requestId, { channel, handler, timer })
    ipcRenderer
      .invoke('ai:streamMessage', {
        requestId,
        request,
        activeFilePath,
        useContext,
        agentRole,
        enableTools,
        planMode,
        resumeFrom
      })
      .catch((err: Error) => {
        onChunk({
          content: `\n\n**Error:** ${err?.message || String(err)}`,
          done: true,
          error: err?.message || String(err)
        })
        cleanupStream(requestId)
      })
    return requestId
  },
  /** P1 pipeline: sequential agent orchestration (Research → Writer, etc.). */
  streamAIPipeline: (
    request: unknown,
    stages: { role: string; instruction: string }[],
    onChunk: (chunk: AiStreamChunkPayload) => void,
    activeFilePath?: string,
    useContext?: boolean
  ) => {
    const requestId = Math.random().toString(36).slice(2)
    const channel = `ai:stream:${requestId}`
    const handler: (_: unknown, chunk: AiStreamChunkPayload) => void = (_, chunk) => {
      onChunk(chunk)
      if (chunk.done) cleanupStream(requestId)
    }
    ipcRenderer.on(channel, handler)
    const timer = setTimeout(() => cleanupStream(requestId), STREAM_WATCHDOG_MS)
    streamWatchdogs.set(requestId, { channel, handler, timer })
    ipcRenderer
      .invoke('ai:streamPipeline', {
        requestId,
        request,
        stages,
        activeFilePath,
        useContext
      })
      .catch((err: Error) => {
        onChunk({
          content: `\n\n**Error:** ${err?.message || String(err)}`,
          done: true,
          error: err?.message || String(err)
        })
        cleanupStream(requestId)
      })
    return requestId
  },
  cancelAIStream: (requestId: string) => {
    // Release the renderer-side listener so cancel always cleans up, even if the
    // main-process stream never emits a final `done` chunk.
    cleanupStream(requestId)
    return ipcRenderer.invoke('ai:cancelStream', requestId)
  },
  applyWriteProposal: (proposalId: string, content?: string) =>
    ipcRenderer.invoke('ai:applyProposal', proposalId, content),
  rejectWriteProposal: (proposalId: string) => ipcRenderer.invoke('ai:rejectProposal', proposalId),
  listWriteProposals: () => ipcRenderer.invoke('ai:listProposals'),
  promoteToKnowledge: (
    content: string,
    citations: { title: string; path: string }[],
    suggestedTitle?: string
  ) => ipcRenderer.invoke('ai:promoteKnowledge', content, citations, suggestedTitle),
  getWriteProposal: (proposalId: string) => ipcRenderer.invoke('ai:getProposal', proposalId),
  ensureAiMemory: () => ipcRenderer.invoke('ai:ensureMemory'),
  listAiMemory: () => ipcRenderer.invoke('ai:listMemory'),
  listAIEvents: (limit?: number) => ipcRenderer.invoke('ai:listAIEvents', limit),
  getAIEventStats: (days?: number) => ipcRenderer.invoke('ai:getAIEventStats', days),
  clearAIEvents: () => ipcRenderer.invoke('ai:clearAIEvents'),
  exportAIEventsCSV: () => ipcRenderer.invoke('ai:exportAIEventsCSV'),

  saveChat: (conv: unknown) => ipcRenderer.invoke('chat:save', conv),
  listChats: () => ipcRenderer.invoke('chat:list'),
  loadChat: (id: string) => ipcRenderer.invoke('chat:load', id),
  deleteChat: (id: string) => ipcRenderer.invoke('chat:delete', id),
  newChatId: () => ipcRenderer.invoke('chat:newId'),
  // M3.4 (AI-20/21/22)
  renameChat: (id: string, title: string) => ipcRenderer.invoke('chat:rename', id, title),
  archiveChat: (id: string) => ipcRenderer.invoke('chat:archive', id),
  exportChat: (id: string, format?: string) => ipcRenderer.invoke('chat:export', id, format),
  searchChats: (query: string, limit?: number) => ipcRenderer.invoke('chat:search', query, limit),

  // R2-2: stream resume checkpoints (.workspacegraph/checkpoints)
  saveCheckpoint: (cp: unknown) => ipcRenderer.invoke('checkpoint:save', cp),
  listCheckpoints: () => ipcRenderer.invoke('checkpoint:list'),
  loadCheckpoint: (id: string) => ipcRenderer.invoke('checkpoint:load', id),
  deleteCheckpoint: (id: string) => ipcRenderer.invoke('checkpoint:delete', id),

  // Templates + domain (Phase 4)
  listTemplates: () => ipcRenderer.invoke('template:list'),
  renderTemplate: (templateId: string, vars?: Record<string, string>) =>
    ipcRenderer.invoke('template:render', { templateId, vars }),
  createFromTemplate: (opts: {
    templateId: string
    title: string
    folder?: string
    extraVars?: Record<string, string>
  }) => ipcRenderer.invoke('template:createNote', opts),
  seedTemplates: () => ipcRenderer.invoke('template:seed'),
  getDomainOverview: () => ipcRenderer.invoke('domain:overview'),
  listDomain: (type: string) => ipcRenderer.invoke('domain:list', type),
  getPeopleLinkedTo: (filePath: string) => ipcRenderer.invoke('domain:peopleLinkedTo', filePath),

  getAutomation: () => ipcRenderer.invoke('automation:get'),
  saveAutomation: (config: unknown) => ipcRenderer.invoke('automation:save', config),
  setAutomationEnabled: (enabled: boolean) => ipcRenderer.invoke('automation:setEnabled', enabled),
  runAutomationRule: (ruleId: string) => ipcRenderer.invoke('automation:runRule', ruleId),

  // MCP (R0-1) — server registry + tool discovery for the AI agent
  getMcpServers: () => ipcRenderer.invoke('mcp:getServers'),
  saveMcpServers: (servers: unknown[]) => ipcRenderer.invoke('mcp:saveServers', servers),
  testMcpServer: (server: unknown) => ipcRenderer.invoke('mcp:testServer', server),
  getMcpTools: () => ipcRenderer.invoke('mcp:getTools'),

  listPlugins: () => ipcRenderer.invoke('plugins:list'),
  listPluginCommands: () => ipcRenderer.invoke('plugins:commands'),
  reloadPlugins: () => ipcRenderer.invoke('plugins:reload'),
  runPluginCommand: (pluginId: string, commandId: string, args?: Record<string, unknown>) =>
    ipcRenderer.invoke('plugins:runCommand', { pluginId, commandId, args }),
  revokePluginPermissions: (pluginId: string) => ipcRenderer.invoke('plugins:revoke', pluginId),
  onPluginNotify: (callback: (payload: { message: string }) => void) => {
    const handler = (_: unknown, payload: { message: string }): void => callback(payload)
    ipcRenderer.on('plugin:notify', handler)
    return () => ipcRenderer.removeListener('plugin:notify', handler)
  },

  getApiHealth: () => ipcRenderer.invoke('api:health'),
  getSecurityStatus: () => ipcRenderer.invoke('security:status'),

  // Settings
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (settings: Record<string, unknown>) =>
    ipcRenderer.invoke('settings:save', settings),

  // M8.6 (SEC-2): manual vault backup
  createBackup: () => ipcRenderer.invoke('backup:create'),
  listBackups: () => ipcRenderer.invoke('backup:list'),

  // Window chrome (title bar overlay colors for light/dark)
  setTitleBarTheme: (mode: 'dark' | 'light') => ipcRenderer.invoke('window:setTitleBarTheme', mode)
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore -- electronAPI is defined by @electron-toolkit/preload at runtime; types are unavailable in this sandbox
  window.electron = electronAPI
  // @ts-ignore -- the full Api shape lives in index.d.ts; the runtime object is assembled here without a literal type
  window.api = api
}
