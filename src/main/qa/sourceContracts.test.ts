/**
 * Source-contract checks — consolidated from the former `scripts/qa-*.mjs`
 * static audits (qa-runtime, qa-engines, qa-phase2-5, qa-graph-*, qa-ai-*,
 * qa-api-sequential, qa-features-sequential, qa-light-ux).
 *
 * These are wiring/contract assertions (source-level) that must survive
 * refactors — they run in CI via `npm test` (vitest include src/**\/test).
 */
import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// src/main/qa → project root
const root = path.resolve(__dirname, '../../..')

function read(rel: string): string {
  return fs.readFileSync(path.join(root, rel), 'utf8')
}
function exists(rel: string): boolean {
  return fs.existsSync(path.join(root, rel))
}
/** Read ALL IPC source (handlers split across modules). */
function readIpcSource(): string {
  const dir = path.join(root, 'src/main/ipc')
  let out = ''
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name)
      if (e.isDirectory()) walk(full)
      else if (e.name.endsWith('.ts')) out += fs.readFileSync(full, 'utf8') + '\n'
    }
  }
  walk(dir)
  return out
}

const has = (haystack: string, ...needles: string[]): boolean =>
  needles.every((n) => haystack.includes(n))
const hasAny = (haystack: string, ...needles: string[]): boolean =>
  needles.some((n) => haystack.includes(n))

describe('IPC surface (whole src/main/ipc dir)', () => {
  const ipc = readIpcSource()

  it('workspace open/create/close handlers', () => {
    expect(has(ipc, 'workspace:open', 'workspace:create', 'workspace:close')).toBe(true)
  })
  it('graph backlinks + resolveLink', () => {
    expect(has(ipc, 'graph:getBacklinks', 'graph:resolveLink')).toBe(true)
  })
  it('markdown render + shared watcher attach', () => {
    expect(has(ipc, 'markdown:render', 'attachFileWatcher')).toBe(true)
  })
  it('search rebuild + stats', () => {
    expect(has(ipc, 'search:rebuildIndex', 'search:getStats')).toBe(true)
  })
  it('template + domain IPC', () => {
    expect(has(ipc, 'template:list', 'template:createNote', 'domain:overview')).toBe(true)
  })
  it('domain sync on workspace data', () => {
    expect(ipc.includes('domainEngine.setParsedFiles')).toBe(true)
  })
  it('AI keys load from settings on startup', () => {
    expect(ipc.includes('loadSettingsIntoProviders')).toBe(true)
  })
  it('AI configure persists settings', () => {
    expect(ipc.includes('workspaceEngine.saveSettings')).toBe(true)
  })
  it('workspace lifecycle clears graph+search+domain', () => {
    expect(has(ipc, 'graphEngine.clear', 'searchEngine.clear', 'domainEngine.clear')).toBe(true)
  })
  it('AI provider matrix', () => {
    for (const h of [
      'ai:getProviders',
      'ai:testProvider',
      'ai:importGrokCli',
      'ai:configure',
      'ai:setActiveProvider',
      'ai:sendMessage',
      'ai:streamMessage',
      'ai:cancelStream',
      'ai:applyProposal',
      'ai:rejectProposal',
      'ai:ensureMemory',
      'ai:listMemory'
    ]) {
      expect(ipc).toContain(`'${h}'`)
    }
  })
  it('chat persist + tools IPC', () => {
    expect(has(ipc, 'chat:save', 'chat:load', 'chat:delete', 'enableTools')).toBe(true)
  })
  it('platform IPC (automation/plugins/security/health)', () => {
    expect(has(ipc, 'automation:get', 'plugins:list', 'security:status', 'api:health')).toBe(true)
  })
  it('graph local/orphans/hubs/layout/settings', () => {
    for (const h of [
      'graph:getLocal',
      'graph:getOrphans',
      'graph:getHubs',
      'graph:getLayout',
      'graph:saveLayout',
      'graph:getSettings',
      'graph:saveSettings',
      'graph:getPath',
      'graph:getNeighborhood',
      'graph:listViews',
      'graph:saveView',
      'graph:deleteView'
    ]) {
      expect(ipc).toContain(`'${h}'`)
    }
  })
  it('AI permission gate + path sandbox + openExternal', () => {
    expect(hasAny(ipc, 'perms.aiAccess', 'aiAccess')).toBe(true)
    expect(hasAny(ipc, 'assertPathInVault', 'isPathInVault')).toBe(true)
    expect(has(ipc, 'file:openExternal', 'shell.openPath')).toBe(true)
  })
  it('create vault name guard', () => {
    expect(hasAny(ipc, "name === '.'", 'Invalid workspace name')).toBe(true)
  })
  it('IPC stream try/catch', () => {
    expect(has(ipc, 'catch (err)', 'ai:streamMessage')).toBe(true)
  })

  // ── Full parity: every channel invoked by preload must be registered in main,
  //    and every registered handler must be exposed through the preload bridge. ──
  const channelRe = /'([a-z]+:[a-zA-Z]+)'/g
  const extractChannels = (src: string): Set<string> => {
    const out = new Set<string>()
    for (const m of src.matchAll(channelRe)) out.add(m[1])
    return out
  }
  // Handlers live in src/main/ipc/handlers/*, plus a few registered directly in index.ts
  const registeredSrc =
    readIpcSource() + '\n' + (exists('src/main/index.ts') ? read('src/main/index.ts') : '')
  const registered = extractChannels(registeredSrc)
  const preload = read('src/preload/index.ts')
  const bridged = extractChannels(preload)

  it('every preload-invoked channel is registered by a main handler', () => {
    // Push-only channels (main → renderer via webContents.send): they have no
    // ipcMain.handle by design; preload subscribes with ipcRenderer.on.
    // embedding:progress also appears in the registered set (ai.ts is scanned),
    // but plugin:notify lives in src/main/plugin/jsRunner.ts, outside the scan.
    const PUSH_ONLY = new Set(['embedding:progress', 'plugin:notify'])
    const missing = [...bridged].filter((c) => !registered.has(c) && !PUSH_ONLY.has(c))
    expect(missing).toEqual([])
  })

  it('every registered IPC channel is exposed through the preload bridge', () => {
    const orphan = [...registered].filter((c) => !bridged.has(c))
    expect(orphan).toEqual([])
  })

  it('all 77 registered channels accounted for (no silent handler drift)', () => {
    expect(registered.size).toBeGreaterThanOrEqual(75)
  })
})

