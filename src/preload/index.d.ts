import { ElectronAPI } from '@electron-toolkit/preload'

export interface API {
  openFolder: () => Promise<string | null>
  resolveKerjaVault: () => Promise<{
    path: string | null
    defaultPath: string
    exists: boolean
    isKerja: boolean
    rel: Record<string, string>
  }>
  openKerjaVault: () => Promise<{ ok: boolean; state?: any; error?: string }>

  openWorkspace: (folderPath: string) => Promise<any>
  createWorkspace: (parentPath: string, name: string) => Promise<any>
  closeWorkspace: () => Promise<boolean>
  getWorkspaceState: () => Promise<any>
  getRecentWorkspaces: () => Promise<string[]>
  onWorkspaceUpdated: (callback: (state: any) => void) => () => void

  readFile: (filePath: string) => Promise<any>
  writeFile: (
    filePath: string,
    content: string,
    expectedMtime?: number
  ) => Promise<
    { conflict: false } | { conflict: true; existingMtime: number; theirs: string; yours: string }
  >
  deleteFile: (filePath: string) => Promise<{ ok: boolean; trashed: boolean; trashPath?: string }>
  restoreFile: (filePath: string) => Promise<{ ok: boolean; path: string }>
  emptyTrash: () => Promise<{ ok: boolean; count: number }>
  createFile: (filePath: string, content?: string) => Promise<boolean>
  createFolder: (folderPath: string) => Promise<boolean>
  renameFile: (
    oldPath: string,
    newPath: string
  ) => Promise<{ ok: boolean; renamedLinks: number; affectedFiles: string[] }>
  openFileExternal: (filePath: string) => Promise<{ ok: boolean; error?: string }>

  getGraphData: () => Promise<any>
  getGraphSkeleton: () => Promise<{
    nodes: any[]
    edges: any[]
    nodeCount: number
    edgeCount: number
    realNodeCount: number
  }>
  getGraphNeighbors: (nodeId: string, depth?: number) => Promise<any>
  getLocalGraph: (opts: {
    nodeIdOrPath: string
    depth?: number
    includeTagEdges?: boolean
  }) => Promise<{
    centerId: string
    depth: number
    nodes: any[]
    edges: any[]
    nodeCount: number
    edgeCount: number
  } | null>
  getGraphPath: (opts: {
    fromIdOrPath: string
    toIdOrPath: string
    includeTagEdges?: boolean
    maxDepth?: number
  }) => Promise<{
    fromId: string
    toId: string
    found: boolean
    length: number
    nodeIds: string[]
    edgeKeys: string[]
    nodes: any[]
    edges: any[]
  } | null>
  getGraphNeighborhood: (opts: {
    nodeIdOrPath: string
    depth?: number
    includeTagEdges?: boolean
  }) => Promise<{ centerId: string; ids: string[]; edgeKeys: string[] } | null>
  getGraphOrphans: () => Promise<{ ids: string[]; nodes: any[]; count: number }>
  getGraphHubs: (minDegree?: number) => Promise<{
    minDegree: number
    ids: string[]
    nodes: any[]
    count: number
  }>
  getGraphLayout: () => Promise<{
    version: number
    vaultPath?: string
    updatedAt: string
    nodes: Record<string, { x: number; y: number; pinned?: boolean }>
    camera?: { x: number; y: number; k: number } | null
  }>
  saveGraphLayout: (payload: {
    nodes?: Record<string, { x: number; y: number; pinned?: boolean }>
    camera?: { x: number; y: number; k: number } | null
    replaceAll?: boolean
    cameraOnly?: boolean
  }) => Promise<{ ok: boolean; path?: string; count?: number; error?: string }>
  getGraphSettings: () => Promise<{
    forces: {
      center: number
      charge: number
      linkDist: number
      linkStr: number
      collide: number
    }
    display: {
      showLabels: boolean
      showTagEdges: boolean
      showLegend: boolean
      dimHubs: boolean
      hideOrphans: boolean
      arrows: boolean
      textFade: number
      nodeSize: number
      lineThickness: number
      existingFilesOnly: boolean
      showTags: boolean
      showAttachments: boolean
      animateForces: boolean
      edgeColorBy: 'default' | 'type'
    }
    filters: {
      hubDegreeThreshold: number
      localDepth: number
      orphanMode: 'all' | 'hide' | 'only'
      hubMode: 'all' | 'dim' | 'hide'
      searchMode: 'spotlight' | 'filter'
    }
    groups: Array<{ id: string; query: string; color: string }>
  }>
  saveGraphSettings: (partial: Record<string, unknown>) => Promise<any>
  saveGraphPng: (
    dataUrl: string,
    defaultName: string
  ) => Promise<{
    ok: boolean
    path?: string
    canceled?: boolean
    error?: string
  }>
  listGraphViews: () => Promise<{
    version: number
    vaultPath?: string
    updatedAt: string
    views: Array<{
      id: string
      name: string
      updatedAt: string
      snapshot: Record<string, unknown>
    }>
  }>
  saveGraphView: (payload: {
    id?: string
    name: string
    snapshot: Record<string, unknown>
  }) => Promise<{
    ok: boolean
    view?: { id: string; name: string; updatedAt: string; snapshot: Record<string, unknown> }
    views?: Array<{
      id: string
      name: string
      updatedAt: string
      snapshot: Record<string, unknown>
    }>
    error?: string
  }>
  deleteGraphView: (id: string) => Promise<{
    ok: boolean
    views?: Array<{
      id: string
      name: string
      updatedAt: string
      snapshot: Record<string, unknown>
    }>
    error?: string
  }>
  filterGraphByType: (types: string[]) => Promise<any>
  filterGraphByTag: (tag: string) => Promise<any>
  getBacklinks: (nodeIdOrPath: string) => Promise<{ nodes: any[]; edges: any[] }>
  getOutgoingLinks: (nodeIdOrPath: string) => Promise<{ nodes: any[]; edges: any[] }>
  resolveWikiLink: (target: string) => Promise<string | null>
  onGraphUpdated: (callback: (data: any) => void) => () => void

