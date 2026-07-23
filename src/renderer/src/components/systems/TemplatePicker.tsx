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
    setTitle('')
    setError('')
  }, [open])

  if (!open) return null

  const handleCreate = async () => {
    if (!selected) return
    const tpl = templates.find((t) => t.id === selected)
    const name =
      title.trim() || (tpl?.kind === 'daily' ? new Date().toISOString().split('T')[0] : 'Untitled')
    const res = await window.api.createFromTemplate({ templateId: selected, title: name })
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
          <div style={{ fontWeight: 600, marginBottom: 4 }}>New from template</div>
          <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
            Project · Task · People · Knowledge · SOP · Daily
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
                  {t.name} ({t.kind}) {t.builtin ? '' : '· user'}
                </option>
              ))}
            </select>
          </label>
          <label style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
            Title
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
          {error && <div style={{ fontSize: 12, color: 'var(--color-error)' }}>{error}</div>}
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button className="btn btn-ghost btn-sm" onClick={onClose}>
              Cancel
            </button>
            <button className="btn btn-primary btn-sm" onClick={() => void handleCreate()}>
              Create
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
