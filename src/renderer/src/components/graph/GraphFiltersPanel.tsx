/**
 * Global graph settings panel — Obsidian-style collapsible sections:
 * Filters · Groups · Display · Forces (+ Explore / Layout / Views / Performance).
 */
import React, { useState } from 'react'
import type {
  GraphColorGroup,
  GraphDisplayOpts,
  GraphForceSettings,
  GraphSettings,
  GraphSavedView,
  GraphPerfMode,
  GraphSearchMode
} from '../../store/graphStore'
import { Icon } from '../ui/Icons'

export type OrphanMode = 'all' | 'hide' | 'only'
export type HubMode = 'all' | 'dim' | 'hide'
export type ColorByMode = 'type' | 'folder'
export type { GraphPerfMode }

export interface GraphFiltersPanelProps {
  searchQuery: string
  onSearchChange: (q: string) => void
  selectedType: string
  onTypeChange: (t: string) => void
  selectedTag: string
  onTagChange: (t: string) => void
  allTags: string[]
  typeOptions: string[]
  orphanMode: OrphanMode
  onOrphanMode: (m: OrphanMode) => void
  hubMode: HubMode
  onHubMode: (m: HubMode) => void
  hubThreshold: number
  onHubThreshold: (n: number) => void
  showTagEdges: boolean
  onShowTagEdges: (v: boolean) => void
  showLabels: boolean
  onShowLabels: (v: boolean) => void
  showLegend: boolean
  onShowLegend: (v: boolean) => void
  /** Obsidian "Existing files only" */
  existingFilesOnly: boolean
  onExistingFilesOnly: (v: boolean) => void
  showTags: boolean
  onShowTags: (v: boolean) => void
  showAttachments: boolean
  onShowAttachments: (v: boolean) => void
  animateForces: boolean
  onAnimateForces: (v: boolean) => void
  onForcePreset?: (key: string) => void
  /** spotlight | filter (Obsidian search subtraction) */
  searchMode: GraphSearchMode
  onSearchMode: (m: GraphSearchMode) => void
  orphanCount: number
  hubCount: number
  totalNodes: number
  visibleNodes: number
  ghostCount?: number
  tagCount?: number
  attachmentCount?: number
  /** Phase 3 */
  forces: GraphForceSettings
  onForcesChange: (next: GraphForceSettings) => void
  onForcesCommit: (next: GraphForceSettings) => void
  onForcesReset: () => void
  pinnedCount: number
  layoutNodeCount: number
  layoutStatus: string | null
  onSaveLayout: () => void
  onClearLayout: () => void
  onReheat: () => void
  /** Phase 4 */
  colorBy: ColorByMode
  onColorBy: (m: ColorByMode) => void
  nodeOptions: { id: string; title: string }[]
  pathFromId: string
  pathToId: string
  onPathFromId: (id: string) => void
  onPathToId: (id: string) => void
  pathStatus: string | null
  hasPath: boolean
  onFindPath: () => void
  onClearPath: () => void
  focusDepth: number
  onFocusDepth: (d: number) => void
  hasFocus: boolean
  onFocusNeighbors: () => void
  onClearFocus: () => void
  /** Phase 5 */
  perfMode: GraphPerfMode
  onPerfMode: (m: GraphPerfMode) => void
  lodLabel: string
  savedViews: GraphSavedView[]
  onSaveView: (name: string) => void
  onLoadView: (id: string) => void
  onDeleteView: (id: string) => void
  onExportPng: () => void
  viewsStatus: string | null
  /** Obsidian-like display knobs + color groups */
  displayOpts: GraphDisplayOpts
  onDisplayOptsChange: (next: GraphDisplayOpts) => void
  onDisplayOptsCommit: (next: GraphDisplayOpts) => void
  colorGroups: GraphColorGroup[]
  onColorGroupsChange: (next: GraphColorGroup[]) => void
  onPersist?: (partial: Partial<GraphSettings>) => void
}

function displayPatch(
  showLabels: boolean,
  showTagEdges: boolean,
  showLegend: boolean,
  orphanMode: OrphanMode,
  hubMode: HubMode,
  extra?: Partial<GraphSettings['display']>
): GraphSettings['display'] {
  return {
    showLabels,
    showTagEdges,
    showLegend,
    dimHubs: hubMode === 'dim',
    hideOrphans: orphanMode === 'hide',
    arrows: extra?.arrows ?? false,
    textFade: extra?.textFade ?? 1,
    nodeSize: extra?.nodeSize ?? 1,
    lineThickness: extra?.lineThickness ?? 1,
    existingFilesOnly: extra?.existingFilesOnly ?? true,
    showTags: extra?.showTags ?? false,
    showAttachments: extra?.showAttachments ?? false,
    animateForces: extra?.animateForces ?? false
  }
}