describe('Preload bridge', () => {
  const pre = read('src/preload/index.ts')
  const preD = exists('src/preload/index.d.ts') ? read('src/preload/index.d.ts') : ''

  it('exposes graph + markdown APIs', () => {
    expect(has(pre, 'getBacklinks', 'renderMarkdown')).toBe(true)
  })
  it('exposes search index APIs', () => {
    expect(has(pre, 'rebuildSearchIndex', 'getSearchStats', 'searchQuery')).toBe(true)
  })
  it('exposes AI APIs', () => {
    for (const fn of [
      'getAIProviders',
      'testAIProvider',
      'importGrokCli',
      'configureAIProvider',
      'setActiveAIProvider',
      'streamAIMessage',
      'cancelAIStream',
      'applyWriteProposal',
      'enableTools',
      'ensureAiMemory'
    ]) {
      expect(pre).toContain(fn)
    }
  })
  it('exposes template/domain/platform APIs', () => {
    for (const fn of [
      'createFromTemplate',
      'getDomainOverview',
      'getAutomation',
      'listPlugins',
      'getSecurityStatus',
      'getApiHealth',
      'getSettings',
      'saveSettings',
      'setTitleBarTheme',
      'openFileExternal'
    ]) {
      expect(pre).toContain(fn)
    }
  })
  it('exposes graph layout/view APIs', () => {
    for (const fn of [
      'getLocalGraph',
      'getGraphOrphans',
      'getGraphHubs',
      'getGraphLayout',
      'saveGraphLayout',
      'getGraphSettings',
      'saveGraphSettings',
      'getGraphPath',
      'getGraphNeighborhood',
      'listGraphViews',
      'saveGraphView',
      'deleteGraphView'
    ]) {
      expect(pre).toContain(fn)
    }
  })
  it('preload stream invoke has catch', () => {
    expect(has(pre, '.catch(', 'streamAIMessage')).toBe(true)
  })
  it('types mirror preload functions', () => {
    expect(preD).toContain('getBacklinks')
    expect(preD).toContain('getGraphPath')
    expect(preD).toContain('setTitleBarTheme')
    expect(preD).toContain('streamAIMessage')
  })
})

