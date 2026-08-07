/**
 * P3-1: follow-up composer mode.
 *
 * When the user clicks "Follow-up" on an assistant message that produced write
 * proposals, the NEXT prompt carries a compact context block listing those
 * proposals (path · mode · status · snippet) — so the model continues from
 * them WITHOUT the user re-typing (or re-sending) the whole answer. The block
 * also survives history windowing: even if the source message falls out of the
 * 8-turn window, the proposal list still reaches the model.
 */

export interface FollowUpProposal {
  mode?: string
  relativePath?: string
  content?: string
  status?: string
}

/** Max characters of a proposal snippet carried in the preamble. */
const SNIPPET_CHARS = 120

/**
 * Compact context block prepended to the next user prompt. Empty when there
 * are no proposals — callers skip the injection entirely.
 */
export function followUpPreamble(proposals: FollowUpProposal[] | undefined): string {
  if (!proposals?.length) return ''
  const lines = proposals.map((p) => {
    const path = p.relativePath || '(file)'
    const tag = p.mode
      ? `[${p.mode}${p.status ? ` · ${p.status}` : ''}]`
      : p.status
        ? `[${p.status}]`
        : ''
    const flat = (p.content || '').replace(/\s+/g, ' ').trim()
    const snippet = flat.slice(0, SNIPPET_CHARS)
    const quoted = snippet ? ` — "${snippet}${snippet.length >= SNIPPET_CHARS ? '…' : ''}"` : ''
    return `- ${tag} ${path}${quoted}`
  })
  return (
    'Konteks follow-up dari jawaban sebelumnya — proposal write berikut (belum tentu diterapkan):\n' +
    lines.join('\n') +
    '\n\nLanjutkan dari konteks ini; jangan ulangi seluruh jawaban sebelumnya.'
  )
}

/**
 * Short composer-chip label: `Follow-up · 2 proposal · foo.md, bar.md` (paths
 * truncated to two + overflow count).
 */
export function followUpChipLabel(proposals: FollowUpProposal[] | undefined): string {
  if (!proposals?.length) return 'Follow-up'
  const names = proposals
    .map((p) => p.relativePath?.split('/').pop() || p.relativePath || 'file')
    .slice(0, 2)
  const extra = proposals.length > 2 ? ` +${proposals.length - 2}` : ''
  return `Follow-up · ${proposals.length} proposal · ${names.join(', ')}${extra}`
}
