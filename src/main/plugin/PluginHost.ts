/**
 * Plugin Host (blueprint 28) — declarative plugins + sandboxed JS plugins.
 * Plugins live in <vault>/.workspacegraph/plugins/<id>/manifest.json
 * JS plugins declare "main": "main.js" and run in the vm sandbox (worker
 * thread) via jsRunner — no require/process/network; api.* ops are gated.
 */
import fs from 'fs'
import path from 'path'
import { runJsPluginCommand, defaultPermissionGate } from './jsRunner'

export interface PluginCommand {
  id: string
  title: string
  /** Prefill search or open path; 'js' runs a sandboxed handler */
  action: 'search_prefill' | 'open_path' | 'create_from_template' | 'run_automation' | 'js'
  args?: Record<string, string>
  /** For action 'js' — handler exported by the plugin's main.js */
  handler?: string
}

/**
 * M6b PLG-1: declarative context-menu extension point. Items are appended to
 * the file-tree context menu; clicking runs the referenced plugin command with
 * the target file/folder path in `args.filePath`.
 */
export interface PluginContextMenuItem {
  id: string
  title: string
  /** When to show: 'file' (any non-dir), 'folder', or 'any'. Default 'any'. */
  when?: 'file' | 'folder' | 'any'
  /** Command id from this plugin's `commands` to run when clicked. */
  commandId: string
}

/**
 * M6b PLG-1: declarative search-provider extension point. A JS plugin declares
 * a handler (exported from main.js) that receives `{ query, limit }` as ctx.input
 * and returns `[{ title, path, relativePath, preview }]`. Results are merged into
 * the search modal under the provider name.
 */
export interface PluginSearchProvider {
  id: string
  name: string
  /** Handler exported by main.js that performs the search. */
  handler: string
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
  /** JS plugin entry (relative to plugin dir) — sandboxed */
  main?: string
  /** M6b PLG-3: minimum SDK version this plugin requires */
  minSdkVersion?: string
  /** M6b PLG-3: other plugins this one depends on (ids) */
  dependencies?: string[]
  /** M6b PLG-1: context-menu items appended to the file tree */
  contextMenus?: PluginContextMenuItem[]
  /** M6b PLG-1: search providers merged into search results */
  searchProviders?: PluginSearchProvider[]
  /** M6b PLG-6: event types this plugin subscribes to (file_created, …) */
  events?: string[]
}

/** Current plugin SDK version — bump on breaking api.* surface changes. */
export const PLUGIN_SDK_VERSION = '1.0.0'

/** Compare two semver-ish strings: true when `have` >= `need`. */
function sdkSatisfies(have: string, need: string): boolean {
  const parse = (v: string): number[] => v.split('.').map((p) => Number.parseInt(p, 10) || 0)
  const [h1, h2, h3] = parse(have)
  const [n1, n2, n3] = parse(need)
  if (h1 !== n1) return h1 > n1
  if (h2 !== n2) return h2 > n2
  return h3 >= n3
}

