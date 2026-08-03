import { registerWorkspaceHandlers } from './handlers/workspace'
import { registerFileHandlers } from './handlers/files'
import { registerGraphHandlers } from './handlers/graph'
import { registerSearchHandlers } from './handlers/search'
import { registerAIHandlers } from './handlers/ai'
import { registerChatHandlers } from './handlers/chat'
import { registerTemplateHandlers } from './handlers/templates'
import { registerDomainHandlers } from './handlers/domain'
import { registerAutomationHandlers } from './handlers/automation'
import { registerPluginsHandlers } from './handlers/plugins'
import { registerSettingsHandlers } from './handlers/settings'
import { loadSettingsIntoProviders } from './shared'

/**
 * IPC registrar — delegates every channel group to a per-domain module.
 * Domain modules live in ./handlers/* and shared helpers in ./shared.
 */
export function registerIPCHandlers(): void {
  loadSettingsIntoProviders()

  registerWorkspaceHandlers()
  registerFileHandlers()
  registerGraphHandlers()
  registerSearchHandlers()
  registerAIHandlers()
  registerChatHandlers()
  registerTemplateHandlers()
  registerDomainHandlers()
  registerAutomationHandlers()
  registerPluginsHandlers()
  registerSettingsHandlers()
}
