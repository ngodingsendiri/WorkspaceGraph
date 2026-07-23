/** Theme preference + apply helpers (shared by AppShell, Settings, Editor). */

export type ThemePreference = 'dark' | 'light' | 'system'
export type ThemeMode = 'dark' | 'light'

const STORAGE_KEY = 'wg-theme'

export function resolveMode(pref: ThemePreference): ThemeMode {
  if (pref === 'system') {
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
  }
  return pref
}

export function getCachedThemePref(): ThemePreference {
  try {
    const v = localStorage.getItem(STORAGE_KEY)
    if (v === 'dark' || v === 'light' || v === 'system') return v
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
  // Sync Electron window chrome (title bar overlay)
  try {
    void window.api?.setTitleBarTheme?.(mode)
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
    const mode = document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark'
    onChange(mode)
  })
  obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })

  return () => {
    mq.removeEventListener('change', onMq)
    obs.disconnect()
  }
}

export function getActiveMode(): ThemeMode {
  return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark'
}
