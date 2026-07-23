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
import { readPermissions, DEFAULT_PERMISSIONS } from '../security/Permissions'
import { isPathInVault } from '../security/PathSandbox'

export const InternalAPI = {
  version: '0.5.0',

  getVersion(): string {
    return this.version
  },

  getWorkspaceRoot(): string | null {
    return workspaceEngine.getState().rootPath
  },

  getPermissions() {
    const settings = workspaceEngine.getSettings()
    return readPermissions(settings)
  },

  search(query: string, limit = 20) {
    return searchEngine.search({ query, limit })
  },

  getGraph() {
    return graphEngine.getGraphData()
  },

  getDomainOverview() {
    return domainEngine.getOverview()
  },

  listTemplates() {
    return templateEngine.listTemplates(this.getWorkspaceRoot())
  },

  getIndexStats() {
    return searchEngine.getIndexStats()
  },

  getAutomation() {
    return {
      enabled: automationEngine.isEnabled(),
      config: automationEngine.getConfig(),
      logs: automationEngine.getLogs(30)
    }
  },

  getPlugins() {
    return pluginHost.list().map((p) => ({
      id: p.manifest.id,
      name: p.manifest.name,
      version: p.manifest.version,
      enabled: p.enabled,
      description: p.manifest.description,
      commands: p.manifest.commands?.length || 0
    }))
  },

  getPluginCommands() {
    return pluginHost.listCommands()
  },

  isPathSafe(filePath: string): boolean {
    return isPathInVault(filePath, this.getWorkspaceRoot())
  },

  health() {
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