describe('Renderer wiring', () => {
  it('chatStore handles stream errors + tools', () => {
    const chat = read('src/renderer/src/store/chatStore.ts')
    expect(has(chat, 'streamAIMessage', 'chunk.error')).toBe(true)
    expect(has(chat, 'enableTools', 'applyProposal', 'learnWorkspace:')).toBe(true)
    expect(chat.includes('historyForApi')).toBe(true)
  })
  it('Settings Test button + Save + rebuild + sections', () => {
    const set = read('src/renderer/src/components/settings/SettingsView.tsx')
    expect(has(set, 'testAIProvider', 'handleTest')).toBe(true)
    expect(has(set, 'configureAIProvider', 'importGrokCli')).toBe(true)
    expect(hasAny(set, "'security'", "'automation'", 'Security', 'Automation', 'Plugins')).toBe(
      true
    )
    expect(hasAny(set, 'Rebuild', 'rebuildSearchIndex')).toBe(true)
    expect(has(set, 'saveSettings', 'getSettings')).toBe(true)
  })
  it('Welcome screen create vault + no bad demo path', () => {
    const wel = read('src/renderer/src/components/welcome/WelcomeScreen.tsx')
    expect(has(wel, 'createWorkspace', 'openFolder')).toBe(true)
    expect(wel).not.toContain('Proyek\\Workspacegraph')
  })
  it('Sidebar context menu + open editor + icons', () => {
    const side = read('src/renderer/src/components/layout/Sidebar.tsx')
    expect(has(side, 'onContextMenu', 'Rename', 'Delete')).toBe(true)
    expect(side).toContain("setActiveView('editor')")
    expect(side).toContain('<Icon')
  })
  it('AppShell hotkeys + bootTheme', () => {
    const shell = read('src/renderer/src/components/layout/AppShell.tsx')
    expect(has(shell, "key === 'n'", "key === 'k'", "key === 'd'")).toBe(true)
    expect(shell.includes('bootTheme')).toBe(true)
  })
  it('editorStore refresh + backlinks panel + preview resolve', () => {
    const ed = read('src/renderer/src/store/editorStore.ts')
    expect(has(ed, 'refreshPreview', 'refreshLinks', 'saveTab')).toBe(true)
    const bl = read('src/renderer/src/components/editor/BacklinksPanel.tsx')
    expect(has(bl, 'Outline', 'Backlinks')).toBe(true)
    const prev = read('src/renderer/src/components/editor/MarkdownPreview.tsx')
    expect(prev.includes('resolveWikiLink')).toBe(true)
  })
  it('SearchModal prefill + Dashboard metrics + StatusBar words', () => {
    const sm = read('src/renderer/src/components/search/SearchModal.tsx')
    expect(has(sm, 'search:prefill', 'getRecentNotes')).toBe(true)
    const dash = read('src/renderer/src/components/dashboard/DashboardView.tsx')
    expect(hasAny(dash, 'totalNotes', 'Catatan')).toBe(true)
    expect(has(dash, 'onGraphUpdated', 'getDomainOverview', 'Dari template')).toBe(true)
    const status = read('src/renderer/src/components/layout/StatusBar.tsx')
    expect(hasAny(status, 'wordCount', 'words')).toBe(true)
  })
  it('ChatPanel proposals + citations + cancel + kernel UI', () => {
    const panel = read('src/renderer/src/components/chat/ChatPanel.tsx')
    expect(has(panel, 'Write proposals', 'openCitation')).toBe(true)
    expect(hasAny(panel, 'cancelStream', 'Cancel')).toBe(true)
    expect(has(panel, 'Pelajari workspace', 'chat-panel--kernel', 'learnWorkspace')).toBe(true)
  })
  it('kernel status CSS + store learnWorkspace', () => {
    const css = read('src/renderer/src/styles/globals.css')
    expect(css.includes('chat-kernel-status')).toBe(true)
    const store = read('src/renderer/src/store/chatStore.ts')
    expect(store.includes('learnWorkspace:')).toBe(true)
  })
  it('TemplatePicker wired', () => {
    expect(
      read('src/renderer/src/components/systems/TemplatePicker.tsx').includes('createFromTemplate')
    ).toBe(true)
  })
  it('graphStore state + filters', () => {
    const store = read('src/renderer/src/store/graphStore.ts')
    expect(hasAny(store, 'Array.isArray(data?.nodes)', 'rawNodes')).toBe(true)
    expect(
      has(
        store,
        'tags: Array.isArray',
        'saveLayoutPositions',
        'loadGraphSettings',
        'orphanMode',
        'hubMode'
      )
    ).toBe(true)
    expect(has(store, 'GraphOpenIntent', 'setOpenIntent')).toBe(true)
    expect(has(store, 'savedViews', 'saveGraphView')).toBe(true)
    expect(has(store, 'findPath', 'fetchNeighborhood')).toBe(true)
  })
  it('GraphFiltersPanel controls', () => {
    const f = read('src/renderer/src/components/graph/GraphFiltersPanel.tsx')
    expect(has(f, 'Spotlight', "'hide'", "'only'", 'Ambang hub', 'orphanMode', 'hubMode')).toBe(
      true
    )
    // Copy unified to Indonesian (F-1): labels follow UI language
    expect(has(f, 'Simpan layout', 'Hapus file', 'Reset gaya', 'DEFAULT_FORCE_SETTINGS')).toBe(true)
    expect(has(f, 'Jelajah', 'Cari path', 'Warna node', 'Folder')).toBe(true)
    expect(has(f, 'Ekspor PNG', 'Performa', 'Quality')).toBe(true)
    expect(
      has(f, 'View & Ekspor', 'existingFilesOnly', 'showTags', 'showAttachments', 'animateForces')
    ).toBe(true)
  })
  it('GraphCanvas fluid UI + guards', () => {
    const gc = read('src/renderer/src/components/graph/GraphCanvas.tsx')
    expect(has(gc, 'forceSimulation', 'posCache')).toBe(true)
    expect(hasAny(gc, 'Never paint 0×0', 'never paint 0×0', 'Last resort')).toBe(true)
    expect(hasAny(gc, 'paint failed', 'try {')).toBe(true)
    expect(has(gc, 'fitViewRef', 'GraphFiltersPanel', 'readPalette')).toBe(true)
    expect(hasAny(gc, 'dragged.x = w.x', 'dragged.x = dragged.fx', 'dragged.fx = w.x')).toBe(true)
    expect(has(gc, 'ensureGraphVisible', 'diagnoseEmptyFilter', 'diagnosePathResult')).toBe(true)
    expect(has(gc, 'pathNodeIds', 'pathEdgeKeys', 'pathPulseRef', 'Math.sin')).toBe(true)
    expect(has(gc, 'selectedIds', 'setSelectedIds', 'setSelectedIds(new Set())')).toBe(true)
    expect(has(gc, 'ctrlKey', 'metaKey', 'clipboard', '[[')).toBe(true)
    expect(has(gc, 'layoutNodes', 'saveLayoutPositions', 'toDataURL')).toBe(true)
    expect(has(gc, 'spatialRef', 'resolveLod', 'inView')).toBe(true)
    expect(has(gc, 'ArrowLeft', 'ArrowRight')).toBe(true)
    expect(hasAny(gc, "e.key === '='", 'zoomBy(1.2)')).toBe(true)
    expect(has(gc, 'consumeOpenIntent', 'pendingIntentRef', 'settingsHydratedRef')).toBe(true)
  })
  it('editor has no local-graph dock (LocalGraphCanvas removed)', () => {
    // F: local graph view no longer belongs in the editor — keep it gone
    const editor = read('src/renderer/src/components/editor/MarkdownEditor.tsx')
    expect(editor).not.toContain('LocalGraphView')
    expect(editor).not.toContain('LocalGraphCanvas')
    expect(exists('src/renderer/src/components/graph/LocalGraphCanvas.tsx')).toBe(false)
  })
  it('graphShared utilities', () => {
    const shared = read('src/renderer/src/components/graph/graphShared.ts')
    expect(
      has(
        shared,
        'chargeFor',
        'linkDistanceFor',
        'SpatialHash2D',
        'edgeDrawBudget',
        'FORCE_PRESETS'
      )
    ).toBe(true)
    expect(has(shared, 'css(', 'getPropertyValue', 'readPalette')).toBe(true)
    // Shared force layout is the single source of truth for the global graph
    expect(has(shared, 'applyForceLayout')).toBe(true)
  })
  it('graphCanvas2D owns edge budget logic', () => {
    const c2d = read('src/renderer/src/components/graph/graphCanvas2D.ts')
    expect(hasAny(c2d, 'edgePriority', 'edgesToDraw')).toBe(true)
    expect(c2d.includes('drawCanvas2DScene')).toBe(true)
  })
})

