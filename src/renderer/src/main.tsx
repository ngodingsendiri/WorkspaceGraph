import React from 'react'
import ReactDOM from 'react-dom/client'
// Google Material Symbols — self-hosted (works offline; same glyphs as fonts.google.com/icons)
import 'material-symbols/outlined.css'
import './styles/globals.css'
import App from './App'
import { ErrorBoundary } from './components/ui/ErrorBoundary'
import { applyTheme, getCachedThemePref } from './utils/theme'

// Apply theme before first paint to reduce FOUC (full reconcile in AppShell.bootTheme)
try {
  applyTheme(getCachedThemePref())
} catch (e) {
  console.error('[boot] applyTheme failed', e)
}

const rootEl = document.getElementById('root')
if (!rootEl) {
  document.body.innerHTML =
    '<pre style="padding:16px;color:#f88;font-family:Inter,\'Segoe UI Variable\',\'Segoe UI\',system-ui">#root missing — index.html broken</pre>'
} else {
  ReactDOM.createRoot(rootEl).render(
    <React.StrictMode>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </React.StrictMode>
  )
}
