import { app, dialog, ipcMain } from 'electron'
import fs from 'fs'
import path from 'path'
import { workspaceEngine } from '../../engine/WorkspaceEngine'
import { graphEngine } from '../../engine/GraphEngine'
import {
  readGraphSettingsFromAppSettings,
  loadGraphLayout,
  saveGraphLayout,
  loadGraphViews,
  upsertGraphView,
  deleteGraphView,
  mergeGraphSettings
} from '../../engine/GraphLayoutStore'

export function registerGraphHandlers(): void {
  ipcMain.handle('graph:getData', async () => {
    return graphEngine.getGraphData()
  })

  /**
   * Skeleton graph: node metadata only (no outLinks, no content).
   * Suitable for Global Graph view on large vaults — much lighter IPC payload.
   */
  ipcMain.handle('graph:getSkeleton', async () => {
    return graphEngine.getGraphSkeleton()
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

  /**
   * Save PNG (base64 data URL) via native save dialog — renderer <a download>
   * with data: URLs is unreliable in Electron (silent no-op without will-download).
   */
  ipcMain.handle(
    'graph:savePng',
    async (_, { dataUrl, defaultName }: { dataUrl: string; defaultName: string }) => {
      try {
        if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/png;base64,')) {
          return { ok: false, error: 'Invalid PNG data' }
        }
        const b64 = dataUrl.slice('data:image/png;base64,'.length)
        const buf = Buffer.from(b64, 'base64')
        if (buf.length === 0) return { ok: false, error: 'Empty PNG' }
        const root = workspaceEngine.getState().rootPath
        const res = await dialog.showSaveDialog({
          title: 'Export graph as PNG',
          defaultPath: path.join(root || app.getPath('pictures'), defaultName),
          filters: [{ name: 'PNG image', extensions: ['png'] }]
        })
        if (res.canceled || !res.filePath) return { ok: false, canceled: true }
        fs.writeFileSync(res.filePath, buf)
        return { ok: true, path: res.filePath }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
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
}