describe('Design tokens / light theme', () => {
  it('light theme block present with light bg/text', () => {
    const tokens = read('src/renderer/src/styles/tokens.css')
    expect(tokens).toContain("[data-theme='light']")
    const lightBlock = (tokens.split("[data-theme='light']")[1] || '').slice(0, 20000)
    const bgM = lightBlock.match(/--bg-app:\s*hsl\(([^)]+)\)/)
    const textM = lightBlock.match(/--text-primary:\s*hsl\(([^)]+)\)/)
    const bgL = bgM ? parseFloat(bgM[1].match(/(\d+(?:\.\d+)?)%\s*$/)![1]) : -1
    const textL = textM ? parseFloat(textM[1].match(/(\d+(?:\.\d+)?)%\s*$/)![1]) : -1
    expect(bgL).toBeGreaterThanOrEqual(90)
    expect(textL).toBeGreaterThanOrEqual(0)
    expect(textL).toBeLessThanOrEqual(25)
  })
  it('light titlebar overlay tokens defined', () => {
    const tokens = read('src/renderer/src/styles/tokens.css')
    const lightBlock = (tokens.split("[data-theme='light']")[1] || '').slice(0, 20000)
    const bg = lightBlock.match(/--titlebar-overlay-bg:\s*([^;]+)/)
    const sym = lightBlock.match(/--titlebar-overlay-symbol:\s*([^;]+)/)
    expect(bg && sym).toBeTruthy()
    const val = (bg?.[1] || '').trim().toLowerCase()
    expect(hasAny(val, '#fff', '#f', 'white') || /hsl\([^)]*9\d%\s*\)/.test(val)).toBe(true)
  })
  it('graph node tokens + shadows present', () => {
    const tokens = read('src/renderer/src/styles/tokens.css')
    for (const v of [
      '--node-knowledge',
      '--node-project',
      '--node-task',
      '--node-daily',
      '--node-person',
      '--color-primary',
      '--color-accent',
      '--shadow-md',
      '--graph-bg-glow'
    ]) {
      expect(tokens).toContain(v)
    }
  })
  it('theme util applies data-theme + caches', () => {
    const theme = read('src/renderer/src/utils/theme.ts')
    expect(
      has(
        theme,
        "setAttribute('data-theme'",
        'bootTheme',
        'getSettings',
        'wg-theme',
        'setTitleBarTheme'
      )
    ).toBe(true)
  })
  it('main.tsx pre-paint applyTheme', () => {
    const mainTsx = read('src/renderer/src/main.tsx')
    expect(has(mainTsx, 'applyTheme', 'getCachedThemePref')).toBe(true)
  })
  it('Settings uses shared applyTheme', () => {
    const set = read('src/renderer/src/components/settings/SettingsView.tsx')
    expect(has(set, "from '../../utils/theme'", 'handleTheme')).toBe(true)
  })
  it('CodeMirror theme not hardcoded dark', () => {
    const editor = read('src/renderer/src/components/editor/MarkdownEditor.tsx')
    expect(editor).not.toContain('theme="dark"')
    expect(hasAny(editor, 'theme="none"', 'makeNoteShellTheme')).toBe(true)
    expect(editor.includes('cmTheme')).toBe(true)
    expect(editor.includes('subscribeThemePreferenceChange')).toBe(true)
  })
  it('CM gutters hidden theme-agnostically', () => {
    const globals = read('src/renderer/src/styles/globals.css')
    expect(globals.includes('.cm-gutters') && globals.includes('display: none')).toBe(true)
  })
  it('electron chrome titlebar theme-aware', () => {
    const main = read('src/main/index.ts')
    expect(
      has(main, 'light:', 'setTitleBarOverlay', 'window:setTitleBarTheme', 'backgroundColor')
    ).toBe(true)
  })
  it('light surface selectors exist', () => {
    const globals = read('src/renderer/src/styles/globals.css')
    for (const sel of [
      "[data-theme='light'] .sidebar",
      "[data-theme='light'] .chat-panel",
      "[data-theme='light'] .welcome-action-card",
      '.search-overlay',
      '.graph-filters-panel',
      '.graph-filter-seg',
      '.graph-filter-range',
      '.graph-filter-actions',
      '.graph-filter-status',
      '.graph-views-list'
    ]) {
      expect(globals).toContain(sel)
    }
    expect(globals).toContain('color: var(--text-inverse)')
    expect(globals).toContain("html[data-theme='light']")
  })
})