function modesPatch(
  orphanMode: OrphanMode,
  hubMode: HubMode,
  searchMode: GraphSearchMode = 'spotlight'
): Partial<GraphSettings['filters']> {
  return { orphanMode, hubMode, searchMode }
}

const FORCE_SLIDERS: {
  key: keyof GraphForceSettings
  label: string
  min: number
  max: number
  step: number
  /** Display transform (e.g. show positive repel strength) */
  format: (v: number) => string
}[] = [
  { key: 'center', label: 'Center', min: 0, max: 0.25, step: 0.01, format: (v) => v.toFixed(2) },
  {
    key: 'charge',
    label: 'Repel',
    min: -400,
    max: -10,
    step: 5,
    format: (v) => String(Math.abs(v))
  },
  {
    key: 'linkDist',
    label: 'Link dist',
    min: 20,
    max: 200,
    step: 2,
    format: (v) => String(Math.round(v))
  },
  { key: 'linkStr', label: 'Link str', min: 0.05, max: 1, step: 0.05, format: (v) => v.toFixed(2) },
  { key: 'collide', label: 'Collide', min: 0, max: 1, step: 0.05, format: (v) => v.toFixed(2) }
]

const DISPLAY_SLIDERS: {
  key: Exclude<keyof GraphDisplayOpts, 'arrows'>
  label: string
  min: number
  max: number
  step: number
  format: (v: number) => string
}[] = [
  {
    key: 'textFade',
    label: 'Text fade threshold',
    min: 0.4,
    max: 2.5,
    step: 0.05,
    format: (v) => v.toFixed(2)
  },
  {
    key: 'nodeSize',
    label: 'Node size',
    min: 0.25,
    max: 2,
    step: 0.05,
    format: (v) => v.toFixed(2)
  },
  {
    key: 'lineThickness',
    label: 'Line thickness',
    min: 0.25,
    max: 3,
    step: 0.05,
    format: (v) => v.toFixed(2)
  }
]

/** Suggested swatches for new color groups (Obsidian-like palette) */
const GROUP_COLOR_SWATCHES = [
  '#e05d5d',
  '#e0a35d',
  '#d9cf5d',
  '#7dd35d',
  '#5dd3a7',
  '#5da9e0',
  '#8f7de0',
  '#d65db8'
]

/** Obsidian-style collapsible panel section */
const Section: React.FC<{
  title: string
  defaultOpen?: boolean
  badge?: string
  children: React.ReactNode
}> = ({ title, defaultOpen = false, badge, children }) => {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className={`graph-section ${open ? 'is-open' : ''}`}>
      <button
        type="button"
        className="graph-section-header"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <Icon name="chevronRight" size={12} className="graph-section-chevron" />
        <span className="graph-section-title">{title}</span>
        {badge ? <span className="graph-section-badge">{badge}</span> : null}
      </button>
      {open && <div className="graph-section-body">{children}</div>}
    </div>
  )
}

