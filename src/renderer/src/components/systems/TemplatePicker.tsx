import React, { useEffect, useState } from 'react'
import { useEditorStore } from '../../store/editorStore'
import { useWorkspaceStore } from '../../store/workspaceStore'

interface Tpl {
  id: string
  name: string
  kind: string
  description: string
  defaultFolder: string
  builtin: boolean
}

export const TemplatePicker: React.FC<{ open: boolean; onClose: () => void }> = ({
  open,
  onClose
}) => {
  const [templates, setTemplates] = useState<Tpl[]>([])
  const [selected, setSelected] = useState('')
  const [title, setTitle] = useState('')
  const [owner, setOwner] = useState('')
  const [project, setProject] = useState('')
  const [error, setError] = useState('')
  const openTab = useEditorStore((s) => s.openTab)
  const setActiveView = useWorkspaceStore((s) => s.setActiveView)
  const fetchState = useWorkspaceStore((s) => s.fetchState)

  useEffect(() => {
    if (!open) return
    window.api.listTemplates().then((list) => {
      setTemplates(list || [])
      if (list?.[0]) setSelected(list[0].id)
    })
    // Load templates + reset the form each time the picker opens.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTitle('')
    setOwner('')
    setProject('')
    setError('')
  }, [open])

  if (!open) return null

  const handleCreate = async (): Promise<void> => {
    if (!selected) return
    const tpl = templates.find((t) => t.id === selected)
    const name =
      title.trim() || (tpl?.kind === 'daily' ? new Date().toISOString().split('T')[0] : 'Untitled')
    const extraVars: Record<string, string> = {}
    if (owner.trim()) extraVars.owner = owner.trim()
    if (project.trim()) extraVars.project = project.trim()
    const res = await window.api.createFromTemplate({
      templateId: selected,
      title: name,
      ...(Object.keys(extraVars).length ? { extraVars } : {})
    })
    if (!res.ok) {
      setError(res.error || 'Gagal membuat note')
      return
    }
    await fetchState()
    if (res.path) {
      await openTab(res.path)
      setActiveView('editor')
    }
    onClose()
  }

  return (
    <div className="search-overlay" onClick={onClose}>
      <div className="search-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 480 }}>
        <div style={{ padding: 'var(--space-4)', borderBottom: '1px solid var(--border-subtle)' }}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>Dari template</div>
          <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
            Proyek · Tugas · Orang · Pengetahuan · SOP · Harian
          </div>
        </div>
        <div
          style={{ padding: 'var(--space-4)', display: 'flex', flexDirection: 'column', gap: 12 }}
        >
          <label style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
            Template
            <select
              className="input"
              style={{ width: '100%', marginTop: 4 }}
              value={selected}
              onChange={(e) => setSelected(e.target.value)}
            >
              {templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name} ({t.kind}) {t.builtin ? '' : '· kustom'}
                </option>
              ))}
            </select>
          </label>
          <label style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
            Judul
            <input
              className="input"
              style={{ width: '100%', marginTop: 4 }}
              placeholder="Judul note"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleCreate()
              }}
              autoFocus
            />
          </label>
          {/* M4b.6: owner/project inputs for relevant template kinds */}
          {(() => {
            const kind = templates.find((t) => t.id === selected)?.kind
            const showOwner = kind === 'project' || kind === 'people'
            const showProject = kind === 'task'
            if (!showOwner && !showProject) return null
            return (
              <>
                {showOwner && (
                  <label style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
                    Owner
                    <input
                      className="input"
                      style={{ width: '100%', marginTop: 4 }}
                      placeholder="Nama owner"
                      value={owner}
                      onChange={(e) => setOwner(e.target.value)}
                    />
                  </label>
                )}
                {showProject && (
                  <label style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
                    Project
                    <input
                      className="input"
                      style={{ width: '100%', marginTop: 4 }}
                      placeholder="Nama project terkait"
                      value={project}
                      onChange={(e) => setProject(e.target.value)}
                    />
                  </label>
                )}
              </>
            )
          })()}
          {error && <div style={{ fontSize: 12, color: 'var(--color-error)' }}>{error}</div>}
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button className="btn btn-ghost btn-sm" onClick={onClose}>
              Batal
            </button>
            <button className="btn btn-primary btn-sm" onClick={() => void handleCreate()}>
              Buat
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
