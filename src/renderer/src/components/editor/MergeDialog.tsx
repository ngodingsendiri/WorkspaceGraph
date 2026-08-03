import React, { useState, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '../ui/Icons'

interface MergeDialogProps {
  isOpen: boolean
  onClose: () => void
  onResolve: (resolvedContent: string) => void
  filePath: string
  theirs: string
  yours: string
  base?: string
}

export const MergeDialog: React.FC<MergeDialogProps> = ({
  isOpen,
  onClose,
  onResolve,
  filePath,
  theirs,
  yours,
  base = ''
}) => {
  const [resolved, setResolved] = useState<string>(yours)
  const [activeTab, setActiveTab] = useState<'yours' | 'theirs' | 'merged'>('merged')
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (isOpen) {
      setResolved(yours)
      setActiveTab('merged')
    }
  }, [isOpen, yours])

  const computeBase = (): string => {
    if (base) return base
    const tLines = theirs.split('\n')
    const yLines = yours.split('\n')
    let i = 0
    while (i < tLines.length && i < yLines.length && tLines[i] === yLines[i]) i++
    return tLines.slice(0, i).join('\n')
  }

  const baseContent = computeBase()

  const applyTheirs = () => setResolved(theirs)
  const applyYours = () => setResolved(yours)
  const applyBase = () => setResolved(baseContent)

  if (!isOpen) return null

  const portalRoot = document.getElementById('merge-dialog-portal') || document.body

  return createPortal(
    <div className="merge-dialog-overlay" onClick={onClose}>
      <div className="merge-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="merge-dialog-header">
          <h3>⚠️ Conflict detected</h3>
          <span className="merge-file-path">{filePath}</span>
          <button className="btn btn-ghost btn-icon" onClick={onClose} aria-label="Close">
            <Icon name="close" size={20} />
          </button>
        </div>

        <div className="merge-tabs">
          <button
            className={activeTab === 'yours' ? 'active' : ''}
            onClick={() => setActiveTab('yours')}
          >
            Yours (local)
          </button>
          <button
            className={activeTab === 'theirs' ? 'active' : ''}
            onClick={() => setActiveTab('theirs')}
          >
            Theirs (disk)
          </button>
          <button
            className={activeTab === 'merged' ? 'active' : ''}
            onClick={() => setActiveTab('merged')}
          >
            Merged
          </button>
        </div>

        <div className="merge-content">
          {activeTab === 'yours' && <pre className="merge-pane read-only">{yours}</pre>}
          {activeTab === 'theirs' && <pre className="merge-pane read-only">{theirs}</pre>}
          {activeTab === 'merged' && (
            <textarea
              ref={textareaRef}
              className="merge-pane editable"
              value={resolved}
              onChange={(e) => setResolved(e.target.value)}
              spellCheck={false}
            />
          )}
        </div>

        <div className="merge-actions">
          <button className="btn btn-secondary" onClick={applyBase} disabled={!baseContent}>
            Use Base
          </button>
          <button className="btn btn-secondary" onClick={applyTheirs}>
            Use Theirs
          </button>
          <button className="btn btn-secondary" onClick={applyYours}>
            Use Yours
          </button>
          <button
            className="btn btn-primary"
            onClick={() => {
              onResolve(resolved)
              onClose()
            }}
          >
            Save Merged
          </button>
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>,
    portalRoot
  )
}

export default MergeDialog
