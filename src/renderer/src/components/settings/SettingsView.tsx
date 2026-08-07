import React, { useEffect, useState } from 'react'
import { applyTheme, getCachedThemePref, type ThemePreference } from '../../utils/theme'

type Section =
  'ai' | 'appearance' | 'index' | 'security' | 'automation' | 'plugins' | 'logs' | 'about'

/** One row of the AI event trail (shape mirrors AIEvent in main). */
interface AIEventRow {
  ts: string
  kind: string
  provider?: string
  model?: string
  requestId?: string
  role?: string
  stageCount?: number
  durationMs?: number
  tokensUsed?: number
  status?: string
  error?: string
  tool?: string
  rounds?: number
}

const TERMINAL_KINDS = new Set(['stream_end', 'pipeline', 'send'])
const LOG_FILTERS = [
  { id: 'all', label: 'Semua' },
  { id: 'ok', label: 'OK' },
  { id: 'error', label: 'Error' },
  { id: 'cancelled', label: 'Batal' },
  { id: 'timeout', label: 'Timeout' }
] as const
type LogFilter = (typeof LOG_FILTERS)[number]['id']

const DAYS_ID = ['Min', 'Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab']

const DEFAULT_RULE_DRAFT = {
  name: '',
  mode: 'interval' as 'interval' | 'daily',
  every: 30,
  unit: 'minutes',
  atTime: '09:00',
  days: [] as number[],
  action: 'log',
  message: 'Scheduled run {{date}} {{time}}',
  appendPath: 'Daily/{{date}}.md',
  appendContent: '- Scheduled {{time}}\n'
}

