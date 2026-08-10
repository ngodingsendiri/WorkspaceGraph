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
}

export const DEFAULT_PERMISSIONS: AppPermissions = {
  aiAccess: true,
  aiTools: true,
  // WC-4 decision (2026-08-10): plugins (code execution) and automation (file
  // actions) are OPT-IN — a fresh vault / untrusted folder must never auto-load
  // either. Users enable them explicitly in Settings → Security.
  automation: false,
  plugins: false
}

export function readPermissions(settings: Record<string, unknown>): AppPermissions {
  const p = (settings.permissions || {}) as Partial<AppPermissions>
  return {
    aiAccess: p.aiAccess !== false,
    aiTools: p.aiTools !== false,
    // Explicit opt-in: absent/undefined → OFF (default-off posture).
    automation: p.automation === true,
    plugins: p.plugins === true
  }
}
