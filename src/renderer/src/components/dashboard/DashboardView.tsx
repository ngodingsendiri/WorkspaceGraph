import React, { useEffect, useState } from 'react'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { useEditorStore } from '../../store/editorStore'
import { useGraphStore } from '../../store/graphStore'
import { TemplatePicker } from '../systems/TemplatePicker'
import { Icon } from '../ui/Icons'

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
  const { nodes, edges, fetchGraph, setFocusedNode } = useGraphStore()

  const [recentNotes, setRecentNotes] = useState<
    { id: string; title: string; path: string; relativePath: string; type?: string }[]
  >([])
  const [tags, setTags] = useState<{ tag: string; count: number }[]>([])
  const [domain, setDomain] = useState<DomainOverview | null>(null)
  const [tplOpen, setTplOpen] = useState(false)

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
    try {
      const recent = await window.api.getRecentNotes(6)
      setRecentNotes(recent || [])
      const tagList = await window.api.getTags()
      setTags(tagList || [])
      const ov = await window.api.getDomainOverview()
      setDomain(ov || null)
    } catch (err) {
      console.error('Failed to load dashboard data:', err)
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
    const node = nodes.find((n) => n.path === notePath)
    if (node) {
      setFocusedNode(node.id)
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
    onOpenSearch()
    setTimeout(() => {
      window.dispatchEvent(new CustomEvent('search:prefill', { detail: 'orphan:true' }))
    }, 50)
  }

  const orphanNodes = nodes.filter((n) => n.degree === 0)

  const metrics = [
    {
      label: 'Markdown Notes',
      value: totalNotes || nodes.length,
      color: 'var(--color-primary)',
      onClick: onOpenSearch
    },
    {
      label: 'Projects',
      value: domain?.counts.projects ?? 0,
      color: 'var(--color-accent)',
      onClick: undefined
    },
    {
      label: 'Open Tasks',
      value: domain?.counts.openTasks ?? 0,
      color: 'var(--color-warning)',
      onClick: undefined
    },
    {
      label: 'People',
      value: domain?.counts.people ?? 0,
      color: 'var(--node-person)',
      onClick: undefined
    },
    {
      label: 'Checkboxes',
      value: domain?.counts.openCheckboxes ?? 0,
      color: 'var(--color-success)',
      onClick: undefined,
      hint: 'Open - [ ] across vault'
    },
    {
      label: 'Orphans',
      value: orphanNodes.length,
      color: orphanNodes.length > 0 ? 'var(--color-warning)' : 'var(--text-muted)',
      onClick: orphanNodes.length > 0 ? handleOrphanClick : undefined
    },
    {
      label: 'Graph',
      value: `${nodes.length}/${edges.length}`,
      color: 'var(--color-accent)',
      onClick: () => setActiveView('graph')
    },
    {
      label: 'Files',
      value: totalFiles,
      color: 'var(--text-secondary)',
      onClick: undefined
    }
  ]

  const listItem = (title: string, sub: string, onClick: () => void, badge?: string) => (
    <div
      key={title + sub}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: 'var(--space-2) var(--space-3)',
        borderRadius: 'var(--radius-md)',
        cursor: 'pointer'
      }}
      onClick={onClick}
      onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg-hover)')}
      onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
    >
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 'var(--text-sm)', fontWeight: 500 }} className="truncate">
          {title}
        </div>
        <div style={{ fontSize: 10, color: 'var(--text-muted)' }} className="truncate">
          {sub}
        </div>
      </div>
      {badge && (
        <span style={{ fontSize: 10, color: 'var(--text-muted)', flexShrink: 0, marginLeft: 8 }}>
          {badge}
        </span>
      )}
    </div>
  )

  return (
    <div
      style={{
        padding: 'var(--space-6) var(--space-8)',
        height: '100%',
        overflowY: 'auto',
        background: 'var(--bg-app)'
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 'var(--space-6)'
        }}
      >
        <div>
          <h1 style={{ fontSize: 'var(--text-2xl)', fontWeight: 'var(--weight-bold)' }}>
            Workspace
          </h1>
          <p
            style={{
              fontSize: 'var(--text-xs)',
              color: 'var(--text-muted)',
              marginTop: 4,
              fontFamily: 'var(--font-mono)'
            }}
          >
            {rootPath}
          </p>
        </div>
        <div className="flex gap-2">
          <button className="btn btn-primary btn-sm" onClick={() => setTplOpen(true)}>
            + From template
          </button>
          <button className="btn btn-surface btn-sm" onClick={handleCreateDailyNote}>
            + Daily
          </button>
          <button className="btn btn-ghost btn-sm" onClick={onOpenSearch}>
            Search
          </button>
        </div>
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))',
          gap: 'var(--space-3)',
          marginBottom: 'var(--space-6)'
        }}
      >
        {metrics.map((m) => (
          <div
            key={m.label}
            style={{
              background: 'var(--bg-surface)',
              borderRadius: 'var(--radius-md)',
              padding: 'var(--space-3)',
              cursor: m.onClick ? 'pointer' : 'default'
            }}
            onClick={m.onClick}
            title={(m as { hint?: string }).hint}
          >
            <span
              style={{
                fontSize: 10,
                color: 'var(--text-muted)',
                textTransform: 'uppercase',
                letterSpacing: '0.05em'
              }}
            >
              {m.label}
            </span>
            <div style={{ fontSize: 'var(--text-xl)', fontWeight: 700, color: m.color }}>
              {m.value}
            </div>
          </div>
        ))}
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
          gap: 'var(--space-6)'
        }}
      >
        {/* Open tasks + checkboxes */}
        <div>
          <div className="section-title" style={{ padding: '0 0 var(--space-2) 0' }}>
            Open tasks
          </div>
          {(domain?.tasks.filter((t) => t.status !== 'done' && t.status !== 'completed') || [])
            .slice(0, 6)
            .map((t) =>
              listItem(t.title, t.relativePath, () => openNote(t.path), t.priority || t.status)
            )}
          {(!domain || domain.tasks.length === 0) && (
            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', padding: 8 }}>
              No task notes yet. Use template <b>Task</b>.
            </div>
          )}

          <div className="section-title" style={{ padding: 'var(--space-4) 0 var(--space-2) 0' }}>
            Open checkboxes
          </div>
          {(domain?.openCheckboxes || [])
            .slice(0, 8)
            .map((c) => listItem(c.text, c.noteTitle, () => openNote(c.notePath), undefined))}
        </div>

        {/* Projects + People */}
        <div>
          <div className="section-title" style={{ padding: '0 0 var(--space-2) 0' }}>
            Projects
          </div>
          {(domain?.projects || [])
            .slice(0, 8)
            .map((p) => listItem(p.title, p.relativePath, () => openNote(p.path), p.status))}
          {(!domain || domain.projects.length === 0) && (
            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', padding: 8 }}>
              No projects. Create from template.
            </div>
          )}

          <div className="section-title" style={{ padding: 'var(--space-4) 0 var(--space-2) 0' }}>
            People
          </div>
          {(domain?.people || [])
            .slice(0, 8)
            .map((p) => listItem(p.title, p.relativePath, () => openNote(p.path)))}
          {(!domain || domain.people.length === 0) && (
            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', padding: 8 }}>
              No people notes. Link rekan via [[Name]].
            </div>
          )}
        </div>

        {/* Recent + tags */}
        <div>
          <div className="section-title" style={{ padding: '0 0 var(--space-2) 0' }}>
            Recent
          </div>
          {recentNotes.map((note) => (
            <div
              key={note.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: 'var(--space-2) var(--space-3)',
                borderRadius: 'var(--radius-md)',
                cursor: 'pointer'
              }}
              onClick={() => openNote(note.path)}
              onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg-hover)')}
              onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
            >
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 'var(--text-sm)' }} className="truncate">
                  {note.title}
                </div>
                <div style={{ fontSize: 10, color: 'var(--text-muted)' }} className="truncate">
                  {note.relativePath}
                </div>
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
          ))}

          <div className="section-title" style={{ padding: 'var(--space-4) 0 var(--space-2) 0' }}>
            Tags
          </div>
          <div className="flex flex-wrap gap-2">
            {tags.slice(0, 14).map((t) => (
              <span
                key={t.tag}
                style={{
                  fontSize: 'var(--text-xs)',
                  background: 'var(--bg-surface)',
                  padding: '3px 8px',
                  borderRadius: 'var(--radius-sm)',
                  cursor: 'pointer'
                }}
                onClick={() => handleTagClick(t.tag)}
              >
                #{t.tag} ({t.count})
              </span>
            ))}
          </div>
        </div>
      </div>

      <TemplatePicker open={tplOpen} onClose={() => setTplOpen(false)} />
    </div>
  )
}
