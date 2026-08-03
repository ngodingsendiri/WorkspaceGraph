import { PluginManifest } from './sdk/types'
import { join } from 'path'
import { readFile } from 'fs/promises'

export class PluginHost {
  private plugins = new Map<string, any>()


  async loadPlugin(manifestPath: string): Promise<any> {
    const manifestContent = await readFile(manifestPath, 'utf-8')
    const manifest: PluginManifest = JSON.parse(manifestContent)

    this.validateManifest(manifest)

    const pluginModule = await import(join(join(manifestPath, '..'), manifest.main))

    const pluginObj: any = {
      manifest,
      exports: await import(join(manifestPath, '..', manifest.main)),
      api: {} as any,
      disable: () => this.unload(manifest.id),
      dir: join(manifestPath, '..')
    }

    const api = this.createApi()
    pluginObj.api = api

    if (typeof pluginModule.init === 'function') {
      await pluginModule.init(pluginObj.api)
    }

    this.plugins.set(manifest.id, {
      manifest,
      exports: pluginModule,
      api: api,
      disable: () => this.unload(manifest.id),
      dir: join(manifestPath, '..')
    })
    return {
      manifest,
      exports: pluginModule,
      api: api,
      disable: () => this.unload(manifest.id),
      dir: join(manifestPath, '..')
    }
  }

  private validateManifest(manifest: any): void {
    if (!manifest.id || !/^[a-z][a-z0-9-]*$/.test(manifest.id)) {
      throw new Error('Invalid plugin ID (must be lowercase alphanumeric with hyphens)')
    }
    if (!manifest.name) throw new Error('Plugin name is required')
    if (!manifest.version) throw new Error('Plugin version is required')
    if (!manifest.main) throw new Error('Plugin main entry point is required')

    const validPermissions = [
      'vault.read',
      'vault.write',
      'vault.delete',
      'vault.list',
      'workspace.read',
      'workspace.write',
      'editor.read',
      'editor.write',
      'graph.read',
      'graph.write',
      'search.read',
      'settings.read',
      'settings.write',
      'automation.read',
      'automation.write',
      'commands.read',
      'commands.write',
      'ui.notify',
      'ui.input',
      'ui.progress'
    ]

    for (const perm of manifest.permissions || []) {
      if (!validPermissions.includes(perm)) {
        throw new Error(`Invalid permission: ${perm}`)
      }
    }
  }

  private createApi(): any {
    const createNamespace = (methods: string[]): any => {
      const obj: any = {}
      for (const method of methods) {
        obj[method] = async (..._args: any[]) => {
          console.warn(`API not implemented`)
          return null
        }
      }
      return obj
    }

    return {
      vault: createNamespace(['read', 'write', 'delete', 'exists', 'list', 'stat', 'onChange']),
      workspace: createNamespace([
        'getActiveFile',
        'getOpenFiles',
        'openFile',
        'newFile',
        'onActiveFileChange'
      ]),
      editor: createNamespace([
        'getContent',
        'setContent',
        'getSelection',
        'replaceSelection',
        'insertAtCursor',
        'getCursor',
        'setCursor'
      ]),
      graph: createNamespace([
        'getNodes',
        'getEdges',
        'getNeighbors',
        'getBacklinks',
        'getOrphans'
      ]),
      search: createNamespace(['query', 'getRecent', 'getTags']),
      settings: createNamespace(['get', 'set', 'getAll', 'onChange']),
      automation: createNamespace(['listRules', 'runRule', 'createRule', 'deleteRule']),
      commands: createNamespace(['execute', 'list', 'register', 'unregister']),
      ui: createNamespace([
        'notify',
        'showInput',
        'showConfirm',
        'showSelect',
        'showProgress',
        'hideProgress',
        'openPanel',
        'closePanel'
      ])
    }
  }

  async unload(id: string): Promise<void> {
    const plugin = this.plugins.get(id)
    if (plugin && typeof plugin.exports.disable === 'function') {
      await plugin.exports.disable()
    }
    this.plugins.delete(id)
  }

  getPlugin(id: string): any {
    return this.plugins.get(id)
  }

  getAllPlugins(): any[] {
    return Array.from(this.plugins.values())
  }
}

export const pluginHost = new PluginHost()
