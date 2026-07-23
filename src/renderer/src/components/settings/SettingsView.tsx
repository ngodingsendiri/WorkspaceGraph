import React, { useEffect, useState } from 'react'
import { applyTheme, getCachedThemePref, type ThemePreference } from '../../utils/theme'

type Section = 'ai' | 'appearance' | 'index' | 'security' | 'automation' | 'plugins' | 'about'

export const SettingsView: React.FC = () => {
  const [providers, setProviders] = useState<
    {
      id: string
      name: string
      connected: boolean
      configured?: boolean
      error?: string
      models: { id: string; name: string }[]
    }[]
  >([])
  const [apiKeys, setApiKeys] = useState<Record<string, string>>({})
  const [baseUrls, setBaseUrls] = useState<Record<string, string>>({})
  const [savedStatus, setSavedStatus] = useState('')
  const [theme, setTheme] = useState<ThemePreference>(() => getCachedThemePref())
  const [section, setSection] = useState<Section>('ai')
  const [indexStats, setIndexStats] = useState<{
    memoryCount: number
    sqlite: { count: number; path: string | null; lastRebuild: string | null; open: boolean }
  } | null>(null)
  const [rebuilding, setRebuilding] = useState(false)
  const [permissions, setPermissions] = useState({
    aiAccess: true,
    aiTools: true,
    automation: true,
    plugins: true,
    aiAutoWrite: false
  })
  const [secStatus, setSecStatus] = useState<{
    encryptionAvailable?: boolean
    secrets?: Record<string, string>
  } | null>(null)
  const [automation, setAutomation] = useState<{
    enabled: boolean
    config: {
      rules: {
        id: string
        name: string
        enabled: boolean
        trigger: { type: string; match?: string }
      }[]
    }
    logs: { at: string; ruleId: string; message: string; ok: boolean }[]
  } | null>(null)
  const [plugins, setPlugins] = useState<
    {
      id: string
      name: string
      version: string
      enabled: boolean
      description?: string
      commands: number
    }[]
  >([])
  const [pluginCmds, setPluginCmds] = useState<
    {
      id: string
      title: string
      pluginName: string
      action: string
      args?: Record<string, string>
    }[]
  >([])
  const [health, setHealth] = useState<Record<string, unknown> | null>(null)

  useEffect(() => {
    loadAll()
  }, [])

  const flash = (msg: string) => {
    setSavedStatus(msg)
    setTimeout(() => setSavedStatus(''), 3000)
  }

  const loadAll = async () => {
    const list = await window.api.getAIProviders()
    setProviders(list || [])
    try {
      const settings = (await window.api.getSettings()) as {
        ai?: Record<string, { apiKey?: string; baseUrl?: string }>
        theme?: 'dark' | 'light' | 'system'
        permissions?: typeof permissions
      }
      if (settings?.ai) {
        const keys: Record<string, string> = {}
        const urls: Record<string, string> = {}
        for (const [id, cfg] of Object.entries(settings.ai)) {
          if (cfg.apiKey) keys[id] = cfg.apiKey
          if (cfg.baseUrl) urls[id] = cfg.baseUrl
        }
        setApiKeys(keys)
        setBaseUrls(urls)
      }
      if (settings?.theme) {
        setTheme(settings.theme)
        applyTheme(settings.theme)
      }
      if (settings?.permissions) {
        setPermissions((p) => ({ ...p, ...settings.permissions }))
      }
      setIndexStats(await window.api.getSearchStats())
      setSecStatus(await window.api.getSecurityStatus())
      setAutomation(await window.api.getAutomation())
      setPlugins(await window.api.listPlugins())
      setPluginCmds(await window.api.listPluginCommands())
      setHealth(await window.api.getApiHealth())
    } catch {
      /* ignore */
    }
  }

  const handleSaveKey = async (providerId: string) => {
    const key = apiKeys[providerId]?.trim()
    const baseUrl = baseUrls[providerId]?.trim()
    if (providerId !== 'ollama' && !key) {
      flash('API key required')
      return
    }
    try {
      const res = (await window.api.configureAIProvider(
        providerId,
        key || undefined,
        baseUrl || (providerId === 'ollama' ? 'http://localhost:11434' : undefined)
      )) as boolean | { ok?: boolean; path?: string; error?: string }
      if (res && typeof res === 'object' && res.ok === false) {
        flash(`Save gagal: ${res.error || 'unknown'}`)
        return
      }
      // BUGFIX: do NOT setActive on Save — that silently switched chat provider
      const pathHint = res && typeof res === 'object' && res.path ? ` · ${res.path}` : ''
      flash(`Saved ${providerId}. Klik Test, atau pilih provider di Chat.${pathHint}`)
      await loadAll()
    } catch (e) {
      flash(e instanceof Error ? e.message : 'Save failed')
    }
  }

  const handleTest = async (providerId: string) => {
    flash(`Testing ${providerId}…`)
    try {
      // BUGFIX: testProvider(id) already targets that provider — don't mutate global active
      const res = await window.api.testAIProvider(providerId)
      if (res.ok) {
        flash(`OK ${providerId}: ${res.sample || 'connected'}`)
      } else {
        flash(`FAIL ${providerId}: ${res.error || 'unknown'}`)
      }
      await loadAll()
    } catch (e) {
      flash(e instanceof Error ? e.message : 'Test failed')
    }
  }

  const handleSetDefault = async (providerId: string) => {
    try {
      await window.api.setActiveAIProvider(providerId)
      flash(`Default provider: ${providerId}`)
      await loadAll()
    } catch (e) {
      flash(e instanceof Error ? e.message : 'Set default failed')
    }
  }

  const handleTheme = async (t: ThemePreference) => {
    setTheme(t)
    applyTheme(t)
    try {
      const settings = ((await window.api.getSettings()) as Record<string, unknown>) || {}
      settings.theme = t
      await window.api.saveSettings(settings)
      flash(`Theme: ${t}`)
    } catch (e) {
      flash(e instanceof Error ? e.message : 'Theme save failed')
    }
  }

  const savePermissions = async (next: typeof permissions) => {
    setPermissions(next)
    const settings = ((await window.api.getSettings()) as Record<string, unknown>) || {}
    settings.permissions = next
    await window.api.saveSettings(settings)
    flash('Permissions saved')
    await loadAll()
  }

  const handleRebuildIndex = async () => {
    setRebuilding(true)
    try {
      const res = await window.api.rebuildSearchIndex()
      flash(res.ok ? `Index rebuilt: ${res.count} notes` : res.error || 'Rebuild failed')
      setIndexStats(await window.api.getSearchStats())
    } finally {
      setRebuilding(false)
    }
  }

  const toggleRule = async (ruleId: string, enabled: boolean) => {
    if (!automation) return
    const config = {
      ...automation.config,
      rules: automation.config.rules.map((r) => (r.id === ruleId ? { ...r, enabled } : r))
    }
    await window.api.saveAutomation(config)
    setAutomation(await window.api.getAutomation())
    flash(enabled ? 'Rule enabled' : 'Rule disabled')
  }

  const nav: { id: Section; label: string }[] = [
    { id: 'ai', label: 'AI Providers' },
    { id: 'index', label: 'Search Index' },
    { id: 'security', label: 'Security' },
    { id: 'automation', label: 'Automation' },
    { id: 'plugins', label: 'Plugins' },
    { id: 'appearance', label: 'Appearance' },
    { id: 'about', label: 'About' }
  ]

  return (
    <div className="settings-container">
      <div className="settings-nav">
        <div className="section-title">Settings</div>
        {nav.map((n) => (
          <button
            key={n.id}
            className={`nav-item ${section === n.id ? 'active' : ''}`}
            onClick={() => {
              setSection(n.id)
              if (n.id === 'automation' || n.id === 'plugins' || n.id === 'security') void loadAll()
            }}
          >
            {n.label}
          </button>
        ))}
      </div>

      <div className="settings-content">
        {savedStatus && (
          <div
            className="badge badge-success"
            style={{ marginBottom: 'var(--space-4)', padding: 'var(--space-2) var(--space-4)' }}
          >
            {savedStatus}
          </div>
        )}

        {section === 'ai' && (
          <div className="settings-section">
            <h2>AI Provider Configurations</h2>
            <p
              style={{
                fontSize: 'var(--text-sm)',
                color: 'var(--text-secondary)',
                marginBottom: 'var(--space-4)'
              }}
            >
              Default: <b>Grok (xAI)</b> — import sesi dari Grok CLI (login akun X), atau paste API
              key console.x.ai.
            </p>

            <div
              style={{
                background: 'var(--bg-surface)',
                borderRadius: 8,
                padding: 14,
                marginBottom: 16,
                border: '1px solid var(--border-subtle)'
              }}
            >
              <div style={{ fontWeight: 600, fontSize: 'var(--text-sm)', marginBottom: 6 }}>
                Grok CLI → WorkspaceGraph
              </div>
              <p
                style={{
                  fontSize: 12,
                  color: 'var(--text-muted)',
                  marginBottom: 10,
                  lineHeight: 1.45
                }}
              >
                Sudah login Grok di terminal (`grok`)? Impor sesi akun X dari{' '}
                <code>~/.grok/auth.json</code> → app pakai <code>api.x.ai</code> (bukan CLI proxy).
                Token di-refresh otomatis.
              </p>
              <button
                className="btn btn-primary btn-sm"
                onClick={async () => {
                  flash('Import Grok CLI…')
                  try {
                    const res = await window.api.importGrokCli()
                    if (res.ok) {
                      flash(
                        `Grok OK${res.email ? ` (${res.email})` : ''} · ${res.baseUrl || 'api.x.ai'} · ${res.model || 'grok-4.5'}. Klik Test.`
                      )
                      await loadAll()
                    } else {
                      flash(`Import gagal: ${res.error || 'unknown'}`)
                    }
                  } catch (e) {
                    flash(e instanceof Error ? e.message : 'Import failed')
                  }
                }}
              >
                Import dari Grok CLI (akun X)
              </button>
            </div>

            {providers.map((p) => {
              // Ollama: "connected" = daemon reachable. Cloud: "configured" = key saved (not live ping).
              const isReady = p.id === 'ollama' ? Boolean(p.connected) : Boolean(p.configured)
              const statusText =
                p.id === 'ollama'
                  ? p.connected
                    ? `Online · ${p.models.length} models`
                    : 'Offline — jalankan Ollama di localhost'
                  : p.configured
                    ? `Key saved · ${p.models.length} models · klik Test`
                    : p.error || 'Not configured'
              return (
              <div
                key={p.id}
                className={`provider-card ${isReady ? 'active' : ''}`}
              >
                <div className={`provider-dot ${isReady ? 'connected' : ''}`} />
                <div style={{ flex: 1, minWidth: 120 }}>
                  <div style={{ fontWeight: 600, fontSize: 'var(--text-sm)' }}>{p.name}</div>
                  <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
                    {statusText}
                    {secStatus?.secrets?.[p.id] ? ` · key:${secStatus.secrets[p.id]}` : ''}
                  </div>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {p.id === 'ollama' ? (
                    <input
                      type="text"
                      className="input"
                      placeholder="http://localhost:11434"
                      style={{ width: 260 }}
                      value={baseUrls[p.id] || ''}
                      onChange={(e) => setBaseUrls({ ...baseUrls, [p.id]: e.target.value })}
                    />
                  ) : (
                    <input
                      type="password"
                      className="input"
                      placeholder="API Key"
                      style={{ width: 260 }}
                      value={apiKeys[p.id] || ''}
                      onChange={(e) => setApiKeys({ ...apiKeys, [p.id]: e.target.value })}
                      autoComplete="off"
                    />
                  )}
                  <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                    <button className="btn btn-surface btn-sm" onClick={() => handleTest(p.id)}>
                      Test
                    </button>
                    <button className="btn btn-surface btn-sm" onClick={() => void handleSetDefault(p.id)}>
                      Set default
                    </button>
                    <button className="btn btn-primary btn-sm" onClick={() => handleSaveKey(p.id)}>
                      Save
                    </button>
                  </div>
                </div>
              </div>
              )
            })}
            <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 12, lineHeight: 1.5 }}>
              Alur: isi key → <b>Save</b> (simpan saja) → <b>Test</b> (ping API) → di Chat pilih
              provider, atau <b>Set default</b>. Save tidak lagi mengganti provider aktif chat.
              <br />
              Gemini/OpenAI/Claude/OpenRouter butuh API key. Ollama butuh app Ollama running di
              localhost.
            </p>
          </div>
        )}

        {section === 'index' && (
          <div className="settings-section">
            <h2>Search Index (cache)</h2>
            <div
              style={{
                background: 'var(--bg-surface)',
                borderRadius: 6,
                padding: 16,
                marginBottom: 16,
                fontSize: 'var(--text-sm)'
              }}
            >
              <div>
                Memory: <strong>{indexStats?.memoryCount ?? '—'}</strong>
              </div>
              <div>
                SQLite:{' '}
                <strong
                  style={{
                    color: indexStats?.sqlite.open ? 'var(--color-success)' : 'var(--color-warning)'
                  }}
                >
                  {indexStats?.sqlite.open ? 'open' : 'closed'}
                </strong>{' '}
                · {indexStats?.sqlite.count ?? 0} rows
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', wordBreak: 'break-all' }}>
                {indexStats?.sqlite.path || '—'}
              </div>
            </div>
            <button
              className="btn btn-primary btn-sm"
              onClick={handleRebuildIndex}
              disabled={rebuilding}
            >
              {rebuilding ? 'Rebuilding…' : 'Rebuild index'}
            </button>
          </div>
        )}

        {section === 'security' && (
          <div className="settings-section">
            <h2>Security & permissions</h2>
            <p
              style={{
                fontSize: 'var(--text-sm)',
                color: 'var(--text-secondary)',
                marginBottom: 16
              }}
            >
              Encryption available:{' '}
              <strong>
                {secStatus?.encryptionAvailable ? 'Yes (OS keychain)' : 'No — plaintext fallback'}
              </strong>
            </p>
            {(
              [
                ['aiAccess', 'AI access (network providers)'],
                ['aiTools', 'AI worker tools (search/read/write proposals)'],
                ['automation', 'Automation rules'],
                ['plugins', 'Declarative plugins']
              ] as const
            ).map(([key, label]) => (
              <label
                key={key}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  marginBottom: 10,
                  fontSize: 'var(--text-sm)',
                  cursor: 'pointer'
                }}
              >
                <input
                  type="checkbox"
                  checked={permissions[key]}
                  onChange={(e) => savePermissions({ ...permissions, [key]: e.target.checked })}
                />
                {label}
              </label>
            ))}
            <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 12 }}>
              AI write selalu butuh konfirmasi Apply (aiAutoWrite tetap off). Path di luar vault
              ditolak.
            </p>
          </div>
        )}

        {section === 'automation' && (
          <div className="settings-section">
            <h2>Automation</h2>
            <p
              style={{
                fontSize: 'var(--text-sm)',
                color: 'var(--text-secondary)',
                marginBottom: 12
              }}
            >
              Rules di <code>.workspacegraph/automation.json</code>
            </p>
            <label
              style={{
                display: 'flex',
                gap: 8,
                alignItems: 'center',
                marginBottom: 16,
                fontSize: 'var(--text-sm)'
              }}
            >
              <input
                type="checkbox"
                checked={automation?.enabled ?? false}
                onChange={async (e) => {
                  await window.api.setAutomationEnabled(e.target.checked)
                  setAutomation(await window.api.getAutomation())
                }}
              />
              Engine enabled
            </label>
            {(automation?.config.rules || []).map((r) => (
              <div
                key={r.id}
                style={{
                  background: 'var(--bg-surface)',
                  padding: 12,
                  borderRadius: 6,
                  marginBottom: 8,
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  gap: 12
                }}
              >
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: 'var(--text-sm)' }}>{r.name}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                    {r.trigger.type}
                    {r.trigger.match ? ` · ${r.trigger.match}` : ''}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                  <label style={{ fontSize: 11, display: 'flex', alignItems: 'center', gap: 4 }}>
                    <input
                      type="checkbox"
                      checked={r.enabled}
                      onChange={(e) => toggleRule(r.id, e.target.checked)}
                    />
                    On
                  </label>
                  <button
                    className="btn btn-ghost btn-sm"
                    style={{ fontSize: 10 }}
                    onClick={async () => {
                      const res = await window.api.runAutomationRule(r.id)
                      flash(res.ok ? `Ran ${r.id}` : res.error || 'Failed')
                      setAutomation(await window.api.getAutomation())
                    }}
                  >
                    Run
                  </button>
                </div>
              </div>
            ))}
            <div className="section-title" style={{ marginTop: 16 }}>
              Recent logs
            </div>
            {(automation?.logs || []).slice(0, 8).map((l, i) => (
              <div
                key={i}
                style={{ fontSize: 11, color: l.ok ? 'var(--text-muted)' : 'var(--color-error)' }}
              >
                {l.at.slice(11, 19)} [{l.ruleId}] {l.message}
              </div>
            ))}
          </div>
        )}

        {section === 'plugins' && (
          <div className="settings-section">
            <h2>Plugins (declarative)</h2>
            <p
              style={{
                fontSize: 'var(--text-sm)',
                color: 'var(--text-secondary)',
                marginBottom: 12
              }}
            >
              <code>.workspacegraph/plugins/*/manifest.json</code> — no arbitrary JS execution.
            </p>
            <button
              className="btn btn-surface btn-sm"
              style={{ marginBottom: 16 }}
              onClick={async () => {
                await window.api.reloadPlugins()
                await loadAll()
                flash('Plugins reloaded')
              }}
            >
              Reload plugins
            </button>
            {plugins.map((p) => (
              <div
                key={p.id}
                style={{
                  background: 'var(--bg-surface)',
                  padding: 12,
                  borderRadius: 6,
                  marginBottom: 8
                }}
              >
                <div style={{ fontWeight: 600, fontSize: 'var(--text-sm)' }}>
                  {p.name}{' '}
                  <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>v{p.version}</span>
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                  {p.description || p.id} · {p.commands} commands ·{' '}
                  {p.enabled ? 'enabled' : 'disabled'}
                </div>
              </div>
            ))}
            {plugins.length === 0 && (
              <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
                Buka vault lalu reload — sample plugin dibuat otomatis.
              </div>
            )}
            <div className="section-title" style={{ marginTop: 16 }}>
              Commands
            </div>
            {pluginCmds.map((c) => (
              <button
                key={c.pluginName + c.id}
                className="nav-item"
                style={{ width: '100%', fontSize: 'var(--text-xs)' }}
                onClick={() => {
                  if (c.action === 'search_prefill' && c.args?.query) {
                    window.dispatchEvent(
                      new CustomEvent('search:prefill', { detail: c.args.query })
                    )
                    flash(`Search: ${c.args.query}`)
                  } else if (c.action === 'create_from_template' && c.args?.templateId) {
                    void window.api
                      .createFromTemplate({
                        templateId: c.args.templateId,
                        title: c.args.title || 'New'
                      })
                      .then((r) => flash(r.ok ? `Created ${r.relativePath}` : r.error || 'Failed'))
                  }
                }}
              >
                {c.title}
                <span style={{ marginLeft: 'auto', color: 'var(--text-muted)' }}>
                  {c.pluginName}
                </span>
              </button>
            ))}
          </div>
        )}

        {section === 'appearance' && (
          <div className="settings-section">
            <h2>Appearance</h2>
            <p
              style={{
                fontSize: 'var(--text-sm)',
                color: 'var(--text-secondary)',
                marginBottom: 12
              }}
            >
              Light = paper UI (sidebar, graph, editor, title bar). Dark = Obsidian-flat default.
              Active mode follows preference immediately across all views.
            </p>
            <div className="flex gap-2">
              {(['dark', 'light', 'system'] as const).map((t) => (
                <button
                  key={t}
                  className={`btn btn-sm ${theme === t ? 'btn-primary' : 'btn-surface'}`}
                  onClick={() => handleTheme(t)}
                >
                  {t.charAt(0).toUpperCase() + t.slice(1)}
                </button>
              ))}
            </div>
            <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 10 }}>
              data-theme=
              {typeof document !== 'undefined'
                ? document.documentElement.getAttribute('data-theme') || 'dark'
                : '—'}
            </p>
          </div>
        )}

        {section === 'about' && (
          <div className="settings-section">
            <h2>WorkspaceGraph</h2>
            <p
              style={{
                fontSize: 'var(--text-sm)',
                color: 'var(--text-secondary)',
                lineHeight: 1.6
              }}
            >
              AI Workspace OS · Phase 1–5 core
              <br />
              Internal API: {(health as { apiVersion?: string })?.apiVersion || '—'}
              <br />
              Hotkeys: Ctrl+K · Ctrl+N · Ctrl+Shift+N template · Ctrl+Shift+D daily · Ctrl+B ·
              Ctrl+J · Ctrl+S
            </p>
            {health && (
              <pre
                style={{
                  fontSize: 10,
                  background: 'var(--bg-surface)',
                  padding: 12,
                  borderRadius: 6,
                  overflow: 'auto',
                  maxHeight: 240
                }}
              >
                {JSON.stringify(health, null, 2)}
              </pre>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
