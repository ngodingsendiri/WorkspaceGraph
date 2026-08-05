import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import { tmpdir } from 'os'
import {
  parseToolActions,
  stripToolActions,
  isWriteTool,
  isReadTool,
  executeTool,
  applyProposal,
  listPendingProposals,
  rejectProposal
} from './AgentTools'
import { workspaceEngine } from '../engine/WorkspaceEngine'

describe('AgentTools', () => {
  let vault: string

  beforeEach(() => {
    vault = fs.mkdtempSync(path.join(tmpdir(), 'wg-agent-'))
    workspaceEngine.openWorkspace(vault)
  })

  afterEach(() => {
    try {
      workspaceEngine.closeWorkspace()
      fs.rmSync(vault, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  })

  describe('parseToolActions', () => {
    it('parses two wg-action fences with args', () => {
      const sample = `I'll search first.

\`\`\`wg-action
{"tool":"search","args":{"query":"cuti","limit":3}}
\`\`\`

Then create a note.

\`\`\`wg-action
{"tool":"create_note","args":{"path":"Knowledge/Summary.md","content":"# Summary\\n\\nHello"}}
\`\`\`
`
      const actions = parseToolActions(sample)
      expect(actions).toHaveLength(2)
      expect(actions[0].tool).toBe('search')
      expect(actions[0].args.query).toBe('cuti')
      expect(actions[1].tool).toBe('create_note')
    })

    it('parses json and javascript fences', () => {
      const actions = parseToolActions(
        '```json\n{"tool":"search","args":{"query":"x"}}\n```\n```javascript\n{"tool":"list_dir","args":{}}\n```'
      )
      expect(actions.map((a) => a.tool)).toEqual(['search', 'list_dir'])
    })

    it('parses bare flat JSON objects with tool field', () => {
      // Bare fallback regex matches flat objects ({tool, ...rest}); nested args
      // objects are best-effort and not guaranteed by the bare fallback.
      const actions = parseToolActions('Please do {"tool":"search","query":"cara"} for me')
      expect(actions.some((a) => a.tool === 'search')).toBe(true)
    })

    it('dedupes consecutive identical actions', () => {
      const actions = parseToolActions(
        '```wg-action\n{"tool":"search","args":{"query":"x"}}\n```\n```wg-action\n{"tool":"search","args":{"query":"x"}}\n```'
      )
      expect(actions).toHaveLength(1)
    })

    it('returns empty for no tool blocks', () => {
      expect(parseToolActions('just prose')).toHaveLength(0)
      expect(parseToolActions('')).toHaveLength(0)
    })
  })

  describe('stripToolActions', () => {
    it('removes wg-action fences and keeps prose', () => {
      const sample = `I'll search first.

\`\`\`wg-action
{"tool":"search","args":{"query":"cuti"}}
\`\`\`

Keep me.`
      const stripped = stripToolActions(sample)
      expect(stripped).not.toContain('wg-action')
      expect(stripped).toContain("I'll search")
      expect(stripped).toContain('Keep me')
    })
  })

  describe('tool classification', () => {
    it('classifies write vs read tools', () => {
      expect(isWriteTool('write_note')).toBe(true)
      expect(isWriteTool('append_note')).toBe(true)
      expect(isWriteTool('create_note')).toBe(true)
      expect(isWriteTool('create_from_template')).toBe(true)
      expect(isWriteTool('search')).toBe(false)
      expect(isReadTool('search')).toBe(true)
      expect(isReadTool('read_note')).toBe(true)
      expect(isReadTool('list_dir')).toBe(true)
    })
  })

  describe('write proposals (executeTool → applyProposal)', () => {
    it('creates a proposal for create_note and applies it', async () => {
      const res = await executeTool({
        tool: 'create_note',
        args: { path: 'Knowledge/FromAI.md', content: '# FromAI\n\nHello' }
      })
      expect(res.ok).toBe(true)
      expect(res.proposalId).toBeTruthy()
      expect(listPendingProposals().some((p) => p.id === res.proposalId)).toBe(true)

      const applied = applyProposal(res.proposalId!)
      expect(applied.ok).toBe(true)
      const file = path.join(vault, 'Knowledge', 'FromAI.md')
      expect(fs.existsSync(file)).toBe(true)
      expect(fs.readFileSync(file, 'utf8')).toContain('# FromAI')
      // Non-pending proposal cannot be applied twice
      expect(applyProposal(res.proposalId!).ok).toBe(false)
    })

    it('rejects non-existent proposal', () => {
      expect(applyProposal('nope').ok).toBe(false)
      expect(rejectProposal('nope')).toBe(false)
    })

    it('rejects path outside vault', async () => {
      const res = await executeTool({
        tool: 'create_note',
        args: { path: path.join(vault, '..', 'evil.md'), content: 'x' }
      })
      expect(res.ok).toBe(false)
    })

    it('append_note merges content into proposal', async () => {
      fs.writeFileSync(path.join(vault, 'Knowledge', 'Base.md'), '# Base\n')
      const res = await executeTool({
        tool: 'append_note',
        args: { path: 'Knowledge/Base.md', content: '## Added\n\nmore' }
      })
      expect(res.ok).toBe(true)
      const applied = applyProposal(res.proposalId!)
      expect(applied.ok).toBe(true)
      const content = fs.readFileSync(path.join(vault, 'Knowledge', 'Base.md'), 'utf8')
      expect(content).toContain('## Added')
    })

    it('write_note to existing file preserves frontmatter in proposal', async () => {
      const base = '---\ntitle: Existing\n---\n# Existing\n\nBody'
      fs.writeFileSync(path.join(vault, 'Knowledge', 'Existing.md'), base)
      const res = await executeTool({
        tool: 'write_note',
        args: { path: 'Knowledge/Existing.md', content: 'Updated body' }
      })
      expect(res.ok).toBe(true)
      const applied = applyProposal(res.proposalId!)
      expect(applied.ok).toBe(true)
      const content = fs.readFileSync(path.join(vault, 'Knowledge', 'Existing.md'), 'utf8')
      expect(content).toContain('title: Existing')
      expect(content).toContain('Updated body')
    })

    it('returns clear error when no workspace open', async () => {
      workspaceEngine.closeWorkspace()
      const res = await executeTool({ tool: 'search', args: { query: 'x' } })
      expect(res.ok).toBe(false)
      expect(res.error).toContain('No workspace')
    })

    it('rejects unclosed frontmatter content', async () => {
      const res = await executeTool({
        tool: 'create_note',
        args: { path: 'Knowledge/Bad.md', content: '---\ntitle: x\nbody only' }
      })
      expect(res.ok).toBe(false)
      expect(res.error).toContain('unclosed frontmatter')
    })
  })
})
