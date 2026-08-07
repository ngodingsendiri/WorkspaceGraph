import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import { tmpdir } from 'os'
import {
  PROMPT_DEFAULTS,
  PROMPT_IDS,
  loadPromptEntries,
  renderPrompt,
  promptsDir,
  promptsFilePath
} from './PromptRegistry'
import { KERNEL_SYSTEM_PROMPT, BOOTSTRAP_USER_PROMPT } from './WorkspaceMemory'
import { workspaceEngine } from '../engine/WorkspaceEngine'

describe('PromptRegistry (doc 19 — prompt as versioned asset)', () => {
  let vault: string

  beforeEach(() => {
    vault = fs.mkdtempSync(path.join(tmpdir(), 'wg-prompts-'))
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

  it('ships versioned defaults for every prompt id', () => {
    expect(PROMPT_IDS).toEqual(['kernel', 'bootstrap', 'toolsHead', 'toolsTail'])
    for (const id of PROMPT_IDS) {
      const e = PROMPT_DEFAULTS[id]
      expect(e.version).toBeGreaterThanOrEqual(1)
      expect(e.template.length).toBeGreaterThan(50)
      expect(['system', 'user']).toContain(e.category)
    }
    expect(PROMPT_DEFAULTS.kernel.template).toContain('WorkspaceGraph AI Kernel')
    expect(PROMPT_DEFAULTS.bootstrap.template).toContain('PELAJARI WORKSPACE')
    expect(PROMPT_DEFAULTS.toolsHead.template).toContain('{{tools}}')
    expect(PROMPT_DEFAULTS.toolsTail.template).toContain('[[wikilinks]]')
  })

  it('materializes prompts.json on first access under .workspacegraph/prompts/', () => {
    loadPromptEntries(vault)
    const file = promptsFilePath(vault)
    expect(fs.existsSync(file)).toBe(true)
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<
      string,
      { version: number; template: string }
    >
    expect(onDisk.kernel.version).toBe(PROMPT_DEFAULTS.kernel.version)
    expect(onDisk.kernel.template).toContain('WorkspaceGraph AI Kernel')
    expect(onDisk.toolsHead.template).toContain('{{tools}}')
  })

  it('renders {{tools}} into the head (no literal token remains)', () => {
    const out = renderPrompt(
      'toolsHead',
      { tools: '1. search — search\n2. read_note — read' },
      vault
    )
    expect(out).toContain('1. search — search')
    expect(out).toContain('2. read_note — read')
    expect(out).not.toContain('{{tools}}')
    expect(out).toContain('wg-action')
  })

  it('fills {{date}}/{{workspace}} builtins and caller vars; unknown tokens stay intact', () => {
    loadPromptEntries(vault) // materialize the file first
    // Fork the kernel with placeholder-rich text at a higher version
    const file = promptsFilePath(vault)
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, unknown>
    onDisk.kernel = {
      version: 99,
      category: 'system',
      template: 'K: {{date}} | {{workspace}} | {{custom}} | {{missing}}'
    }
    fs.writeFileSync(file, JSON.stringify(onDisk, null, 2))

    const out = renderPrompt('kernel', { custom: 'X' }, vault)
    expect(out).toContain(new Date().toISOString().split('T')[0])
    expect(out).toContain(path.basename(vault))
    expect(out).toContain('| X |')
    expect(out).toContain('{{missing}}') // unknown placeholder preserved, not stripped
  })

  it('uses a file override only when its version is >= the shipped default', () => {
    loadPromptEntries(vault) // materialize the file first
    const file = promptsFilePath(vault)
    const writeKernel = (version: number, template: string): void => {
      const onDisk = JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, unknown>
      onDisk.kernel = { version, category: 'system', template }
      fs.writeFileSync(file, JSON.stringify(onDisk, null, 2))
    }
    // version 99 (> default 1) → override wins
    writeKernel(99, 'CUSTOM KERNEL')
    expect(renderPrompt('kernel', {}, vault)).toBe('CUSTOM KERNEL')
    // version 1 (== default) → still wins (user is on the current line)
    writeKernel(1, 'SAME VERSION EDIT')
    expect(renderPrompt('kernel', {}, vault)).toBe('SAME VERSION EDIT')
    // version 0 (< default) → stale fork, shipped default wins
    writeKernel(0, 'STALE')
    expect(renderPrompt('kernel', {}, vault)).toContain('WorkspaceGraph AI Kernel')
  })

  it('corrupt / unreadable file falls back to defaults without throwing', () => {
    fs.mkdirSync(promptsDir(vault), { recursive: true })
    fs.writeFileSync(promptsFilePath(vault), '{not json')
    const entries = loadPromptEntries(vault)
    expect(entries.kernel.template).toContain('WorkspaceGraph AI Kernel')
    expect(renderPrompt('kernel', {}, vault)).toContain('WorkspaceGraph AI Kernel')
  })

  it('renders defaults when no vault is open (renderPrompt never needs a root)', () => {
    workspaceEngine.closeWorkspace()
    const out = renderPrompt('kernel')
    expect(out).toContain('WorkspaceGraph AI Kernel')
    expect(renderPrompt('bootstrap')).toContain('PELAJARI WORKSPACE')
  })

  it('kernels derived by WorkspaceMemory carry the shipped default text', () => {
    expect(KERNEL_SYSTEM_PROMPT).toContain('workspace kernel assistant')
    expect(BOOTSTRAP_USER_PROMPT).toContain('PELAJARI WORKSPACE')
  })
})
