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
  // M8.4 (API-2): track the app version so api:health reports the REAL
  // release the consumer is talking to (was a stale independent '0.5.0').
  version: '2.0.0',

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

  searchRecentNotes(limit: number): ReturnType<typeof searchEngine.getRecentFiles> {
    return searchEngine.getRecentFiles(limit)
  },

  searchByTag(tag: string): ReturnType<typeof searchEngine.searchByTag> {
    return searchEngine.searchByTag(tag)
  },

  getSearchTags(): ReturnType<typeof searchEngine.getAllTags> {
    return searchEngine.getAllTags()
  },

  getGraph(): GraphData {
    return graphEngine.getGraphData()
  },

  getGraphSkeleton(): ReturnType<typeof graphEngine.getGraphSkeleton> {
    return graphEngine.getGraphSkeleton()
  },

  getGraphNeighbors(nodeId: string, depth = 1): ReturnType<typeof graphEngine.getNeighbors> {
    return graphEngine.getNeighbors(nodeId, depth)
  },

  getGraphOrphans(): {
    ids: string[]
    nodes: unknown[]
    count: number
  } {
    const ids = graphEngine.getOrphanNodeIds()
    return {
      ids,
      nodes: ids.map((id) => graphEngine.getNodeById(id)).filter(Boolean),
      count: ids.length
    }
  },

  getGraphHubs(minDegree: number): {
    minDegree: number
    ids: string[]
    nodes: unknown[]
    count: number
  } {
    const nodes = graphEngine.getHubNodes(minDegree)
    return {
      minDegree,
      ids: nodes.map((n) => n.id),
      nodes,
      count: nodes.length
    }
  },

  getGraphBacklinks(nodeIdOrPath: string): ReturnType<typeof graphEngine.getBacklinks> {
    const nodeId = graphEngine.resolveNodeId(nodeIdOrPath)
    if (!nodeId) return { nodes: [], edges: [] }
    return graphEngine.getBacklinks(nodeId)
  },

  getGraphOutgoing(nodeIdOrPath: string): ReturnType<typeof graphEngine.getOutgoingLinks> {
    const nodeId = graphEngine.resolveNodeId(nodeIdOrPath)
    if (!nodeId) return { nodes: [], edges: [] }
    return graphEngine.getOutgoingLinks(nodeId)
  },

  resolveWikiLink(target: string): ReturnType<typeof graphEngine.resolveTitleToPath> {
    return graphEngine.resolveTitleToPath(target)
  },

  getDomainOverview(): DomainOverview {
    return domainEngine.getOverview()
  },

  listDomain(type: string): ReturnType<typeof domainEngine.listByType> {
    return domainEngine.listByType(type as never)
  },

  peopleLinkedTo(filePath: string): ReturnType<typeof domainEngine.peopleLinkedTo> {
    return domainEngine.peopleLinkedTo(filePath)
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

  /** M6b PLG-1: declarative context-menu extension point. */
  getPluginContextMenus(): ReturnType<typeof pluginHost.listContextMenus> {
    return pluginHost.listContextMenus()
  },

  /** M6b PLG-1: declarative search-provider extension point. */
  getPluginSearchProviders(): ReturnType<typeof pluginHost.listSearchProviders> {
    return pluginHost.listSearchProviders()
  },

  /** M6b PLG-1: run a plugin search provider (sandboxed JS). */
  runPluginSearchProvider(
    pluginId: string,
    providerId: string,
    query: string,
    limit = 10
  ): ReturnType<typeof pluginHost.runSearchProvider> {
    return pluginHost.runSearchProvider(pluginId, providerId, query, limit)
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
