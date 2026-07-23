/**
 * Granular app permissions (Phase 5 / Security blueprint)
 */
export interface AppPermissions {
  /** AI chat / network to providers */
  aiAccess: boolean
  /** AI agent tools (read/write proposals) */
  aiTools: boolean
  /** Run automation rules */
  automation: boolean
  /** Load declarative plugins */
  plugins: boolean
  /** Allow write proposals from AI without extra UI gate is never true — always confirm */
  aiAutoWrite: boolean
}

export const DEFAULT_PERMISSIONS: AppPermissions = {
  aiAccess: true,
  aiTools: true,
  automation: true,
  plugins: true,
  aiAutoWrite: false
}

export function readPermissions(settings: Record<string, unknown>): AppPermissions {
  const p = (settings.permissions || {}) as Partial<AppPermissions>
  return {
    aiAccess: p.aiAccess !== false,
    aiTools: p.aiTools !== false,
    automation: p.automation !== false,
    plugins: p.plugins !== false,
    aiAutoWrite: p.aiAutoWrite === true
  }
}
