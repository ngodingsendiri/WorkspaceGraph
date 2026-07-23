import React, { useMemo } from 'react'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { useGraphStore } from '../../store/graphStore'
import { useEditorStore } from '../../store/editorStore'
import { Icon } from '../ui/Icons'

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
    </div>
  )
}
