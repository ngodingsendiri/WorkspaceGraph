import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

const api = {
  // Dialog
  openFolder: () => ipcRenderer.invoke('dialog:openFolder'),

  // Kerja / Obsidian vault Diskominfo
  resolveKerjaVault: () => ipcRenderer.invoke('kerja:resolveVault'),
  openKerjaVault: () => ipcRenderer.invoke('kerja:openVault'),

  // Workspace
  openWorkspace: (folderPath: string) => ipcRenderer.invoke('workspace:open', folderPath),
  createWorkspace: (parentPath: string, name: string) =>
    ipcRenderer.invoke('workspace:create', { parentPath, name }),
  closeWorkspace: () => ipcRenderer.invoke('workspace:close'),
  getWorkspaceState: () => ipcRenderer.invoke('workspace:getState'),
  getRecentWorkspaces: () => ipcRenderer.invoke('workspace:getRecent'),
  onWorkspaceUpdated: (callback: (state: unknown) => void) => {
    const handler = (_: unknown, state: unknown) => callback(state)
    ipcRenderer.on('workspace:updated', handler)
    return () => ipcRenderer.removeListener('workspace:updated', handler)
  },

  // Files
  readFile: (filePath: string) => ipcRenderer.invoke('file:read', filePath),
  writeFile: (filePath: string, content: string) =>
    ipcRenderer.invoke('file:write', { filePath, content }),
  deleteFile: (filePath: string) => ipcRenderer.invoke('file:delete', filePath),
  createFile: (filePath: string, content?: string) =>
    ipcRenderer.invoke('file:create', { filePath, content }),
  createFolder: (folderPath: string) => ipcRenderer.invoke('file:createFolder', folderPath),
  renameFile: (oldPath: string, newPath: string) =>
    ipcRenderer.invoke('file:rename', { oldPath, newPath }),

  // Graph
  getGraphData: () => ipcRenderer.invoke('graph:getData'),
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
    nodes: Record<string, { x: number; y: number; pinned?: boolean }>
    replaceAll?: boolean
  }) => ipcRenderer.invoke('graph:saveLayout', payload),
  getGraphSettings: () => ipcRenderer.invoke('graph:getSettings'),
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
    const handler = (_: unknown, data: unknown) => callback(data)
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
  testAIProvider: (providerId?: string) => ipcRenderer.invoke('ai:testProvider', providerId),
  importGrokCli: () => ipcRenderer.invoke('ai:importGrokCli'),
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
    onChunk: (chunk: {
      content: string
      done: boolean
      citations?: { title: string; path: string }[]
      proposals?: unknown[]
      toolStatus?: string
      round?: number
      error?: string
    }) => void,
    activeFilePath?: string,
    useContext?: boolean,
    agentRole?: string,
    enableTools?: boolean
  ) => {
    const requestId = Math.random().toString(36).slice(2)
    const channel = `ai:stream:${requestId}`
    const handler = (
      _: unknown,
      chunk: {
        content: string
        done: boolean
        citations?: { title: string; path: string }[]
        proposals?: unknown[]
        toolStatus?: string
        round?: number
        error?: string
      }
    ) => {
      onChunk(chunk)
      if (chunk.done) {
        ipcRenderer.removeListener(channel, handler)
      }
    }
    ipcRenderer.on(channel, handler)
    ipcRenderer
      .invoke('ai:streamMessage', {
        requestId,
        request,
        activeFilePath,
        useContext,
        agentRole,
        enableTools
      })
      .catch((err: Error) => {
        onChunk({
          content: `\n\n**Error:** ${err?.message || String(err)}`,
          done: true,
          error: err?.message || String(err)
        })
        ipcRenderer.removeListener(channel, handler)
      })
    return requestId
  },
  cancelAIStream: (requestId: string) => ipcRenderer.invoke('ai:cancelStream', requestId),
  applyWriteProposal: (proposalId: string) => ipcRenderer.invoke('ai:applyProposal', proposalId),
  rejectWriteProposal: (proposalId: string) => ipcRenderer.invoke('ai:rejectProposal', proposalId),
  listWriteProposals: () => ipcRenderer.invoke('ai:listProposals'),
  getWriteProposal: (proposalId: string) => ipcRenderer.invoke('ai:getProposal', proposalId),

  saveChat: (conv: unknown) => ipcRenderer.invoke('chat:save', conv),
  listChats: () => ipcRenderer.invoke('chat:list'),
  loadChat: (id: string) => ipcRenderer.invoke('chat:load', id),
  newChatId: () => ipcRenderer.invoke('chat:newId'),

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

  getAutomation: () => ipcRenderer.invoke('automation:get'),
  saveAutomation: (config: unknown) => ipcRenderer.invoke('automation:save', config),
  setAutomationEnabled: (enabled: boolean) => ipcRenderer.invoke('automation:setEnabled', enabled),
  runAutomationRule: (ruleId: string) => ipcRenderer.invoke('automation:runRule', ruleId),

  listPlugins: () => ipcRenderer.invoke('plugins:list'),
  listPluginCommands: () => ipcRenderer.invoke('plugins:commands'),
  reloadPlugins: () => ipcRenderer.invoke('plugins:reload'),

  getApiHealth: () => ipcRenderer.invoke('api:health'),
  getSecurityStatus: () => ipcRenderer.invoke('security:status'),

  // Settings
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (settings: Record<string, unknown>) =>
    ipcRenderer.invoke('settings:save', settings),

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
  // @ts-ignore
  window.electron = electronAPI
  // @ts-ignore
  window.api = api
}
