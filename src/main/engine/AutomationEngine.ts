/**
 * Automation System (blueprint 22) — declarative rules in vault
 * File: <vault>/.workspacegraph/automation.json
 */
import fs from 'fs'
import path from 'path'
import { workspaceEngine } from './WorkspaceEngine'
import { assertPathInVault } from '../security/PathSandbox'

export type AutomationTriggerType =
  'file_created' | 'file_updated' | 'file_deleted' | 'workspace_opened' | 'manual'

export interface AutomationRule {
  id: string
  name: string
  enabled: boolean
  trigger: {
    type: AutomationTriggerType
    /** glob-like: ends with .md or contains path fragment */
    match?: string
  }
  actions: AutomationAction[]
}

export type AutomationAction =
  | { type: 'log'; message: string }
  | { type: 'append_to_note'; path: string; content: string }
  | { type: 'set_frontmatter_tag'; path: string; tag: string }

export interface AutomationLogEntry {
  at: string
  ruleId: string
  message: string
  ok: boolean
}

export interface AutomationConfig {
  version: 1
  rules: AutomationRule[]
}

const DEFAULT_CONFIG: AutomationConfig = {
  version: 1,
  rules: [
    {
      id: 'sample-log-md',
      name: 'Log markdown changes',
      enabled: false,
      trigger: { type: 'file_updated', match: '.md' },
      actions: [{ type: 'log', message: 'MD updated: {{relativePath}}' }]
    },
    {
      id: 'daily-touch-log',
      name: 'Append file create to daily note',
      enabled: false,
      trigger: { type: 'file_created', match: '.md' },
      actions: [
        {
          type: 'append_to_note',
          path: 'Daily/{{date}}.md',
          content: '- Created [[{{title}}]] ({{relativePath}})\n'
        }
      ]
    }
  ]
}

export class AutomationEngine {
  private config: AutomationConfig = DEFAULT_CONFIG
  private logs: AutomationLogEntry[] = []
  private enabled = true
  private rootPath: string | null = null

  load(workspaceRoot: string): void {
    this.rootPath = workspaceRoot
    const file = path.join(workspaceRoot, '.workspacegraph', 'automation.json')
    try {
      if (fs.existsSync(file)) {
        this.config = JSON.parse(fs.readFileSync(file, 'utf-8')) as AutomationConfig
        if (!this.config.rules) this.config.rules = []
      } else {
        this.config = JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as AutomationConfig
        this.save()
      }
    } catch {
      this.config = JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as AutomationConfig
    }
  }

  unload(): void {
    this.rootPath = null
  }

  setEnabled(on: boolean): void {
    this.enabled = on
  }

  isEnabled(): boolean {
    return this.enabled
  }

  getConfig(): AutomationConfig {
    return this.config
  }

  getLogs(limit = 50): AutomationLogEntry[] {
    return this.logs.slice(-limit).reverse()
  }

