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

function EmbeddingBadge() {
  const [status, setStatus] = useState<EmbedStatus | null>(null)
  const isOpen = useWorkspaceStore((s) => s.isOpen)

  useEffect(() => {
    if (!isOpen || !window.api?.getEmbeddingStatus) return
    let mounted = true
    const poll = async () => {
      try {
        const s = await window.api.getEmbeddingStatus()
        if (mounted) setStatus(s)
      } catch { /* ignore */ }
    }
    poll()
    const id = setInterval(poll, 3000)
    return () => { mounted = false; clearInterval(id) }
  }, [isOpen])

  if (!status || status.state === 'idle') return null

  const labels: Record<EmbedState, string> = {
    idle: '',
    loading_model: 'Loading AI model…',
    indexing: `Indexing ${status.indexedFiles} files`,
    ready: `Semantic: ${status.totalChunks} chunks`
  }
  const colors: Record<EmbedState, string> = {
    idle: 'transparent',
    loading_model: 'var(--color-warning, #f59e0b)',
    indexing: 'var(--accent, #6366f1)',
    ready: 'var(--color-success, #22c55e)'
  }
  const spinning = status.state === 'loading_model' || status.state === 'indexing'

  return (
    <span
      title={`Semantic RAG — ${labels[status.state]}`}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 4,
        color: colors[status.state], fontSize: 'var(--text-xs)',
        cursor: 'default'
      }}
    >
      {spinning
        ? <span style={{ display: 'inline-block', animation: 'spin 1s linear infinite' }}>⟳</span>
        : <Icon name="psychology" size={12} />
      }
      {labels[status.state]}
    </span>
  )
}

export const StatusBar: React.FC = () => {
  const { totalFiles, totalFolders, totalNotes, rootPath } = useWorkspaceStore()
  const nodeCount = useGraphStore((s) => s.nodes.length)
  const edgeCount = useGraphStore((s) => s.edges.length)
  // Only active tab meta + content length-ish fields — not full tabs array churn for inactive
  const surfaceMode = useEditorStore((s) => s.surfaceMode)
  const active = useEditorStore((s) => s.tabs.find((t) => t.id === s.activeTabId))

  const wordCount = useMemo(() => {
    if (!active?.content) return 0
    // strip frontmatter for count
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

  return (
    <div className="app-statusbar">
      <span className="truncate" style={{ maxWidth: 280 }} title={rootPath || ''}>
        {rootPath ? rootPath.split(/[/\\]/).pop() : 'No vault'}
      </span>
      <span>•</span>
      <span>{totalNotes} notes</span>
      <span>•</span>
      <span>
        {totalFiles} files / {totalFolders} folders
      </span>
      <span>•</span>
      <span>
        Graph {nodeCount}/{edgeCount}
      </span>
      {shortPath && (
        <>
          <span>•</span>
          <span className="truncate" style={{ maxWidth: 220 }} title={active?.path}>
            {shortPath}
            {active?.isDirty ? ' •' : ''}
          </span>
          <span>•</span>
          <span>{wordCount} words</span>
          <span style={{ opacity: 0.85 }}>{surfaceMode === 'source' ? 'source' : 'live'}</span>
          {active?.isDirty && <span style={{ color: 'var(--color-warning)' }}>unsaved</span>}
        </>
      )}
      <span
        style={{
          marginLeft: 'auto',
          display: 'inline-flex',
          alignItems: 'center',
          gap: 8
        }}
      >
        <EmbeddingBadge />
        <span
          style={{
            color: 'var(--color-success)',
            fontSize: 'var(--text-xs)',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4
          }}
        >
          <Icon name="checkCircle" size={12} />
          Active
        </span>
      </span>
      <style>{`@keyframes spin { from{transform:rotate(0deg)} to{transform:rotate(360deg)} }`}</style>
    </div>
  )
}
