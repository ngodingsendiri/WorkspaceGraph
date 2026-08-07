import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import { tmpdir } from 'os'
import {
  parseToolActions,
  stripToolActions,
  isWriteTool,
  isReadTool,
  isToolAllowed,
  executeTool,
  applyProposal,
  listPendingProposals,
  rejectProposal,
  promoteToKnowledge,
  buildToolSchemas,
  buildToolsSystemPrompt,
  ROLE_TOOL_PERMISSIONS,
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

  function writeVaultNote(rel: string, content: string): void {
    const abs = path.join(vault, rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, content)
  }

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

  describe('P1 per-role tool permissions (doc 20 agent capabilities)', () => {
    it('researcher is read-only + may delegate; general/writer have the full toolset', () => {
      for (const t of ['search', 'read_note', 'list_dir', 'list_templates']) {
        expect(isToolAllowed('researcher', t)).toBe(true)
      }
      // R1-3: delegation is not a write — a researcher may hand off to a writer
      // child, but its OWN toolset stays strictly read-only.
      expect(isToolAllowed('researcher', 'delegate_subagent')).toBe(true)
      for (const t of ['write_note', 'append_note', 'create_note', 'create_from_template']) {
        expect(isToolAllowed('researcher', t)).toBe(false)
      }
      for (const t of [
        'search',
        'read_note',
        'list_dir',
        'list_templates',
        'write_note',
        'append_note',
        'create_note',
        'create_from_template',
        'delegate_subagent'
      ]) {
        expect(isToolAllowed('general', t)).toBe(true)
        expect(isToolAllowed('writer', t)).toBe(true)
      }
    })

    it('curator may create/append but never overwrite; planner may create + template', () => {
      expect(isToolAllowed('curator', 'create_note')).toBe(true)
      expect(isToolAllowed('curator', 'append_note')).toBe(true)
      expect(isToolAllowed('curator', 'write_note')).toBe(false)
      expect(isToolAllowed('planner', 'create_from_template')).toBe(true)
      expect(isToolAllowed('planner', 'create_note')).toBe(true)
      expect(isToolAllowed('planner', 'write_note')).toBe(false)
      expect(isToolAllowed('planner', 'append_note')).toBe(false)
    })

    it('buildToolSchemas(role) advertises only allowed tools', () => {
      const research = buildToolSchemas('researcher').map((s) => s.function.name)
      expect(research).toEqual([
        'search',
        'read_note',
        'list_dir',
        'list_templates',
        'delegate_subagent'
      ])
      const general = buildToolSchemas('general').map((s) => s.function.name)
      expect(general).toHaveLength(9)
      expect(general).toContain('create_from_template')
      expect(general).toContain('delegate_subagent')
      // create_plan is plan-mode-only — never in the general runtime set
      expect(general).not.toContain('create_plan')
      // Researcher never sees write schemas
      expect(buildToolSchemas('researcher').some((s) => s.function.name === 'write_note')).toBe(
        false
      )
    })

    it('buildToolsSystemPrompt(role) lists only allowed tools in the fence protocol', () => {
      const rp = buildToolsSystemPrompt('researcher')
      expect(rp).toContain('wg-action')
      expect(rp).toContain('read_note — args')
      expect(rp).not.toContain('write_note — args')
      expect(rp).not.toContain('create_from_template')
      expect(buildToolsSystemPrompt('general')).toContain('write_note — args')
    })

    it('ROLE_TOOL_PERMISSIONS covers every AgentRole', () => {
      for (const r of ['general', 'writer', 'researcher', 'curator', 'planner']) {
        expect(ROLE_TOOL_PERMISSIONS[r as keyof typeof ROLE_TOOL_PERMISSIONS]).toBeDefined()
      }
    })

    it('P2 registry: tools prompt renders the {{tools}} placeholder (no literal token leaks)', () => {
      const p = buildToolsSystemPrompt('general')
      expect(p).not.toContain('{{tools}}')
      expect(p).toContain('1. search — args')
      // general fence ends at delegate_subagent (9) — create_plan only in plan mode
      expect(p).toContain('9. delegate_subagent — args')
      expect(p).not.toContain('create_plan — args')
      // Researcher role-filtered list is numbered fresh (1..5): four reads +
      // delegate_subagent — never the general 1..10.
      const rp = buildToolsSystemPrompt('researcher')
      expect(rp).toContain('1. search — args')
      expect(rp).toContain('4. list_templates — args')
      expect(rp).toContain('5. delegate_subagent — args')
      expect(rp).not.toContain('6.')
    })
  })

  describe('native function calling schemas (P-A1)', () => {
    it('buildToolSchemas exposes all 9 runtime tools as OpenAI-compatible functions', () => {
      const schemas = buildToolSchemas()
      expect(schemas).toHaveLength(9)
      const names = schemas.map((s) => s.function.name)
      expect(names).toEqual([
        'search',
        'read_note',
        'list_dir',
        'write_note',
        'append_note',
        'create_note',
        'list_templates',
        'create_from_template',
        'delegate_subagent'
      ])
      for (const s of schemas) {
        expect(s.type).toBe('function')
        expect(s.function.description.length).toBeGreaterThan(10)
        expect(s.function.parameters.type).toBe('object')
      }
      // create_plan exists as a schema but only surfaces under plan mode
      const plan = buildToolSchemas('general', [], { planMode: true }).map((s) => s.function.name)
      expect(plan).toContain('create_plan')
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

    it('P2 promoteToKnowledge: creates a Knowledge/ proposal with backlink sources', () => {
      writeVaultNote('Knowledge/Basis.md', '# Basis\n\nFakta.')
      writeVaultNote('Daily/2026-08-07.md', '# Harian')
      const res = promoteToKnowledge(
        '# Ringkasan\n\nIni hasil riset.',
        [
          { title: 'Basis', path: path.join(vault, 'Knowledge', 'Basis.md') },
          { title: 'Harian', path: path.join(vault, 'Daily', '2026-08-07.md') }
        ],
        'Riset Topik X'
      )
      expect(res.ok).toBe(true)
      const p = res.proposal!
      expect(p.mode).toBe('create')
      expect(p.relativePath).toContain('Knowledge/Riset Topik X.md')
      expect(p.content).toContain('type: knowledge')
      expect(p.content).toContain('# Ringkasan')
      // Backlinks to the cited notes (vault-relative wikilinks)
      expect(p.content).toContain('[[Knowledge/Basis|Basis]]')
      expect(p.content).toContain('[[Daily/2026-08-07|Harian]]')
      // Proposal lands in the dock, applies to disk on confirm
      expect(listPendingProposals().some((x) => x.id === p.id)).toBe(true)
      const applied = applyProposal(p.id)
      expect(applied.ok).toBe(true)
      expect(fs.existsSync(path.join(vault, 'Knowledge', 'Riset Topik X.md'))).toBe(true)
    })

    it('P2 promoteToKnowledge: empty answer is rejected; unique filename on clash', () => {
      expect(promoteToKnowledge('', [], 'X').ok).toBe(false)
      writeVaultNote('Knowledge/Clash.md', '# Lama')
      const a = promoteToKnowledge('Isi baru', [], 'Clash')
      expect(a.ok).toBe(true)
      expect(a.proposal!.relativePath).toBe('Knowledge/Clash-2.md')
    })

    it('P2 promoteToKnowledge: title defaults to the first content line', () => {
      const res = promoteToKnowledge('## Ringkasan Eksekutif\n\nBla bla.', [])
      expect(res.ok).toBe(true)
      expect(res.proposal!.relativePath).toContain('Ringkasan Eksekutif')
    })

    it('P2 promoteToKnowledge: sibling-prefix citation path falls back to path.relative', () => {
      // A sibling of the vault (e.g. C:/vault-evil when root is C:/vault) must
      // NOT be treated as inside it — a naive startsWith would slice a
      // corrupted `-evil/Note` backlink. Expected: the ../-style relative path.
      const sibling = `${vault}-evil/Note.md`
      const res = promoteToKnowledge('# Ringkasan\n\nTeks.', [{ title: 'Evil', path: sibling }])
      expect(res.ok).toBe(true)
      expect(res.proposal!.content).not.toContain('[[-evil/Note|Evil]]')
      expect(res.proposal!.content).toContain(
        `[[${path.relative(vault, sibling).replace(/\\/g, '/').replace(/\.md$/i, '')}|Evil]]`
      )
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

    it('P1 guard: researcher cannot execute write tools even when called directly', async () => {
      const res = await executeTool(
        { tool: 'create_note', args: { path: 'Knowledge/Denied.md', content: '# X' } },
        'researcher'
      )
      expect(res.ok).toBe(false)
      expect(res.error).toContain('tidak diizinkan')
      expect(res.error).toContain('researcher')
      // Nothing was created — the guard runs BEFORE any filesystem access
      expect(fs.existsSync(path.join(vault, 'Knowledge', 'Denied.md'))).toBe(false)
      // Read tools still work under the same role
      const read = await executeTool({ tool: 'search', args: { query: 'x' } }, 'researcher')
      expect(read.ok).toBe(true)
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

  describe('R1-3 plan mode + sub-agent delegation', () => {
    it('plan mode toolset = reads + create_plan only (no writes, no delegation)', () => {
      const planSchemas = buildToolSchemas('general', [], { planMode: true }).map(
        (s) => s.function.name
      )
      expect(planSchemas).toEqual([
        'search',
        'read_note',
        'list_dir',
        'list_templates',
        'create_plan'
      ])
      // The gate agrees with the advertisement
      expect(isToolAllowed('general', 'write_note', { planMode: true })).toBe(false)
      expect(isToolAllowed('general', 'create_note', { planMode: true })).toBe(false)
      expect(isToolAllowed('general', 'delegate_subagent', { planMode: true })).toBe(false)
      expect(isToolAllowed('general', 'create_plan', { planMode: true })).toBe(true)
      // Fence prompt matches: create_plan listed, write_note absent
      const fence = buildToolsSystemPrompt('general', [], { planMode: true })
      expect(fence).toContain('create_plan — args')
      expect(fence).not.toContain('write_note — args')
      expect(fence).not.toContain('delegate_subagent')
    })

    it('sub-agent mode hides delegate_subagent so delegation cannot recurse', () => {
      const names = buildToolSchemas('general', [], { excludeDelegate: true }).map(
        (s) => s.function.name
      )
      expect(names).not.toContain('delegate_subagent')
      expect(names).toContain('create_note') // other tools intact
      expect(isToolAllowed('general', 'delegate_subagent', { excludeDelegate: true })).toBe(false)
    })

    it('create_plan stages a Planning/ proposal from structured steps', async () => {
      const res = await executeTool(
        {
          tool: 'create_plan',
          args: {
            title: 'Rombak API',
            goal: 'Cukup key + baseUrl untuk mendeteksi semua model',
            steps: ['Baca provider', 'Tulis ModelDiscovery', 'Wire IPC + UI'],
            notes: 'Tidak menyentuh produksi'
          }
        },
        'general',
        { planMode: true }
      )
      expect(res.ok).toBe(true)
      expect(res.proposalId).toBeTruthy()
      const p = listPendingProposals().find((x) => x.id === res.proposalId)!
      expect(p.mode).toBe('create')
      expect(p.relativePath).toContain('Planning/Rombak API.md')
      expect(p.content).toContain('## Tujuan')
      expect(p.content).toContain('Cukup key + baseUrl')
      expect(p.content).toContain('## Langkah')
      expect(p.content).toContain('1. Baca provider')
      expect(p.content).toContain('3. Wire IPC + UI')
      expect(p.content).toContain('## Catatan')
      expect(p.content).toContain('Tidak menyentuh produksi')
      // Applies like any proposal
      expect(applyProposal(p.id).ok).toBe(true)
      expect(fs.existsSync(path.join(vault, 'Planning', 'Rombak API.md'))).toBe(true)
    })

    it('create_plan rejects missing goal / empty steps', async () => {
      const noGoal = await executeTool(
        { tool: 'create_plan', args: { title: 'X', steps: ['a'] } },
        'general',
        { planMode: true }
      )
      expect(noGoal.ok).toBe(false)
      expect(noGoal.error).toContain('goal')
      const noSteps = await executeTool(
        { tool: 'create_plan', args: { title: 'X', goal: 'y', steps: [] } },
        'general',
        { planMode: true }
      )
      expect(noSteps.ok).toBe(false)
      expect(noSteps.error).toContain('steps')
    })

    it('plan mode: implementation writes are denied even for the general role', async () => {
      const res = await executeTool(
        { tool: 'write_note', args: { path: 'Knowledge/X.md', content: 'x' } },
        'general',
        { planMode: true }
      )
      expect(res.ok).toBe(false)
      expect(res.error).toContain('plan mode')
      expect(fs.existsSync(path.join(vault, 'Knowledge', 'X.md'))).toBe(false)
    })

    it('create_plan is NOT allowed outside plan mode (gate + advertisement agree)', async () => {
      expect(isToolAllowed('general', 'create_plan')).toBe(false)
      const res = await executeTool({
        tool: 'create_plan',
        args: { title: 'X', goal: 'y', steps: ['a'] }
      })
      expect(res.ok).toBe(false)
      expect(res.error).toContain('tidak diizinkan')
    })

    it('delegate_subagent reaching the static executor fails loudly (middleware intercept)', async () => {
      const res = await executeTool({
        tool: 'delegate_subagent',
        args: { role: 'researcher', task: 'x' }
      })
      expect(res.ok).toBe(false)
      expect(res.error).toContain('middleware')
    })
  })
})