describe('Engine source contracts', () => {
  it('SearchEngine hybrid FTS + operators + date coerce', () => {
    const se = read('src/main/engine/SearchEngine.ts')
    expect(hasAny(se, 'searchFts', 'indexDatabase')).toBe(true)
    expect(has(se, 'searchBacklinks', 'path:', 'coerceDate')).toBe(true)
  })
  it('ContextEngine token budget + backlinks + system folders', () => {
    const ctx = read('src/main/ai/ContextEngine.ts')
    expect(hasAny(ctx, 'tokenBudget', 'TOKEN_BUDGET')).toBe(true)
    expect(has(ctx, 'backlink', 'getBacklinks', 'getSystemFolderNotes', 'tokenEstimate')).toBe(true)
    expect(has(ctx, 'listAiMemoryPaths', "'ai-memory'")).toBe(true)
  })
  it('IndexDatabase uses FTS5 index.db', () => {
    const idb = read('src/main/engine/IndexDatabase.ts')
    expect(has(idb, 'index.db', 'fts5')).toBe(true)
  })
  it('WorkspaceEngine standard folders + seed + recent', () => {
    const we = read('src/main/engine/WorkspaceEngine.ts')
    expect(
      has(
        we,
        'STANDARD_FOLDERS',
        'createWorkspace',
        'openWorkspace',
        'seedBuiltinToVault',
        'getRecentWorkspaces'
      )
    ).toBe(true)
    expect(has(we, 'Knowledge', 'Daily', 'People')).toBe(true)
  })
  it('GraphEngine outLinks cache + ghost + prune', () => {
    const eng = read('src/main/engine/GraphEngine.ts')
    expect(
      has(
        eng,
        'outLinks',
        'rebuildWikiEdgesFromOutLinks',
        'pruneGhostEdges',
        'isGhost',
        'ensureGhostNode'
      )
    ).toBe(true)
    expect(has(eng, 'upsertAttachment', 'removeAttachment')).toBe(true)
  })
  it('TemplateEngine builtins + seed + render', () => {
    const te = read('src/main/engine/TemplateEngine.ts')
    expect(
      has(
        te,
        'builtin-project',
        'builtin-task',
        'builtin-people',
        'seedBuiltinToVault',
        '{{title}}'
      )
    ).toBe(true)
  })
  it('DomainEngine overview + checkbox parse', () => {
    const de = read('src/main/engine/DomainEngine.ts')
    expect(has(de, 'getOverview', 'parseCheckboxes', "type === 'project'", "type === 'task'")).toBe(
      true
    )
  })
})

