/** Theme preference + apply helpers (shared by AppShell, Settings, Editor). */

export type ThemePreference = 'dark' | 'light' | 'system' | 'high-contrast'
export type ThemeMode = 'dark' | 'light' | 'high-contrast'

const STORAGE_KEY = 'wg-theme'

export function resolveMode(pref: ThemePreference): ThemeMode {
  if (pref === 'high-contrast') return 'high-contrast'
  if (pref === 'system') {
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
  }
  return pref as ThemeMode
}

export function getCachedThemePref(): ThemePreference {
  try {
    const v = localStorage.getItem(STORAGE_KEY)
    if (v === 'dark' || v === 'light' || v === 'system' || v === 'high-contrast') return v
  } catch {
    /* ignore */
  }
  return 'dark'
}

export function applyTheme(pref: ThemePreference): ThemeMode {
  const mode = resolveMode(pref)
  const root = document.documentElement
  root.setAttribute('data-theme', mode)
  root.style.colorScheme = mode
  try {
    localStorage.setItem(STORAGE_KEY, pref)
  } catch {
    /* ignore */
  }
  // Sync Electron window chrome (title bar overlay) — high-contrast maps to dark chrome
  try {
    const chromeMode = mode === 'high-contrast' ? 'dark' : mode
    void window.api?.setTitleBarTheme?.(chromeMode)
  } catch {
    /* ignore */
  }
  return mode
}

/** Apply cached theme immediately, then reconcile with vault/user settings. */
export async function bootTheme(): Promise<ThemeMode> {
  let mode = applyTheme(getCachedThemePref())
  try {
    const settings = (await window.api.getSettings()) as { theme?: ThemePreference } | null
    if (settings?.theme) {
      mode = applyTheme(settings.theme)
    }
  } catch {
    /* settings unavailable — keep cache */
  }
  return mode
}

export function subscribeThemePreferenceChange(onChange: (mode: ThemeMode) => void): () => void {
  const mq = window.matchMedia('(prefers-color-scheme: light)')
  const onMq = (): void => {
    const pref = getCachedThemePref()
    if (pref === 'system') onChange(applyTheme('system'))
  }
  mq.addEventListener('change', onMq)

  const obs = new MutationObserver(() => {
    const attr = document.documentElement.getAttribute('data-theme')
    const mode: ThemeMode =
      attr === 'light' ? 'light' : attr === 'high-contrast' ? 'high-contrast' : 'dark'
    onChange(mode)
  })
  obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })

  return () => {
    mq.removeEventListener('change', onMq)
    obs.disconnect()
  }
}

export function getActiveMode(): ThemeMode {
  const attr = document.documentElement.getAttribute('data-theme')
  if (attr === 'light') return 'light'
  if (attr === 'high-contrast') return 'high-contrast'
  return 'dark'
}
