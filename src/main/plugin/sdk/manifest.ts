import { AppAPI } from './types'

export interface PluginManifest {
  id: string
  name: string
  version: string
  description: string
  author: string
  minAppVersion: string
  main: string
  permissions: PluginPermission[]
  settings?: PluginSetting[]
  isDesktopOnly?: boolean
}

export type PluginPermission =
  | 'vault:read'
  | 'vault:write'
  | 'vault:delete'
  | 'vault:list'
  | 'workspace:read'
  | 'workspace:write'
  | 'editor:read'
  | 'editor:write'
  | 'graph:read'
  | 'graph:write'
  | 'search:read'
  | 'settings:read'
  | 'settings:write'
  | 'automation:read'
  | 'automation:write'
  | 'commands:read'
  | 'commands:write'
  | 'ui:notify'
  | 'ui:input'
  | 'ui:progress'

export interface PluginSetting {
  id: string
  name: string
  description: string
  type: 'string' | 'number' | 'boolean' | 'select' | 'multiselect'
  default: unknown
  options?: { label: string; value: unknown }[]
  required?: boolean
}

export interface LoadedPlugin {
  manifest: PluginManifest
  exports: Record<string, unknown>
  api: AppAPI
  disable(): void
}