export interface LoadedPlugin {
  manifest: PluginManifest
  dir: string
  enabled: boolean
  /** True when manifest.main resolves to an existing file inside the plugin dir */
  js?: boolean
  jsEntry?: string
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
          // M6b PLG-3: SDK compatibility gate — a plugin built for a NEWER SDK
          // must not load silently and fail at runtime.
          if (manifest.minSdkVersion && !sdkSatisfies(PLUGIN_SDK_VERSION, manifest.minSdkVersion)) {
            console.warn(
              `[PluginHost] ${manifest.id}: butuh SDK >= ${manifest.minSdkVersion} (host ${PLUGIN_SDK_VERSION}) — tidak dimuat`
            )
            continue
          }
          const pluginDir = path.join(dir, e.name)
          let jsEntry: string | null = null
          if (manifest.main) {
            const candidate = path.resolve(pluginDir, manifest.main)
            const inside = candidate.startsWith(path.resolve(pluginDir) + path.sep)
            if (inside) {
              jsEntry = candidate
            } else {
              console.warn(
                `[PluginHost] ${manifest.id}: main "${manifest.main}" keluar dari folder plugin — diabaikan`
              )
            }
          }
          const js = Boolean(jsEntry && fs.existsSync(jsEntry))
          this.plugins.push({
            manifest,
            dir: path.join(dir, e.name),
            enabled: manifest.enabled !== false,
            js,
            jsEntry: js && jsEntry ? jsEntry : undefined
          })
        } catch {
          /* skip bad plugin */
        }
      }
    } catch {
      /* ignore */
    }
    // M6b PLG-2: after (re)load, subscribed plugins can react to host lifecycle
    this.emitEvent('plugin_loaded')
  }

  unload(): void {
    // M6b PLG-2: notify subscribed plugins they're being unloaded (vault close)
    this.emitEvent('plugin_unloaded')
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

  /** M6b PLG-1: context-menu items from all enabled plugins. */
  listContextMenus(): (PluginContextMenuItem & { pluginId: string; pluginName: string })[] {
    const out: (PluginContextMenuItem & { pluginId: string; pluginName: string })[] = []
    for (const p of this.plugins) {
      if (!p.enabled) continue
      for (const m of p.manifest.contextMenus || []) {
        out.push({ ...m, pluginId: p.manifest.id, pluginName: p.manifest.name })
      }
    }
    return out
  }

  /** M6b PLG-1: search providers from all enabled plugins. */
  listSearchProviders(): (PluginSearchProvider & { pluginId: string; pluginName: string })[] {
    const out: (PluginSearchProvider & { pluginId: string; pluginName: string })[] = []
    for (const p of this.plugins) {
      if (!p.enabled) continue
      if (!p.js) continue
      for (const s of p.manifest.searchProviders || []) {
        out.push({ ...s, pluginId: p.manifest.id, pluginName: p.manifest.name })
      }
    }
    return out
  }

  /**
   * M6b PLG-6: fire an event at enabled JS plugins subscribed via manifest.events
   * (e.g. ["file_created", "daily_note_created"]). The plugin's `onEvent` handler
   * receives `{ type, filePath }` as ctx.input. Fire-and-forget: errors are logged,
   * never propagated (a slow plugin must not stall the vault watcher).
   */
  emitEvent(type: string, filePath?: string): void {
    for (const p of this.plugins) {
      if (!p.enabled || !p.jsEntry) continue
      if (!(p.manifest.events || []).includes(type)) continue
      const runtime = {
        pluginId: p.manifest.id,
        pluginName: p.manifest.name,
        version: p.manifest.version,
        dir: p.dir,
        entry: p.jsEntry,
        permissions: p.manifest.permissions
      }
      void runJsPluginCommand(runtime, 'onEvent', { type, filePath }).then((res) => {
        if (!res.ok) {
          console.warn(
            `[PluginHost] ${p.manifest.id} onEvent(${type}) failed: ${res.error ?? 'unknown'}`
          )
        }
      })
    }
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
    const jsExample = path.join(pluginsDir, 'example-hello-js')
    fs.mkdirSync(jsExample, { recursive: true })
    const jsManifest: PluginManifest = {
      id: 'example-hello-js',
      name: 'Example JS Plugin',
      version: '0.1.0',
      author: 'WorkspaceGraph',
      description: 'JS sandbox sample — count notes & notify',
      // M6b PLG-8: default OFF, konsisten ADR-0003 — pengguna mengaktifkan eksplisit
      enabled: false,
      main: 'main.js',
      permissions: ['read'],
      commands: [
        {
          id: 'count-notes',
          title: 'Count notes & notify',
          action: 'js',
          handler: 'countNotes'
        }
      ]
    }
    fs.writeFileSync(path.join(jsExample, 'manifest.json'), JSON.stringify(jsManifest, null, 2))
    fs.writeFileSync(
      path.join(jsExample, 'main.js'),
      `// Example JS plugin — runs in a vm sandbox inside a worker thread.
// No require/process/network. api.* calls are routed to the app; write ops prompt.
module.exports = {
  async countNotes(ctx) {
    const notes = await ctx.api.vault.list()
    const msg = 'Halo dari plugin JS! ' + notes.length + ' catatan di vault.'
    await ctx.api.ui.notify(msg)
    return { notes: notes.length }
  }
}
`
    )
    fs.writeFileSync(
      path.join(jsExample, 'README.md'),
      '# Example JS plugin\n\nRuns in the sandboxed JS runner (vm + worker thread).\n'
    )
  }

  /** Execute a command. JS commands run in the sandboxed runner. */
  async runCommand(
    pluginId: string,
    commandId: string,
    args: Record<string, unknown> = {}
  ): Promise<{ ok: boolean; result?: unknown; error?: string }> {
    const p = this.plugins.find((x) => x.manifest.id === pluginId)
    if (!p) return { ok: false, error: 'Plugin not found' }
    if (!p.enabled) return { ok: false, error: 'Plugin disabled' }
    const cmd = (p.manifest.commands || []).find((c) => c.id === commandId)
    if (!cmd) return { ok: false, error: 'Command not found' }
    if (cmd.action !== 'js') {
      return { ok: false, error: 'Bukan command JS — jalankan dari UI' }
    }
    if (!p.jsEntry) return { ok: false, error: 'Plugin tidak punya JS entry' }
    const runtime = {
      pluginId: p.manifest.id,
      pluginName: p.manifest.name,
      version: p.manifest.version,
      dir: p.dir,
      entry: p.jsEntry,
      permissions: p.manifest.permissions
    }
    return runJsPluginCommand(runtime, cmd.handler || '', args)
  }

  /**
   * M6b PLG-1: run a plugin's declared search-provider handler with
   * `input = { query, limit }`. Returns the handler result (expected:
   * `[{ title, path, relativePath, preview }]`).
   */
  async runSearchProvider(
    pluginId: string,
    providerId: string,
    query: string,
    limit = 10
  ): Promise<{ ok: boolean; result?: unknown; error?: string }> {
    const p = this.plugins.find((x) => x.manifest.id === pluginId)
    if (!p) return { ok: false, error: 'Plugin not found' }
    if (!p.enabled) return { ok: false, error: 'Plugin disabled' }
    if (!p.jsEntry) return { ok: false, error: 'Plugin tidak punya JS entry' }
    const sp = (p.manifest.searchProviders || []).find((s) => s.id === providerId)
    if (!sp) return { ok: false, error: 'Search provider not found' }
    const runtime = {
      pluginId: p.manifest.id,
      pluginName: p.manifest.name,
      version: p.manifest.version,
      dir: p.dir,
      entry: p.jsEntry,
      permissions: p.manifest.permissions
    }
    return runJsPluginCommand(runtime, sp.handler, { query, limit })
  }

  /** Forget session permission grants for a plugin (next op prompts again). */
  revokePermissions(pluginId: string): void {
    defaultPermissionGate.revoke(pluginId)
  }
}

export const pluginHost = new PluginHost()
