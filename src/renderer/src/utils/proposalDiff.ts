/**
 * P2-6: proposal diff preview — pure line-diff helpers shared by the proposal
 * dialog's "Diff" tab. Kept dependency-free so it unit-tests in the node env.
 *
 * Strategy: trim the common prefix/suffix first (cheap, handles most note
 * edits), then run a line-based LCS only over the changed middle. Pathological
 * inputs (e.g. a minified blob) fall back to remove-all + add-all instead of
 * an O(n·m) blowup.
 */

export type DiffLineKind = 'same' | 'add' | 'remove'

export interface DiffLine {
  kind: DiffLineKind
  text: string
}

/** Cells above this skip the LCS and degrade to remove-all + add-all
 * (~1000×1000 lines; keeps the transient DP table at a few MB). */
const LCS_CELL_LIMIT = 1_000_000

function splitLines(text: string): string[] {
  return text.replace(/\r\n/g, '\n').split('\n')
}

/** LCS backtrack over the middle slice → remove-before-add run (Myers-ish). */
function lcsOps(a: string[], b: string[]): DiffLine[] {
  const n = a.length
  const m = b.length
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ kind: 'same', text: a[i] })
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ kind: 'remove', text: a[i] })
      i++
    } else {
      out.push({ kind: 'add', text: b[j] })
      j++
    }
  }
  while (i < n) {
    out.push({ kind: 'remove', text: a[i] })
    i++
  }
  while (j < m) {
    out.push({ kind: 'add', text: b[j] })
    j++
  }
  return out
}

/**
 * Diff `current` (disk) → `proposed`. Added lines are the new content,
 * removed lines are what would disappear after applying the proposal.
 */
export function diffLines(current: string, proposed: string): DiffLine[] {
  const a = splitLines(current)
  const b = splitLines(proposed)

  // Trim common prefix + suffix so the LCS only walks the changed middle.
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--
    endB--
  }

  const prefix: DiffLine[] = a.slice(0, start).map((text) => ({ kind: 'same', text }))
  const suffix: DiffLine[] = a.slice(endA).map((text) => ({ kind: 'same', text }))

  if (start === endA && start === endB) return [...prefix, ...suffix]

  const midA = a.slice(start, endA)
  const midB = b.slice(start, endB)
  const middle: DiffLine[] =
    midA.length * midB.length > LCS_CELL_LIMIT
      ? [
          ...midA.map((text) => ({ kind: 'remove' as const, text })),
          ...midB.map((text) => ({ kind: 'add' as const, text }))
        ]
      : lcsOps(midA, midB)

  return [...prefix, ...middle, ...suffix]
}

/** Counts of added/removed lines — shown in the dialog's diff summary. */
export function diffStats(diff: DiffLine[]): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const l of diff) {
    if (l.kind === 'add') added++
    else if (l.kind === 'remove') removed++
  }
  return { added, removed }
}
