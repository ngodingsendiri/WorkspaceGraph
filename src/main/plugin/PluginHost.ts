/**
 * Minimal declarative Plugin Host (blueprint 28 — core first, secure by default)
 * Plugins live in <vault>/.workspacegraph/plugins/<id>/manifest.json
 * No arbitrary code execution — commands are declarative only.
 */
import fs from 'fs'
import path from 'path'

export interface PluginCommand {
  id: string
  title: string
  /** Prefill search or open path */
  action: 'search_prefill' | 'open_path' | 'create_from_template' | 'run_automation'
  args?: Record<string, string>
}

export interface PluginManifest {
  id: string
  name: string
  version: string
  author?: string
  description?: string
  permissions?: string[]
  commands?: PluginCommand[]
  enabled?: boolean
}

export interface LoadedPlugin {
  manifest: PluginManifest
  dir: string
  enabled: boolean
}

export class PluginHost {
  private plugins: LoadedPlugin[] = []
  private allowed = true

  setAllowed(on: boolean): void {
    this.allowed = on
  }

  load(workspaceRoot: string): void {
    this.plugins = []
    if (!this.allowed) return

    const dir = path.join(workspaceRoot, '.workspacegraph', 'plugins')
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
      this.writeExamplePlugin(dir)
      return
    }

    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true })
      for (const e of entries) {
        if (!e.isDirectory()) continue
        const manifestPath = path.join(dir, e.name, 'manifest.json')
        if (!fs.existsSync(manifestPath)) continue
        try {
          const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as PluginManifest
          if (!manifest.id || !manifest.name) continue
          // Security: only known permission strings; strip unknown
          const safePerms = (manifest.permissions || []).filter((p) =>
            ['read', 'search', 'template', 'automation'].includes(p)
          )
          manifest.permissions = safePerms
          this.plugins.push({
            manifest,
            dir: path.join(dir, e.name),
            enabled: manifest.enabled !== false
          })
        } catch {
          /* skip bad plugin */
        }
      }
    } catch {
      /* ignore */
    }
  }

  unload(): void {
    this.plugins = []
  }

  list(): LoadedPlugin[] {
    return this.plugins
  }

  listCommands(): (PluginCommand & { pluginId: string; pluginName: string })[] {
    const out: (PluginCommand & { pluginId: string; pluginName: string })[] = []
    for (const p of this.plugins) {
      if (!p.enabled) continue
      for (const c of p.manifest.commands || []) {
        out.push({ ...c, pluginId: p.manifest.id, pluginName: p.manifest.name })
      }
    }
    return out
  }

  private writeExamplePlugin(pluginsDir: string): void {
    const example = path.join(pluginsDir, 'example-quick-search')
    fs.mkdirSync(example, { recursive: true })
    const manifest: PluginManifest = {
      id: 'example-quick-search',
      name: 'Example Quick Search',
      version: '0.1.0',
      author: 'WorkspaceGraph',
      description: 'Declarative sample plugin — search shortcuts',
      permissions: ['search'],
      enabled: true,
      commands: [
        {
          id: 'search-orphans',
          title: 'Find orphan notes',
          action: 'search_prefill',
          args: { query: 'orphan:true' }
        },
        {
          id: 'new-project-tpl',
          title: 'New project from template',
          action: 'create_from_template',
          args: { templateId: 'builtin-project', title: 'New Project' }
        }
      ]
    }
    fs.writeFileSync(path.join(example, 'manifest.json'), JSON.stringify(manifest, null, 2))
    fs.writeFileSync(
      path.join(example, 'README.md'),
      '# Example plugin\n\nDeclarative only. Edit manifest.json commands. No JS execution.\n'
    )
  }
}

export const pluginHost = new PluginHost()
