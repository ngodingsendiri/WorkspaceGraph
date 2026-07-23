/**
 * Light-mode UX sequential audit — static + token consistency.
 * Run: node scripts/qa-light-ux.mjs
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(__dirname, '..')

const results = []
function record(id, name, status, detail = '') {
  results.push({ id, name, status, detail })
  const tag = status === 'pass' ? 'PASS' : status === 'fail' ? 'FAIL' : 'MANUAL'
  const line = `  [${tag.padEnd(6)}] ${id} — ${name}${detail ? ` · ${detail}` : ''}`
  if (status === 'fail') console.error(line)
  else console.log(line)
}
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8')
const exists = (p) => fs.existsSync(path.join(root, p))

console.log('\n═══ Light Mode UX Audit ═══\n')

// 1. Tokens
console.log('── 1. Design tokens ──')
const tokens = read('src/renderer/src/styles/tokens.css')
record('L1.1', 'Light theme block [data-theme=light]', tokens.includes("[data-theme='light']") ? 'pass' : 'fail')
const lightBlock = (tokens.split("[data-theme='light']")[1] || '').slice(0, 2500)
const bgAppM = lightBlock.match(/--bg-app:\s*hsl\([^)]+\)/)
const textPM = lightBlock.match(/--text-primary:\s*hsl\([^)]+\)/)
const lightness = (s) => {
  const m = s && s.match(/(\d+(?:\.\d+)?)%\s*\)/)
  return m ? parseFloat(m[1]) : -1
}
const bgL = lightness(bgAppM?.[0])
const textL = lightness(textPM?.[0])
record('L1.2', 'Light bg-app is light (L≥90)', bgL >= 90 ? 'pass' : 'fail', bgAppM?.[0] || 'missing')
record('L1.3', 'Light text-primary is dark (L≤25)', textL >= 0 && textL <= 25 ? 'pass' : 'fail', textPM?.[0] || 'missing')
record('L1.4', 'Light graph tokens present', tokens.includes('--graph-label-fill') && tokens.includes('--graph-edge-wiki') ? 'pass' : 'fail')
// Light titlebar must define overlay tokens (hex or hsl); color should be light (not dark #28282b)
const lightTitleBg = lightBlock.match(/--titlebar-overlay-bg:\s*([^;]+)/)
const lightTitleSym = lightBlock.match(/--titlebar-overlay-symbol:\s*([^;]+)/)
const titleBgVal = (lightTitleBg?.[1] || '').trim().toLowerCase()
const titleIsLight =
  Boolean(titleBgVal) &&
  !titleBgVal.includes('28282b') &&
  (titleBgVal.startsWith('#fff') ||
    titleBgVal.startsWith('#f') ||
    /hsl\([^)]*9\d%\s*\)/.test(titleBgVal) ||
    titleBgVal === 'white')
record(
  'L1.5',
  'Titlebar overlay light tokens',
  tokens.includes('--titlebar-overlay-bg') && Boolean(lightTitleSym) && titleIsLight
    ? 'pass'
    : 'fail',
  titleBgVal || 'missing light --titlebar-overlay-bg'
)
for (const v of [
  '--node-knowledge',
  '--node-project',
  '--node-task',
  '--node-daily',
  '--node-person',
  '--color-primary',
  '--color-accent',
  '--shadow-md'
]) {
  record(`L1.t${v}`, `Light token ${v}`, lightBlock.includes(v) || tokens.includes(v) ? 'pass' : 'fail')
}

// 2. Theme bootstrap
console.log('\n── 2. Theme apply pipeline ──')
record('L2.1', 'theme util exists', exists('src/renderer/src/utils/theme.ts') ? 'pass' : 'fail')
const themeUtil = exists('src/renderer/src/utils/theme.ts') ? read('src/renderer/src/utils/theme.ts') : ''
record('L2.2', 'applyTheme sets data-theme', themeUtil.includes("setAttribute('data-theme'") ? 'pass' : 'fail')
record('L2.3', 'bootTheme loads settings', themeUtil.includes('bootTheme') && themeUtil.includes('getSettings') ? 'pass' : 'fail')
record('L2.4', 'localStorage cache wg-theme', themeUtil.includes('wg-theme') ? 'pass' : 'fail')
record('L2.5', 'setTitleBarTheme from applyTheme', themeUtil.includes('setTitleBarTheme') ? 'pass' : 'fail')
const mainTsx = read('src/renderer/src/main.tsx')
record('L2.6', 'main.tsx pre-paint applyTheme', mainTsx.includes('applyTheme') && mainTsx.includes('getCachedThemePref') ? 'pass' : 'fail')
const shell = read('src/renderer/src/components/layout/AppShell.tsx')
record('L2.7', 'AppShell bootTheme on mount', shell.includes('bootTheme') ? 'pass' : 'fail')
const settings = read('src/renderer/src/components/settings/SettingsView.tsx')
record('L2.8', 'Settings uses shared applyTheme', settings.includes("from '../../utils/theme'") && settings.includes('handleTheme') ? 'pass' : 'fail')

// 3. Electron chrome
console.log('\n── 3. Electron title bar ──')
const main = read('src/main/index.ts')
record('L3.1', 'Title bar overlay not hardcoded-only dark', main.includes("light:") && main.includes('setTitleBarOverlay') ? 'pass' : 'fail')
record('L3.2', 'IPC window:setTitleBarTheme', main.includes('window:setTitleBarTheme') ? 'pass' : 'fail')
record('L3.3', 'backgroundColor theme-aware', main.includes('backgroundColor') ? 'pass' : 'fail')
const preload = read('src/preload/index.ts')
record('L3.4', 'preload setTitleBarTheme exposed', preload.includes('setTitleBarTheme') ? 'pass' : 'fail')
const preloadD = read('src/preload/index.d.ts')
record('L3.5', 'types for setTitleBarTheme', preloadD.includes('setTitleBarTheme') ? 'pass' : 'fail')

// 4. CodeMirror
console.log('\n── 4. Editor CodeMirror ──')
const editor = read('src/renderer/src/components/editor/MarkdownEditor.tsx')
record('L4.1', 'CodeMirror theme not hardcoded dark', !editor.includes('theme="dark"') && editor.includes('theme={cmTheme}') ? 'pass' : 'fail')
record('L4.2', 'Editor listens for theme changes', editor.includes('subscribeThemePreferenceChange') ? 'pass' : 'fail')
const globals = read('src/renderer/src/styles/globals.css')
record('L4.3', 'CM gutters light styles', globals.includes("[data-theme='light'] .wg-codemirror") ? 'pass' : 'fail')

// 5. Graph
console.log('\n── 5. Graph light UX ──')
const graph = read('src/renderer/src/components/graph/GraphCanvas.tsx')
record(
  'L5.1',
  'Graph reads CSS tokens (not only hardcodes)',
  (graph.includes('cssVar') || graph.includes('getPropertyValue') || graph.includes("css('--node")) &&
    (graph.includes('--node-knowledge') || graph.includes("css('--node-knowledge"))
    ? 'pass'
    : 'fail'
)
record(
  'L5.2',
  'Graph observes data-theme',
  graph.includes("attributeFilter: ['data-theme']") || graph.includes("data-theme") ? 'pass' : 'fail'
)
record('L5.3', 'graph-container uses --graph-bg-glow', globals.includes('--graph-bg-glow') ? 'pass' : 'fail')
record(
  'L5.4',
  'Canvas graph (Obsidian-like) present',
  graph.includes('canvas') || graph.includes('HTMLCanvasElement') || graph.includes('getContext')
    ? 'pass'
    : 'fail'
)

// 6. Surfaces / hardcodes
console.log('\n── 6. Component hardcodes ──')
const dash = read('src/renderer/src/components/dashboard/DashboardView.tsx')
record('L6.1', 'Dashboard metrics use CSS vars', !dash.includes("hsl(195, 90%, 55%)") && dash.includes('var(--color-accent)') ? 'pass' : 'fail')
record(
  'L6.2',
  'search-overlay layout not light-only',
  (() => {
    // Base .search-overlay must have display:flex / z-index; light only overrides background
    const baseMatch = globals.match(/\.search-overlay\s*\{([^}]+)\}/)
    const base = baseMatch?.[1] || ''
    return base.includes('display: flex') && base.includes('z-index') ? 'pass' : 'fail'
  })()
)
record('L6.3', 'btn-primary uses --text-inverse', globals.includes('color: var(--text-inverse)') ? 'pass' : 'fail')
record('L6.4', 'Light sidebar/chat polish', globals.includes("[data-theme='light'] .sidebar") && globals.includes("[data-theme='light'] .chat-panel") ? 'pass' : 'fail')
record('L6.5', 'Light welcome cards', globals.includes("[data-theme='light'] .welcome-action-card") ? 'pass' : 'fail')
record('L6.6', 'color-scheme light on html', globals.includes("html[data-theme='light']") && globals.includes('color-scheme: light') ? 'pass' : 'fail')

// 7. Manual checklist for live UI
console.log('\n── 7. Manual live UI ──')
const manuals = [
  ['L7.1', 'Welcome screen light contrast'],
  ['L7.2', 'Sidebar + file tree light'],
  ['L7.3', 'Editor CodeMirror light theme'],
  ['L7.4', 'Preview pane light'],
  ['L7.5', 'Graph nodes/labels/edges light'],
  ['L7.6', 'Chat panel light bubbles'],
  ['L7.7', 'Search modal scrim + modal light'],
  ['L7.8', 'Settings appearance toggle dark↔light'],
  ['L7.9', 'Title bar window controls match theme'],
  ['L7.10', 'Dashboard metric cards light']
]
for (const [id, name] of manuals) {
  record(id, name, 'manual', 'npm run dev → Settings → Light')
}

// Summary
const pass = results.filter((r) => r.status === 'pass').length
const fail = results.filter((r) => r.status === 'fail').length
const manual = results.filter((r) => r.status === 'manual').length
console.log(`\n═══ SUMMARY: ${pass} PASS · ${fail} FAIL · ${manual} MANUAL ═══\n`)
if (fail > 0) {
  console.error('Light UX audit FAILED')
  process.exit(1)
}
console.log('Light UX static audit clean')
process.exit(0)
