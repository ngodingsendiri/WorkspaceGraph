import React, { useMemo, useState, useEffect } from 'react'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { useGraphStore } from '../../store/graphStore'
import { useEditorStore } from '../../store/editorStore'
import { Icon } from '../ui/Icons'

type EmbedState = 'idle' | 'loading_model' | 'indexing' | 'ready'

interface EmbedStatus {
  state: EmbedState
  totalChunks: number
  indexedFiles: number
  modelReady: boolean
}

function EmbeddingBadge(): React.JSX.Element | null {
  const [status, setStatus] = useState<EmbedStatus | null>(null)
  const isOpen = useWorkspaceStore((s) => s.isOpen)

  useEffect(() => {
    if (!isOpen || !window.api?.getEmbeddingStatus) return
    let mounted = true
    const poll = async (): Promise<void> => {
      try {
        const s = await window.api.getEmbeddingStatus()
        if (mounted) setStatus(s)
      } catch {
        /* ignore */
      }
    }
    poll()
    const id = setInterval(poll, 3000)
    return () => {
      mounted = false
      clearInterval(id)
    }
  }, [isOpen])

  if (!status || status.state === 'idle') return null

  const labels: Record<EmbedState, string> = {
    idle: '',
    loading_model: 'Memuat model AI…',
    indexing: `Mengindeks ${status.indexedFiles} file`,
    ready: `Semantik: ${status.totalChunks} chunk`
  }
  const tone: Record<EmbedState, string> = {
    idle: 'transparent',
    loading_model: 'var(--color-warning)',
    indexing: 'var(--color-accent)',
    ready: 'var(--color-success)'
  }
  const spinning = status.state === 'loading_model' || status.state === 'indexing'

  return (
    <span
      className={`status-embed ${spinning ? 'is-busy' : ''}`}
      style={{ color: tone[status.state] }}
      title={`Semantic RAG — ${labels[status.state]}`}
    >
      {spinning ? <Icon name="sync" size={12} /> : <Icon name="psychology" size={12} />}
      {labels[status.state]}
    </span>
  )
}

export const StatusBar: React.FC = () => {
  const { totalFiles, totalFolders, totalNotes, rootPath } = useWorkspaceStore()
  const nodeCount = useGraphStore((s) => s.nodes.length)
  const edgeCount = useGraphStore((s) => s.edges.length)
  const surfaceMode = useEditorStore((s) => s.surfaceMode)
  const active = useEditorStore((s) => s.tabs.find((t) => t.id === s.activeTabId))

  const wordCount = useMemo(() => {
    if (!active?.content) return 0
    let body = active.content
    if (body.startsWith('---')) {
      const end = body.indexOf('\n---', 3)
      if (end !== -1) body = body.slice(end + 4)
    }
    return body.split(/\s+/).filter((w) => w.length > 0).length
  }, [active?.content])

  const shortPath = active
    ? rootPath
      ? active.path.replace(rootPath, '').replace(/^[\\/]/, '')
      : active.path
    : null

  const vaultName = rootPath ? rootPath.split(/[/\\]/).pop() : 'Tanpa vault'

  return (
    <div className="app-statusbar">
      {/* Left group — file context */}
      <span className="status-left">
        <span className="truncate" title={rootPath || ''}>
          {vaultName}
        </span>
        <span className="status-sep">•</span>
        <span>{totalNotes} catatan</span>
        <span className="status-sep status-optional">•</span>
        <span className="status-optional">
          {totalFiles} file / {totalFolders} folder
        </span>
        <span className="status-sep status-optional">•</span>
        <span className="status-optional">
          Graph {nodeCount}/{edgeCount}
        </span>
        {shortPath && (
          <>
            <span className="status-sep">•</span>
            <span className="truncate" title={active?.path}>
              {shortPath}
              {active?.isDirty ? ' •' : ''}
            </span>
            <span className="status-sep status-optional">•</span>
            <span className="status-optional">{wordCount} kata</span>
            <span className="status-mode status-optional">
              {surfaceMode === 'source' ? 'source' : 'live'}
            </span>
            {active?.saveState === 'saving' && (
              <span className="status-dirty" title="Menyimpan perubahan…">
                menyimpan…
              </span>
            )}
            {active?.saveState === 'error' && (
              <span
                className="status-save-error"
                title="Penyimpanan gagal — aplikasi akan mencoba lagi otomatis"
              >
                gagal disimpan
              </span>
            )}
            {active?.isDirty && active?.saveState !== 'error' && (
              <span className="status-dirty">belum disimpan</span>
            )}
          </>
        )}
      </span>

      {/* Right group — system status */}
      <span className="status-right">
        <EmbeddingBadge />
        <span className="status-ready" title="Vault aktif & terindeks">
          <Icon name="checkCircle" size={12} />
          Siap
        </span>
      </span>
    </div>
  )
}