export const SettingsView: React.FC = () => {
  const [providers, setProviders] = useState<
    {
      id: string
      name: string
      connected: boolean
      configured?: boolean
      error?: string
      models: { id: string; name: string; free?: boolean }[]
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
  const [embeddingStatus, setEmbeddingStatus] = useState<{
    state: 'idle' | 'loading_model' | 'indexing' | 'ready'
    totalChunks: number
    indexedFiles: number
    modelReady: boolean
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
        trigger: {
          type: string
          match?: string
          schedule?: { every?: number; unit?: string; atTime?: string; daysOfWeek?: number[] }
        }
      }[]
    }
    logs: { at: string; ruleId: string; message: string; ok: boolean }[]
    schedule?: { running: boolean; nextFire: string | null }
  } | null>(null)
  const [plugins, setPlugins] = useState<
    {
      id: string
      name: string
      version: string
      enabled: boolean
      description?: string
      commands: number
      js?: boolean
    }[]
  >([])
  const [pluginCmds, setPluginCmds] = useState<
    {
      id: string
      title: string
      pluginName: string
      pluginId: string
      action: string
      args?: Record<string, string>
    }[]
  >([])
  const [health, setHealth] = useState<Record<string, unknown> | null>(null)
  const [semanticContext, setSemanticContext] = useState(true)
  const [trashEnabled, setTrashEnabled] = useState(true)
  const [showAddRule, setShowAddRule] = useState(false)
  const [draft, setDraft] = useState({ ...DEFAULT_RULE_DRAFT })
  const [aiEvents, setAiEvents] = useState<AIEventRow[]>([])
  const [logFilter, setLogFilter] = useState<LogFilter>('all')
  const [confirmClear, setConfirmClear] = useState(false)
  const [logStats, setLogStats] = useState<{
    total: number
    sizeBytes: number
  } | null>(null)
  const [retentionDays, setRetentionDays] = useState(0)

  const flash = (msg: string): void => {
    setSavedStatus(msg)
    setTimeout(() => setSavedStatus(''), 3000)
  }

  const loadAll = async (): Promise<void> => {
    const list = await window.api.getAIProviders()
    setProviders(list || [])
    try {
      const settings = (await window.api.getSettings()) as {
        ai?: Record<string, { apiKey?: string; baseUrl?: string }>
        theme?: 'dark' | 'light' | 'system'
        permissions?: typeof permissions
        semanticContext?: boolean
        trashEnabled?: boolean
        aiEventRetentionDays?: number
      }
      if (settings?.ai) {
        const urls: Record<string, string> = {}
        for (const [id, cfg] of Object.entries(settings.ai)) {
          if (cfg.baseUrl) urls[id] = cfg.baseUrl
        }
        setBaseUrls(urls)
      }
      // Keys are never shipped to the renderer (security) — fields stay masked,
      // "saved" state comes from security:status. Only a newly typed key is sent.
      setApiKeys({})
      if (settings?.theme) {
        setTheme(settings.theme)
        applyTheme(settings.theme)
      }
      if (settings?.permissions) {
        setPermissions((p) => ({ ...p, ...settings.permissions }))
      }
      setSemanticContext(settings?.semanticContext !== false)
      setTrashEnabled(settings?.trashEnabled !== false)
      setRetentionDays(Number(settings?.aiEventRetentionDays) || 0)
      setIndexStats(await window.api.getSearchStats())
      setEmbeddingStatus(await window.api.getEmbeddingStatus())
      setSecStatus(await window.api.getSecurityStatus())
      setAutomation(await window.api.getAutomation())
      setPlugins(await window.api.listPlugins())
      setPluginCmds(await window.api.listPluginCommands())
      setHealth(await window.api.getApiHealth())
    } catch {
      /* ignore */
    }
  }

  // Mount-only load; loadAll identity changes every render and including it
  // would re-fetch on every keystroke.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot bootstrap
    void loadAll()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleSaveKey = async (providerId: string): Promise<void> => {
    const key = apiKeys[providerId]?.trim()
    const baseUrl = baseUrls[providerId]?.trim()
    // Key is masked in the UI — leaving it blank keeps the stored key (if any).
    const alreadySaved =
      providerId === 'ollama' ||
      (secStatus?.secrets?.[providerId] && secStatus.secrets[providerId] !== 'empty')
    if (providerId !== 'ollama' && !key && !alreadySaved) {
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

  const handleTest = async (providerId: string): Promise<void> => {
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

  const handleSetDefault = async (providerId: string): Promise<void> => {
    try {
      await window.api.setActiveAIProvider(providerId)
      flash(`Default provider: ${providerId}`)
      await loadAll()
    } catch (e) {
      flash(e instanceof Error ? e.message : 'Set default failed')
    }
  }

  /** Bypass the 5-min model cache: pull the live list from the API now. */
  const handleRefreshModels = async (providerId: string): Promise<void> => {
    try {
      const res = await window.api.refreshProviderModels(providerId)
      if (res.ok) {
        flash(`${providerId}: ${res.models.length} model dimuat ulang`)
      } else {
        flash(res.error || `Refresh ${providerId} gagal`)
      }
      await loadAll()
    } catch (e) {
      flash(e instanceof Error ? e.message : 'Refresh failed')
    }
  }

  const handleTheme = async (t: ThemePreference): Promise<void> => {
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

  const savePermissions = async (next: typeof permissions): Promise<void> => {
    setPermissions(next)
    const settings = ((await window.api.getSettings()) as Record<string, unknown>) || {}
    settings.permissions = next
    await window.api.saveSettings(settings)
    flash('Permissions saved')
    await loadAll()
  }

  const saveTrashEnabled = async (enabled: boolean): Promise<void> => {
    setTrashEnabled(enabled)
    const settings = ((await window.api.getSettings()) as Record<string, unknown>) || {}
    settings.trashEnabled = enabled
    await window.api.saveSettings(settings)
    flash(enabled ? 'Trash (soft-delete) enabled' : 'Trash disabled — delete menghapus permanen')
  }

  const saveSemanticContext = async (enabled: boolean): Promise<void> => {
    setSemanticContext(enabled)
    const settings = ((await window.api.getSettings()) as Record<string, unknown>) || {}
    settings.semanticContext = enabled
    await window.api.saveSettings(settings)
    flash(
      enabled ? 'Semantic context aktif' : 'Semantic context nonaktif — AI hanya pakai FTS + graph'
    )
  }

  const handleRebuildIndex = async (): Promise<void> => {
    setRebuilding(true)
    try {
      const res = await window.api.rebuildSearchIndex()
      flash(res.ok ? `Index rebuilt: ${res.count} notes` : res.error || 'Rebuild failed')
      setIndexStats(await window.api.getSearchStats())
    } finally {
      setRebuilding(false)
    }
  }

  const toggleRule = async (ruleId: string, enabled: boolean): Promise<void> => {
    if (!automation) return
    const config = {
      ...automation.config,
      rules: automation.config.rules.map((r) => (r.id === ruleId ? { ...r, enabled } : r))
    }
    await window.api.saveAutomation(config)
    setAutomation(await window.api.getAutomation())
    flash(enabled ? 'Rule enabled' : 'Rule disabled')
  }

  const describeSchedule = (
    s:
      | {
          every?: number
          unit?: string
          atTime?: string
          daysOfWeek?: number[]
        }
      | undefined
  ): string => {
    if (!s) return ''
    const parts: string[] = []
    if (s.atTime) parts.push(`harian ${s.atTime}`)
    else if (s.every && s.every > 0) {
      const u = s.unit === 'hours' ? 'jam' : s.unit === 'days' ? 'hari' : 'menit'
      parts.push(`setiap ${s.every} ${u}`)
    }
    const list = s.daysOfWeek
    if (list && list.length > 0 && list.length < 7) {
      const sorted = [...list].sort((a, b) => a - b)
      if (sorted.length >= 2 && sorted[sorted.length - 1] - sorted[0] === sorted.length - 1) {
        parts.push(`${DAYS_ID[sorted[0]]}–${DAYS_ID[sorted[sorted.length - 1]]}`)
      } else {
        parts.push(sorted.map((d) => DAYS_ID[d]).join(', '))
      }
    }
    return parts.join(' · ') || 'setiap hari'
  }

  const addScheduleRule = async (): Promise<void> => {
    if (!automation || !draft.name.trim()) return
    const rule = {
      id: `sched-${Date.now().toString(36)}`,
      name: draft.name.trim(),
      enabled: true,
      trigger: {
        type: 'schedule',
        schedule: {
          ...(draft.mode === 'daily'
            ? { atTime: draft.atTime || '09:00' }
            : { every: draft.every || 30, unit: draft.unit }),
          ...(draft.days.length > 0 ? { daysOfWeek: [...draft.days].sort((a, b) => a - b) } : {})
        }
      },
      actions: [
        draft.action === 'log'
          ? { type: 'log', message: draft.message || 'Scheduled {{date}} {{time}}' }
          : {
              type: 'append_to_note',
              path: draft.appendPath || 'Daily/{{date}}.md',
              content: draft.appendContent || '- Scheduled {{time}}\n'
            }
      ]
    }
    const config = { ...automation.config, rules: [...automation.config.rules, rule] }
    const res = await window.api.saveAutomation(config)
    if (res.ok) {
      flash(`Rule "${draft.name}" dibuat`)
      setShowAddRule(false)
      setDraft({ ...DEFAULT_RULE_DRAFT })
    } else {
      flash(res.error || 'Gagal membuat rule')
    }
    setAutomation(await window.api.getAutomation())
  }

  const loadAIEvents = async (): Promise<void> => {
    try {
      const events = ((await window.api.listAIEvents(300)) || []) as AIEventRow[]
      // Terminal kinds only, and drop pipeline/stream 'started' bookends (they
      // carry no outcome — just entry markers) so every row has a real status.
      setAiEvents(
        events.filter((e) => TERMINAL_KINDS.has(e.kind) && e.status && e.status !== 'started')
      )
      const stats = (await window.api.getAIEventStats(7)) as {
        total?: number
        sizeBytes?: number
      }
      setLogStats({ total: stats.total ?? 0, sizeBytes: stats.sizeBytes ?? 0 })
    } catch {
      /* ignore */
    }
  }

  const saveLogRetention = async (days: number): Promise<void> => {
    setRetentionDays(days)
    const settings = ((await window.api.getSettings()) as Record<string, unknown>) || {}
    settings.aiEventRetentionDays = days
    await window.api.saveSettings(settings)
    flash(
      days > 0
        ? `Log AI dipangkas otomatis setelah ${days} hari`
        : 'Retensi off — log disimpan tanpa batas'
    )
  }

  const handleClearAIEvents = async (): Promise<void> => {
    if (!confirmClear) {
      // Two-step confirm: first click arms, second click wipes (no window.confirm)
      setConfirmClear(true)
      setTimeout(() => setConfirmClear(false), 3500)
      return
    }
    setConfirmClear(false)
    try {
      const res = await window.api.clearAIEvents()
      if (res.ok) {
        flash(`Log AI dibersihkan (${res.removed} file)`)
        await loadAIEvents()
      } else {
        flash('Gagal membersihkan log')
      }
    } catch (e) {
      flash(e instanceof Error ? e.message : 'Clear failed')
    }
  }

  const nav: { id: Section; label: string }[] = [
    { id: 'ai', label: 'AI Providers' },
    { id: 'index', label: 'Search Index' },
    { id: 'security', label: 'Security' },
    { id: 'automation', label: 'Automation' },
    { id: 'plugins', label: 'Plugins' },
    { id: 'appearance', label: 'Appearance' },
    { id: 'logs', label: 'AI Activity' },
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
              if (n.id === 'logs') void loadAIEvents()
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
              const freeCount = p.models.filter((m) => m.free).length
              const freeHint =
                freeCount > 0
                  ? ` · ${freeCount} model gratis`
                  : p.id === 'ollama'
                    ? ' · semua lokal (gratis)'
                    : ''
              const statusText =
                p.id === 'ollama'
                  ? p.connected
                    ? `Online · ${p.models.length} models${freeHint}`
                    : 'Offline — jalankan Ollama di localhost'
                  : p.configured
                    ? `Key saved · ${p.models.length} models${freeHint} · klik Test`
                    : p.error || 'Not configured'
              return (
                <div key={p.id} className={`provider-card ${isReady ? 'active' : ''}`}>
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
                        placeholder={
                          secStatus?.secrets?.[p.id] && secStatus.secrets[p.id] !== 'empty'
                            ? '••••••  (saved)'
                            : 'API Key'
                        }
                        style={{ width: 260 }}
                        value={apiKeys[p.id] || ''}
                        onChange={(e) => setApiKeys({ ...apiKeys, [p.id]: e.target.value })}
                        autoComplete="off"
                      />
                    )}
                    <div
                      style={{
                        display: 'flex',
                        gap: 6,
                        justifyContent: 'flex-end',
                        flexWrap: 'wrap'
                      }}
                    >
                      <button className="btn btn-surface btn-sm" onClick={() => handleTest(p.id)}>
                        Test
                      </button>
                      <button
                        className="btn btn-surface btn-sm"
                        onClick={() => void handleSetDefault(p.id)}
                      >
                        Set default
                      </button>
                      <button
                        className="btn btn-surface btn-sm"
                        title="Bypass cache 5 menit — tarik ulang daftar model dari API sekarang"
                        onClick={() => void handleRefreshModels(p.id)}
                        disabled={!isReady}
                      >
                        Refresh models
                      </button>
                      <button
                        className="btn btn-primary btn-sm"
                        onClick={() => handleSaveKey(p.id)}
                      >
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

            <div
              style={{
                background: 'var(--bg-surface)',
                borderRadius: 6,
                padding: 16,
                marginBottom: 16,
                fontSize: 'var(--text-sm)'
              }}
            >
              <div
                style={{
                  fontWeight: 600,
                  fontSize: 'var(--text-sm)',
                  marginBottom: 6,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8
                }}
              >
                Embedding (semantic memory)
                {embeddingStatus && (
                  <span
                    className={`badge ${
                      embeddingStatus.state === 'ready' ? 'badge-success' : 'badge-warning'
                    }`}
                  >
                    {embeddingStatus.state}
                  </span>
                )}
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                Model:{' '}
                <strong
                  style={{
                    color: embeddingStatus?.modelReady
                      ? 'var(--color-success)'
                      : 'var(--text-muted)'
                  }}
                >
                  {embeddingStatus?.modelReady ? 'ready' : 'not loaded'}
                </strong>{' '}
                · {embeddingStatus?.totalChunks ?? 0} chunks · {embeddingStatus?.indexedFiles ?? 0}{' '}
                files
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                Dipakai Context AI (semantic recall) saat vault terbuka.
              </div>
            </div>

            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                marginBottom: 12,
                fontSize: 'var(--text-sm)',
                cursor: 'pointer'
              }}
            >
              <input
                type="checkbox"
                checked={semanticContext}
                onChange={(e) => void saveSemanticContext(e.target.checked)}
              />
              Semantic context (AI pakai vector search untuk konteks)
            </label>

            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                marginBottom: 16,
                fontSize: 'var(--text-sm)',
                cursor: 'pointer'
              }}
            >
              <input
                type="checkbox"
                checked={trashEnabled}
                onChange={(e) => void saveTrashEnabled(e.target.checked)}
              />
              Trash (soft-delete) — hapus pindah ke .trash dulu
            </label>

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
                ['plugins', 'Plugins (declarative + JS sandbox)']
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
              ditolak. Plugin JS jalan di sandbox vm + worker; operasi tulis butuh prompt izin.
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
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 16 }}>
              Scheduler:{' '}
              <b
                style={{
                  color: automation?.schedule?.running
                    ? 'var(--color-success)'
                    : 'var(--color-error)'
                }}
              >
                {automation?.schedule?.running ? 'aktif' : 'berhenti'}
              </b>
              {automation?.schedule?.nextFire ? (
                <>
                  {' '}
                  · next{' '}
                  <b>
                    {new Date(automation.schedule.nextFire).toLocaleTimeString([], {
                      hour: '2-digit',
                      minute: '2-digit'
                    })}
                  </b>
                </>
              ) : null}
            </div>
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
                    {r.trigger.type === 'schedule' ? (
                      <span style={{ color: 'var(--color-primary)' }}>
                        ⏰ {describeSchedule(r.trigger.schedule)}
                      </span>
                    ) : (
                      <>
                        {r.trigger.type}
                        {r.trigger.match ? ` · ${r.trigger.match}` : ''}
                      </>
                    )}
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
            <button
              className="btn btn-surface btn-sm"
              style={{ marginTop: 4 }}
              onClick={() => setShowAddRule((v) => !v)}
            >
              {showAddRule ? 'Batal' : '+ Tambah rule terjadwal'}
            </button>
            {showAddRule && (
              <div
                style={{
                  background: 'var(--bg-surface)',
                  padding: 12,
                  borderRadius: 6,
                  marginTop: 8,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 10
                }}
              >
                <input
                  className="input"
                  placeholder="Nama rule"
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                />
                <div style={{ display: 'flex', gap: 6 }}>
                  {(['interval', 'daily'] as const).map((m) => (
                    <button
                      key={m}
                      className={`btn btn-sm ${draft.mode === m ? 'btn-primary' : 'btn-surface'}`}
                      onClick={() => setDraft({ ...draft, mode: m })}
                    >
                      {m === 'interval' ? 'Interval' : 'Harian (jam)'}
                    </button>
                  ))}
                </div>
                {draft.mode === 'interval' ? (
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <input
                      className="input"
                      type="number"
                      min={1}
                      value={draft.every}
                      onChange={(e) => setDraft({ ...draft, every: Number(e.target.value) || 1 })}
                      style={{ width: 70 }}
                    />
                    <select
                      className="input"
                      value={draft.unit}
                      onChange={(e) => setDraft({ ...draft, unit: e.target.value })}
                    >
                      <option value="minutes">menit</option>
                      <option value="hours">jam</option>
                      <option value="days">hari</option>
                    </select>
                  </div>
                ) : (
                  <input
                    className="input"
                    type="time"
                    value={draft.atTime}
                    onChange={(e) => setDraft({ ...draft, atTime: e.target.value })}
                    style={{ width: 120 }}
                  />
                )}
                <div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>
                    Hari (kosong = setiap hari)
                  </div>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {DAYS_ID.map((label, i) => (
                      <label
                        key={label}
                        style={{
                          fontSize: 11,
                          display: 'flex',
                          alignItems: 'center',
                          gap: 2,
                          cursor: 'pointer'
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={draft.days.includes(i)}
                          onChange={(e) =>
                            setDraft({
                              ...draft,
                              days: e.target.checked
                                ? [...draft.days, i]
                                : draft.days.filter((d) => d !== i)
                            })
                          }
                        />
                        {label}
                      </label>
                    ))}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  {(['log', 'append_to_note'] as const).map((a) => (
                    <button
                      key={a}
                      className={`btn btn-sm ${draft.action === a ? 'btn-primary' : 'btn-surface'}`}
                      onClick={() => setDraft({ ...draft, action: a })}
                    >
                      {a === 'log' ? 'Log' : 'Append ke catatan'}
                    </button>
                  ))}
                </div>
                {draft.action === 'log' ? (
                  <input
                    className="input"
                    placeholder="Pesan ({{date}} {{time}} {{workspace}})"
                    value={draft.message}
                    onChange={(e) => setDraft({ ...draft, message: e.target.value })}
                  />
                ) : (
                  <>
                    <input
                      className="input"
                      placeholder="Path (mis. Daily/{{date}}.md)"
                      value={draft.appendPath}
                      onChange={(e) => setDraft({ ...draft, appendPath: e.target.value })}
                    />
                    <input
                      className="input"
                      placeholder="Konten"
                      value={draft.appendContent}
                      onChange={(e) => setDraft({ ...draft, appendContent: e.target.value })}
                    />
                  </>
                )}
                <button
                  className="btn btn-primary btn-sm"
                  disabled={!draft.name.trim()}
                  onClick={() => void addScheduleRule()}
                >
                  Simpan rule
                </button>
              </div>
            )}
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
            <h2>Plugins</h2>
            <p
              style={{
                fontSize: 'var(--text-sm)',
                color: 'var(--text-secondary)',
                marginBottom: 12
              }}
            >
              <code>.workspacegraph/plugins/*/manifest.json</code> — declarative commands; plugin
              dengan <code>main</code> berjalan di sandbox JS (vm + worker, izin per operasi tulis).
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
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 8
                  }}
                >
                  <div style={{ fontWeight: 600, fontSize: 'var(--text-sm)', minWidth: 0 }}>
                    {p.name}{' '}
                    <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>
                      v{p.version}
                    </span>
                    {p.js && (
                      <span
                        className="badge"
                        style={{
                          background: 'var(--color-primary)',
                          color: '#fff',
                          marginLeft: 6
                        }}
                        title="Plugin JS berjalan di sandbox (vm + worker), operasi tulis butuh izin"
                      >
                        JS sandbox
                      </span>
                    )}
                  </div>
                  {p.js && (
                    <button
                      className="btn btn-ghost btn-sm"
                      style={{ fontSize: 10, flexShrink: 0 }}
                      onClick={async () => {
                        await window.api.revokePluginPermissions(p.id)
                        flash(`Izin ${p.name} di-reset — prompt muncul lagi`)
                      }}
                    >
                      Reset izin
                    </button>
                  )}
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
                  } else if (c.action === 'js') {
                    void window.api.runPluginCommand(c.pluginId, c.id, c.args).then((res) => {
                      if (res.ok) {
                        const r = res.result
                        flash(
                          r !== undefined && r !== null
                            ? `OK: ${typeof r === 'object' ? JSON.stringify(r) : String(r)}`
                            : `OK: ${c.title}`
                        )
                      } else {
                        flash(res.error || 'Plugin gagal')
                      }
                    })
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

        {section === 'logs' && (
          <div className="settings-section">
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 8,
                marginBottom: 8
              }}
            >
              <h2 style={{ margin: 0 }}>AI Activity Log</h2>
              <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                <button
                  className="btn btn-surface btn-sm"
                  onClick={async () => {
                    try {
                      const res = await window.api.exportAIEventsCSV()
                      if (res.canceled) return
                      if (res.ok) flash(`CSV diekspor (${res.count} event): ${res.path}`)
                      else flash(res.error || 'Export gagal')
                    } catch (e) {
                      flash(e instanceof Error ? e.message : 'Export failed')
                    }
                  }}
                >
                  Ekspor CSV
                </button>
                <button className="btn btn-surface btn-sm" onClick={() => void loadAIEvents()}>
                  Refresh
                </button>
                <button
                  className={`btn btn-sm ${confirmClear ? 'btn-danger' : 'btn-ghost'}`}
                  onClick={() => void handleClearAIEvents()}
                >
                  {confirmClear ? 'Konfirmasi hapus?' : 'Clear log'}
                </button>
              </div>
            </div>
            <p
              style={{
                fontSize: 'var(--text-sm)',
                color: 'var(--text-secondary)',
                marginBottom: 8
              }}
            >
              Jejak terstruktur stream AI ke <code>.workspacegraph/logs/ai-events.jsonl</code>
              {logStats ? (
                <>
                  {' '}
                  · <b>{logStats.total}</b> event · {(logStats.sizeBytes / 1024).toFixed(0)} KB
                </>
              ) : null}
            </p>

            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                marginBottom: 12,
                fontSize: 'var(--text-sm)'
              }}
            >
              <label htmlFor="ai-log-retention" style={{ color: 'var(--text-secondary)' }}>
                Hapus otomatis event lebih tua dari
              </label>
              <select
                id="ai-log-retention"
                className="input"
                style={{ width: 150 }}
                value={retentionDays}
                onChange={(e) => void saveLogRetention(Number(e.target.value))}
              >
                <option value={0}>Off (simpan semua)</option>
                <option value={7}>7 hari</option>
                <option value={30}>30 hari</option>
                <option value={90}>90 hari</option>
                <option value={180}>180 hari</option>
                <option value={365}>1 tahun</option>
              </select>
            </div>

            <div className="ai-log-filters">
              {LOG_FILTERS.map((f) => (
                <button
                  key={f.id}
                  className={`ai-log-filter-chip ${logFilter === f.id ? 'active' : ''}`}
                  onClick={() => setLogFilter(f.id)}
                >
                  {f.label}
                </button>
              ))}
            </div>

            {aiEvents.length === 0 ? (
              <div
                style={{
                  fontSize: 'var(--text-xs)',
                  color: 'var(--text-muted)',
                  padding: '10px 0'
                }}
              >
                Belum ada aktivitas AI tercatat. Jalankan chat atau Test provider untuk mengisi log.
              </div>
            ) : (
              <div className="ai-log-list">
                {aiEvents
                  .filter((e) => logFilter === 'all' || e.status === logFilter)
                  .slice(0, 60)
                  .map((e, i) => (
                    <div key={`${e.ts}-${i}`} className="ai-log-row">
                      <div className="ai-log-time">
                        {e.ts
                          ? new Date(e.ts).toLocaleTimeString([], {
                              hour: '2-digit',
                              minute: '2-digit',
                              second: '2-digit'
                            })
                          : '—'}
                      </div>
                      <span
                        className={`badge ai-log-status ${
                          e.status === 'ok'
                            ? 'badge-success'
                            : e.status === 'error'
                              ? 'badge-error'
                              : e.status === 'timeout'
                                ? 'badge-warning'
                                : 'badge-surface'
                        }`}
                      >
                        {e.status || e.kind}
                      </span>
                      <div className="ai-log-main">
                        <div className="ai-log-title truncate">
                          {e.provider || '—'}
                          {e.model ? ` · ${e.model}` : ''}
                          {e.kind === 'pipeline' && e.stageCount
                            ? ` · pipeline ${e.stageCount} stage`
                            : ''}
                        </div>
                        {e.error && <div className="ai-log-err truncate">{e.error}</div>}
                      </div>
                      <div className="ai-log-nums">
                        {typeof e.durationMs === 'number'
                          ? `${(e.durationMs / 1000).toFixed(1)}s`
                          : '—'}
                        {typeof e.tokensUsed === 'number' && e.tokensUsed > 0
                          ? ` · ${e.tokensUsed >= 1000 ? `${(e.tokensUsed / 1000).toFixed(1)}k` : e.tokensUsed} tok`
                          : ''}
                      </div>
                    </div>
                  ))}
              </div>
            )}
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
