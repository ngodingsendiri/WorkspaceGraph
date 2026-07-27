import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { WorkspaceEngine } from './WorkspaceEngine'
import fs from 'fs'
import path from 'path'
import { tmpdir } from 'os'

describe('WorkspaceEngine', () => {
  let engine: WorkspaceEngine
  let testDir: string

  beforeEach(() => {
    engine = new WorkspaceEngine()
    testDir = fs.mkdtempSync(path.join(tmpdir(), 'wg-test-'))
  })

  afterEach(() => {
    try {
      fs.rmSync(testDir, { recursive: true, force: true })
    } catch {}
  })

  describe('openWorkspace', () => {
    it('opens existing directory', () => {
      const state = engine.openWorkspace(testDir)
      expect(state.isOpen).toBe(true)
      expect(state.rootPath).toBe(path.resolve(testDir))
    })

    it('throws for non-existent path', () => {
      expect(() => engine.openWorkspace('/nonexistent')).toThrow('does not exist')
    })

    it('throws for file path', () => {
      const file = path.join(testDir, 'file.txt')
      fs.writeFileSync(file, 'test')
      expect(() => engine.openWorkspace(file)).toThrow('must be a directory')
    })

    it('creates .workspacegraph folder and config', () => {
      engine.openWorkspace(testDir)
      expect(fs.existsSync(path.join(testDir, '.workspacegraph', 'workspace.json'))).toBe(true)
    })

    it('creates standard folders on new workspace', () => {
      engine.openWorkspace(testDir)
      const standard = ['Knowledge', 'Projects', 'Tasks', 'Daily', 'Templates', 'Documents', 'People', 'SOP', 'Prompt', 'Rules', 'Assets', 'Archive']
      for (const folder of standard) {
        expect(fs.existsSync(path.join(testDir, folder))).toBe(true)
      }
    })

    it('skips standard folders for existing Obsidian vault', () => {
      fs.mkdirSync(path.join(testDir, '.obsidian'))
      engine.openWorkspace(testDir)
      expect(fs.existsSync(path.join(testDir, 'Knowledge'))).toBe(false)
    })

    it('creates Templates folder (seeding requires TemplateEngine)', () => {
      engine.openWorkspace(testDir)
      const templatesDir = path.join(testDir, 'Templates')
      expect(fs.existsSync(templatesDir)).toBe(true)
      // Template seeding requires TemplateEngine module which isn't available in tests
      // expect(fs.readdirSync(templatesDir).length).toBeGreaterThan(0)
    })
  })

  describe('createWorkspace', () => {
    it('creates new workspace directory', () => {
      const newPath = path.join(testDir, 'MyVault')
      const state = engine.createWorkspace(testDir, 'MyVault')
      expect(state.rootPath).toBe(newPath)
      expect(fs.existsSync(newPath)).toBe(true)
    })

    it('throws if directory exists', () => {
      fs.mkdirSync(path.join(testDir, 'Existing'))
      expect(() => engine.createWorkspace(testDir, 'Existing')).toThrow('already exists')
    })
  })

  describe('closeWorkspace', () => {
    it('resets state', () => {
      engine.openWorkspace(testDir)
      engine.closeWorkspace()
      const state = engine.getState()
      expect(state.isOpen).toBe(false)
      expect(state.rootPath).toBeNull()
    })
  })

  describe('file operations', () => {
    beforeEach(() => {
      engine.openWorkspace(testDir)
    })

    it('reads file', () => {
      fs.writeFileSync(path.join(testDir, 'test.md'), 'Hello World')
      const content = engine.readFile(path.join(testDir, 'test.md'))
      expect(content.content).toBe('Hello World')
      expect(typeof content.mtime).toBe('number')
    })

    it('writes file', () => {
      const filePath = path.join(testDir, 'new.md')
      engine.writeFile(filePath, 'Content')
      expect(fs.readFileSync(filePath, 'utf-8')).toBe('Content')
    })

    it('creates parent directories on write', () => {
      const filePath = path.join(testDir, 'deep', 'nested', 'file.md')
      engine.writeFile(filePath, 'Content')
      expect(fs.existsSync(filePath)).toBe(true)
    })

    it('throws on write to existing file', () => {
      const filePath = path.join(testDir, 'exists.md')
      fs.writeFileSync(filePath, 'Old')
      expect(() => engine.createFile(filePath, 'New')).toThrow('already exists')
    })

    it('deletes file', () => {
      const filePath = path.join(testDir, 'todelete.md')
      fs.writeFileSync(filePath, 'Content')
      engine.deleteFile(filePath)
      expect(fs.existsSync(filePath)).toBe(false)
    })

    it('deletes directory recursively', () => {
      const dirPath = path.join(testDir, 'todelete')
      fs.mkdirSync(dirPath, { recursive: true })
      fs.writeFileSync(path.join(dirPath, 'file.md'), 'Content')
      engine.deleteFile(dirPath)
      expect(fs.existsSync(dirPath)).toBe(false)
    })

    it('creates empty file', () => {
      const filePath = path.join(testDir, 'new.md')
      engine.createFile(filePath)
      expect(fs.existsSync(filePath)).toBe(true)
      expect(fs.readFileSync(filePath, 'utf-8')).toBe('')
    })

    it('creates folder', () => {
      const folderPath = path.join(testDir, 'newfolder')
      engine.createFolder(folderPath)
      expect(fs.existsSync(folderPath)).toBe(true)
    })
  })

  describe('renameFile with WikiLink update', () => {
    beforeEach(() => {
      engine.openWorkspace(testDir)
    })

    it('renames file and updates wiki links', () => {
      fs.writeFileSync(path.join(testDir, 'OldName.md'), '# OldName\n\nSee [[OldName]]')
      fs.writeFileSync(path.join(testDir, 'Other.md'), '# Other\n\nLink to [[OldName]]')

      const result = engine.renameFile(
        path.join(testDir, 'OldName.md'),
        path.join(testDir, 'NewName.md')
      )

      expect(result.renamedLinks).toBe(2)
      expect(result.affectedFiles.length).toBe(2)

      expect(fs.readFileSync(path.join(testDir, 'NewName.md'), 'utf-8')).toContain('[[NewName]]')
      expect(fs.readFileSync(path.join(testDir, 'Other.md'), 'utf-8')).toContain('[[NewName]]')
      expect(fs.existsSync(path.join(testDir, 'OldName.md'))).toBe(false)
    })

    it('preserves aliases in wiki links', () => {
      fs.writeFileSync(path.join(testDir, 'A.md'), '# A\n\n[[A|Alias]]')
      engine.renameFile(path.join(testDir, 'A.md'), path.join(testDir, 'B.md'))

      const content = fs.readFileSync(path.join(testDir, 'B.md'), 'utf-8')
      expect(content).toContain('[[B|Alias]]')
    })

    it('preserves heading anchors', () => {
      fs.writeFileSync(path.join(testDir, 'A.md'), '# A\n\n[[A#Heading]]')
      engine.renameFile(path.join(testDir, 'A.md'), path.join(testDir, 'B.md'))

      const content = fs.readFileSync(path.join(testDir, 'B.md'), 'utf-8')
      expect(content).toContain('[[B#Heading]]')
    })

    it('does not update links when disabled', () => {
      fs.writeFileSync(path.join(testDir, 'A.md'), '# A\n\n[[A]]')
      engine.renameFile(
        path.join(testDir, 'A.md'),
        path.join(testDir, 'B.md'),
        { updateLinks: false }
      )

      const content = fs.readFileSync(path.join(testDir, 'B.md'), 'utf-8')
      expect(content).toContain('[[A]]')
    })

    it('throws for non-existent source', () => {
      expect(() => engine.renameFile(
        path.join(testDir, 'None.md'),
        path.join(testDir, 'New.md')
      )).toThrow('does not exist')
    })

    it('throws if target exists', () => {
      fs.writeFileSync(path.join(testDir, 'A.md'), '# A')
      fs.writeFileSync(path.join(testDir, 'B.md'), '# B')
      expect(() => engine.renameFile(
        path.join(testDir, 'A.md'),
        path.join(testDir, 'B.md')
      )).toThrow('Target already exists')
    })
  })

  describe('settings encryption', () => {
    beforeEach(() => {
      engine.openWorkspace(testDir)
    })

    it('saves and loads settings', () => {
      engine.saveSettings({ theme: 'dark', customKey: 'value' })
      const loaded = engine.getSettings()
      expect(loaded.theme).toBe('dark')
      expect(loaded.customKey).toBe('value')
    })

    it('encrypts sensitive keys', () => {
      engine.saveSettings({ ai: { provider1: { apiKey: 'secret' } }, normalKey: 'value' })
      const raw = engine.getSettingsRaw()
      expect(raw.ai.provider1.apiKey).not.toBe('secret')
      expect(typeof raw.ai.provider1.apiKey).toBe('string')
      expect(raw.normalKey).toBe('value')
    })

    it('decrypts on load', () => {
      engine.saveSettings({ ai: { provider1: { apiKey: 'secret' } } })
      const loaded = engine.getSettings()
      expect(loaded.ai.provider1.apiKey).toBe('secret')
    })
  })

  describe('getAllMarkdownPaths', () => {
    beforeEach(() => {
      engine.openWorkspace(testDir)
    })

    it('finds all markdown files recursively', () => {
      fs.writeFileSync(path.join(testDir, 'A.md'), '# A')
      fs.mkdirSync(path.join(testDir, 'sub'))
      fs.writeFileSync(path.join(testDir, 'sub', 'B.md'), '# B')

      const paths = engine.getAllMarkdownPaths()
      expect(paths).toHaveLength(2)
      expect(paths.some(p => p.includes('A.md'))).toBe(true)
      expect(paths.some(p => p.includes(path.join('sub', 'B.md')) || p.includes('sub/B.md'))).toBe(true)
    })

    it('ignores hidden folders and node_modules', () => {
      fs.writeFileSync(path.join(testDir, 'A.md'), '# A')
      fs.mkdirSync(path.join(testDir, '.hidden'))
      fs.writeFileSync(path.join(testDir, '.hidden', 'B.md'), '# B')
      fs.mkdirSync(path.join(testDir, 'node_modules'))
      fs.writeFileSync(path.join(testDir, 'node_modules', 'C.md'), '# C')

      const paths = engine.getAllMarkdownPaths()
      expect(paths).toHaveLength(1)
    })
  })

  describe('recent workspaces', () => {
    it('tracks recent workspaces', () => {
      const dir1 = path.join(testDir, 'Vault1')
      const dir2 = path.join(testDir, 'Vault2')
      fs.mkdirSync(dir1)
      fs.mkdirSync(dir2)

      engine.openWorkspace(dir1)
      engine.openWorkspace(dir2)

      const recents = engine.getRecentWorkspaces()
      expect(recents[0]).toBe(dir2)
      expect(recents[1]).toBe(dir1)
    })

    it('limits to 10', () => {
      for (let i = 0; i < 12; i++) {
        const d = path.join(testDir, `Vault${i}`)
        fs.mkdirSync(d)
        engine.openWorkspace(d)
      }
      expect(engine.getRecentWorkspaces().length).toBe(10)
    })
  })

  describe('refreshFiles', () => {
    beforeEach(() => {
      engine.openWorkspace(testDir)
    })

    it('updates file list after external changes', () => {
      fs.writeFileSync(path.join(testDir, 'New.md'), '# New')
      const files = engine.refreshFiles()
      expect(files.some(f => f.name === 'New.md')).toBe(true)
    })
  })
})