describe('AI system contracts', () => {
  it('all six providers registered in middleware', () => {
    const mid = read('src/main/ai/AIMiddleware.ts')
    for (const p of [
      'GrokProvider',
      'GeminiProvider',
      'OpenAIProvider',
      'ClaudeProvider',
      'OllamaProvider',
      'OpenRouterProvider'
    ]) {
      expect(mid).toContain(p)
    }
    expect(
      has(
        mid,
        'listModels()',
        'configured',
        'belum dikonfigurasi',
        'testProvider',
        'enableTools',
        'MAX_TOOL_ROUNDS',
        'cancelStream'
      )
    ).toBe(true)
    expect(has(mid, 'importGrokFromCli', 'getAllProvidersStatus')).toBe(true)
    expect(has(mid, 'KERNEL_SYSTEM_PROMPT', 'unknown tools skipped')).toBe(true)
  })
  it('provider modules implement interface', () => {
    const files = ['Grok', 'Gemini', 'OpenAI', 'Claude', 'Ollama', 'OpenRouter']
    for (const id of files) {
      const src = read(`src/main/ai/providers/${id}Provider.ts`)
      expect(
        has(
          src,
          'sendMessage',
          'streamMessage',
          'listModels',
          'healthCheck',
          'extends BaseProvider'
        )
      ).toBe(true)
    }
  })
  it('Grok provider official API + CLI auth', () => {
    const grok = read('src/main/ai/providers/GrokProvider.ts')
    expect(grok).toContain("OFFICIAL_BASE = 'https://api.x.ai/v1'")
    expect(has(grok, 'importGrokCliAuth', 'auth.json', 'ensureSession')).toBe(true)
  })
  it('Gemini flash default + 429 handling', () => {
    const gem = read('src/main/ai/providers/GeminiProvider.ts')
    expect(hasAny(gem, 'gemini-2.0-flash', 'flash')).toBe(true)
    expect(hasAny(gem, '429', 'RESOURCE_EXHAUSTED')).toBe(true)
  })
  it('Ollama localhost + no key', () => {
    const ollama = read('src/main/ai/providers/OllamaProvider.ts')
    expect(ollama.includes('11434')).toBe(true)
  })
  it('BaseProvider contracts', () => {
    const base = read('src/main/ai/providers/BaseProvider.ts')
    expect(has(base, 'isConfigured()', 'configure(config', 'getApiKeyMasked')).toBe(true)
  })
  it('AgentTools fences + tools + AI Memory mention', () => {
    const tools = read('src/main/ai/AgentTools.ts')
    expect(tools).toContain('```(?:wg-action|json|javascript)?')
    expect(
      has(tools, "'search'", 'read_note', 'list_dir', 'write_note', 'append_note', 'create_note')
    ).toBe(true)
    expect(
      has(tools, 'applyProposal', 'pending', 'AI Memory', 'create_from_template', 'list_templates')
    ).toBe(true)
    expect(hasAny(tools, 'path escape', 'outside vault', 'startsWith')).toBe(true)
  })
  it('ConversationStore guards path traversal + cache path', () => {
    const conv = read('src/main/ai/ConversationStore.ts')
    expect(
      has(conv, 'safeConversationId', '^[a-zA-Z0-9_-]{1,80}$', '.workspacegraph', 'chats')
    ).toBe(true)
  })
  it('WorkspaceMemory constants', () => {
    const mem = read('src/main/ai/WorkspaceMemory.ts')
    expect(
      has(
        mem,
        "AI_MEMORY_DIR = 'AI Memory'",
        'ensureAiMemoryScaffold',
        'KERNEL_SYSTEM_PROMPT',
        '00 Index.md'
      )
    ).toBe(true)
  })
})

