import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import { tmpdir } from 'os'
import {
  DEFAULT_GRAPH_SETTINGS,
  mergeGraphSettings,
  loadGraphLayout,
  saveGraphLayout,
  normalizeCamera,
  resolveGraphLod,
  upsertGraphView,
  loadGraphViews,
  deleteGraphView,
  normalizeOrphanMode,
  normalizeHubMode,
  normalizeSearchMode
} from './GraphLayoutStore'

describe('GraphLayoutStore', () => {
  let tmpVault: string

  beforeEach(() => {
    tmpVault = fs.mkdtempSync(path.join(tmpdir(), 'wg-layout-'))
    fs.mkdirSync(path.join(tmpVault, '.workspacegraph'), { recursive: true })
  })

  afterEach(() => {
    try {
      fs.rmSync(tmpVault, { recursive: true, force: true })
    } catch {}
  })

  describe('mergeGraphSettings', () => {
    it('merges partial forces + display onto defaults', () => {
      const merged = mergeGraphSettings({
        forces: { charge: -50 },
        display: { showTagEdges: true }
      })
      expect(merged.forces.charge).toBe(-50)
      expect(merged.display.showTagEdges).toBe(true)
      expect(merged.forces.center).toBe(DEFAULT_GRAPH_SETTINGS.forces.center)
    })

    it('clamps out-of-range values', () => {
      expect(mergeGraphSettings({ forces: { charge: -999 } }).forces.charge).toBe(-400)
      expect(mergeGraphSettings({ filters: { localDepth: 9 } }).filters.localDepth).toBe(5)
      expect(mergeGraphSettings({ filters: { localDepth: 0 } }).filters.localDepth).toBe(1)
      expect(mergeGraphSettings({ forces: { center: 9 } }).forces.center).toBe(0.25)
      expect(mergeGraphSettings({ forces: { linkDist: 1 } }).forces.linkDist).toBe(20)
      expect(mergeGraphSettings({ forces: { linkStr: 0 } }).forces.linkStr).toBe(0.05)
    })

    it('handles null partial', () => {
      const m = mergeGraphSettings(null)
      expect(m.display.existingFilesOnly).toBe(true)
      expect(m.display.showTags).toBe(false)
      expect(m.display.animateForces).toBe(false)
    })

    it('normalizes filter modes with fallback', () => {
      expect(mergeGraphSettings({ filters: { searchMode: 'filter' } }).filters.searchMode).toBe(
        'filter'
      )
      expect(mergeGraphSettings({ filters: { searchMode: 'nope' } }).filters.searchMode).toBe(
        'spotlight'
      )
    })

    it('maps orphanMode/hubMode to legacy display flags', () => {
      const mHide = mergeGraphSettings({ filters: { orphanMode: 'hide', hubMode: 'hide' } })
      expect(mHide.filters.orphanMode).toBe('hide')
      expect(mHide.display.hideOrphans).toBe(true)
      expect(mHide.filters.hubMode).toBe('hide')
      expect(mHide.display.dimHubs).toBe(false)
    })

    it('migrates legacy display flags to filter modes', () => {
      const m = mergeGraphSettings({ display: { hideOrphans: true, dimHubs: false } })
      expect(m.filters.orphanMode).toBe('hide')
      expect(m.filters.hubMode).toBe('all')
    })

    it('preserves modes when only threshold changes', () => {
      const base = mergeGraphSettings({ filters: { orphanMode: 'hide', hubMode: 'hide' } })
      const mThr = mergeGraphSettings({
        forces: base.forces,
        display: base.display,
        filters: { ...base.filters, hubDegreeThreshold: 22 }
      })
      expect(mThr.filters.orphanMode).toBe('hide')
      expect(mThr.filters.hubMode).toBe('hide')
      expect(mThr.filters.hubDegreeThreshold).toBe(22)
    })
  })

  describe('normalize* helpers', () => {
    it('normalizes orphan mode', () => {
      expect(normalizeOrphanMode('only')).toBe('only')
      expect(normalizeOrphanMode('nope')).toBe('all')
    })
    it('normalizes hub mode', () => {
      expect(normalizeHubMode('dim')).toBe('dim')
      expect(normalizeHubMode('zzz')).toBe('dim')
    })
    it('normalizes search mode', () => {
      expect(normalizeSearchMode('filter')).toBe('filter')
      expect(normalizeSearchMode('bogus')).toBe('spotlight')
    })
  })

  describe('layout save/load round-trip', () => {
    it('loads empty layout', () => {
      const empty = loadGraphLayout(tmpVault)
      expect(Object.keys(empty.nodes)).toHaveLength(0)
      expect(empty.version).toBe(1)
    })

    it('saves nodes with pins and loads them back', () => {
      const save = saveGraphLayout(tmpVault, {
        nodes: { a: { x: 10, y: 20, pinned: true }, b: { x: 1, y: 2 } }
      })
      expect(save.ok).toBe(true)
      expect(save.count).toBe(2)

      const load = loadGraphLayout(tmpVault)
      expect(load.nodes.a?.pinned).toBe(true)
      expect(load.nodes.a?.x).toBe(10)
      expect(load.nodes.b?.y).toBe(2)
    })

    it('merges partial saves without wiping other nodes', () => {
      saveGraphLayout(tmpVault, { nodes: { a: { x: 10, y: 20 } } })
      saveGraphLayout(tmpVault, { nodes: { b: { x: 99, y: 99, pinned: true } } })

      const load = loadGraphLayout(tmpVault)
      expect(load.nodes.a?.x).toBe(10)
      expect(load.nodes.b?.x).toBe(99)
      expect(load.nodes.b?.pinned).toBe(true)
    })

    it('rejects non-finite positions', () => {
      saveGraphLayout(tmpVault, { nodes: { bad: { x: NaN, y: 1 } } })
      const load = loadGraphLayout(tmpVault)
      expect(load.nodes.bad).toBeUndefined()
    })

    it('rejects save without vault', () => {
      expect(saveGraphLayout(null, { nodes: {} }).ok).toBe(false)
    })

    it('replaceAll clears nodes', () => {
      saveGraphLayout(tmpVault, { nodes: { a: { x: 1, y: 2 } } })
      const clear = saveGraphLayout(tmpVault, { nodes: {} }, { replaceAll: true })
      expect(clear.ok).toBe(true)
      expect(clear.count).toBe(0)
      expect(Object.keys(loadGraphLayout(tmpVault).nodes)).toHaveLength(0)
    })
  })

  describe('camera', () => {
    it('normalizes valid camera and clamps k', () => {
      expect(normalizeCamera({ x: 1, y: 2, k: 1.2 })?.k).toBe(1.2)
      expect(normalizeCamera({ x: 1, y: 2, k: 99 })).toBeNull()
      expect(normalizeCamera({ x: NaN, y: 1, k: 1 })).toBeNull()
      expect(normalizeCamera({ x: 0, y: 0, k: 0.01 })).toBeNull()
    })

    it('persists camera and keeps nodes with cameraOnly save', () => {
      saveGraphLayout(tmpVault, { nodes: { a: { x: 1, y: 2 } } })
      saveGraphLayout(tmpVault, { camera: { x: 10, y: 20, k: 1.5 } })
      const load = loadGraphLayout(tmpVault)
      expect(Math.abs(load.camera!.k - 1.5)).toBeLessThan(0.001)
      expect(load.camera!.x).toBe(10)
      expect(load.camera!.y).toBe(20)

      saveGraphLayout(tmpVault, { camera: { x: 3, y: 4, k: 0.8 } }, { cameraOnly: true })
      const load2 = loadGraphLayout(tmpVault)
      expect(load2.nodes.a?.x).toBe(1)
      expect(Math.abs(load2.camera!.k - 0.8)).toBeLessThan(0.001)
    })
  })

  describe('resolveGraphLod', () => {
    it('auto thresholds', () => {
      expect(resolveGraphLod(10, 'auto')).toBe('full')
      expect(resolveGraphLod(180, 'auto')).toBe('medium')
      expect(resolveGraphLod(450, 'auto')).toBe('low')
    })
    it('quality always full / speed aggressive', () => {
      expect(resolveGraphLod(500, 'quality')).toBe('full')
      expect(resolveGraphLod(50, 'speed')).toBe('low')
    })
  })

  describe('saved graph views', () => {
    it('creates view with snapshot', () => {
      const vSave = upsertGraphView(tmpVault, {
        name: 'Kerja focus',
        snapshot: {
          orphanMode: 'hide',
          hubMode: 'dim',
          colorBy: 'folder',
          perfMode: 'speed'
        }
      })
      expect(vSave.ok).toBe(true)
      expect(vSave.view?.id).toBeTruthy()
      expect(vSave.view?.snapshot.orphanMode).toBe('hide')
      expect(vSave.view?.snapshot.colorBy).toBe('folder')
      expect(vSave.view?.snapshot.perfMode).toBe('speed')
    })

    it('loads saved views', () => {
      upsertGraphView(tmpVault, { name: 'Kerja focus', snapshot: {} })
      const vLoad = loadGraphViews(tmpVault)
      expect(vLoad.views).toHaveLength(1)
      expect(vLoad.views[0]?.name).toBe('Kerja focus')
    })

    it('upserts by same name (no duplicates)', () => {
      upsertGraphView(tmpVault, { name: 'V', snapshot: { orphanMode: 'hide' } })
      const vUp = upsertGraphView(tmpVault, { name: 'V', snapshot: { orphanMode: 'only' } })
      expect(vUp.views).toHaveLength(1)
      expect(vUp.view?.snapshot.orphanMode).toBe('only')
    })

    it('deletes view', () => {
      const v = upsertGraphView(tmpVault, { name: 'V', snapshot: {} })
      const vDel = deleteGraphView(tmpVault, v.view!.id)
      expect(vDel.ok).toBe(true)
      expect(vDel.views).toHaveLength(0)
    })

    it('sanitizes invalid snapshot modes', () => {
      const v = upsertGraphView(tmpVault, {
        name: 'san',
        snapshot: { orphanMode: 'nope', hubMode: 'zzz', perfMode: 'turbo', colorBy: 'rainbow' }
      })
      expect(v.view?.snapshot.orphanMode).toBe('all')
      expect(v.view?.snapshot.hubMode).toBe('dim')
      expect(v.view?.snapshot.perfMode).toBe('auto')
      // Only 'folder' | 'type' are accepted; anything else falls back to 'default'
      expect(v.view?.snapshot.colorBy).toBe('default')
    })

    it('rejects view without vault or name', () => {
      expect(upsertGraphView(null, { name: 'x', snapshot: {} }).ok).toBe(false)
      expect(upsertGraphView(tmpVault, { name: '', snapshot: {} }).ok).toBe(false)
    })
  })
})
