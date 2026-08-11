import React, { useEffect, useState } from 'react'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { useEditorStore } from '../../store/editorStore'
import { useGraphStore } from '../../store/graphStore'
import { countGraphNotes, countGraphLinks } from '../graph/graphViewData'
import { TemplatePicker } from '../systems/TemplatePicker'
import { Icon, type IconName } from '../ui/Icons'
import { toast } from '../ui/Toast'

const SkeletonRows: React.FC<{ count?: number }> = ({ count = 4 }) => (
  <div className="dash-skeleton">
    <div className="dash-skeleton-row wide" />
    {Array.from({ length: count }).map((_, i) => (
      <div key={i} className="dash-skeleton-row" />
    ))}
  </div>
)

const SectionHead: React.FC<{ icon: IconName; title: string; count?: number }> = ({
  icon,
  title,
  count
}) => (
  <div className="dash-section-head">
    <Icon name={icon} size={13} />
    <span>{title}</span>
    {typeof count === 'number' && count > 0 && <span className="dash-section-count">{count}</span>}
  </div>
)

const EmptyState: React.FC<{ text: string }> = ({ text }) => (
  <div className="dash-empty">
    <Icon name="info" size={13} />
    <span>{text}</span>
  </div>
)

type EmbedState = 'idle' | 'loading_model' | 'indexing' | 'ready'
interface EmbedStatus {
  state: EmbedState
  totalChunks: number
  indexedFiles: number
  modelReady: boolean
}

/** Semantic RAG progress badge — live % bar while indexing, status when ready. */
function SemanticRagCard(): React.JSX.Element {
  const [status, setStatus] = useState<EmbedStatus | null>(null)
  const [progress, setProgress] = useState<{ current: number; total: number } | null>(null)
  const [enabled, setEnabled] = useState(true)

  useEffect(() => {
    let mounted = true
    // Guard against a stale snapshot overwriting a newer pushed status: the
    // progress stream is strictly newer than the mount-time getEmbeddingStatus
    // poll, so once any progress event lands we stop applying the snapshot.
    let sawProgress = false
    const load = async (): Promise<void> => {
      try {
        const s = await window.api.getEmbeddingStatus()
        if (mounted && !sawProgress) setStatus(s)
        const settings = (await window.api.getSettings()) as { semanticContext?: boolean } | null
        if (mounted) setEnabled(settings?.semanticContext !== false)
      } catch {
        /* ignore */
      }
    }
    void load()
    const unsub = window.api.onEmbeddingProgress?.((p) => {
      if (!mounted) return
      sawProgress = true
      setStatus(p.status)
      if (p.stage === 'ready' || p.total <= 0) setProgress(null)
      else setProgress({ current: p.current, total: p.total })
    })
    return () => {
      mounted = false
      unsub?.()
    }
  }, [])

  const pct =
    progress && progress.total > 0
      ? Math.min(100, Math.round((progress.current / progress.total) * 100))
      : 0
  const busy = status?.state === 'loading_model' || status?.state === 'indexing'
  // Before the first progress tick (indexing already underway at mount) the
  // poll snapshot has no current/total — show indexedFiles as a lower bound.
  const showBar = enabled && status?.state === 'indexing' && progress
  const tone = !enabled
    ? 'var(--text-muted)'
    : status?.state === 'ready'
      ? 'var(--color-success)'
      : busy
        ? 'var(--color-accent)'
        : 'var(--text-muted)'

  const title = !enabled
    ? 'Semantic RAG nonaktif — AI pakai FTS + graph saja (toggle di Settings → Search Index)'
    : status?.state === 'loading_model'
      ? 'Memuat model embedding…'
      : status?.state === 'indexing'
        ? showBar
          ? `Mengindeks ${progress!.current}/${progress!.total} chunk…`
          : `Mengindeks ${status.indexedFiles} file…`
        : status?.state === 'ready'
          ? `Siap · ${status.totalChunks} chunk · ${status.indexedFiles} file`
          : 'Belum aktif — buka vault untuk mengindeks'

  return (
    <div className="dash-rag" style={{ '--rag-tone': tone } as React.CSSProperties}>
      <div className="dash-rag-head">
        <span className="dash-rag-title">
          <Icon name="psychology" size={14} />
          Semantic RAG
          {busy && <Icon name="sync" size={12} className="is-spinning" />}
        </span>
        <span className="dash-rag-state" style={{ color: tone }}>
          {!enabled
            ? 'nonaktif'
            : status?.state === 'loading_model'
              ? 'memuat model…'
              : status?.state === 'indexing'
                ? `${pct}%`
                : status?.state === 'ready'
                  ? `${status.totalChunks} chunk · ${status.indexedFiles} file`
                  : 'idle'}
        </span>
      </div>
      {showBar ? (
        <div className="dash-rag-track">
          <div className="dash-rag-bar" style={{ width: `${pct}%` }} />
        </div>
      ) : null}
      <div className="dash-rag-meta">{title}</div>
    </div>
  )
}