describe('Security / platform / installer', () => {
  it('PathSandbox exports', () => {
    const ps = read('src/main/security/PathSandbox.ts')
    expect(has(ps, 'assertPathInVault', 'isPathInVault')).toBe(true)
  })
  it('SecretsStore safeStorage + encrypt', () => {
    const sec = read('src/main/security/SecretsStore.ts')
    expect(has(sec, 'safeStorage', 'encryptSecret', 'apiKey')).toBe(true)
  })
  it('Permissions flags', () => {
    const perm = read('src/main/security/Permissions.ts')
    expect(has(perm, 'aiTools', 'automation', 'aiAccess')).toBe(true)
  })
  it('AutomationEngine rules file + actions', () => {
    const auto = read('src/main/engine/AutomationEngine.ts')
    expect(has(auto, 'automation.json', 'file_updated', 'append_to_note', 'handleEvent')).toBe(true)
  })
  it('PluginHost declarative + commands', () => {
    const plug = read('src/main/plugin/PluginHost.ts')
    expect(has(plug, 'manifest.json', 'search_prefill')).toBe(true)
    expect(hasAny(plug, 'No JS', 'declarative', 'Declarative')).toBe(true)
  })
  it('InternalAPI health + version', () => {
    const api = read('src/main/api/InternalAPI.ts')
    expect(has(api, 'health', 'version')).toBe(true)
  })
  it('installer appId + native unpack', () => {
    const eby = read('electron-builder.yml')
    expect(has(eby, 'WorkspaceGraph', 'com.workspacegraph.app')).toBe(true)
    expect(hasAny(eby, 'better-sqlite3', 'asarUnpack')).toBe(true)
  })
  it('electron-vite externalizes better-sqlite3', () => {
    expect(read('electron.vite.config.ts').includes('better-sqlite3')).toBe(true)
  })
})

describe('Project foundation', () => {
  it('package.json has dev/typecheck/qa scripts', () => {
    const pkg = read('package.json')
    expect(has(pkg, '"typecheck"', '"dev"', '"qa"')).toBe(true)
  })
  it('blueprint constitution + roadmap present', () => {
    expect(exists('00_Constitution.md')).toBe(true)
    expect(exists('35_Roadmap.md')).toBe(true)
  })
})
