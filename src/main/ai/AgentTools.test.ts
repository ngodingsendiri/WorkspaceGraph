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
  rejectProposal,
  buildToolSchemas,
  nativeCallsToActions,
  formatToolResultForModel
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

  describe('native function calling schemas (P-A1)', () => {
    it('buildToolSchemas exposes all 8 tools as OpenAI-compatible functions', () => {
      const schemas = buildToolSchemas()
      expect(schemas).toHaveLength(8)
      const names = schemas.map((s) => s.function.name)
      expect(names).toEqual([
        'search',
        'read_note',
        'list_dir',
        'write_note',
        'append_note',
        'create_note',
        'list_templates',
        'create_from_template'
      ])
      for (const s of schemas) {
        expect(s.type).toBe('function')
        expect(s.function.description.length).toBeGreaterThan(10)
        expect(s.function.parameters.type).toBe('object')
      }
    })

    it('search schema requires query; read_note requires path', () => {
      const byName = Object.fromEntries(
        buildToolSchemas().map((s) => [s.function.name, s.function])
      )
      // JSON Schema: required lives inside parameters (OpenAI-compatible)
      expect(byName.search.parameters.required).toEqual(['query'])
      expect(byName.search.parameters.properties.query.type).toBe('string')
      expect(byName.read_note.parameters.required).toEqual(['path'])
      expect(byName.create_note.parameters.required).toEqual(['path'])
    })

    it('nativeCallsToActions parses args JSON and keeps call ids', () => {
      const pending = nativeCallsToActions([
        { id: 'call_1', name: 'search', arguments: '{"query":"cuti","limit":3}' },
        { id: 'call_2', name: 'list_dir', arguments: '{}' }
      ])
      expect(pending).toHaveLength(2)
      expect(pending[0].callId).toBe('call_1')
      expect(pending[0].action).toEqual({
        tool: 'search',
        args: { query: 'cuti', limit: 3 }
      })
      expect(pending[1].action.tool).toBe('list_dir')
    })

    it('nativeCallsToActions degrades invalid JSON to {} and skips unnamed', () => {
      const pending = nativeCallsToActions([
        { id: 'bad', name: 'search', arguments: '{not json' },
        { id: 'anon', name: '   ', arguments: '{}' }
      ])
      expect(pending).toHaveLength(1)
      expect(pending[0].action.args).toEqual({})
      expect(pending[0].action.tool).toBe('search')
    })

    it('formatToolResultForModel returns JSON for ok results and error line otherwise', () => {
      const ok = formatToolResultForModel({
        tool: 'list_dir',
        ok: true,
        result: { path: '', items: [{ name: 'a.md', type: 'file', path: 'a.md' }] }
      })
      expect(ok).toContain('a.md')
      const bad = formatToolResultForModel({ tool: 'search', ok: false, error: 'boom' })
      expect(bad).toBe('ERROR: boom')
    })
  })

  describe('proposal persistence to .workspacegraph/proposals (P-B2)', () => {
    it('writes a proposal file on create and reloads it after a restart (close + reopen)', async () => {
      const res = await executeTool({
        tool: 'create_note',
        args: { path: 'Knowledge/Persist.md', content: '# Persist\n\nIsi' }
      })
      expect(res.ok).toBe(true)
      const file = path.join(vault, '.workspacegraph', 'proposals', `${res.proposalId}.json`)
      expect(fs.existsSync(file)).toBe(true)
      const onDisk = JSON.parse(fs.readFileSync(file, 'utf-8'))
      expect(onDisk.status).toBe('pending')
      expect(onDisk.relativePath).toBe('Knowledge/Persist.md')

      // Simulate an app restart: close the vault and reopen it — the pending
      // proposal must come back from disk (not the in-memory map).
      workspaceEngine.closeWorkspace()
      workspaceEngine.openWorkspace(vault)
      expect(listPendingProposals().some((p) => p.id === res.proposalId)).toBe(true)

      // Apply is terminal: note is written AND the persisted file is removed.
      const applied = applyProposal(res.proposalId!)
      expect(applied.ok).toBe(true)
      expect(fs.existsSync(path.join(vault, 'Knowledge', 'Persist.md'))).toBe(true)
      expect(fs.existsSync(file)).toBe(false)
    })

    it('reject removes the persisted file (no resurrection on restart)', async () => {
      const res = await executeTool({
        tool: 'create_note',
        args: { path: 'Knowledge/Rej.md', content: '# Rej' }
      })
      const file = path.join(vault, '.workspacegraph', 'proposals', `${res.proposalId}.json`)
      expect(fs.existsSync(file)).toBe(true)
      expect(rejectProposal(res.proposalId!)).toBe(true)
      expect(fs.existsSync(file)).toBe(false)

      workspaceEngine.closeWorkspace()
      workspaceEngine.openWorkspace(vault)
      expect(listPendingProposals().some((p) => p.id === res.proposalId)).toBe(false)
    })

    it('scopes pending proposals per vault — switching vaults hides foreign proposals', async () => {
      const res = await executeTool({
        tool: 'create_note',
        args: { path: 'Knowledge/Scoped.md', content: '# Scoped' }
      })
      expect(res.ok).toBe(true)
      const vault2 = fs.mkdtempSync(path.join(tmpdir(), 'wg-scope-'))
      try {
        workspaceEngine.openWorkspace(vault2)
        expect(listPendingProposals()).toHaveLength(0)
        // Back to the original vault → proposal reloaded from its own dir
        workspaceEngine.openWorkspace(vault)
        expect(listPendingProposals().some((p) => p.id === res.proposalId)).toBe(true)
      } finally {
        fs.rmSync(vault2, { recursive: true, force: true })
      }
    })

    it('append_note persists the SLICE preview (not the merged full content)', async () => {
      fs.writeFileSync(path.join(vault, 'Knowledge', 'Base.md'), '# Base\n')
      const res = await executeTool({
        tool: 'append_note',
        args: { path: 'Knowledge/Base.md', content: '## Tambahan\n\nbaris baru' }
      })
      expect(res.ok).toBe(true)
      const file = path.join(vault, '.workspacegraph', 'proposals', `${res.proposalId}.json`)
      const onDisk = JSON.parse(fs.readFileSync(file, 'utf-8'))
      expect(onDisk.preview).toContain('Tambahan')
      expect(onDisk.preview).not.toContain('baris baru\n\n# Base')
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