  save(config?: AutomationConfig): void {
    if (config) this.config = config
    if (!this.rootPath) return
    const dir = path.join(this.rootPath, '.workspacegraph')
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, 'automation.json'),
      JSON.stringify(this.config, null, 2),
      'utf-8'
    )
  }

  private matchPath(match: string | undefined, filePath: string): boolean {
    if (!match) return true
    const m = match.toLowerCase()
    const p = filePath.replace(/\\/g, '/').toLowerCase()
    if (m.startsWith('*.')) return p.endsWith(m.slice(1))
    return p.includes(m)
  }

  private interpolate(template: string, ctx: Record<string, string>): string {
    return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, k) => ctx[k] ?? '')
  }

  private buildCtx(filePath?: string): Record<string, string> {
    const date = new Date().toISOString().split('T')[0]
    const root = this.rootPath || ''
    const relativePath = filePath && root ? path.relative(root, filePath).replace(/\\/g, '/') : ''
    const title = filePath ? path.basename(filePath, path.extname(filePath)) : ''
    return {
      date,
      time: new Date().toTimeString().slice(0, 5),
      path: filePath || '',
      relativePath,
      title,
      workspace: root ? path.basename(root) : ''
    }
  }

  handleEvent(type: AutomationTriggerType, filePath?: string): void {
    if (!this.enabled || !this.rootPath) return

    const ctx = this.buildCtx(filePath)
    for (const rule of this.config.rules) {
      if (!rule.enabled) continue
      if (rule.trigger.type !== type) continue
      if (filePath && !this.matchPath(rule.trigger.match, filePath)) continue

      for (const action of rule.actions) {
        try {
          this.runAction(action, ctx, rule.id)
        } catch (err) {
          this.pushLog(rule.id, err instanceof Error ? err.message : String(err), false)
        }
      }
    }
  }

  private runAction(action: AutomationAction, ctx: Record<string, string>, ruleId: string): void {
    if (action.type === 'log') {
      const msg = this.interpolate(action.message, ctx)
      this.pushLog(ruleId, msg, true)
      console.log(`[Automation] ${ruleId}: ${msg}`)
      return
    }

    if (action.type === 'append_to_note') {
      const rel = this.interpolate(action.path, ctx)
      const abs = path.join(this.rootPath!, rel)
      assertPathInVault(abs, this.rootPath!)
      const content = this.interpolate(action.content, ctx)
      const dir = path.dirname(abs)
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
      if (!fs.existsSync(abs)) {
        workspaceEngine.writeFile(
          abs,
          `---\ntitle: ${path.basename(abs, '.md')}\ntype: daily\ndate: ${ctx.date}\n---\n\n# ${path.basename(abs, '.md')}\n\n`
        )
      }
      const existing = workspaceEngine.readFile(abs)
      workspaceEngine.writeFile(abs, existing.replace(/\s*$/, '') + '\n' + content)
      this.pushLog(ruleId, `append → ${rel}`, true)
      return
    }

    if (action.type === 'set_frontmatter_tag') {
      const rel = this.interpolate(action.path, ctx)
      const abs = path.join(this.rootPath!, rel)
      assertPathInVault(abs, this.rootPath!)
      if (!fs.existsSync(abs)) {
        this.pushLog(ruleId, `tag skip missing ${rel}`, false)
        return
      }
      let raw = workspaceEngine.readFile(abs)
      const tag = this.interpolate(action.tag, ctx)
      if (raw.includes(`#${tag}`) || raw.includes(`- ${tag}`)) {
        this.pushLog(ruleId, `tag already present ${tag}`, true)
        return
      }
      if (raw.startsWith('---')) {
        // Normalize CRLF to LF first so frontmatter slicing is clean on Windows
        const norm = raw.replace(/\r\n/g, '\n')
        const end = norm.indexOf('\n---', 3)
        if (end !== -1) {
          const fm = norm.slice(0, end)
          const body = norm.slice(end)
          if (fm.includes('tags:')) {
            raw =
              fm.replace(/tags:\s*\[([^\]]*)\]/, (_full, inner: string) => {
                const parts = inner
                  .split(',')
                  .map((s: string) => s.trim())
                  .filter(Boolean)
                if (!parts.includes(tag) && !parts.includes(`"${tag}"`)) parts.push(tag)
                return `tags: [${parts.join(', ')}]`
              }) + body
          } else {
            raw = fm + `\ntags: [${tag}]` + body
          }
          workspaceEngine.writeFile(abs, raw)
          this.pushLog(ruleId, `tag ${tag} → ${rel}`, true)
        }
      }
    }
  }

  private pushLog(ruleId: string, message: string, ok: boolean): void {
    this.logs.push({ at: new Date().toISOString(), ruleId, message, ok })
    if (this.logs.length > 200) this.logs = this.logs.slice(-200)
  }

  runManual(ruleId: string, filePath?: string): { ok: boolean; error?: string } {
    if (!this.rootPath) return { ok: false, error: 'No workspace open' }
    const rule = this.config.rules.find((r) => r.id === ruleId)
    if (!rule) return { ok: false, error: 'Rule not found' }
    const ctx = this.buildCtx(filePath)
    for (const action of rule.actions) {
      try {
        this.runAction(action, ctx, rule.id)
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
    return { ok: true }
  }
}

export const automationEngine = new AutomationEngine()
