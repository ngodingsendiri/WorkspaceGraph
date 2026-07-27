/**
 * Plugin SDK v1 — Typed API surface for WorkspaceGraph plugins
 * Provides safe, declarative access to core functionality without arbitrary code execution
 */

// Core types
export interface PluginManifest {
  id: string
  name: string
  version: string
  author?: string
  description?: string
  permissions?: PluginPermission[]
  commands?: PluginCommand[]
  enabled?: boolean
  minAppVersion?: string
}

export type PluginPermission = 
  | 'vault.read'
  | 'vault.write'
  | 'vault.delete'
  | 'search.read'
  | 'graph.read'
  | 'graph.write'
  | 'editor.read'
  | 'editor.write'
  | 'automation.read'
  | 'automation.write'
  | 'settings.read'
  | 'settings.write'

export interface PluginCommand {
  id: string
  title: string
  icon?: string
  callback: (ctx: PluginContext) => Promise<void> | void
}

export interface PluginContext {
  // App-level
  app: AppAPI
  // Plugin metadata
  plugin: {
    id: string
    name: string
    version: string
    dir: string
  }
  // User input
  input?: {
    prompt: (message: string, placeholder?: string) => Promise<string | null>
    confirm: (message: string) => Promise<boolean>
    select: (options: string[]) => Promise<string | null>
  }
}

// Typed API surface
export interface AppAPI {
  vault: VaultAPI
  workspace: WorkspaceAPI
  editor: EditorAPI
  graph: GraphAPI
  search: SearchAPI
  settings: SettingsAPI
  automation: AutomationAPI
  commands: CommandsAPI
  ui: UIAPI
}

export interface VaultAPI {
  // File operations
  read(path: string): Promise<string | null>
  write(path: string, content: string): Promise<void>
  delete(path: string): Promise<void>
  exists(path: string): Promise<boolean>
  list(path: string): Promise<string[]>
  // Metadata
  stat(path: string): Promise<FileStat | null>
  // Watch
  onChange(callback: (path: string) => void): () => void
}

export interface FileStat {
  path: string
  size: number
  mtime: number
  isDirectory: boolean
}

export interface WorkspaceAPI {
  getActiveFile(): Promise<string | null>
  getOpenFiles(): Promise<string[]>
  openFile(path: string): Promise<void>
  newFile(content?: string): Promise<string>
  onActiveFileChange(callback: (path: string | null) => void): () => void
}

export interface EditorAPI {
  getContent(): Promise<string>
  setContent(content: string): Promise<void>
  getSelection(): Promise<string>
  replaceSelection(text: string): Promise<void>
  insertAtCursor(text: string): Promise<void>
  getCursor(): Promise<{ line: number; ch: number } | null>
  setCursor(pos: { line: number; ch: number }): Promise<void>
}

export interface GraphAPI {
  getNodes(): Promise<GraphNode[]>
  getEdges(): Promise<GraphEdge[]>
  getNeighbors(nodeId: string, depth?: number): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }>
  getBacklinks(nodeId: string): Promise<GraphNode[]>
  getOrphans(): Promise<GraphNode[]>
}

export interface GraphNode {
  id: string
  title: string
  type: string
  path: string
  tags: string[]
}

export interface GraphEdge {
  id: string
  source: string
  target: string
  type: 'wiki_link' | 'tag' | 'folder'
}

export interface SearchAPI {
  query(options: SearchOptions): Promise<SearchResult[]>
  getRecent(limit?: number): Promise<SearchResult[]>
  getTags(): Promise<{ tag: string; count: number }[]>
}

export interface SearchOptions {
  query: string
  limit?: number
  filterType?: string
  filterTag?: string
}

export interface SearchResult {
  id: string
  title: string
  path: string
  relativePath: string
  score: number
  type: string
  tags: string[]
  preview?: string
}

export interface SettingsAPI {
  get(key: string): Promise<unknown>
  set(key: string, value: unknown): Promise<void>
  getAll(): Promise<Record<string, unknown>>
  onChange(key: string, callback: (value: unknown) => void): () => void
}

export interface AutomationAPI {
  listRules(): Promise<AutomationRule[]>
  runRule(id: string): Promise<void>
  createRule(rule: Omit<AutomationRule, 'id'>): Promise<AutomationRule>
  deleteRule(id: string): Promise<void>
}

export interface AutomationRule {
  id: string
  name: string
  trigger: 'file_created' | 'file_modified' | 'file_deleted' | 'schedule' | 'manual'
  condition?: string
  actions: AutomationAction[]
  enabled: boolean
}

export interface AutomationAction {
  type: 'write_file' | 'run_command' | 'search' | 'notify'
  args: Record<string, unknown>
}

export interface CommandsAPI {
  execute(id: string, args?: Record<string, unknown>): Promise<void>
  list(): Promise<CommandInfo[]>
  register(command: Omit<CommandInfo, 'id'>): Promise<string>
  unregister(id: string): Promise<void>
}

export interface CommandInfo {
  id: string
  title: string
  icon?: string
  category?: string
}

export interface UIAPI {
  notify(message: string, type?: 'info' | 'success' | 'warning' | 'error'): void
  showInput(prompt: string, placeholder?: string): Promise<string | null>
  showConfirm(message: string): Promise<boolean>
  showSelect(options: string[]): Promise<string | null>
  showProgress(message: string, progress: number): void
  hideProgress(): void
  openPanel(panelId: string): void
  closePanel(panelId: string): void
}