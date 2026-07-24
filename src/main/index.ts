import { app, shell, BrowserWindow, ipcMain, nativeTheme } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { registerIPCHandlers } from './ipc'
import { workspaceEngine } from './engine/WorkspaceEngine'

/* Global graph now uses SVG for display; GPU flag left optional only. */

/**
 * Must match --bg-surface in tokens.css so Windows caption buttons
 * (min/max/close) sit on the same strip as the app titlebar — not a floating island.
 */
const TITLEBAR = {
  dark: {
    color: '#28282b', // hsl(240, 4%, 16%) ≈ --bg-surface
    symbolColor: '#a1a1aa',
    height: 40
  },
  light: {
    // Match tokens.css [data-theme=light] --titlebar-overlay-bg / --bg-surface
    color: '#ffffff',
    symbolColor: '#64748b',
    height: 40
  }
} as const

/** App chrome background ≈ --bg-app light hsl(220,18%,96%) */
const APP_BG = {
  dark: '#1f1f22',
  light: '#f2f4f7'
} as const

function resolveOverlayTheme(): 'dark' | 'light' {
  try {
    const settings = workspaceEngine.getSettings() as { theme?: string }
    const t = settings?.theme
    if (t === 'light') return 'light'
    if (t === 'dark') return 'dark'
    if (t === 'system') {
      return nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
    }
  } catch {
    /* default dark */
  }
  return 'dark'
}

function applyTitleBarOverlay(win: BrowserWindow, mode: 'dark' | 'light'): void {
  if (typeof win.setTitleBarOverlay !== 'function') return
  const c = TITLEBAR[mode]
  try {
    win.setTitleBarOverlay({
      color: c.color,
      symbolColor: c.symbolColor,
      height: c.height
    })
  } catch {
    /* not supported on this platform */
  }
}

function createWindow(): void {
  const mode = resolveOverlayTheme()
  const overlay = TITLEBAR[mode]

  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    // Seamless custom chrome + OS min/max/close
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: overlay.color,
      symbolColor: overlay.symbolColor,
      height: overlay.height
    },
    backgroundColor: mode === 'light' ? APP_BG.light : APP_BG.dark,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  /**
   * CSP for Electron renderer.
   * - Allow Vite HMR (ws/localhost) in dev
   * - Allow Google Fonts / Material Symbols (fonts.google.com + gstatic)
   * - unsafe-eval needed by Vite React refresh in development
   * Previous overly-strict CSP caused blank UI (blocked fonts + HMR).
   */
  mainWindow.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          [
            "default-src 'self'",
            "script-src 'self' 'unsafe-eval' 'unsafe-inline'",
            "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
            "font-src 'self' data: https://fonts.gstatic.com",
            "img-src 'self' data: blob:",
            "connect-src 'self' https: http://localhost:* http://127.0.0.1:* ws://localhost:* ws://127.0.0.1:* wss://localhost:* wss://127.0.0.1:*",
            "worker-src 'self' blob:"
          ].join('; ')
        ]
      }
    })
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.workspacegraph.app')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  registerIPCHandlers()

  // Theme-aware Windows title bar overlay (also callable from renderer)
  ipcMain.handle('window:setTitleBarTheme', (_, mode: 'dark' | 'light') => {
    const m = mode === 'light' ? 'light' : 'dark'
    for (const win of BrowserWindow.getAllWindows()) {
      applyTitleBarOverlay(win, m)
    }
    return true
  })

  createWindow()

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