  searchQuery: (options: any) => Promise<any[]>
  getRecentNotes: (limit: number) => Promise<any[]>
  searchByTag: (tag: string) => Promise<any[]>
  getTags: () => Promise<{ tag: string; count: number }[]>
  getSearchStats: () => Promise<{
    memoryCount: number
    sqlite: { count: number; path: string | null; lastRebuild: string | null; open: boolean }
  }>
  rebuildSearchIndex: () => Promise<{
    ok: boolean
    count?: number
    path?: string | null
    lastRebuild?: string | null
    error?: string
  }>
  renderMarkdown: (content: string) => Promise<string>

  getAIProviders: () => Promise<any[]>
  testAIProvider: (providerId?: string) => Promise<{ ok: boolean; error?: string; sample?: string }>
  importGrokCli: () => Promise<{
    ok: boolean
    error?: string
    email?: string
    model?: string
    baseUrl?: string
    path?: string
  }>
  getEmbeddingStatus: () => Promise<{
    state: 'idle' | 'loading_model' | 'indexing' | 'ready'
    totalChunks: number
    indexedFiles: number
    modelReady: boolean
  }>
  onEmbeddingProgress: (
    callback: (payload: {
      current: number
      total: number
      stage: string
      status: {
        state: 'idle' | 'loading_model' | 'indexing' | 'ready'
        totalChunks: number
        indexedFiles: number
        modelReady: boolean
      }
    }) => void
  ) => () => void
  configureAIProvider: (
    providerId: string,
    apiKey?: string,
    baseUrl?: string,
    defaultModel?: string,
    backend?: string
  ) => Promise<boolean | { ok?: boolean; path?: string; error?: string }>
  setActiveAIProvider: (providerId: string) => Promise<boolean>
  sendAIMessage: (
    request: any,
    activeFilePath?: string,
    useContext?: boolean,
    agentRole?: string
  ) => Promise<any>
  streamAIMessage: (
    request: any,
    onChunk: (chunk: {
      content: string
      done: boolean
      citations?: { title: string; path: string }[]
      proposals?: WriteProposal[]
      toolStatus?: string
      round?: number
      error?: string
      tokensUsed?: number
      contextTokens?: number
      verifications?: { path: string; title: string; supported: boolean; score: number }[]
    }) => void,
    activeFilePath?: string,
    useContext?: boolean,
    agentRole?: string,
    enableTools?: boolean
  ) => string
  cancelAIStream: (requestId: string) => Promise<boolean>
  applyWriteProposal: (
    proposalId: string
  ) => Promise<{ ok: boolean; path?: string; error?: string }>
  rejectWriteProposal: (proposalId: string) => Promise<{ ok: boolean }>
  listWriteProposals: () => Promise<WriteProposal[]>
  getWriteProposal: (proposalId: string) => Promise<WriteProposal | null>
  ensureAiMemory: () => Promise<{
    ok: boolean
    created: string[]
    existing: string[]
    dir?: string
    error?: string
  }>
  listAiMemory: () => Promise<{
    ok: boolean
    dir: string
    files: string[]
    core?: string[]
  }>

