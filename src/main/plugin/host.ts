import { PluginManifest, PluginPermission, LoadedPlugin, AppAPI, PluginContext } from './sdk/types'
import { join } from 'path'
import { readFile } from 'fs/promises'

// Permission checker
function checkPermission(plugin: LoadedPlugin, permission: string): boolean {
  return plugin.manifest.permissions?.includes(permission as PluginPermission) ?? false
}

// LoadedPlugin type
interface LoadedPluginInternal {
  manifest: PluginManifest
  exports: Record<string, unknown>
  api: AppAPI
  disable: () => void
  dir: string
}

// Sandboxed API proxy
function createApiProxy(plugin: LoadedPluginInternal, context: PluginContext): AppAPI {
  const handler: ProxyHandler<any> = {
    get(target: any, prop: string | symbol) {
      if (typeof prop !== 'string') return target[prop]
      
      const parts = prop.split('.')
      let current = target
      
      for (let i = 0; i < parts.length - 1; i++) {
        if (!current) return undefined
        current = current[parts[i]]
      }
      
      const lastPart = parts[parts.length - 1]
      const method = current[lastPart]
      
      if (typeof method === 'function') {
        return (...args: any[]) => {
          // Check permission based on API namespace
          const ns = parts[0]
          
          switch (ns) {
            case 'vault':
              if (!checkPermission(plugin, `vault.${lastPart}`)) {
                throw new Error(`Permission denied: vault.${lastPart}`)
              }
              break
            case 'search':
              if (!checkPermission(plugin, 'search.read')) {
                throw new Error('Permission denied: search.read')
              }
              break
            case 'graph':
              if (!checkPermission(plugin, `graph.${lastPart === 'read' ? 'read' : 'write'}`)) {
                throw new Error(`Permission denied: graph.${lastPart}`)
              }
              break
            case 'editor':
              if (!checkPermission(plugin, `editor.${lastPart === 'read' ? 'read' : 'write'}`)) {
                throw new Error(`Permission denied: editor.${lastPart}`)
              }
              break
            case 'automation':
              if (!checkPermission(plugin, `automation.${lastPart === 'read' ? 'read' : 'write'}`)) {
                throw new Error(`Permission denied: automation.${lastPart}`)
              }
              break
            case 'settings':
              if (!checkPermission(plugin, `settings.${lastPart === 'read' ? 'read' : 'write'}`)) {
                throw new Error(`Permission denied: settings.${lastPart}`)
              }
              break
            case 'commands':
              if (!checkPermission(plugin, `commands.${lastPart === 'read' ? 'read' : 'write'}`)) {
                throw new Error(`Permission denied: commands.${lastPart}`)
              }
              break
            case 'ui':
              if (!checkPermission(plugin, `ui.${lastPart}`)) {
                throw new Error(`Permission denied: ui.${lastPart}`)
              }
              break
            case 'settings':
              if (!checkPermission(plugin, `settings.${lastPart === 'read' ? 'read' : 'write'}`)) {
                throw new Error(`Permission denied: settings.${lastPart}`)
              }
              break
            case 'workspace':
              if (!checkPermission(plugin, `workspace.${lastPart === 'read' ? 'read' : 'write'}`)) {
                throw new Error(`Permission denied: workspace.${lastPart}`)
              }
              break
            case 'commands':
              if (!checkPermission(plugin, `commands.${lastPart === 'read' ? 'read' : 'write'}`)) {
                throw new Error(`Permission denied: commands.${lastPart}`)
              }
              break
            case 'ui':
              if (!checkPermission(plugin, `ui.${lastPart}`)) {
                throw new Error(`Permission denied: ui.${lastPart}`)
              }
              break
            case 'automation':
              if (!checkPermission(plugin, `automation.${lastPart === 'read' ? 'read' : 'write'}`)) {
                throw new Error(`Permission denied: automation.${lastPart}`)
              }
              break
          }
          
          return method.bind(current)(...args)
        }
        return method
      }
      return current?.[lastPart]
    }
  
  // Build typed API surface
  const api = buildApi(plugin)
  
  return new Proxy(api, handler)
}

// Permission checker
function checkPermission(plugin: LoadedPluginInternal, permission: string): boolean {
  return plugin.manifest.permissions?.includes(permission as any) ?? false
}

// LoadedPlugin type
interface LoadedPluginInternal {
  manifest: PluginManifest
  exports: Record<string, unknown>
  api: AppAPI
  disable: () => void
  dir: string
}

// Build typed API surface
function buildApi(plugin: LoadedPluginInternal, context: PluginContext): AppAPI {
  return {
    vault: createVaultApi(plugin),
    workspace: createWorkspaceApi(plugin),
    editor: createEditorApi(plugin),
    graph: createGraphApi(plugin),
    search: createSearchApi(plugin),
    settings: createSettingsApi(plugin),
    automation: createAutomationApi(plugin),
    commands: createCommandsApi(plugin),
    ui: createUiApi(plugin),
  }
}

function createVaultApi(plugin: LoadedPluginInternal): any {
  return {
    read: async (path: string) => null,
    write: async (path: string, content: string) => {},
    delete: async (path: string) => {},
    exists: async (path: string) => false,
    list: async (path: string) => [],
    stat: async (path: string) => null,
    onChange: (callback: (path: string) => void) => () => {},
  }
}

function createWorkspaceApi(plugin: LoadedPluginInternal): any {
  return {
    getActiveFile: async () => null,
    getOpenFiles: async () => [],
    openFile: async (path: string) => {},
    newFile: async (content?: string) => '',
    onActiveFileChange: (callback: (path: string | null) => void) => () => {},
  }
}

function createEditorApi(plugin: LoadedPluginInternal): any {
  return {
    getContent: async () => '',
    setContent: async (content: string) => {},
    getSelection: async () => '',
    replaceSelection: async (text: string) => {},
    insertAtCursor: async (text: string) => {},
    getCursor: async () => null,
    setCursor: async (pos: { line: number; ch: number }) => {},
  }
}

function createGraphApi(plugin: LoadedPluginInternal): any {
  return {
    getNodes: async () => [],
    getEdges: async () => [],
    getNeighbors: async (nodeId: string, depth?: number) => ({ nodes: [], edges: [] }),
    getBacklinks: async (nodeId: string) => [],
    getOrphans: async () => [],
  }
}

function createSearchApi(plugin: LoadedPluginInternal): any {
  return {
    query: async (options: any) => [],
    getRecent: async (limit?: number) => [],
    getTags: async () => [],
  }
}

function createSettingsApi(plugin: LoadedPluginInternal): any {
  return {
    get: async (key: string) => null,
    set: async (key: string, value: unknown) => {},
    getAll: async () => ({}),
    onChange: (key: string, callback: (value: unknown) => void) => () => {},
  }
}

function createAutomationApi(plugin: LoadedPluginInternal): any {
  return {
    listRules: async () => [],
    runRule: async (id: string) => {},
    createRule: async (rule: any) => ({ ...rule, id: 'new' }),
    deleteRule: async (id: string) => {},
  }
}

function createCommandsApi(plugin: LoadedPluginInternal): any {
  return {
    execute: async (id: string, args?: Record<string, unknown>) => {},
    list: async () => [],
    register: async (command: any) => 'new-id',
    unregister: async (id: string) => {},
  }
}

function createUiApi(plugin: LoadedPluginInternal): any {
  return {
    notify: (message: string, type?: 'info' | 'success' | 'warning' | 'error') => {},
    showInput: async (prompt: string, placeholder?: string) => null,
    showConfirm: async (message: string) => false,
    showSelect: async (options: string[]) => null,
    showProgress: (message: string, progress: number) => {},
    hideProgress: () => {},
    openPanel: (panelId: string) => {},
    closePanel: (panelId: string) => {},
  }
}

// LoadedPlugin type
interface LoadedPluginInternal {
  manifest: PluginManifest
  exports: Record<string, unknown>
  api: AppAPI
  disable: () => void
  dir: string
}

import { PluginManifest, PluginPermission, LoadedPlugin, AppAPI, PluginContext } from './sdk/types'
import { join } from 'path'
import { readFile } from 'fs/promises'

// Permission checker
function checkPermission(plugin: any, permission: string): boolean {
  return plugin.manifest.permissions?.includes(permission as any) ?? false
}

// PluginHost class
export class PluginHost {
  private plugins = new Map<string, LoadedPluginInternal>()
  private appApi: AppAPI
  private context: PluginContext
  private workspaceRoot = ''

  constructor(appApi: AppAPI, context: PluginContext) {
    this.appApi = appApi
    this.context = context
  }

  setWorkspaceRoot(root: string) {
    this.workspaceRoot = root
  }

  async loadPlugin(dir: string): Promise<any> {
    try {
      // Read manifest
      const manifestPath = join(dir, 'manifest.json')
      const manifestContent = await readFile(manifestPath, 'utf-8')
      const manifest = JSON.parse(manifestContent) as PluginManifest
      
      // Validate manifest
      this.validateManifest(manifest)
      
      // Load main module
      const mainPath = join(dir, manifest.main)
      const mod = await import(mainPath)
      
      // Create plugin context
      const context = this.createPluginContext(manifest)
      
      // Create API proxy
      const api = this.createApiProxy(manifest)
      
      // Initialize plugin
      let exports = {}
      if (mod.onload) {
        await mod.onload(api)
      }
      if (mod.exports) {
        exports = mod.exports
      }
      
      const plugin: any = {
        manifest,
        exports,
        api,
        disable: () => {
          if (mod.onunload) {
            mod.onunload()
          }
        },
        dir,
      }
      
      this.plugins.set(manifest.id, plugin)
      return plugin
    } catch (err) {
      console.error(`Failed to load plugin from ${dir}:`, err)
      return null
    }
  }

  async unloadPlugin(id: string): Promise<void> {
    const plugin = this.plugins.get(id)
    if (plugin) {
      plugin.disable()
      this.plugins.delete(id)
    }
  }

  getPlugin(id: string): any {
    return this.plugins.get(id)
  }

  getAllPlugins(): any[] {
    return Array.from(this.plugins.values())
  }

  private validateManifest(manifest: any): void {
    if (!manifest.id || !/^[a-z][a-z0-9-]*$/.test(manifest.id)) {
      throw new Error('Invalid plugin ID (must be lowercase alphanumeric with hyphens)')
    }
    if (!manifest.name) throw new Error('Plugin name is required')
    if (!manifest.version) throw new Error('Plugin version is required')
    if (!manifest.main) throw new Error('Plugin main entry point is required')
    
    // Validate permissions
    const validPermissions = [
      'vault.read', 'vault.write', 'vault.delete', 'vault.list',
      'workspace.read', 'workspace.write',
      'editor.read', 'editor.write',
      'graph.read', 'graph.write',
      'search.read',
      'settings.read', 'settings.write',
      'automation.read', 'automation.write',
      'commands.read', 'commands.write',
      'ui.notify', 'ui.input', 'ui.progress',
    ]
    
    for (const perm of manifest.permissions || []) {
      if (!validPermissions.includes(perm)) {
        throw new Error(`Invalid permission: ${perm}`)
      }
    }
  }

  private createPluginContext(manifest: any): PluginContext {
    return {
      app: this.appApi,
      plugin: {
        id: manifest.id,
        name: manifest.name,
        version: manifest.version,
        dir: '',
      },
      input: {
        prompt: async (message: string, placeholder?: string) => {
          return this.context.input?.prompt(message, placeholder) ?? null
        },
        confirm: async (message: string) => {
          return this.context.input?.confirm(message) ?? false
        },
        select: async (options: string[]) => {
          return this.context.input?.select(options) ?? null
        }
      }
    }
  }

  private createApiProxy(manifest: any): any {
    return this.createApiStubs()
  }

  private createApiStubs(): AppAPI {
    const createNamespace = <T extends Record<string, any>>(methods: string[]): T => {
      const obj = {} as T
      for (const method of methods) {
        obj[method] = async (...args: any[]) => {
          console.warn(`API not implemented`)
          return null
        }
      }
      return obj
    }

    return {
      vault: createNamespace('vault', ['read', 'write', 'delete', 'exists', 'list', 'stat', 'onChange']),
      workspace: createNamespace('workspace', ['getActiveFile', 'getOpenFiles', 'openFile', 'newFile', 'onActiveFileChange']),
      editor: createNamespace('editor', ['getContent', 'setContent', 'getSelection', 'replaceSelection', 'insertAtCursor', 'getCursor', 'setCursor']),
      graph: createNamespace('graph', ['getNodes', 'getEdges', 'getNeighbors', 'getBacklinks', 'getOrphans']),
      search: createNamespace('search', ['query', 'getRecent', 'getTags']),
      settings: createNamespace('settings', ['get', 'set', 'getAll', 'onChange']),
      automation: createNamespace('automation', ['listRules', 'runRule', 'createRule', 'deleteRule']),
      commands: createNamespace('commands', ['execute', 'list', 'register', 'unregister']),
      ui: createNamespace('ui', ['notify', 'showInput', 'showConfirm', 'showSelect', 'showProgress', 'hideProgress', 'openPanel', 'closePanel']),
    }
  }
}

export const pluginHost = new PluginHost({} as any, {} as any)