export const GraphFiltersPanel: React.FC<GraphFiltersPanelProps> = ({
  searchQuery,
  onSearchChange,
  selectedType,
  onTypeChange,
  selectedTag,
  onTagChange,
  allTags,
  typeOptions,
  orphanMode,
  onOrphanMode,
  hubMode,
  onHubMode,
  hubThreshold,
  onHubThreshold,
  showTagEdges,
  onShowTagEdges,
  showLabels,
  onShowLabels,
  showLegend,
  onShowLegend,
  existingFilesOnly,
  onExistingFilesOnly,
  showTags,
  onShowTags,
  showAttachments,
  onShowAttachments,
  animateForces,
  onAnimateForces,
  onForcePreset,
  searchMode,
  onSearchMode,
  orphanCount,
  hubCount,
  totalNodes,
  visibleNodes,
  ghostCount = 0,
  tagCount = 0,
  attachmentCount = 0,
  forces,
  onForcesChange,
  onForcesCommit,
  onForcesReset,
  pinnedCount,
  layoutNodeCount,
  layoutStatus,
  onSaveLayout,
  onClearLayout,
  onReheat,
  colorBy,
  onColorBy,
  nodeOptions,
  pathFromId,
  pathToId,
  onPathFromId,
  onPathToId,
  pathStatus,
  hasPath,
  onFindPath,
  onClearPath,
  focusDepth,
  onFocusDepth,
  hasFocus,
  onFocusNeighbors,
  onClearFocus,
  perfMode,
  onPerfMode,
  lodLabel,
  savedViews,
  onSaveView,
  onLoadView,
  onDeleteView,
  onExportPng,
  viewsStatus,
  displayOpts,
  onDisplayOptsChange,
  onDisplayOptsCommit,
  colorGroups,
  onColorGroupsChange,
  onPersist
}) => {
  const [viewName, setViewName] = useState('')
  const [groupQuery, setGroupQuery] = useState('')
  const [groupColor, setGroupColor] = useState(GROUP_COLOR_SWATCHES[5])

  const persistModes = (
    nextOrphan: OrphanMode,
    nextHub: HubMode,
    nextSearch: GraphSearchMode = searchMode
  ): void => {
    onPersist?.({
      display: displayPatch(showLabels, showTagEdges, showLegend, nextOrphan, nextHub, {
        ...displayOpts,
        existingFilesOnly
      }),
      filters: modesPatch(nextOrphan, nextHub, nextSearch) as GraphSettings['filters']
    })
  }

  const persistDisplayToggles = (
    labels: boolean,
    tagEdges: boolean,
    legend: boolean,
    existingOnly: boolean = existingFilesOnly
  ): void => {
    onPersist?.({
      display: displayPatch(labels, tagEdges, legend, orphanMode, hubMode, {
        ...displayOpts,
        existingFilesOnly: existingOnly
      }),
      filters: modesPatch(orphanMode, hubMode, searchMode) as GraphSettings['filters']
    })
  }

  const addGroup = (): void => {
    const query = groupQuery.trim()
    if (!query) return
    onColorGroupsChange([
      ...colorGroups,
      {
        id: `grp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
        query,
        color: groupColor
      }
    ])
    setGroupQuery('')
  }

  return (
    <div
      className="graph-settings-panel graph-filters-panel"
      role="region"
      aria-label="Graph filters"
    >
      {/* ─── Filters (Obsidian: search + toggles) ─── */}
      <Section title="Filters" defaultOpen>
        <div className="graph-settings-row">
          <label htmlFor="graph-spotlight">Search</label>
          <input
            id="graph-spotlight"
            type="search"
            className="input graph-filter-search"
            placeholder={
              searchMode === 'filter'
                ? 'Filter: hanya match ditampilkan…'
                : 'Spotlight: match disorot…'
            }
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        <div className="graph-settings-row">
          <label>Mode search</label>
          <div className="graph-filter-seg" role="group" aria-label="Search mode">
            {(
              [
                ['spotlight', 'Spotlight'],
                ['filter', 'Filter']
              ] as const
            ).map(([id, lab]) => (
              <button
                key={id}
                type="button"
                className={`local-graph-chip ${searchMode === id ? 'active' : ''}`}
                aria-pressed={searchMode === id}
                title={
                  id === 'filter'
                    ? 'Sembunyikan non-match (seperti filter Obsidian)'
                    : 'Redupkan non-match, tetap tampil'
                }
                onClick={() => {
                  onSearchMode(id)
                  persistModes(orphanMode, hubMode, id)
                }}
              >
                {lab}
              </button>
            ))}
          </div>
        </div>

        <label className="graph-check">
          <input
            type="checkbox"
            checked={existingFilesOnly}
            onChange={(e) => {
              onExistingFilesOnly(e.target.checked)
              persistDisplayToggles(showLabels, showTagEdges, showLegend, e.target.checked)
            }}
          />
          Existing files only
          {ghostCount > 0 ? (
            <span className="graph-filter-hint"> · {ghostCount} ghost</span>
          ) : null}
        </label>
        <label className="graph-check">
          <input
            type="checkbox"
            checked={showTags}
            onChange={(e) => {
              onShowTags(e.target.checked)
              onPersist?.({
                display: {
                  ...displayPatch(showLabels, showTagEdges, showLegend, orphanMode, hubMode, {
                    ...displayOpts,
                    existingFilesOnly,
                    showTags: e.target.checked,
                    showAttachments,
                    animateForces
                  })
                }
              })
            }}
          />
          Tags
          {tagCount > 0 ? <span className="graph-filter-hint"> · {tagCount}</span> : null}
        </label>
        <label className="graph-check">
          <input
            type="checkbox"
            checked={showAttachments}
            onChange={(e) => {
              onShowAttachments(e.target.checked)
              onPersist?.({
                display: {
                  ...displayPatch(showLabels, showTagEdges, showLegend, orphanMode, hubMode, {
                    ...displayOpts,
                    existingFilesOnly,
                    showTags,
                    showAttachments: e.target.checked,
                    animateForces
                  })
                }
              })
            }}
          />
          Attachments
          {attachmentCount > 0 ? (
            <span className="graph-filter-hint"> · {attachmentCount}</span>
          ) : null}
        </label>
        <p className="graph-filter-hint">
          Tags = diamond #tag · Attachments = file non-md · Ghost = hollow.
        </p>

        <div className="graph-settings-row">
          <label>Orphans ({orphanCount})</label>
          <div className="graph-filter-seg" role="group" aria-label="Orphan mode">
            {(
              [
                ['all', 'Semua'],
                ['hide', 'Sembunyi'],
                ['only', 'Hanya']
              ] as const
            ).map(([id, lab]) => (
              <button
                key={id}
                type="button"
                className={`local-graph-chip ${orphanMode === id ? 'active' : ''}`}
                aria-pressed={orphanMode === id}
                onClick={() => {
                  onOrphanMode(id)
                  persistModes(id, hubMode)
                }}
              >
                {lab}
              </button>
            ))}
          </div>
        </div>

        <div className="graph-settings-row">
          <label>
            Hubs ≥ {hubThreshold} ({hubCount})
          </label>
          <div className="graph-filter-seg" role="group" aria-label="Hub mode">
            {(
              [
                ['all', 'Normal'],
                ['dim', 'Redup'],
                ['hide', 'Sembunyi']
              ] as const
            ).map(([id, lab]) => (
              <button
                key={id}
                type="button"
                className={`local-graph-chip ${hubMode === id ? 'active' : ''}`}
                aria-pressed={hubMode === id}
                onClick={() => {
                  onHubMode(id)
                  persistModes(orphanMode, id)
                }}
              >
                {lab}
              </button>
            ))}
          </div>
          <label className="graph-filter-range">
            <span>Ambang hub</span>
            <input
              type="range"
              min={3}
              max={40}
              value={hubThreshold}
              onChange={(e) => onHubThreshold(Number(e.target.value))}
              onMouseUp={(e) => {
                const n = Number((e.target as HTMLInputElement).value)
                onPersist?.({
                  filters: {
                    hubDegreeThreshold: n,
                    orphanMode,
                    hubMode
                  } as GraphSettings['filters']
                })
              }}
              onTouchEnd={(e) => {
                const n = Number((e.target as HTMLInputElement).value)
                onPersist?.({
                  filters: {
                    hubDegreeThreshold: n,
                    orphanMode,
                    hubMode
                  } as GraphSettings['filters']
                })
              }}
            />
            <span className="graph-filter-range-val">{hubThreshold}</span>
          </label>
        </div>

        <div className="graph-settings-row">
          <label htmlFor="graph-filter-type">Tipe</label>
          <select
            id="graph-filter-type"
            className="chat-select graph-filter-select"
            value={selectedType}
            onChange={(e) => onTypeChange(e.target.value)}
          >
            <option value="all">Semua tipe</option>
            {typeOptions.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </div>

        {allTags.length > 0 && (
          <div className="graph-settings-row">
            <label htmlFor="graph-filter-tag">Tag</label>
            <select
              id="graph-filter-tag"
              className="chat-select graph-filter-select"
              value={selectedTag}
              onChange={(e) => onTagChange(e.target.value)}
            >
              <option value="all">Semua tag</option>
              {allTags.map((t) => (
                <option key={t} value={t}>
                  #{t}
                </option>
              ))}
            </select>
          </div>
        )}
      </Section>

      {/* ─── Groups (Obsidian: color groups by query) ─── */}
      <Section
        title="Groups"
        defaultOpen
        badge={colorGroups.length > 0 ? String(colorGroups.length) : undefined}
      >
        {colorGroups.length > 0 && (
          <ul className="graph-groups-list">
            {colorGroups.map((g) => (
              <li key={g.id} className="graph-group-row">
                <span className="graph-group-dot" style={{ background: g.color }} />
                <span className="graph-group-query" title={g.query}>
                  {g.query}
                </span>
                <button
                  type="button"
                  className="graph-group-del"
                  onClick={() => onColorGroupsChange(colorGroups.filter((x) => x.id !== g.id))}
                  title="Hapus grup"
                  aria-label={`Hapus grup ${g.query}`}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="graph-group-add">
          <input
            type="color"
            className="graph-group-color"
            value={groupColor}
            onChange={(e) => setGroupColor(e.target.value)}
            title="Warna grup"
            aria-label="Warna grup"
          />
          <input
            type="text"
            className="input graph-filter-search"
            placeholder="tag:kerja path:projects …"
            value={groupQuery}
            onChange={(e) => setGroupQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                addGroup()
              }
            }}
            autoComplete="off"
            spellCheck={false}
          />
          <button
            type="button"
            className="local-graph-chip"
            disabled={!groupQuery.trim()}
            onClick={addGroup}
          >
            + Group
          </button>
        </div>
        <div className="graph-group-swatches">
          {GROUP_COLOR_SWATCHES.map((c) => (
            <button
              key={c}
              type="button"
              className={`graph-group-swatch ${groupColor === c ? 'active' : ''}`}
              style={{ background: c }}
              onClick={() => setGroupColor(c)}
              title={c}
              aria-label={`Warna ${c}`}
            />
          ))}
        </div>
        <p className="graph-filter-hint">
          Query: tag:, path:, file:, type: · spasi = AND · -negasi · grup pertama yang match menang.
        </p>
      </Section>

      {/* ─── Display (Obsidian: arrows, text fade, node size, line thickness) ─── */}
      <Section title="Display" defaultOpen>
        {DISPLAY_SLIDERS.map((s) => (
          <label key={s.key} className="graph-filter-range">
            <span>
              {s.label}
              <span className="graph-filter-range-val"> {s.format(displayOpts[s.key])}</span>
            </span>
            <input
              type="range"
              min={s.min}
              max={s.max}
              step={s.step}
              value={displayOpts[s.key]}
              onChange={(e) => {
                const n = Number(e.target.value)
                onDisplayOptsChange({ ...displayOpts, [s.key]: n })
              }}
              onMouseUp={(e) => {
                const n = Number((e.target as HTMLInputElement).value)
                onDisplayOptsCommit({ ...displayOpts, [s.key]: n })
              }}
              onTouchEnd={(e) => {
                const n = Number((e.target as HTMLInputElement).value)
                onDisplayOptsCommit({ ...displayOpts, [s.key]: n })
              }}
            />
          </label>
        ))}

        <label className="graph-check">
          <input
            type="checkbox"
            checked={displayOpts.arrows}
            onChange={(e) => onDisplayOptsCommit({ ...displayOpts, arrows: e.target.checked })}
          />
          Panah arah wikilink
        </label>
        <label className="graph-check">
          <input
            type="checkbox"
            checked={showLabels}
            onChange={(e) => {
              onShowLabels(e.target.checked)
              persistDisplayToggles(e.target.checked, showTagEdges, showLegend)
            }}
          />
          Label
        </label>
        <label className="graph-check">
          <input
            type="checkbox"
            checked={showTagEdges}
            onChange={(e) => {
              onShowTagEdges(e.target.checked)
              persistDisplayToggles(showLabels, e.target.checked, showLegend)
            }}
          />
          Edge tag (default off)
        </label>
        <label className="graph-check">
          <input
            type="checkbox"
            checked={showLegend}
            onChange={(e) => {
              onShowLegend(e.target.checked)
              persistDisplayToggles(showLabels, showTagEdges, e.target.checked)
            }}
          />
          Legend
        </label>

        <div className="graph-settings-row">
          <label>Warna node</label>
          <div className="graph-filter-seg" role="group" aria-label="Color by">
            {(
              [
                ['type', 'Tipe'],
                ['folder', 'Folder']
              ] as const
            ).map(([id, lab]) => (
              <button
                key={id}
                type="button"
                className={`local-graph-chip ${colorBy === id ? 'active' : ''}`}
                aria-pressed={colorBy === id}
                onClick={() => onColorBy(id)}
              >
                {lab}
              </button>
            ))}
          </div>
          <p className="graph-filter-hint">Color groups menimpa warna tipe/folder.</p>
        </div>
      </Section>

      {/* ─── Forces ─── */}
      <Section title="Forces" defaultOpen>
        <div className="graph-settings-row">
          <label>Preset</label>
          <div className="graph-filter-seg" role="group" aria-label="Force presets">
            {(
              [
                ['default', 'Default'],
                ['compact', 'Compact'],
                ['relaxed', 'Relaxed'],
                ['clustered', 'Cluster']
              ] as const
            ).map(([id, lab]) => (
              <button
                key={id}
                type="button"
                className="local-graph-chip"
                onClick={() => onForcePreset?.(id)}
              >
                {lab}
              </button>
            ))}
          </div>
        </div>
        <label className="graph-check">
          <input
            type="checkbox"
            checked={animateForces}
            onChange={(e) => {
              onAnimateForces(e.target.checked)
              onPersist?.({
                display: {
                  ...displayPatch(showLabels, showTagEdges, showLegend, orphanMode, hubMode, {
                    ...displayOpts,
                    existingFilesOnly,
                    showTags,
                    showAttachments,
                    animateForces: e.target.checked
                  })
                }
              })
            }}
          />
          Animate (graph tetap hidup pelan)
        </label>
        {FORCE_SLIDERS.map((s) => (
          <label key={s.key} className="graph-filter-range">
            <span>
              {s.label}
              <span className="graph-filter-range-val"> {s.format(forces[s.key])}</span>
            </span>
            <input
              type="range"
              min={s.min}
              max={s.max}
              step={s.step}
              value={forces[s.key]}
              onChange={(e) => {
                const n = Number(e.target.value)
                onForcesChange({ ...forces, [s.key]: n })
              }}
              onMouseUp={(e) => {
                const n = Number((e.target as HTMLInputElement).value)
                onForcesCommit({ ...forces, [s.key]: n })
              }}
              onTouchEnd={(e) => {
                const n = Number((e.target as HTMLInputElement).value)
                onForcesCommit({ ...forces, [s.key]: n })
              }}
            />
          </label>
        ))}
        <div className="graph-filter-actions">
          <button
            type="button"
            className="local-graph-chip"
            onClick={onForcesReset}
            title="Reset force defaults"
          >
            Reset forces
          </button>
        </div>
        <p className="graph-filter-hint">
          Geser slider → layout hidup; lepas → simpan ke settings.
        </p>
      </Section>

      {/* ─── Explore (path + focus) ─── */}
      <Section title="Explore">
        <p className="graph-filter-hint">
          Path: Shift+klik dua node · Focus: Alt+klik node · atau pilih di bawah.
        </p>
        <div className="graph-settings-row">
          <label htmlFor="graph-path-from">Path dari</label>
          <select
            id="graph-path-from"
            className="chat-select graph-filter-select"
            value={pathFromId}
            onChange={(e) => onPathFromId(e.target.value)}
          >
            <option value="">— pilih note —</option>
            {nodeOptions.map((n) => (
              <option key={n.id} value={n.id}>
                {n.title}
              </option>
            ))}
          </select>
        </div>
        <div className="graph-settings-row">
          <label htmlFor="graph-path-to">Path ke</label>
          <select
            id="graph-path-to"
            className="chat-select graph-filter-select"
            value={pathToId}
            onChange={(e) => onPathToId(e.target.value)}
          >
            <option value="">— pilih note —</option>
            {nodeOptions.map((n) => (
              <option key={n.id} value={n.id}>
                {n.title}
              </option>
            ))}
          </select>
        </div>
        <div className="graph-filter-actions">
          <button
            type="button"
            className="local-graph-chip"
            onClick={onFindPath}
            disabled={!pathFromId || !pathToId}
          >
            Find path
          </button>
          <button
            type="button"
            className="local-graph-chip"
            onClick={onClearPath}
            disabled={!hasPath && !pathFromId}
          >
            Clear path
          </button>
        </div>
        {pathStatus && <p className="graph-filter-status">{pathStatus}</p>}

        <div className="graph-settings-row" style={{ marginTop: 8 }}>
          <label>Focus tetangga</label>
          <div className="graph-filter-seg" role="group" aria-label="Focus depth">
            {([1, 2, 3, 4, 5] as const).map((d) => (
              <button
                key={d}
                type="button"
                className={`local-graph-chip ${focusDepth === d ? 'active' : ''}`}
                aria-pressed={focusDepth === d}
                onClick={() => onFocusDepth(d)}
                title={`Neighborhood depth ${d}`}
              >
                D{d}
              </button>
            ))}
          </div>
        </div>
        <div className="graph-filter-actions">
          <button type="button" className="local-graph-chip" onClick={onFocusNeighbors}>
            Focus path-from / hover
          </button>
          <button
            type="button"
            className="local-graph-chip"
            onClick={onClearFocus}
            disabled={!hasFocus}
          >
            Clear focus
          </button>
        </div>
      </Section>

      {/* ─── Layout (pin + persist) ─── */}
      <Section title="Layout">
        <p className="graph-filter-hint">
          Pin: drag node · unpin: double-click · {pinnedCount} pinned · vault file{' '}
          {layoutNodeCount > 0 ? `${layoutNodeCount} pos` : 'kosong'}
        </p>
        <div className="graph-filter-actions">
          <button
            type="button"
            className="local-graph-chip"
            onClick={onSaveLayout}
            title="Simpan posisi ke vault"
          >
            Save layout
          </button>
          <button
            type="button"
            className="local-graph-chip"
            onClick={onReheat}
            title="Lepas pin & re-layout"
          >
            Re-layout
          </button>
          <button
            type="button"
            className="local-graph-chip"
            onClick={onClearLayout}
            title="Hapus file layout di vault"
          >
            Clear file
          </button>
        </div>
        {layoutStatus && <p className="graph-filter-status">{layoutStatus}</p>}
      </Section>

      {/* ─── Views & Export ─── */}
      <Section title="Views & Export">
        <div className="graph-settings-row">
          <label htmlFor="graph-view-name">Simpan view saat ini</label>
          <div className="graph-filter-save-row">
            <input
              id="graph-view-name"
              type="text"
              className="input graph-filter-search"
              placeholder="Nama view…"
              value={viewName}
              onChange={(e) => setViewName(e.target.value)}
              maxLength={80}
            />
            <button
              type="button"
              className="local-graph-chip"
              disabled={!viewName.trim()}
              onClick={() => {
                const n = viewName.trim()
                if (!n) return
                onSaveView(n)
                setViewName('')
              }}
            >
              Save
            </button>
          </div>
        </div>
        {savedViews.length > 0 ? (
          <ul className="graph-views-list">
            {savedViews.map((v) => (
              <li key={v.id} className="graph-views-item">
                <button
                  type="button"
                  className="graph-views-load"
                  onClick={() => onLoadView(v.id)}
                  title="Load view"
                >
                  {v.name}
                </button>
                <button
                  type="button"
                  className="graph-views-del"
                  onClick={() => onDeleteView(v.id)}
                  title="Hapus view"
                  aria-label={`Hapus ${v.name}`}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="graph-filter-hint">Belum ada saved view di vault.</p>
        )}
        <div className="graph-filter-actions">
          <button
            type="button"
            className="local-graph-chip"
            onClick={onExportPng}
            title="Export PNG"
          >
            Export PNG
          </button>
        </div>
        {viewsStatus && <p className="graph-filter-status">{viewsStatus}</p>}
      </Section>

      {/* ─── Performance ─── */}
      <Section title="Performance">
        <div className="graph-filter-seg" role="group" aria-label="Performance mode">
          {(
            [
              ['auto', 'Auto'],
              ['quality', 'Quality'],
              ['speed', 'Speed']
            ] as const
          ).map(([id, lab]) => (
            <button
              key={id}
              type="button"
              className={`local-graph-chip ${perfMode === id ? 'active' : ''}`}
              aria-pressed={perfMode === id}
              onClick={() => onPerfMode(id)}
            >
              {lab}
            </button>
          ))}
        </div>
        <p className="graph-filter-hint">LOD: {lodLabel} · frustum cull + label thinning</p>
      </Section>

      <p className="graph-filter-hint graph-filter-footer">
        Menampilkan <strong>{visibleNodes}</strong> / {totalNodes} notes · wikilink default
      </p>
      <p className="graph-filter-hint">
        Keys: Esc clear · F fit · R layout · S save · E PNG · P panel · / search · Ctrl+klik select
        · Ctrl+A · Ctrl+C copy [[links]] · O open
      </p>
    </div>
  )
}

export { DEFAULT_FORCE_SETTINGS } from './graphShared'
