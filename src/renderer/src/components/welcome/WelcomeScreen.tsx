import React, { useState } from 'react'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { Icon } from '../ui/Icons'

export const WelcomeScreen: React.FC = () => {
  const {
    openWorkspace,
    recentWorkspaces,
    fetchRecentWorkspaces,
    fetchState,
    setActiveView,
    lastError,
    clearError
  } = useWorkspaceStore()
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState('')

  React.useEffect(() => {
    fetchRecentWorkspaces()
  }, [fetchRecentWorkspaces])

  const showErr = error || lastError || ''

  const handleOpenFolder = async () => {
    setError('')
    clearError()
    const folder = await window.api.openFolder()
    if (folder) {
      const ok = await openWorkspace(folder)
      if (!ok) setError(useWorkspaceStore.getState().lastError || 'Gagal membuka vault')
    }
  }

  const handleCreateVault = async () => {
    setError('')
    clearError()
    setCreating(true)
    try {
      const parent = await window.api.openFolder()
      if (!parent) return
      const name = window.prompt('Nama workspace baru:', 'MyWorkspace')
      if (!name?.trim()) return
      const state = await window.api.createWorkspace(parent, name.trim())
      if (state?.rootPath) {
        await fetchState()
        setActiveView('dashboard')
        await fetchRecentWorkspaces()
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Gagal membuat workspace')
    } finally {
      setCreating(false)
    }
  }

  return (
    <div className="welcome-screen">
      <div className="welcome-inner">
        <div className="welcome-logo">
          <div className="welcome-logo-icon">
            <Icon name="graph" size={40} strokeWidth={1.5} />
          </div>
          <h1 className="welcome-title">WorkspaceGraph</h1>
          <p className="welcome-subtitle">
            Markdown vault di disk — graph, search, dan AI sebagai pekerja.
          </p>
        </div>

        {showErr && (
          <div className="badge badge-error welcome-error" style={{ padding: '8px 12px' }}>
            {showErr}
          </div>
        )}

        <div className="welcome-actions" role="group" aria-label="Vault actions">
          <button type="button" className="welcome-action-card" onClick={handleOpenFolder}>
            <Icon name="openFolder" size={28} strokeWidth={1.5} />
            <h3>Open Vault</h3>
            <p>Buka folder Markdown (Obsidian-compatible)</p>
          </button>

          <button
            type="button"
            className="welcome-action-card"
            onClick={creating ? undefined : handleCreateVault}
            disabled={creating}
            aria-busy={creating}
          >
            <Icon name="plus" size={28} strokeWidth={1.5} />
            <h3>{creating ? 'Membuat…' : 'Create Vault'}</h3>
            <p>Workspace baru + folder standar</p>
          </button>
        </div>

        {recentWorkspaces.length > 0 && (
          <div className="welcome-recent">
            <div className="section-title">Recent</div>
            <div className="flex flex-col gap-1">
              {recentWorkspaces.map(p => (
                <button
                  key={p}
                  type="button"
                  className="nav-item"
                  onClick={() => openWorkspace(p)}
                  style={{ justifyContent: 'space-between', width: '100%' }}
                >
                  <span className="truncate">{p.split(/[/\\]/).pop()}</span>
                  <span
                    style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', maxWidth: '55%' }}
                    className="truncate"
                  >
                    {p}
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
