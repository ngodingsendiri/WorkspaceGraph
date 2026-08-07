import { describe, it, expect } from 'vitest'
import { followUpPreamble, followUpChipLabel, type FollowUpProposal } from './chatFollowUp'

const props = (over: Partial<FollowUpProposal>): FollowUpProposal => ({
  mode: 'overwrite',
  relativePath: 'Knowledge/foo.md',
  content: 'isi catatan',
  status: 'pending',
  ...over
})

describe('followUpPreamble (P3-1)', () => {
  it('returns empty for no proposals', () => {
    expect(followUpPreamble(undefined)).toBe('')
    expect(followUpPreamble([])).toBe('')
  })

  it('lists every proposal with mode · status · path', () => {
    const p = followUpPreamble([
      props({ mode: 'overwrite', relativePath: 'Knowledge/foo.md' }),
      props({ mode: 'append', relativePath: 'AI Memory/Cara Kerja.md', status: 'pending' })
    ])
    expect(p).toContain('[overwrite · pending] Knowledge/foo.md')
    expect(p).toContain('[append · pending] AI Memory/Cara Kerja.md')
    expect(p).toContain('Konteks follow-up')
    expect(p).toContain('jangan ulangi seluruh jawaban sebelumnya')
  })

  it('carries a snippet capped at 120 chars with ellipsis', () => {
    const long = 'x'.repeat(300)
    const p = followUpPreamble([props({ content: long })])
    expect(p).toContain(`"${'x'.repeat(120)}…"`)
    expect(p).not.toContain('x'.repeat(200))
  })

  it('normalizes multi-line snippets to a single line', () => {
    const p = followUpPreamble([props({ content: 'baris satu\n\nbaris dua' })])
    expect(p).toContain('baris satu baris dua')
    expect(p).not.toContain('\nbaris dua')
  })

  it('handles missing mode/path gracefully', () => {
    const p = followUpPreamble([
      props({ mode: undefined, relativePath: undefined, content: undefined })
    ])
    expect(p).toContain('(file)')
  })
})

describe('followUpChipLabel (P3-1)', () => {
  it('counts proposals and shows up to two paths', () => {
    const label = followUpChipLabel([
      props({ relativePath: 'Knowledge/foo.md' }),
      props({ relativePath: 'Knowledge/bar.md' })
    ])
    expect(label).toBe('Follow-up · 2 proposal · foo.md, bar.md')
  })

  it('adds an overflow count beyond two paths', () => {
    const label = followUpChipLabel([
      props({ relativePath: 'a/one.md' }),
      props({ relativePath: 'b/two.md' }),
      props({ relativePath: 'c/three.md' })
    ])
    expect(label).toContain('one.md, two.md')
    expect(label).toContain(' +1')
  })

  it('falls back for empty proposals', () => {
    expect(followUpChipLabel(undefined)).toBe('Follow-up')
  })
})
