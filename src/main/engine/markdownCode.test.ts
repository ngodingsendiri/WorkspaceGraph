import { describe, it, expect } from 'vitest'
import { splitCodeSegments, stripCodeRegions, fenceMarkerOf } from './markdownCode'

describe('markdownCode tokenizer (WA-3/4/5/10)', () => {
  describe('splitCodeSegments', () => {
    it('splits plain text into a single text segment', () => {
      const segs = splitCodeSegments('hello [[world]]')
      expect(segs).toEqual([{ type: 'text', raw: 'hello [[world]]' }])
    })

    it('extracts fenced code blocks (```)', () => {
      const segs = splitCodeSegments('a\n```js\n[[NotALink]]\n```\nb')
      expect(segs).toEqual([
        { type: 'text', raw: 'a\n' },
        { type: 'code', raw: '```js\n[[NotALink]]\n```' },
        { type: 'text', raw: '\nb' }
      ])
    })

    it('extracts tilde fenced code blocks (~~~) — WA-10', () => {
      const segs = splitCodeSegments('a\n~~~ts\n# fake heading\n~~~\nb')
      expect(segs).toEqual([
        { type: 'text', raw: 'a\n' },
        { type: 'code', raw: '~~~ts\n# fake heading\n~~~' },
        { type: 'text', raw: '\nb' }
      ])
    })

    it('does not close a ``` fence with ~~~ (and vice versa)', () => {
      const segs = splitCodeSegments('```\n~~~\n# in fence\n```')
      expect(segs.filter((s) => s.type === 'code')).toHaveLength(1)
      expect(segs[0]).toEqual({ type: 'code', raw: '```\n~~~\n# in fence\n```' })
    })

    it('extracts inline code spans', () => {
      const segs = splitCodeSegments('a `[[x]]` b')
      expect(segs).toEqual([
        { type: 'text', raw: 'a ' },
        { type: 'code', raw: '`[[x]]`' },
        { type: 'text', raw: ' b' }
      ])
    })

    it('leaves an unclosed fence as text (parity with renderer)', () => {
      const segs = splitCodeSegments('```js\nnever closed')
      expect(segs.every((s) => s.type === 'text')).toBe(true)
    })
  })

  describe('stripCodeRegions', () => {
    it('preserves length so indices stay aligned (wiki-link extraction)', () => {
      const content = '`[[x]]` [[Real]]\n```\n#tag\n```'
      const stripped = stripCodeRegions(content)
      expect(stripped.length).toBe(content.length)
      // Only the real link / tag outside code survive
      expect(stripped).toContain('[[Real]]')
      expect(stripped).not.toContain('#tag')
      expect(stripped).not.toContain('[[x]]')
    })
  })

  describe('fenceMarkerOf', () => {
    it('detects opening markers with optional indent/info string', () => {
      expect(fenceMarkerOf('```')).toBe('```')
      expect(fenceMarkerOf('```js')).toBe('```')
      expect(fenceMarkerOf('   ~~~')).toBe('~~~')
      expect(fenceMarkerOf('~~~md')).toBe('~~~')
      expect(fenceMarkerOf('# not a fence')).toBeNull()
      expect(fenceMarkerOf('plain')).toBeNull()
    })
  })
})
