import React, { useEffect, useState } from 'react'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { useEditorStore } from '../../store/editorStore'
import { useGraphStore } from '../../store/graphStore'
import { TemplatePicker } from '../systems/TemplatePicker'
import { Icon } from '../ui/Icons'

const SkeletonRows: React.FC<{ count?: number }> = ({ count = 4 }) => (
  <div className="dash-skeleton">
    <div className="dash-skeleton-row wide" />
    {Array.from({ length: count }).map((_, i) => (
      <div key={i} className="dash-skeleton-row" />
    ))}
  </div>
)

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

  useEffect(() => {
    fetchGraph()
    loadDashboardData()
    const unsub = window.api.onGraphUpdated(() => {
      fetchGraph()
      loadDashboardData()
    })
    return () => unsub()
  }, [fetchGraph])

  const loadDashboardData = async () => {
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

  const openNote = async (filePath: string) => {
    await openTab(filePath)
    setActiveView('editor')
  }

  const handleCreateDailyNote = async () => {
    const res = await window.api.createFromTemplate({
      templateId: 'builtin-daily',
      title: new Date().toISOString().split('T')[0]
    })
    if (res.ok && res.path) {
      await openNote(res.path)
    } else if (rootPath) {
      // fallback
      const today = new Date().toISOString().split('T')[0]
      const sep = rootPath.includes('\\') ? '\\' : '/'
      const filePath = `${rootPath}${sep}Daily${sep}${today}.md`
      await window.api.createFile(
        filePath,
        `---\ntitle: ${today}\ntype: daily\ndate: ${today}\n---\n\n# ${today}\n\n## Focus\n\n- [ ] \n`
      )
      await openNote(filePath)
    }
  }

  const handleOpenInGraph = (notePath: string) => {
    // Windows paths: case/separators may differ between search index and graph nodes
    const norm = (p: string) => p.replace(/\\/g, '/').toLowerCase()
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

  const handleTagClick = (tag: string) => {
    onOpenSearch()
    setTimeout(() => {
      window.dispatchEvent(new CustomEvent('search:prefill', { detail: `#${tag}` }))
    }, 50)
  }

  const handleOrphanClick = () => {
    // Open Graph with orphans-only filter (primary); search remains available via search
    setOpenIntent({ orphanMode: 'only' })
    setActiveView('graph')
  }

  const handleOrphanSearch = () => {
    onOpenSearch()
    setTimeout(() => {
      window.dispatchEvent(new CustomEvent('search:prefill', { detail: 'orphan:true' }))
    }, 50)
  }

  /** Real notes only — exclude ghosts/tags/attachments */
  const orphanNodes = nodes.filter(
    (n) => !n.isGhost && !n.isTag && !n.isAttachment && n.degree === 0
  )
  const realNoteCount = nodes.filter((n) => !n.isGhost && !n.isTag && !n.isAttachment).length

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
      hint: 'Buka Graph · orphans only'
    },
    {
      label: 'Graph',
      value: `${realNoteCount}/${edges.filter((e) => e.type !== 'tag').length}`,
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

  const listItem = (title: string, sub: string, onClick: () => void, badge?: string) => (
    <div key={`${title}\u0000${sub}`} className="dash-list-item" onClick={onClick}>
      <div style={{ minWidth: 0 }}>
        <div className="dash-list-title truncate">{title}</div>
        <div className="dash-list-sub truncate">{sub}</div>
      </div>
      {badge && <span className="dash-list-badge">{badge}</span>}
    </div>
  )

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
          <button className="btn btn-surface btn-sm" onClick={handleCreateDailyNote}>
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
          >
            <span className="dash-metric-label">{m.label}</span>
            <span className="dash-metric-value" style={{ color: m.color }}>
              {m.value}
            </span>
          </button>
        ))}
      </div>

      <div className="dash-grid">
        {/* Open tasks + checkboxes */}
        <section className="dash-section">
          <div className="section-title" style={{ padding: '0 0 var(--space-2) 0' }}>
            Tugas terbuka
          </div>
          {loading ? (
            <SkeletonRows count={4} />
          ) : (
            <>
              {(domain?.tasks.filter(
                (t) => t.status !== 'done' && t.status !== 'completed'
              ) || [])
                .slice(0, 6)
                .map((t) =>
                  listItem(t.title, t.relativePath, () => openNote(t.path), t.priority || t.status)
                )}
              {(!domain || domain.tasks.length === 0) && (
                <div className="dash-empty">Belum ada catatan tugas. Buat lewat template Task.</div>
              )}
            </>
          )}

          <div className="section-title" style={{ padding: 'var(--space-4) 0 var(--space-2) 0' }}>
            Checklist terbuka
          </div>
          {(domain?.openCheckboxes || [])
            .slice(0, 8)
            .map((c) => listItem(c.text, c.noteTitle, () => openNote(c.notePath)))}
        </section>

        {/* Projects + People */}
        <section className="dash-section">
          <div className="section-title" style={{ padding: '0 0 var(--space-2) 0' }}>
            Proyek
          </div>
          {loading ? (
            <SkeletonRows count={3} />
          ) : (
            <>
              {(domain?.projects || [])
                .slice(0, 8)
                .map((p) => listItem(p.title, p.relativePath, () => openNote(p.path), p.status))}
              {(!domain || domain.projects.length === 0) && (
                <div className="dash-empty">Belum ada proyek. Buat dari template.</div>
              )}
            </>
          )}

          <div className="section-title" style={{ padding: 'var(--space-4) 0 var(--space-2) 0' }}>
            Orang
          </div>
          {loading ? (
            <SkeletonRows count={3} />
          ) : (
            <>
              {(domain?.people || [])
                .slice(0, 8)
                .map((p) => listItem(p.title, p.relativePath, () => openNote(p.path)))}
              {(!domain || domain.people.length === 0) && (
                <div className="dash-empty">Belum ada catatan orang. Link rekan via [[Nama]].</div>
              )}
            </>
          )}
        </section>

        {/* Recent + tags */}
        <section className="dash-section">
          <div className="section-title" style={{ padding: '0 0 var(--space-2) 0' }}>
            Terbaru
          </div>
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

          <div className="section-title" style={{ padding: 'var(--space-4) 0 var(--space-2) 0' }}>
            Tag
          </div>
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
            className="section-title"
            style={{
              padding: 'var(--space-4) 0 var(--space-2) 0',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 8
            }}
          >
            <span>Catatan orphan</span>
            {orphanNodes.length > 0 && (
              <button
                type="button"
                className="btn btn-ghost btn-sm btn-tiny"
                onClick={handleOrphanClick}
                title="Buka Graph · hanya orphan"
              >
                Graph
              </button>
            )}
          </div>
          {orphanNodes.length === 0 ? (
            <div className="dash-empty">Tidak ada orphan — semua catatan terhubung.</div>
          ) : (
            orphanNodes
              .slice(0, 8)
              .map((n) =>
                listItem(n.title, n.relativePath || n.type, () => openNote(n.path), '0 links')
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