/** Compact "AI usage" card — 7-day window from the structured event log (P3). */
interface AiUsageWindow {
  days: number
  operations: number
  tokensUsed: number
  errors: number
  cancelled: number
  timedOut: number
  errorRate: number
  avgDurationMs: number
  series: { day: string; operations: number; errors: number; tokensUsed: number }[]
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}jt`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

function AiUsageCard(): React.JSX.Element {
  const [w, setW] = useState<AiUsageWindow | null>(null)

  useEffect(() => {
    let mounted = true
    const load = async (): Promise<void> => {
      try {
        const res = (await window.api.getAIEventStats(7)) as { windowed?: AiUsageWindow | null }
        if (mounted) setW(res.windowed ?? null)
      } catch {
        /* ignore */
      }
    }
    void load()
    // Refresh alongside the rest of the dashboard (vault switch / new notes)
    const unsub = window.api.onGraphUpdated?.(() => {
      void load()
    })
    return () => {
      mounted = false
      unsub?.()
    }
  }, [])

  const ops = w?.operations ?? 0
  const tokens = w?.tokensUsed ?? 0
  const errPct = w && w.operations > 0 ? Math.round(w.errorRate * 100) : 0
  const tone =
    !w || w.operations === 0
      ? 'var(--text-muted)'
      : w.errors > 0
        ? 'var(--color-warning)'
        : 'var(--color-success)'
  const maxOps = Math.max(1, ...(w?.series.map((s) => s.operations) ?? [1]))
  const avgSec = w && w.avgDurationMs > 0 ? (w.avgDurationMs / 1000).toFixed(1) : '–'

  const statusText = !w
    ? 'belum ada aktivitas'
    : w.operations === 0
      ? 'tidak ada aktivitas 7 hari'
      : `${errPct}% error`

  return (
    <div className="dash-rag" style={{ '--rag-tone': tone } as React.CSSProperties}>
      <div className="dash-rag-head">
        <span className="dash-rag-title">
          <Icon name="bot" size={14} />
          AI usage
          <span className="dash-rag-sub">7 hari</span>
        </span>
        <span className="dash-rag-state" style={{ color: tone }}>
          {statusText}
        </span>
      </div>

      <div className="dash-ai-stats">
        <div className="dash-ai-stat">
          <span className="dash-ai-stat-value">{ops}</span>
          <span className="dash-ai-stat-label">stream</span>
        </div>
        <div className="dash-ai-stat">
          <span className="dash-ai-stat-value">{formatTokens(tokens)}</span>
          <span className="dash-ai-stat-label">token</span>
        </div>
        <div className="dash-ai-stat">
          <span className="dash-ai-stat-value">{avgSec}s</span>
          <span className="dash-ai-stat-label">rata-rata</span>
        </div>
      </div>

      {w && w.series.length > 0 ? (
        <div className="dash-ai-bars">
          {w.series.map((s) => (
            <div
              key={s.day}
              className="dash-ai-bar-col"
              title={`${s.day}: ${s.operations} stream${s.errors ? ` · ${s.errors} error` : ''} · ${formatTokens(s.tokensUsed)} token`}
            >
              <div
                className="dash-ai-bar"
                style={{
                  height: `${Math.max(4, Math.round((s.operations / maxOps) * 100))}%`,
                  background: s.errors > 0 ? 'var(--color-warning)' : tone
                }}
              />
            </div>
          ))}
        </div>
      ) : null}

      <div className="dash-rag-meta">
        {w && w.operations > 0
          ? `${w.operations} operasi · ${w.errors} error${w.cancelled ? ` · ${w.cancelled} batal` : ''}${w.timedOut ? ` · ${w.timedOut} timeout` : ''} — dari log .workspacegraph/logs`
          : 'Aktivitas AI tercatat otomatis ke log event — stream, token, dan error di sini.'}
      </div>
    </div>
  )
}

interface DomainOverview {
  projects: { title: string; path: string; status?: string; relativePath: string }[]
  tasks: { title: string; path: string; status?: string; priority?: string; relativePath: string }[]
  people: { title: string; path: string; relativePath: string }[]
  openCheckboxes: { text: string; noteTitle: string; notePath: string }[]
  counts: {
    projects: number
    tasks: number
    people: number
    knowledge: number
    openTasks: number
    doneTasks: number
    openCheckboxes: number
  }
  projectsByStatus: Record<string, number>
  tasksByStatus: Record<string, number>
}

export const DashboardView: React.FC<{ onOpenSearch: () => void }> = ({ onOpenSearch }) => {
  const { rootPath, totalFiles, totalNotes, setActiveView } = useWorkspaceStore()
  const openTab = useEditorStore((s) => s.openTab)
  const { nodes, edges, fetchGraph, setFocusedNode, setOpenIntent } = useGraphStore()

  const [recentNotes, setRecentNotes] = useState<
    { id: string; title: string; path: string; relativePath: string; type?: string }[]
  >([])
  const [tags, setTags] = useState<{ tag: string; count: number }[]>([])
  const [domain, setDomain] = useState<DomainOverview | null>(null)
  const [tplOpen, setTplOpen] = useState(false)
  const [loading, setLoading] = useState(true)

  const loadDashboardData = async (): Promise<void> => {
    setLoading(true)
    try {
      const recent = await window.api.getRecentNotes(6)
      setRecentNotes(recent || [])
      const tagList = await window.api.getTags()
      setTags(tagList || [])
      const ov = await window.api.getDomainOverview()
      setDomain(ov || null)
    } catch (err) {
      console.error('Failed to load dashboard data:', err)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchGraph()
    // eslint-disable-next-line react-hooks/set-state-in-effect -- bootstrap fetch
    loadDashboardData()
    const unsub = window.api.onGraphUpdated(() => {
      fetchGraph()

      loadDashboardData()
    })
    return () => unsub()
  }, [fetchGraph])

  const openNote = async (filePath: string): Promise<void> => {
    await openTab(filePath)
    setActiveView('editor')
  }

  const handleCreateDailyNote = async (): Promise<void> => {
    const today = new Date().toISOString().split('T')[0]
    try {
      const res = await window.api.createFromTemplate({
        templateId: 'builtin-daily',
        title: today
      })
      // Created or already exists today → open the note (exists returns ok:false + path)
      if (res.ok && res.path) {
        await openNote(res.path)
        return
      }
      if (res.path) {
        await openNote(res.path)
        return
      }
    } catch (err) {
      console.error('Daily note via template failed:', err)
    }
    // Fallback: manual creation (works even if template seeding failed)
    if (!rootPath) return
    try {
      const sep = rootPath.includes('\\') ? '\\' : '/'
      const filePath = `${rootPath}${sep}Daily${sep}${today}.md`
      await window.api.createFile(
        filePath,
        `---\ntitle: ${today}\ntype: daily\ndate: ${today}\n---\n\n# ${today}\n\n## Focus\n\n- [ ] \n`
      )
      await openNote(filePath)
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), { variant: 'error' })
    }
  }

  const handleOpenInGraph = (notePath: string): void => {
    // Windows paths: case/separators may differ between search index and graph nodes
    const norm = (p: string): string => p.replace(/\\/g, '/').toLowerCase()
    const target = norm(notePath)
    const node = nodes.find(
      (n) =>
        norm(n.path) === target ||
        norm(n.relativePath) === target ||
        norm(n.path).endsWith('/' + target) ||
        target.endsWith('/' + norm(n.relativePath))
    )
    if (node) {
      setFocusedNode(node.id)
      setActiveView('graph')
    } else {
      // Still open Graph View so user can search — focus is best-effort
      setActiveView('graph')
    }
  }

  const handleTagClick = (tag: string): void => {
    onOpenSearch()
    setTimeout(() => {
      window.dispatchEvent(new CustomEvent('search:prefill', { detail: `#${tag}` }))
    }, 50)
  }

  const handleOrphanClick = (): void => {
    // Open Graph with orphans-only filter (primary); search remains available via search
    setOpenIntent({ orphanMode: 'only' })
    setActiveView('graph')
  }

  const handleOrphanSearch = (): void => {
    onOpenSearch()
    setTimeout(() => {
      window.dispatchEvent(new CustomEvent('search:prefill', { detail: 'orphan:true' }))
    }, 50)
  }

  /** Real notes only — exclude ghosts/tags/attachments */
  const orphanNodes = nodes.filter(
    (n) => !n.isGhost && !n.isTag && !n.isAttachment && n.degree === 0
  )
  // F-5: shared graph counter — identical semantics to the graph view header
  const realNoteCount = countGraphNotes(nodes)

  const metrics: {
    label: string
    value: number | string
    color: string
    hint?: string
    onClick?: () => void
  }[] = [
    {
      label: 'Catatan',
      value: totalNotes || nodes.length,
      color: 'var(--color-primary)',
      onClick: onOpenSearch
    },
    {
      label: 'Proyek',
      value: domain?.counts.projects ?? 0,
      color: 'var(--color-accent)',
      onClick: undefined
    },
    {
      label: 'Tugas terbuka',
      value: domain?.counts.openTasks ?? 0,
      color: 'var(--color-warning)',
      onClick: undefined
    },
    {
      label: 'Orang',
      value: domain?.counts.people ?? 0,
      color: 'var(--node-person)',
      onClick: undefined
    },
    {
      label: 'Checklist',
      value: domain?.counts.openCheckboxes ?? 0,
      color: 'var(--color-success)',
      onClick: undefined,
      hint: '- [ ] terbuka di seluruh vault'
    },
    {
      label: 'Orphan',
      value: orphanNodes.length,
      color: orphanNodes.length > 0 ? 'var(--color-warning)' : 'var(--text-muted)',
      onClick: orphanNodes.length > 0 ? handleOrphanClick : undefined,
      hint: 'Buka Graph · hanya orphan'
    },
    {
      label: 'Graph',
      value: `${realNoteCount}/${countGraphLinks(edges)}`,
      color: 'var(--color-accent)',
      onClick: () => setActiveView('graph')
    },
    {
      label: 'File',
      value: totalFiles,
      color: 'var(--text-secondary)',
      onClick: undefined
    }
  ]

  const listItem = (
    title: string,
    sub: string,
    onClick: () => void,
    badge?: string
  ): React.JSX.Element => (
    <div key={`${title}\u0000${sub}`} className="dash-list-item" onClick={onClick}>
      <div style={{ minWidth: 0 }}>
        <div className="dash-list-title truncate">{title}</div>
        <div className="dash-list-sub truncate">{sub}</div>
      </div>
      {badge && <span className="dash-list-badge">{badge}</span>}
    </div>
  )

  const openTasks = (domain?.tasks.filter((t) => t.status !== 'done' && t.status !== 'completed') ||
    []) as DomainOverview['tasks']

  return (
    <div className="dashboard-view">
      <div className="dash-head">
        <div style={{ minWidth: 0 }}>
          <h1 className="dash-title">Workspace</h1>
          <p className="dash-path truncate" title={rootPath ?? undefined}>
            {rootPath}
          </p>
        </div>
        <div className="flex gap-2" style={{ flexShrink: 0 }}>
          <button className="btn btn-primary btn-sm" onClick={() => setTplOpen(true)}>
            + Dari template
          </button>
          <button className="btn btn-surface btn-sm" onClick={() => void handleCreateDailyNote()}>
            + Daily
          </button>
          <button className="btn btn-ghost btn-sm" onClick={onOpenSearch}>
            Cari
          </button>
        </div>
      </div>

      <div className="dash-metrics">
        {metrics.map((m) => (
          <button
            key={m.label}
            type="button"
            className={`dash-metric ${m.onClick ? 'clickable' : ''}`}
            onClick={m.onClick}
            title={m.hint}
            style={{ '--metric-color': m.color } as React.CSSProperties}
          >
            <span className="dash-metric-label">{m.label}</span>
            <span className="dash-metric-value">{m.value}</span>
          </button>
        ))}
      </div>

      <SemanticRagCard />

      <AiUsageCard />

      <div className="dash-grid">
        {/* Open tasks + checkboxes */}
        <section className="dash-section">
          <SectionHead icon="check" title="Tugas terbuka" count={domain?.counts.openTasks} />
          {loading ? (
            <SkeletonRows count={4} />
          ) : (
            <>
              {openTasks
                .slice(0, 6)
                .map((t) =>
                  listItem(t.title, t.relativePath, () => openNote(t.path), t.priority || t.status)
                )}
              {(!domain || domain.tasks.length === 0) && (
                <EmptyState text="Belum ada catatan tugas. Buat lewat template Task." />
              )}
            </>
          )}

          <div style={{ height: 'var(--space-3)' }} />
          <SectionHead
            icon="checkCircle"
            title="Checklist terbuka"
            count={domain?.openCheckboxes.length}
          />
          {(domain?.openCheckboxes || [])
            .slice(0, 8)
            .map((c) => listItem(c.text, c.noteTitle, () => openNote(c.notePath)))}
        </section>

        {/* Projects + People */}
        <section className="dash-section">
          <SectionHead icon="folder" title="Proyek" count={domain?.projects.length} />
          {loading ? (
            <SkeletonRows count={3} />
          ) : (
            <>
              {(domain?.projects || [])
                .slice(0, 8)
                .map((p) => listItem(p.title, p.relativePath, () => openNote(p.path), p.status))}
              {(!domain || domain.projects.length === 0) && (
                <EmptyState text="Belum ada proyek. Buat dari template." />
              )}
            </>
          )}

          <div style={{ height: 'var(--space-3)' }} />
          <SectionHead icon="people" title="Orang" count={domain?.people.length} />
          {loading ? (
            <SkeletonRows count={3} />
          ) : (
            <>
              {(domain?.people || [])
                .slice(0, 8)
                .map((p) => listItem(p.title, p.relativePath, () => openNote(p.path)))}
              {(!domain || domain.people.length === 0) && (
                <EmptyState text="Belum ada catatan orang. Link rekan via [[Nama]]." />
              )}
            </>
          )}
        </section>

        {/* Recent + tags + orphans */}
        <section className="dash-section">
          <SectionHead icon="history" title="Terbaru" count={recentNotes.length} />
          {loading ? (
            <SkeletonRows count={4} />
          ) : (
            recentNotes.map((note) => (
              <div key={note.id} className="dash-list-item" onClick={() => openNote(note.path)}>
                <div style={{ minWidth: 0 }}>
                  <div className="dash-list-title truncate">{note.title}</div>
                  <div className="dash-list-sub truncate">{note.relativePath}</div>
                </div>
                <button
                  className="btn btn-ghost btn-sm btn-icon"
                  onClick={(e) => {
                    e.stopPropagation()
                    handleOpenInGraph(note.path)
                  }}
                  title="Graph"
                >
                  <Icon name="graph" size={14} />
                </button>
              </div>
            ))
          )}

          <div style={{ height: 'var(--space-3)' }} />
          <SectionHead icon="tag" title="Tag" count={tags.length} />
          <div className="flex flex-wrap gap-2">
            {loading ? (
              <SkeletonRows count={2} />
            ) : (
              tags.slice(0, 14).map((t) => (
                <button
                  key={t.tag}
                  type="button"
                  className="dash-tag"
                  onClick={() => handleTagClick(t.tag)}
                >
                  #{t.tag} ({t.count})
                </button>
              ))
            )}
          </div>

          <div
            className="dash-section-head"
            style={{ justifyContent: 'space-between', paddingTop: 'var(--space-4)' }}
          >
            <span className="flex gap-2 items-center">
              <Icon name="graph" size={13} />
              Catatan orphan
            </span>
            {orphanNodes.length > 0 && (
              <span className="flex gap-2 items-center">
                <span className="dash-section-count">{orphanNodes.length}</span>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm btn-tiny"
                  onClick={handleOrphanClick}
                  title="Buka Graph · hanya orphan"
                >
                  Graph
                </button>
              </span>
            )}
          </div>
          {orphanNodes.length === 0 ? (
            <EmptyState text="Tidak ada orphan — semua catatan terhubung." />
          ) : (
            orphanNodes
              .slice(0, 8)
              .map((n) =>
                listItem(n.title, n.relativePath || n.type, () => openNote(n.path), '0 link')
              )
          )}
          {orphanNodes.length > 8 && (
            <button
              type="button"
              className="btn btn-ghost btn-sm btn-tiny"
              style={{ marginTop: 4 }}
              onClick={handleOrphanClick}
            >
              +{orphanNodes.length - 8} lagi di Graph
            </button>
          )}
          {orphanNodes.length > 0 && (
            <button
              type="button"
              className="btn btn-ghost btn-sm btn-tiny"
              style={{ marginTop: 2, color: 'var(--text-muted)' }}
              onClick={handleOrphanSearch}
            >
              Cari orphan:true
            </button>
          )}
        </section>
      </div>

      <TemplatePicker open={tplOpen} onClose={() => setTplOpen(false)} />
    </div>
  )
}
