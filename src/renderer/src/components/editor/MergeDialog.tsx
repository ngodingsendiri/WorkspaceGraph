import React, { useState, useEffect, useRef, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '../ui/Icons'
import { diffLines, diffStats } from '../../utils/proposalDiff'

interface MergeDialogProps {
  isOpen: boolean
  onClose: () => void
  onResolve: (resolvedContent: string) => void
  filePath: string
  theirs: string
  yours: string
  base?: string
  /**
   * P2-6: 'proposal' reuses the same dialog shell for the chat proposal diff
   * preview — tabs become Disk / Proposal / Diff and the Proposal tab is
   * editable so the user can tweak before Apply.
   */
  variant?: 'conflict' | 'proposal'
  /** Proposal write mode ('create' | 'overwrite' | 'append') for the header. */
  mode?: string
}

export const MergeDialog: React.FC<MergeDialogProps> = ({
  isOpen,
  onClose,
  onResolve,
  filePath,
  theirs,
  yours,
  base = '',
  variant = 'conflict',
  mode
}) => {
  const [resolved, setResolved] = useState<string>(yours)
  const [activeTab, setActiveTab] = useState<'yours' | 'theirs' | 'merged'>('merged')
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const isProposal = variant === 'proposal'

  // Reset dialog state to the incoming "yours" content each time it opens.
  useEffect(() => {
    if (isOpen) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- reset-on-open pattern
      setResolved(yours)
      // Both variants land on 'merged' (conflict → merged pane, proposal → the
      // Diff tab the card button promised).
      setActiveTab('merged')
    }
  }, [isOpen, yours, variant])

  const computeBase = (): string => {
    if (base) return base
    const tLines = theirs.split('\n')
    const yLines = yours.split('\n')
    let i = 0
    while (i < tLines.length && i < yLines.length && tLines[i] === yLines[i]) i++
    return tLines.slice(0, i).join('\n')
  }

  const baseContent = computeBase()

  const applyTheirs = (): void => setResolved(theirs)
  const applyYours = (): void => setResolved(yours)
  const applyBase = (): void => setResolved(baseContent)

  // P2-6: live diff (proposal/edited vs disk) for the Diff tab — computed ONLY
  // while that tab is visible so typing in the editable Proposal pane never
  // pays for a full LCS on every keystroke.
  const diff = useMemo(
    () => (isProposal && activeTab === 'merged' ? diffLines(theirs, resolved) : []),
    [isProposal, activeTab, theirs, resolved]
  )
  const stats = useMemo(() => diffStats(diff), [diff])

  if (!isOpen) return null

  const portalRoot = document.getElementById('merge-dialog-portal') || document.body

  const tabLabel = (t: 'yours' | 'theirs' | 'merged'): string => {
    if (isProposal) {
      if (t === 'yours') return 'Proposal (baru)'
      if (t === 'theirs') return 'Sekarang (disk)'
      return 'Diff'
    }
    if (t === 'yours') return 'Yours (local)'
    if (t === 'theirs') return 'Theirs (disk)'
    return 'Merged'
  }

  return createPortal(
    <div className="merge-dialog-overlay" onClick={onClose}>
      <div className="merge-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="merge-dialog-header">
          <h3 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Icon
              name={isProposal ? 'file' : 'warning'}
              size={16}
              style={{ color: isProposal ? 'var(--color-primary)' : 'var(--color-warning)' }}
            />
            {isProposal ? `Proposal · ${mode || 'ubah'}` : 'Conflict detected'}
          </h3>
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
            {tabLabel('yours')}
          </button>
          <button
            className={activeTab === 'theirs' ? 'active' : ''}
            onClick={() => setActiveTab('theirs')}
          >
            {tabLabel('theirs')}
          </button>
          <button
            className={activeTab === 'merged' ? 'active' : ''}
            onClick={() => setActiveTab('merged')}
          >
            {tabLabel('merged')}
          </button>
        </div>

        <div className="merge-content">
          {activeTab === 'yours' &&
            (isProposal ? (
              <textarea
                ref={textareaRef}
                className="merge-pane editable"
                value={resolved}
                onChange={(e) => setResolved(e.target.value)}
                spellCheck={false}
                aria-label="Konten proposal (bisa diedit)"
              />
            ) : (
              <pre className="merge-pane read-only">{yours}</pre>
            ))}
          {activeTab === 'theirs' && <pre className="merge-pane read-only">{theirs}</pre>}
          {activeTab === 'merged' &&
            (isProposal ? (
              <div className="merge-pane merge-diff">
                <div className="merge-diff-summary" aria-hidden>
                  <span className="is-add">+{stats.added}</span>
                  <span className="is-remove">−{stats.removed}</span>
                  <span className="merge-diff-muted">baris berubah vs disk</span>
                </div>
                {diff.map((l, i) => (
                  <div key={i} className={`md-line is-${l.kind}`}>
                    <span className="md-line-mark" aria-hidden>
                      {l.kind === 'add' ? '+' : l.kind === 'remove' ? '−' : ' '}
                    </span>
                    {l.text}
                  </div>
                ))}
              </div>
            ) : (
              <textarea
                ref={textareaRef}
                className="merge-pane editable"
                value={resolved}
                onChange={(e) => setResolved(e.target.value)}
                spellCheck={false}
              />
            ))}
        </div>

        <div className="merge-actions">
          {isProposal ? (
            <>
              <button
                className="btn btn-secondary"
                onClick={applyTheirs}
                title="Gunakan isi file di disk"
              >
                Gunakan disk
              </button>
              <button
                className="btn btn-primary"
                onClick={() => {
                  onResolve(resolved)
                  onClose()
                }}
              >
                Terapkan proposal
              </button>
              <button className="btn btn-ghost" onClick={onClose}>
                Tutup
              </button>
            </>
          ) : (
            <>
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
            </>
          )}
        </div>
      </div>
    </div>,
    portalRoot
  )
}

export default MergeDialog