  saveChat: (conv: any) => Promise<{ ok: boolean; path?: string; error?: string }>
  listChats: () => Promise<any[]>
  loadChat: (id: string) => Promise<any | null>
  newChatId: () => Promise<string>
  deleteChat: (id: string) => Promise<{ ok: boolean; error?: string }>

  listTemplates: () => Promise<
    {
      id: string
      name: string
      kind: string
      description: string
      defaultFolder: string
      sourcePath?: string
      builtin: boolean
    }[]
  >
  renderTemplate: (
    templateId: string,
    vars?: Record<string, string>
  ) => Promise<{ content: string | null; template: any }>
  createFromTemplate: (opts: {
    templateId: string
    title: string
    folder?: string
    extraVars?: Record<string, string>
  }) => Promise<{ ok: boolean; path?: string; relativePath?: string; error?: string }>
  seedTemplates: () => Promise<{ ok: boolean; count?: number; error?: string }>
  getDomainOverview: () => Promise<any>
  listDomain: (type: string) => Promise<any[]>

  getAutomation: () => Promise<{
    enabled: boolean
    config: {
      version: 1
      rules: Array<{
        id: string
        name: string
        enabled: boolean
        trigger: {
          type: string
          match?: string
          schedule?: {
            every?: number
            unit?: string
            atTime?: string
            daysOfWeek?: number[]
          }
        }
        actions: unknown[]
      }>
    }
    logs: { at: string; ruleId: string; message: string; ok: boolean }[]
    schedule: { running: boolean; nextFire: string | null }
  }>
  saveAutomation: (config: unknown) => Promise<{ ok: boolean; error?: string }>
  setAutomationEnabled: (enabled: boolean) => Promise<boolean>
  runAutomationRule: (ruleId: string) => Promise<{ ok: boolean; error?: string }>

  listPlugins: () => Promise<
    {
      id: string
      name: string
      version: string
      enabled: boolean
      description?: string
      commands: number
      js?: boolean
    }[]
  >
  listPluginCommands: () => Promise<any[]>
  reloadPlugins: () => Promise<{ ok: boolean; count?: number }>
  runPluginCommand: (
    pluginId: string,
    commandId: string,
    args?: Record<string, unknown>
  ) => Promise<{ ok: boolean; result?: unknown; error?: string }>
  revokePluginPermissions: (pluginId: string) => Promise<{ ok: boolean }>
  onPluginNotify: (callback: (payload: { message: string }) => void) => () => void

  getApiHealth: () => Promise<any>
  getSecurityStatus: () => Promise<any>

  getSettings: () => Promise<any>
  saveSettings: (settings: Record<string, any>) => Promise<boolean>

  setTitleBarTheme: (mode: 'dark' | 'light') => Promise<boolean>
}

export interface WriteProposal {
  id: string
  tool: string
  absolutePath: string
  relativePath: string
  content: string
  mode: string
  preview: string
  status: string
  createdAt: string
}

declare global {
  interface Window {
    electron: ElectronAPI
    api: API
  }
}
