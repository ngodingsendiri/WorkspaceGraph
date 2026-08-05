/**
 * Stable Internal API surface (blueprint 30) — facade used by IPC / future plugins.
 * Keeps core engines decoupled from transport.
 */
import { workspaceEngine } from '../engine/WorkspaceEngine'
import { searchEngine } from '../engine/SearchEngine'
import { graphEngine } from '../engine/GraphEngine'
import { templateEngine } from '../engine/TemplateEngine'
import { domainEngine } from '../engine/DomainEngine'
import { automationEngine } from '../engine/AutomationEngine'
import { pluginHost } from '../plugin/PluginHost'
import { indexDatabase } from '../engine/IndexDatabase'
import { readPermissions, DEFAULT_PERMISSIONS, type AppPermissions } from '../security/Permissions'
import { isPathInVault } from '../security/PathSandbox'
import type { SearchResult } from '../workers/worker-pool'
import type { GraphData } from '../engine/GraphEngine'
import type { DomainOverview } from '../engine/DomainEngine'
import type { TemplateDef } from '../engine/TemplateEngine'

export const InternalAPI = {
  version: '0.5.0',

  getVersion(): string {
    return this.version
  },

  getWorkspaceRoot(): string | null {
    return workspaceEngine.getState().rootPath
  },

  getPermissions(): AppPermissions {
    const settings = workspaceEngine.getSettings()
    return readPermissions(settings)
  },

  search(query: string, limit = 20): Promise<SearchResult[]> {
    return searchEngine.search({ query, limit })
  },

  getGraph(): GraphData {
    return graphEngine.getGraphData()
  },

  getDomainOverview(): DomainOverview {
    return domainEngine.getOverview()
  },

  listTemplates(): TemplateDef[] {
    return templateEngine.listTemplates(this.getWorkspaceRoot())
  },

  getIndexStats(): ReturnType<typeof searchEngine.getIndexStats> {
    return searchEngine.getIndexStats()
  },

  getAutomation(): {
    enabled: boolean
    config: ReturnType<typeof automationEngine.getConfig>
    logs: ReturnType<typeof automationEngine.getLogs>
  } {
    return {
      enabled: automationEngine.isEnabled(),
      config: automationEngine.getConfig(),
      logs: automationEngine.getLogs(30)
    }
  },

  getPlugins(): Array<{
    id: string
    name: string
    version: string
    enabled: boolean
    description?: string
    commands: number
    js: boolean
  }> {
    return pluginHost.list().map((p) => ({
      id: p.manifest.id,
      name: p.manifest.name,
      version: p.manifest.version,
      enabled: p.enabled,
      description: p.manifest.description,
      commands: p.manifest.commands?.length || 0,
      js: p.js || false
    }))
  },

  getPluginCommands(): ReturnType<typeof pluginHost.listCommands> {
    return pluginHost.listCommands()
  },

  runPluginCommand(
    pluginId: string,
    commandId: string,
    args: Record<string, unknown> = {}
  ): ReturnType<typeof pluginHost.runCommand> {
    return pluginHost.runCommand(pluginId, commandId, args)
  },

  revokePluginPermissions(pluginId: string): { ok: boolean } {
    pluginHost.revokePermissions(pluginId)
    return { ok: true }
  },

  isPathSafe(filePath: string): boolean {
    return isPathInVault(filePath, this.getWorkspaceRoot())
  },

  health(): {
    apiVersion: string
    workspaceOpen: boolean
    root: string | null
    index: ReturnType<typeof indexDatabase.getStats>
    searchMemory: ReturnType<typeof searchEngine.getIndexSize>
    permissions: AppPermissions
    defaults: typeof DEFAULT_PERMISSIONS
    plugins: number
    automationRules: number
  } {
    const root = this.getWorkspaceRoot()
    return {
      apiVersion: this.version,
      workspaceOpen: Boolean(root),
      root,
      index: indexDatabase.getStats(),
      searchMemory: searchEngine.getIndexSize(),
      permissions: this.getPermissions(),
      defaults: DEFAULT_PERMISSIONS,
      plugins: this.getPlugins().length,
      automationRules: automationEngine.getConfig().rules.length
    }
  }
}

export type InternalAPIType = typeof InternalAPI
