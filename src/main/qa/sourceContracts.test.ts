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
    // Robustness: a malformed (non-array) defs payload is rejected, so a buggy
    // renderer can never wipe the saved provider list by accident
    expect(ipc.includes("'defs must be an array'")).toBe(true)
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
    // Bad-key failures surface ON the card (not just a toast): red status line +
    // a "Ganti key" action that focuses the key input; typing clears it locally
    expect(has(set, 'AUTH_ERROR_RE', 'providerIssue', 'Ganti key')).toBe(true)
    expect(set.includes('keyInputRefs')).toBe(true)
    expect(set.includes('API key tidak valid')).toBe(true)
    // A newly typed key is verified automatically on Save/add — live Test +
    // Refresh models run without extra clicks (card shows the status directly)
    expect(has(set, 'autoVerifyProvider', 'handleTest', 'handleRefreshModels')).toBe(true)
    expect(set.includes('tes otomatis')).toBe(true)
    expect(has(set, 'await autoVerifyProvider(def.id)', 'await autoVerifyProvider(finalId)')).toBe(
      true
    )
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
  it('P1-1 per-tool streaming trail wired end-to-end', () => {
    const mid = read('src/main/ai/AIMiddleware.ts')
    expect(has(mid, 'ToolRunEvent', 'nextToolRunId', "status: 'running'")).toBe(true)
    const store = read('src/renderer/src/store/chatStore.ts')
    expect(has(store, 'toolRuns', 'runId', 'interrupted')).toBe(true)
    const panel = read('src/renderer/src/components/chat/ChatPanel.tsx')
    expect(has(panel, 'ToolRunList', 'chat-toolrun')).toBe(true)
    expect(read('src/renderer/src/styles/globals.css').includes('chat-toolruns')).toBe(true)
  })
  it('P1-2 cite-on-hover preview wired end-to-end', () => {
    const tip = read('src/renderer/src/components/chat/chatCitationTip.ts')
    expect(has(tip, 'makeCitePreviewCache', 'TooltipPreviewCache', 'citeTipPos')).toBe(true)
    const panel = read('src/renderer/src/components/chat/ChatPanel.tsx')
    expect(has(panel, 'showCiteTip', 'chat-cite-tooltip', 'createPortal')).toBe(true)
    expect(read('src/renderer/src/styles/globals.css').includes('chat-cite-tooltip')).toBe(true)
  })
  it('P1-3 inline model picker wired end-to-end', () => {
    const picker = read('src/renderer/src/components/chat/chatModelPicker.ts')
    expect(has(picker, 'AUTO_MODEL', 'resolveAutoModel', 'buildModelGroups')).toBe(true)
    const store = read('src/renderer/src/store/chatStore.ts')
    expect(has(store, "selectedModelId: 'auto'", 'isAutoModel')).toBe(true)
    const panel = read('src/renderer/src/components/chat/ChatPanel.tsx')
    expect(has(panel, 'chat-model-chip', 'chat-model-picker', 'pickAuto')).toBe(true)
    // A concrete pick persists as the provider's default (survives sessions)
    expect(has(panel, 'setAIProviderDefaultModel', 'isAutoModel(modelId)')).toBe(true)
    expect(read('src/renderer/src/styles/globals.css').includes('chat-model-chip')).toBe(true)
  })
  it('P2-1 token budget bar wired end-to-end', () => {
    const budget = read('src/renderer/src/components/chat/chatTokenBudget.ts')
    expect(has(budget, 'contextBudgetForModel', 'sessionTokenStats', 'formatK')).toBe(true)
    const panel = read('src/renderer/src/components/chat/ChatPanel.tsx')
    expect(has(panel, 'chat-budget', 'outputTokens', 'budgetFraction')).toBe(true)
    expect(read('src/renderer/src/styles/globals.css').includes('chat-budget-fill')).toBe(true)
  })
  it('P2-2 tool summary in the status line wired', () => {
    const sum = read('src/renderer/src/components/chat/chatToolSummary.ts')
    expect(has(sum, 'summarizeToolRuns', 'toolSummaryLabel', 'tools:')).toBe(true)
    const panel = read('src/renderer/src/components/chat/ChatPanel.tsx')
    expect(has(panel, 'toolSummaryLabel', 'toolSummaryText')).toBe(true)
  })
  it('P2-3 composer slash commands wired', () => {
    const cmds = read('src/renderer/src/components/chat/chatSlashCommands.ts')
    expect(has(cmds, 'SLASH_COMMANDS', 'filterSlashCommands', "'/compact'", "'/plan'")).toBe(true)
    const panel = read('src/renderer/src/components/chat/ChatPanel.tsx')
    expect(has(panel, 'slashOpen', 'chat-slash-picker', 'selectSlash')).toBe(true)
    expect(read('src/renderer/src/styles/globals.css').includes('chat-slash-picker')).toBe(true)
  })
  it('P2-6 proposal diff preview reuses MergeDialog + apply content override', () => {
    const dialog = read('src/renderer/src/components/editor/MergeDialog.tsx')
    // MergeDialog gained the proposal variant (Disk/Proposal/Diff tabs)
    expect(has(dialog, "variant?: 'conflict' | 'proposal'", 'diffLines', 'diffStats')).toBe(true)
    expect(has(dialog, 'Proposal (baru)', 'Sekarang (disk)', 'Terapkan proposal')).toBe(true)
    const panel = read('src/renderer/src/components/chat/ChatPanel.tsx')
    expect(has(panel, "from '../editor/MergeDialog'", 'diffTarget', 'openDiff')).toBe(true)
    expect(has(panel, 'variant="proposal"', 'Diff')).toBe(true)
    const store = read('src/renderer/src/store/chatStore.ts')
    expect(
      has(store, 'applyProposal: (', 'content?: string)', 'applyWriteProposal(id, content)')
    ).toBe(true)
    // Content override travels main → disk (edited proposal applies as-is)
    const tools = read('src/main/ai/AgentTools.ts')
    expect(has(tools, 'contentOverride?: string', 'content = contentOverride')).toBe(true)
    const ipc = read('src/main/ipc/handlers/ai.ts')
    expect(has(ipc, '(_, proposalId: string, content?: string)')).toBe(true)
    expect(read('src/preload/index.ts').includes('proposalId, content')).toBe(true)
    expect(read('src/renderer/src/styles/globals.css').includes('merge-diff')).toBe(true)
  })
  it('P3-1 follow-up composer mode wired end-to-end', () => {
    const helper = read('src/renderer/src/components/chat/chatFollowUp.ts')
    expect(has(helper, 'followUpPreamble', 'followUpChipLabel', 'Konteks follow-up')).toBe(true)
    const store = read('src/renderer/src/store/chatStore.ts')
    expect(has(store, 'followUpMessageId', 'setFollowUp', 'followUpPreamble(src?.proposals)')).toBe(
      true
    )
    expect(has(store, 'followUpMessageId: null')).toBe(true)
    const panel = read('src/renderer/src/components/chat/ChatPanel.tsx')
    expect(
      has(panel, 'startFollowUp', 'Follow-up', 'chat-followup-chip', 'followUpChipLabel')
    ).toBe(true)
    expect(read('src/renderer/src/styles/globals.css').includes('chat-followup-chip')).toBe(true)
  })
  it('P3-2 regenerate re-arms follow-up context from the stamped message', () => {
    const store = read('src/renderer/src/store/chatStore.ts')
    // User messages stamp the follow-up source on send
    expect(has(store, 'followUpFrom?: string', 'followUpFrom: followUpMessageId')).toBe(true)
    // Retry/Regenerate re-arms from the stamped source before re-sending
    expect(has(store, 'followUpMessageId: lastUser.followUpFrom ?? null')).toBe(true)
    // Persisted so a loaded session still regenerates with context — proposals
    // included, since the preamble + Follow-up button read them off the message
    expect(has(store, 'followUpFrom: m.followUpFrom', 'proposals: m.proposals')).toBe(true)
  })
  it('P2-4 reasoning streaming wired end-to-end', () => {
    const compat = read('src/main/ai/providers/openaiCompat.ts')
    // Shared delta extractor — both field names, no per-provider drift
    expect(has(compat, 'export function deltaReasoning', 'reasoning_content')).toBe(true)
    const base = read('src/main/ai/providers/BaseProvider.ts')
    expect(has(base, 'reasoning?: string')).toBe(true)
    // All three OpenAI-compat providers capture it (never just one)
    for (const p of ['Grok', 'OpenAI', 'OpenRouter']) {
      expect(read(`src/main/ai/providers/${p}Provider.ts`).includes('deltaReasoning(delta)')).toBe(
        true
      )
    }
    // Middleware passes it through untouched; store accumulates + persists
    expect(read('src/main/ai/AIMiddleware.ts').includes('reasoning: chunk.reasoning')).toBe(true)
    const store = read('src/renderer/src/store/chatStore.ts')
    expect(
      has(store, "(m.reasoning || '') + (chunk.reasoning || '')", 'reasoning: m.reasoning')
    ).toBe(true)
    // Renderer: collapsible block before the answer + CSS
    const panel = read('src/renderer/src/components/chat/ChatPanel.tsx')
    expect(has(panel, 'ReasoningBlock', 'chat-reasoning', 'Berpikir')).toBe(true)
    expect(read('src/renderer/src/styles/globals.css').includes('chat-reasoning')).toBe(true)
  })
  it('P2-7 proposal dock syncs to the loaded chat + vault reopen', () => {
    const store = read('src/renderer/src/store/chatStore.ts')
    // loadChat drops the old session's dock, then restores from loaded messages
    // merged with disk-pending (applied/rejected filtered out)
    expect(has(store, 'pendingProposals: []', 'await get().refreshProposals()')).toBe(true)
    expect(has(store, 'flatMap((m) => m.proposals || [])')).toBe(true)
    expect(has(store, "p.status === 'pending' || !p.status")).toBe(true)
    // ChatPanel re-hydrates the dock whenever the vault changes (restart flow)
    const panel = read('src/renderer/src/components/chat/ChatPanel.tsx')
    expect(has(panel, 's.rootPath', 'void refreshProposals()')).toBe(true)
  })
  it('P2-5 slash commands surface in the global CommandPalette', () => {
    const cmds = read('src/renderer/src/components/chat/chatSlashCommands.ts')
    expect(
      has(
        cmds,
        'requestComposerCommand',
        'consumeComposerCommand',
        'findSlashCommand',
        "'wg:composer-command'"
      )
    ).toBe(true)
    const palette = read('src/renderer/src/components/ui/CommandPalette.tsx')
    expect(
      has(palette, "from '../chat/chatSlashCommands'", 'requestComposerCommand', "group: 'Chat'")
    ).toBe(true)
    const panel = read('src/renderer/src/components/chat/ChatPanel.tsx')
    expect(has(panel, 'wg:composer-command', 'consumeComposerCommand', 'fillComposer')).toBe(true)
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
    expect(has(gc, 'pathNodeIds', 'pathEdgeKeys')).toBe(true)
    // G17: the path-pulse subsystem (pathPulseRef + sine loop) was removed for
    // renderer parity — a canvas-only breathing highlight broke the SVG↔canvas
    // handoff. Guard it stays gone.
    expect(gc).not.toContain('pathPulseRef')
    // G-series module split: the renderer must consume the parity + diagnostics
    // modules (never re-derive a per-renderer literal)
    expect(has(gc, "from './graphRenderTokens'", "from './graphDiagnostics'")).toBe(true)
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
    expect(has(shared, 'chargeFor', 'linkDistanceFor', 'edgeDrawBudget', 'FORCE_PRESETS')).toBe(
      true
    )
    expect(has(shared, 'css(', 'getPropertyValue', 'readPalette')).toBe(true)
    // Shared force layout is the single source of truth for the global graph
    expect(has(shared, 'applyForceLayout')).toBe(true)
  })
  it('renderer parity tokens live in graphRenderTokens (G1–G17 anti-drift)', () => {
    const tokens = read('src/renderer/src/components/graph/graphRenderTokens.ts')
    expect(
      has(
        tokens,
        'nodeRadiusFor',
        'edgeWidthFor',
        'hoverEaseStep',
        'HOVER_GLOW_ALPHA',
        'edgeGlowAlpha',
        'HOT_EDGE_COLOR_HS',
        'hotEdgeWidth',
        'baseEdgeOpacity',
        'hotEdgeOpacity',
        'PATH_EDGE_OP',
        'PATH_EDGE_W',
        'baseEdgeWidth',
        'labelZoomAlpha',
        // G19: node entry animation lives here too (shared by both renderers)
        'nodeEntryProgress',
        'nodeEntryScale',
        'nodeEntryOpacity',
        // P1-1: edge entry fade (slowest-endpoint rule) shared by both renderers
        'edgeEntryOpacity',
        // G20: edge color by type — single source for both renderers
        'edgeColorFor',
        // G-perf: sim-motion SVG reconciliation throttle
        'shouldThrottleSvgPush',
        'SVG_PUSH_THROTTLE_MS',
        // LOD culling: shared frustum rule for both renderers
        'cullMargin',
        'pointOnScreen',
        'edgeOnScreen'
      )
    ).toBe(true)
  })
  it('LOD viewport culling wired in BOTH renderers (shared rule, no handoff pop)', () => {
    const gc = read('src/renderer/src/components/graph/GraphCanvas.tsx')
    const c2d = read('src/renderer/src/components/graph/graphCanvas2D.ts')
    // SVG frame build culls off-frustum nodes AND edges via the shared helpers
    expect(has(gc, 'const margin = cullMargin(lod)')).toBe(true)
    expect(has(gc, 'pointOnScreen(sx, sy, w, h, margin)')).toBe(true)
    expect(has(gc, 'edgeOnScreen(esx1, esy1, esx2, esy2, w, h, margin)')).toBe(true)
    // Canvas2D gesture renderer uses the SAME helpers + margin (parity)
    expect(has(c2d, 'const margin = cullMargin(lod)')).toBe(true)
    expect(has(c2d, 'edgeOnScreen(')).toBe(true)
    expect(has(c2d, 'pointOnScreen(n.x * k + tx, n.y * k + ty, w, h, margin)')).toBe(true)
  })
  it('edge entry animation wired in BOTH renderers (P1-1 parity)', () => {
    const gc = read('src/renderer/src/components/graph/GraphCanvas.tsx')
    const c2d = read('src/renderer/src/components/graph/graphCanvas2D.ts')
    const rt = read('src/renderer/src/components/graph/graphRenderTokens.ts')
    // Shared helper exists and both renderers multiply edge op by it
    expect(has(rt, 'export function edgeEntryOpacity')).toBe(true)
    expect(has(gc, 'op *= entryOp')).toBe(true)
    expect(has(gc, 'op: edgeGlowAlpha(hs, onPath) * entryOp')).toBe(true)
    expect(has(c2d, 'edgeAlpha *= entryOp')).toBe(true)
    expect(has(c2d, 'edgeGlowAlpha(hs, onPath) * entryOp')).toBe(true)
    // Same time base for the whole scene (edges + nodes share entryNow)
    expect(has(gc, 'const entryNow = performance.now()')).toBe(true)
    expect(has(c2d, 'const entryNow = dc.entryComplete')).toBe(true)
  })
  it('perf overlay shows LOD culling pre→post counts (D)', () => {
    const gc = read('src/renderer/src/components/graph/GraphCanvas.tsx')
    const ps = read('src/renderer/src/components/graph/graphPerfStats.ts')
    const gt = read('src/renderer/src/components/graph/graphTypes.ts')
    // Frame carries culling stats; the sampler records them; overlay derives culled
    expect(has(gc, 'culled: {')).toBe(true)
    expect(has(gc, 'renderedEdges: edgeList.length')).toBe(true)
    expect(has(gc, 'renderedNodes: nodesRendered')).toBe(true)
    expect(has(gc, 'totalEdges: svgFrame.culled?.totalEdges ?? 0')).toBe(true)
    expect(has(gc, 'totalEdges - perfSnap.renderedEdges')).toBe(true)
    expect(has(ps, 'totalEdges: number')).toBe(true)
    expect(has(ps, 'renderedNodes: number')).toBe(true)
    expect(has(gt, 'export type CulledStats')).toBe(true)
  })
  it('sim-motion SVG throttle wired in GraphCanvas (G-perf)', () => {
    const gc = read('src/renderer/src/components/graph/GraphCanvas.tsx')
    // Throttle engaged only while the sim moves; flush on settle + gesture
    expect(has(gc, 'svgThrottleRef.current = activeSim.alpha() >= 0.05')).toBe(true)
    expect(has(gc, 'flushSvgFrameRef.current()')).toBe(true)
    expect(has(gc, 'shouldThrottleSvgPush')).toBe(true)
  })
  it('real-browser perf overlay wired in GraphCanvas (G-perf)', () => {
    const gc = read('src/renderer/src/components/graph/GraphCanvas.tsx')
    const ps = read('src/renderer/src/components/graph/graphPerfStats.ts')
    // Toggle key D + overlay panel + rolling stats module + layout-effect timing
    expect(has(gc, "e.key === 'd' || e.key === 'D'")).toBe(true)
    expect(has(gc, 'graph-perf-overlay')).toBe(true)
    expect(has(gc, 'RollingPerfStats')).toBe(true)
    expect(has(gc, 'useLayoutEffect')).toBe(true)
    expect(has(gc, 'SVG_PUSH_THROTTLE_MS')).toBe(true)
    expect(has(ps, 'export class RollingPerfStats')).toBe(true)
    expect(has(ps, 'p95CommitMs')).toBe(true)
  })
  it('adaptive throttle window wired in GraphCanvas (G-perf)', () => {
    const gc = read('src/renderer/src/components/graph/GraphCanvas.tsx')
    const ps = read('src/renderer/src/components/graph/graphPerfStats.ts')
    const rt = read('src/renderer/src/components/graph/graphRenderTokens.ts')
    // Controller + live window feed pushSvgFrame each commit
    expect(has(gc, 'new AdaptiveThrottle(SVG_PUSH_THROTTLE_MS)')).toBe(true)
    expect(has(gc, 'throttleWindowMsRef.current')).toBe(true)
    expect(
      has(
        gc,
        'shouldThrottleSvgPush(now, lastSvgPushRef.current, throttle, throttleWindowMsRef.current)'
      )
    ).toBe(true)
    expect(has(gc, 'ctrl.consider(snap.p95CommitMs, snap.count, performance.now())')).toBe(true)
    expect(has(ps, 'export class AdaptiveThrottle')).toBe(true)
    expect(has(ps, 'THROTTLE_MIN_MS')).toBe(true)
    expect(has(ps, 'THROTTLE_MAX_MS')).toBe(true)
    expect(has(rt, 'windowMs = SVG_PUSH_THROTTLE_MS')).toBe(true)
  })
  it('canvas2D gesture draw-time + spark chart wired (G-perf)', () => {
    const gc = read('src/renderer/src/components/graph/GraphCanvas.tsx')
    const ps = read('src/renderer/src/components/graph/graphPerfStats.ts')
    const sp = read('src/renderer/src/components/graph/graphPerfSpark.ts')
    // Canvas2D gesture path timed only while the overlay is on, into its own stats
    expect(has(gc, 'canvasStatsRef')).toBe(true)
    expect(has(gc, 'perfOverlayRef.current ? performance.now() : 0')).toBe(true)
    expect(has(gc, 'canvasStatsRef.current.push')).toBe(true)
    // Spark chart: last SPARK_BARS commit durations rendered on a mini canvas
    expect(has(gc, 'PerfSparkChart')).toBe(true)
    expect(has(gc, 'sparkLayout(samples, width, height, THROTTLE_TARGET_P95_MS)')).toBe(true)
    expect(has(gc, 'perfStatsRef.current.recent(SPARK_BARS)')).toBe(true)
    expect(has(ps, 'recent(n: number): number[]')).toBe(true)
    expect(has(sp, 'export function sparkLayout')).toBe(true)
    expect(has(sp, 'export function drawSparkBars')).toBe(true)
    expect(has(sp, 'export const SPARK_BARS')).toBe(true)
  })
  it('delta-merge structural sharing wired in GraphCanvas (G-perf)', () => {
    const gc = read('src/renderer/src/components/graph/GraphCanvas.tsx')
    // Prev-frame caches exist, merge runs right before push, reset on rebuild
    expect(has(gc, 'prevEdgesRef')).toBe(true)
    expect(has(gc, 'prevNodesRef')).toBe(true)
    expect(has(gc, 'prevLabelsRef')).toBe(true)
    expect(has(gc, 'deltaMerge(prevEdgesRef.current, edgesOut, sameSvgEdge)')).toBe(true)
    expect(has(gc, 'deltaMerge(prevNodesRef.current, nodesOut, sameSvgNode)')).toBe(true)
    expect(has(gc, 'deltaMerge(prevLabelsRef.current, labelsOut, sameSvgLabel)')).toBe(true)
    expect(has(gc, 'resetFrameCache()')).toBe(true)
    // Memoized per-element components bail on stable object references
    expect(has(gc, 'const SvgEdgeItem = memo(')).toBe(true)
    expect(has(gc, 'const SvgNodeItem = memo(')).toBe(true)
    expect(has(gc, 'const SvgLabelItem = memo(')).toBe(true)
  })
  it('tooltip hover-delay goes through the shared scheduler (P1-2)', () => {
    const gc = read('src/renderer/src/components/graph/GraphCanvas.tsx')
    const sch = read('src/renderer/src/components/graph/graphTooltipScheduler.ts')
    // The scheduler factory owns the delay; GraphCanvas must consume it (never
    // re-implement raw setTimeout per pointermove — that reintroduces flicker)
    expect(has(gc, "from './graphTooltipScheduler'", 'createTooltipScheduler<SimNode>')).toBe(true)
    expect(has(gc, 'tooltipSchedulerRef.current?.hover')).toBe(true)
    expect(has(gc, 'tooltipSchedulerRef.current?.leave')).toBe(true)
    expect(has(gc, 'tooltipSchedulerRef.current?.dispose')).toBe(true)
    expect(has(sch, 'export const TOOLTIP_DELAY_MS = 250')).toBe(true)
    expect(has(sch, 'export function createTooltipScheduler')).toBe(true)
  })
  it('tooltip note-preview goes through the shared cache (P1-3)', () => {
    const gc = read('src/renderer/src/components/graph/GraphCanvas.tsx')
    const pv = read('src/renderer/src/components/graph/graphTooltipPreview.ts')
    // Preview content must come from the per-note cache (never raw file reads
    // in the tooltip hot path) and the markdown-stripping must be shared
    expect(has(gc, "from './graphTooltipPreview'", 'new TooltipPreviewCache')).toBe(true)
    expect(has(gc, 'window.api.readFile', 'tooltipPreviewCacheRef.current?.get')).toBe(true)
    expect(has(gc, 'previewSeqRef.current++')).toBe(true)
    expect(has(gc, 'gt-preview')).toBe(true)
    expect(has(pv, 'export function markdownToPlainText')).toBe(true)
    expect(has(pv, 'export function previewLines')).toBe(true)
  })
  it('keyboard selection control + orphan pruning (P2-7)', () => {
    const gc = read('src/renderer/src/components/graph/GraphCanvas.tsx')
    // Esc deselects first; the full reset only runs when nothing is selected
    expect(has(gc, 'selectedIdsRef.current.size > 0', "setPathStatus('Selection cleared')")).toBe(
      true
    )
    // [ / ] cycle the camera through the ordered selection; Enter opens focus
    expect(has(gc, "e.key === '[' || e.key === ']'", 'selectionNavIndexRef.current')).toBe(true)
    expect(has(gc, "e.key === 'Enter'", 'openTab(focus.path)')).toBe(true)
    // Selection ids are pruned against the visible graph on filter/rebuild
    expect(has(gc, '[...selectedIds].filter((id) => filteredNodeIds.has(id))')).toBe(true)
  })
  it('focused-selection dashed ring is shared between both renderers (P2-8)', () => {
    const gc = read('src/renderer/src/components/graph/GraphCanvas.tsx')
    const c2d = read('src/renderer/src/components/graph/graphCanvas2D.ts')
    const types = read('src/renderer/src/components/graph/graphTypes.ts')
    const sim = read('src/renderer/src/components/graph/graphSimulation.ts')
    const rt = read('src/renderer/src/components/graph/graphRenderTokens.ts')
    // [/] marks the focused id in the shared paint flags (never per-renderer)
    expect(has(gc, 'viewFlagsRef.current.focusSelId = target.id')).toBe(true)
    expect(has(gc, 'flags.focusSelId === n.id', "FOCUS_RING_DASH.join(' ')")).toBe(true)
    expect(has(c2d, 'flags.focusSelId === n.id', 'FOCUS_RING_DASH.map((v) => v / k)')).toBe(true)
    // The dash pattern lives in the parity module (no per-renderer literal)
    expect(has(rt, 'export const FOCUS_RING_DASH = [4, 3] as const')).toBe(true)
    // ViewFlags + GraphViewFlags stay in sync (G20 parity contract)
    expect(has(types, 'focusSelId: string | null')).toBe(true)
    expect(has(sim, 'focusSelId: string | null')).toBe(true)
  })
  it('labels sit centered BELOW the node in both renderers (P3-2)', () => {
    const gc = read('src/renderer/src/components/graph/GraphCanvas.tsx')
    const c2d = read('src/renderer/src/components/graph/graphCanvas2D.ts')
    const rt = read('src/renderer/src/components/graph/graphRenderTokens.ts')
    // One shared anchor helper — never a per-renderer literal
    expect(has(rt, 'export function labelBelowNode', 'LABEL_BELOW_GAP')).toBe(true)
    expect(has(gc, 'labelBelowNode(sx, sy, rWorld)')).toBe(true)
    expect(has(c2d, 'labelBelowNode(sx, sy, rWorld)')).toBe(true)
    // Text is centered on the node's x (SVG anchor + canvas align)
    expect(has(gc, 'textAnchor="middle"')).toBe(true)
    expect(has(c2d, "ctx.textAlign = 'center'")).toBe(true)
    // The old beside-node literals are gone (no handoff drift)
    expect(has(gc, 'x: sx + rWorld * kSafe + 5')).toBe(false)
    expect(has(c2d, 'rWorld * k + 6')).toBe(false)
  })
  it('graph theme flip dips the stage instead of snapping (P3-1)', () => {
    const gc = read('src/renderer/src/components/graph/GraphCanvas.tsx')
    const css = read('src/renderer/src/styles/globals.css')
    // Only an ACTUAL theme flip dips (never the mount-time apply)
    expect(has(gc, 'themeRef.current != null', 'themeRef.current !== mode')).toBe(true)
    expect(has(gc, "classList.add('graph-theme-fade')")).toBe(true)
    expect(has(gc, "animationName === 'graph-theme-fade'")).toBe(true)
    // CSS owns the dip keyframes; reduced-motion users skip it
    expect(has(css, '@keyframes graph-theme-fade', 'graph-theme-fade 0.3s')).toBe(true)
    expect(has(css, '.graph-theme-fade', 'animation: none')).toBe(true)
  })
  it('dot-grain underlay is shared between both renderers (P2-5)', () => {
    const gc = read('src/renderer/src/components/graph/GraphCanvas.tsx')
    const c2d = read('src/renderer/src/components/graph/graphCanvas2D.ts')
    const rt = read('src/renderer/src/components/graph/graphRenderTokens.ts')
    // Both renderers consume the SAME spacing/radius/color tokens (never a
    // per-renderer literal — a handoff would otherwise show a pattern jump)
    expect(has(rt, 'export const DOT_GRID_SPACING = 24')).toBe(true)
    expect(has(rt, 'export const DOT_GRID_RADIUS = 0.9')).toBe(true)
    expect(has(rt, 'export function dotGrainColor')).toBe(true)
    expect(has(c2d, 'dotGrainColor(pal.isLight)')).toBe(true)
    expect(has(c2d, 'DOT_GRID_SPACING', "createPattern(c, 'repeat')")).toBe(true)
    expect(has(gc, 'dotGrainColor(paletteRef.current.isLight)')).toBe(true)
    expect(has(gc, 'patternUnits="userSpaceOnUse"', 'wg-dotgrain-pattern')).toBe(true)
  })
  it('dblclick is Obsidian-like: node opens, empty space zooms (P2-4)', () => {
    const gc = read('src/renderer/src/components/graph/GraphCanvas.tsx')
    // Node: open tab (attachment → external app); legacy unpin retained
    expect(has(gc, 'const onDbl = (e: MouseEvent)', 'openTabRef.current(hit.path)')).toBe(true)
    expect(has(gc, 'hit.pinned = false', 'hit.isGhost || hit.isTag')).toBe(true)
    // Empty space: eased zoom anchored at the cursor (same tween as wheel)
    expect(has(gc, 'startZoomTweenRef.current(nextK, mx, my)')).toBe(true)
    expect(has(gc, 'k0 * 1.5')).toBe(true)
    // No zoom when double-clicking a special node (must not zoom into ghosts)
    expect(has(gc, 'if (hit.isGhost || hit.isTag) return')).toBe(true)
  })
  it('single-click selects, dblclick is the only open gesture (P2-6)', () => {
    const gc = read('src/renderer/src/components/graph/GraphCanvas.tsx')
    // Plain click on a node replaces the selection — never navigates
    expect(has(gc, 'setSelectedIds(new Set([d.id]))')).toBe(true)
    expect(has(gc, 'cur.size !== 1 || !cur.has(d.id)')).toBe(true)
    // The old click-to-open in endGesture must be gone (no accidental nav)
    expect(gc).not.toContain('void openTabRef.current(d.path)')
    // Tag keeps its filter shortcut
    expect(has(gc, "setSearchMode('filter')")).toBe(true)
    // Empty-space click clears the selection; pan with motion keeps it
    expect(has(gc, "mode === 'pan' && !moved", 'setSelectedIds(new Set())')).toBe(true)
    // Attachments now open on dblclick (single-click no longer opens → no
    // double-launch risk)
    expect(has(gc, 'openFileExternal(hit.path)')).toBe(true)
    // Hint reflects the new gesture map (+ P2-7 keyboard line)
    expect(has(gc, 'klik select · dblklik buka · Ctrl+klik multi')).toBe(true)
    expect(has(gc, '[ ] siklus seleksi · Enter buka · Esc deselect')).toBe(true)
  })
  it('both renderers consume edgeColorFor (G20 anti-drift)', () => {
    const c2d = read('src/renderer/src/components/graph/graphCanvas2D.ts')
    const gc = read('src/renderer/src/components/graph/GraphCanvas.tsx')
    expect(has(c2d, 'edgeColorFor(e.type, flags.edgeColorBy, pal)')).toBe(true)
    expect(has(gc, 'edgeColorFor(e.type, flags.edgeColorBy, pal)')).toBe(true)
    // Per-renderer edge literals must not creep back in (handoff parity)
    expect(c2d).not.toContain("e.type === 'tag' ? pal.edgeTag : pal.edge")
  })
  it('GraphViewFlags stays in sync with ViewFlags (G20 flags parity)', () => {
    const sim = read('src/renderer/src/components/graph/graphSimulation.ts')
    const types = read('src/renderer/src/components/graph/graphTypes.ts')
    // edgeColorBy must exist in BOTH flag interfaces so wiring useGraphSimulation
    // later can never silently drop the edge stroke mode (latent drift guard)
    expect(has(sim, 'GraphViewFlags', 'edgeColorBy')).toBe(true)
    expect(has(types, 'ViewFlags', 'edgeColorBy')).toBe(true)
  })
  it('entry animation stamped only on new sim nodes + export never mid-fade (G19)', () => {
    const gc = read('src/renderer/src/components/graph/GraphCanvas.tsx')
    const c2d = read('src/renderer/src/components/graph/graphCanvas2D.ts')
    // Sim rebuild stamps born/enterOrder on new nodes and kicks a bounded driver
    expect(has(gc, 'born: isNew', 'enterOrder: isNew', 'entryKickRef.current()')).toBe(true)
    // Both renderers consume the same helpers; PNG export forces full entry
    expect(has(c2d, 'nodeEntryProgress', 'nodeEntryOpacity')).toBe(true)
    expect(has(c2d, 'entryComplete')).toBe(true)
    expect(has(gc, 'entryComplete: true')).toBe(true)
  })
  it('graph diagnostics live in graphDiagnostics', () => {
    const diag = read('src/renderer/src/components/graph/graphDiagnostics.ts')
    expect(
      has(
        diag,
        'diagnoseEmptyFilter',
        'diagnoseViewportBlank',
        'diagnosePathResult',
        'SpatialHash2D'
      )
    ).toBe(true)
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
    // Robustness: corrupt settings/config degrade instead of crashing — the
    // unreadable file is backed up (never silently destroyed) and a leftover
    // .tmp (atomic-write) is used as recovery source
    expect(has(we, 'readSettingsFile', "settingsPath + '.tmp'", '.corrupt-${Date.now()}')).toBe(
      true
    )
    // recent.json gets the same self-healing: atomic writes + .tmp recovery
    expect(has(we, 'loadRecentWorkspaces', 'atomicWriteJson', 'quarantineCorruptFile')).toBe(true)
    // Chat + proposal stores share the pattern: corrupt files are quarantined
    // (preserved aside, removed from the list) and writes are atomic
    const conv = read('src/main/ai/ConversationStore.ts')
    expect(has(conv, 'isStoredConversation', 'quarantineCorruptFile', 'atomicWriteJson')).toBe(true)
    expect(has(read('src/main/ai/AgentTools.ts'), 'quarantineCorruptFile', 'atomicWriteJson')).toBe(
      true
    )
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
  it('all six built-in adapters live in the dynamic provider registry', () => {
    const reg = read('src/main/ai/providerRegistry.ts')
    for (const p of [
      'GrokProvider',
      'GeminiProvider',
      'OpenAIProvider',
      'ClaudeProvider',
      'OllamaProvider',
      'OpenRouterProvider'
    ]) {
      expect(reg).toContain(p)
    }
    // The provider set is DATA (settings.aiProviders), not code — registry builds
    // the map from defs, with a generic OpenAI-compatible adapter for custom rows.
    expect(
      has(reg, 'buildProviderMap', 'readProviderDefs', 'sanitizeDefs', 'OpenAICompatProvider')
    ).toBe(true)
    const mid = read('src/main/ai/AIMiddleware.ts')
    expect(
      has(
        mid,
        'listModels()',
        'configured',
        'belum dikonfigurasi',
        'testProvider',
        'enableTools',
        'MAX_TOOL_ROUNDS',
        'cancelStream',
        'rebuildProviders'
      )
    ).toBe(true)
    expect(has(mid, 'importGrokFromCli', 'getAllProvidersStatus')).toBe(true)
    // Bad-key/empty-list failures surface on the Settings card: Test failures
    // are remembered (lastTestError) and /models failures become modelsError
    expect(has(mid, 'lastTestError', 'testError: this.lastTestError.get', 'modelsError')).toBe(true)
    // P2: kernel comes from the Prompt Registry (per-vault override), not a literal
    expect(has(mid, "renderPrompt('kernel')", 'unknown tools skipped')).toBe(true)
  })
  it('dynamic providers: add/edit/delete wired end-to-end (settings → IPC → preload → UI)', () => {
    const reg = read('src/main/ai/providerRegistry.ts')
    const ipc = read('src/main/ipc/handlers/ai.ts')
    const pre = read('src/preload/index.ts')
    const set = read('src/renderer/src/components/settings/SettingsView.tsx')
    // Registry: seeds + custom adapter + the pure settings-mutation that owns
    // key-cleanup (drop removed keys), baseUrl/defaultModel sync, and the
    // active-provider fallback — the handler delegates to it
    expect(
      has(reg, 'DEFAULT_PROVIDER_DEFS', 'makeProviderId', "kind: 'builtin' | 'openai-compat'")
    ).toBe(true)
    expect(
      has(
        reg,
        'applyProviderDefsToSettings',
        'delete ai[id]',
        'd.baseUrl !== undefined) entry.baseUrl',
        "settings.activeProvider = clean[0]?.id ?? ''",
        'mergeBuiltinDefs'
      )
    ).toBe(true)
    // IPC: read + write the provider list; the handler persists + rebuilds live
    expect(ipc.includes("'ai:getProviderConfigs'")).toBe(true)
    expect(ipc.includes("'ai:saveProviderConfigs'")).toBe(true)
    expect(ipc.includes("'ai:resetProviderConfigs'")).toBe(true)
    expect(ipc.includes("'ai:setProviderDefaultModel'")).toBe(true)
    expect(has(ipc, 'applyProviderDefsToSettings(settings, defs)', 'rebuildProviders(clean)')).toBe(
      true
    )
    // Preload bridge
    expect(
      has(
        pre,
        'getAIProviderConfigs',
        'saveAIProviderConfigs',
        'resetAIProviderConfigs',
        'setAIProviderDefaultModel'
      )
    ).toBe(true)
    // UI: one add form + delete per row + reset-to-builtins (no hardcoded shells)
    expect(set.includes('PROVIDER_SHELLS')).toBe(false)
    expect(has(set, 'Tambah provider', 'handleAddProvider', 'handleDeleteProvider')).toBe(true)
    expect(
      has(set, 'providerIdFromName', 'saveAIProviderConfigs', 'Reset ke provider bawaan')
    ).toBe(true)
  })
  it('P2 prompt registry: versioned JSON assets under .workspacegraph/prompts/', () => {
    const reg = read('src/main/ai/PromptRegistry.ts')
    const wm = read('src/main/ai/WorkspaceMemory.ts')
    const tools = read('src/main/ai/AgentTools.ts')
    // Registry ships versioned defaults and renders {{...}} placeholders at runtime
    expect(has(reg, 'PROMPT_DEFAULTS', 'version: 1', 'renderPrompt', '{{tools}}')).toBe(true)
    // Materializes/loads a per-vault JSON snapshot, gated by version
    expect(
      has(
        reg,
        "'.workspacegraph', 'prompts'",
        'prompts.json',
        'e.version >= PROMPT_DEFAULTS[id].version'
      )
    ).toBe(true)
    // Kernel + bootstrap derive from the registry; tools head/tail rendered with {{tools}}
    expect(wm.includes("renderPrompt('kernel')")).toBe(true)
    expect(wm.includes("renderPrompt('bootstrap')")).toBe(true)
    expect(
      has(tools, "renderPrompt('toolsHead', { tools: lines", "renderPrompt('toolsTail')")
    ).toBe(true)
  })
  it('runtime model discovery: /models fetchers + free flags wired in all providers', () => {
    const disc = read('src/main/ai/providers/modelDiscovery.ts')
    const base = read('src/main/ai/providers/BaseProvider.ts')
    const mid = read('src/main/ai/AIMiddleware.ts')
    const ipc = read('src/main/ipc/handlers/ai.ts')
    const pre = read('src/preload/index.ts')
    // Shared discovery module: OpenAI-compat + Gemini + Anthropic + OpenRouter
    expect(
      has(
        disc,
        'export async function fetchOpenAICompatModels',
        'export async function fetchGeminiModels',
        'export async function fetchAnthropicModels',
        'export async function fetchOpenRouterModels'
      )
    ).toBe(true)
    // Free-model indication: exact pricing for OpenRouter, heuristic for Gemini,
    // and the model flag itself lives on ModelInfo
    expect(has(disc, 'Number(v) === 0', 'isGeminiFreeTier', 'markFreeByHeuristic')).toBe(true)
    expect(has(base, 'free?: boolean', 'ownedBy?: string')).toBe(true)
    // Every provider consumes the shared discovery + cache (no stale hardcoded
    // list as the ONLY source — runtime always tried first). The model cache
    // now lives in BaseProvider, so every provider inherits it; the fetchers
    // are consumed where the API shape applies (Ollama fetches /api/tags itself
    // but still inherits the TTL cache).
    expect(has(base, 'protected modelCache = createModelCache()')).toBe(true)
    for (const p of ['Grok', 'OpenAI', 'Gemini', 'Claude', 'OpenRouter', 'Ollama']) {
      const src = read(`src/main/ai/providers/${p}Provider.ts`)
      expect(
        hasAny(
          src,
          'fetchOpenAICompatModels',
          'fetchGeminiModels',
          'fetchAnthropicModels',
          'fetchOpenRouterModels',
          'this.modelCache.get()'
        )
      ).toBe(true)
    } // Renderer surfaces the free flag (picker badge + Settings model count)
    const picker = read('src/renderer/src/components/chat/chatModelPicker.ts')
    expect(has(picker, 'free?: boolean', 'contextWindow?: number', 'ownedBy?: string')).toBe(true)
    expect(has(picker, 'formatContextWindow', 'modelDetailSubtitle')).toBe(true)
    const panel = read('src/renderer/src/components/chat/ChatPanel.tsx')
    expect(has(panel, 'm.free &&', 'chat-model-free-badge', 'Gratis', 'chat-model-row-sub')).toBe(
      true
    )
    const set = read('src/renderer/src/components/settings/SettingsView.tsx')
    expect(has(set, 'freeCount', 'model gratis')).toBe(true)
    expect(read('src/renderer/src/styles/globals.css').includes('chat-model-free-badge')).toBe(true)
    // Base-path auto-detection: candidate list + discovery adopt the working
    // chat base so completions hit the same versioned path as /models
    expect(
      has(disc, 'export function chatBaseCandidates', 'export async function discoverOpenAICompat')
    ).toBe(true)
    expect(has(disc, 'export function isVersionedBase')).toBe(true)
    expect(has(disc, 'export function shouldAdoptChatBase')).toBe(true)
    expect(has(disc, '`${clean}/v1`', '`${clean}/api/v1`', "replace(/\\/models\\/?$/, '')")).toBe(
      true
    )
    for (const p of ['Grok', 'OpenAI']) {
      const src = read(`src/main/ai/providers/${p}Provider.ts`)
      // Adoption goes through the shared helper (never a per-provider literal),
      // and the adopted base rebuilds the SDK client
      expect(has(src, 'discoverOpenAICompat', 'shouldAdoptChatBase')).toBe(true)
      expect(has(src, 'this.client = null')).toBe(true)
      // Lazy chat-path guard: a bare-domain baseUrl is adopted before the
      // first chat call, not only when listModels() happens to have run
      expect(has(src, 'ensureChatBase', 'chatBaseProbed')).toBe(true)
    }
    // Settings: base URL editable on EVERY provider row (dynamic registry) + vendor label
    expect(has(set, "def.id === 'ollama'", 'Base URL', 'vendor ', 'ownedBy')).toBe(true)
    // Manual refresh: cache-bust + IPC + Settings button
    expect(has(base, 'clearModelCache(): void')).toBe(true)
    expect(
      has(mid, 'refreshProviderModels', 'provider.clearModelCache()', 'return { ok: true, models }')
    ).toBe(true)
    expect(has(ipc, "'ai:refreshProviderModels'")).toBe(true)
    expect(has(pre, 'refreshProviderModels: (providerId: string)')).toBe(true)
    expect(has(set, 'handleRefreshModels', 'Refresh models', 'res.models.length')).toBe(true)
  })
  it('per-provider loading spinner: progress push wired end-to-end', () => {
    const mid = read('src/main/ai/AIMiddleware.ts')
    const ipc = read('src/main/ipc/handlers/ai.ts')
    const pre = read('src/preload/index.ts')
    const set = read('src/renderer/src/components/settings/SettingsView.tsx')
    const css = read('src/renderer/src/styles/globals.css')
    // Main: getAllProvidersStatus accepts an optional per-provider callback
    expect(has(mid, 'onProgress?: (status: ProviderStatus) => void', 'onProgress?.(status)')).toBe(
      true
    )
    // Handler pushes each resolved status on its own channel
    expect(has(ipc, "'ai:providerStatus'", 'BrowserWindow.fromWebContents(event.sender)')).toBe(
      true
    )
    // Preload exposes the subscription (returns an unsubscribe)
    expect(has(pre, 'onAIProviderStatus', "ipcRenderer.on('ai:providerStatus'")).toBe(true)
    // Renderer: dynamic rows + per-provider loading state + spinner (no more
    // hardcoded provider shells — the list is the data)
    expect(set.includes('PROVIDER_SHELLS')).toBe(false)
    expect(has(set, 'loadingProviders', 'Memuat model…', 'onAIProviderStatus', 'spinner-sm')).toBe(
      true
    )
    expect(has(css, '.provider-loading', '.spinner-sm')).toBe(true)
    // Save auto-refreshes the saved provider's models (persist defs → configure
    // busts the cache → loadAll re-fetches /models) so a new key/baseUrl shows
    // immediately
    expect(has(set, 'handleSaveProviderRow', 'configureAIProvider', 'loadAll()')).toBe(true)
  })
  it('last-refreshed stamp: modelsFetchedAt flows main → Settings card', () => {
    const disc = read('src/main/ai/providers/modelDiscovery.ts')
    const base = read('src/main/ai/providers/BaseProvider.ts')
    const mid = read('src/main/ai/AIMiddleware.ts')
    const set = read('src/renderer/src/components/settings/SettingsView.tsx')
    // Cache exposes the real fetch timestamp; statuses carry it per provider.
    // Only LIVE fetches stamp it — a fallback-only load stays cached (offline
    // visibility) but claims no freshness (set(models, fromRuntime))
    expect(
      has(disc, 'fetchedAt(): number | null', 'set(models: ModelInfo[], fromRuntime?: boolean)')
    ).toBe(true)
    expect(has(disc, 'fetchedAt: () => (at > 0 && lastWasRuntime ? at : null)')).toBe(true)
    expect(has(base, 'modelsFetchedAt?: number', 'lastModelsFetchedAt')).toBe(true)
    expect(has(mid, 'modelsFetchedAt: provider.lastModelsFetchedAt() ?? undefined')).toBe(true)
    // Every runtime-fetch provider passes whether the live call produced models
    for (const p of ['OpenAI', 'Grok', 'Gemini', 'Claude', 'OpenRouter']) {
      expect(read(`src/main/ai/providers/${p}Provider.ts`)).toContain(
        'this.modelCache.set(out, runtime.length > 0)'
      )
    }
    // Card stamps "diperbarui …" when the timestamp is present (same-day = time,
    // older = short date + time so a stale list is obvious)
    expect(has(set, 'formatRefreshedAt', 'modelsFetchedAt ?', 'diperbarui')).toBe(true)
  })
  it('R0-3 retry/backoff + R0-2 parallel reads wired', () => {
    const retry = read('src/main/ai/providers/providerRetry.ts')
    const mid = read('src/main/ai/AIMiddleware.ts')
    // Shared wrapper: retries only 429/5xx, exponential backoff, optional give-up
    expect(
      has(
        retry,
        'export async function withProviderRetry',
        'export function isRetryableProviderError'
      )
    ).toBe(true)
    expect(has(retry, 'status === 429', 'status >= 500 && status <= 599')).toBe(true)
    expect(has(retry, 'baseDelayMs * 2 ** attempt', 'maxDelayMs')).toBe(true)
    // OpenAI-compat providers wrap BOTH send + stream-create; Claude/Gemini wrap
    // send (Claude's stream helper fires lazily) and Gemini also wraps stream-create
    for (const p of ['OpenAI', 'OpenRouter', 'Grok']) {
      const src = read(`src/main/ai/providers/${p}Provider.ts`)
      expect(has(src, 'withProviderRetry(', 'shouldRetry: () => !(signal?.aborted')).toBe(true)
    }
    expect(
      read('src/main/ai/providers/ClaudeProvider.ts').includes('withProviderRetry(() =>')
    ).toBe(true)
    const gem = read('src/main/ai/providers/GeminiProvider.ts')
    expect(has(gem, 'withProviderRetry(() =>', 'generateContentStream')).toBe(true)
    // R0-2: reads run in parallel batches, completions emitted in request order
    expect(has(mid, 'READ_BATCH_SIZE', 'runReadBatch', 'Promise.all(')).toBe(true)
    expect(
      has(mid, 'running events first, in order', 'completion events in the SAME request order')
    ).toBe(true)
  })
  it('P3 structured AI event log: JSONL under .workspacegraph/logs + rotation + read IPC', () => {
    const log = read('src/main/ai/AIEventLog.ts')
    const mid = read('src/main/ai/AIMiddleware.ts')
    const ipc = read('src/main/ipc/handlers/ai.ts')
    const pre = read('src/preload/index.ts')
    // Module: JSONL append + size rotation + read/stats APIs
    expect(
      has(
        log,
        'ai-events.jsonl',
        "LOG_DIR = '.workspacegraph'",
        "LOG_SUBDIR = 'logs'",
        'export function rotateAIEventLog',
        'export function logAIEvent',
        'export function readAIEvents',
        'export function getAIEventStats',
        'LOG_MAX_BYTES'
      )
    ).toBe(true)
    // Middleware emits lifecycle + tool events with the audit fields
    expect(has(mid, 'logAIEvent', 'logAIOutcome', 'stream_start', 'stream_end')).toBe(true)
    expect(has(mid, 'durationMs: Date.now() - startedAt', 'status: finalMeta.status')).toBe(true)
    expect(has(mid, 'tokensUsed: finalMeta.tokensUsed')).toBe(true)
    expect(has(mid, "logAIOutcome('tool',", 'startedAt')).toBe(true)
    // IPC exposes the trail to the renderer + logs handler-level ops
    expect(
      has(ipc, "'ai:listAIEvents'", "'ai:getAIEventStats'", 'readAIEvents', 'getAIEventStats')
    ).toBe(true)
    expect(has(ipc, "'ai:promoteKnowledge'", "channel: 'ai:promoteKnowledge'")).toBe(true)
    expect(has(pre, 'listAIEvents', 'getAIEventStats')).toBe(true)
  })
  it('AI Activity Log panel: list + filter + clear wired end-to-end', () => {
    const log = read('src/main/ai/AIEventLog.ts')
    const ipc = read('src/main/ipc/handlers/ai.ts')
    const pre = read('src/preload/index.ts')
    const set = read('src/renderer/src/components/settings/SettingsView.tsx')
    const css = read('src/renderer/src/styles/globals.css')
    // Main: wipe API over the whole trail (active + rotated)
    expect(has(log, 'export function clearAIEvents', "f.startsWith('ai-events')")).toBe(true)
    expect(has(ipc, "'ai:clearAIEvents'", 'clearAIEvents(root)')).toBe(true)
    expect(has(pre, "clearAIEvents: () => ipcRenderer.invoke('ai:clearAIEvents')")).toBe(true)
    // Settings: dedicated nav section + terminal-event list + status filter chips
    expect(has(set, "id: 'logs', label: 'AI Activity'", 'TERMINAL_KINDS', 'LOG_FILTERS')).toBe(true)
    expect(has(set, 'listAIEvents(300)', 'logFilter', 'handleClearAIEvents')).toBe(true)
    expect(has(set, 'ai-log-filters', 'ai-log-row', 'Konfirmasi hapus?')).toBe(true)
    expect(has(css, '.ai-log-filter-chip', '.ai-log-row', '.ai-log-status', '.ai-log-nums')).toBe(
      true
    )
  })
  it('AI Activity CSV export: CSV builder + save dialog + preload wired end-to-end', () => {
    const log = read('src/main/ai/AIEventLog.ts')
    const ipc = read('src/main/ipc/handlers/ai.ts')
    const pre = read('src/preload/index.ts')
    const set = read('src/renderer/src/components/settings/SettingsView.tsx')
    // Main: pure CSV serializer + terminal-only reader (drops 'started' bookends)
    expect(has(log, 'export function aiEventsToCSV', 'export function readTerminalAIEvents')).toBe(
      true
    )
    expect(
      has(log, "'timestamp', 'kind', 'provider', 'model'", "'duration_ms', 'tokens_used'")
    ).toBe(true)
    // IPC: native save dialog defaulting to Downloads; preload bridges it
    expect(has(ipc, "'ai:exportAIEventsCSV'", "app.getPath('downloads')", 'showSaveDialog')).toBe(
      true
    )
    expect(has(ipc, 'aiEventsToCSV(events)', 'readTerminalAIEvents(root, 50_000)')).toBe(true)
    expect(has(pre, "exportAIEventsCSV: () => ipcRenderer.invoke('ai:exportAIEventsCSV')")).toBe(
      true
    )
    // Settings: the Export button calls the bridge and flashes the result
    expect(has(set, 'exportAIEventsCSV()', 'Ekspor CSV')).toBe(true)
  })
  it('AI log retention: age-prune on append + Settings control wired end-to-end', () => {
    const log = read('src/main/ai/AIEventLog.ts')
    const set = read('src/renderer/src/components/settings/SettingsView.tsx')
    // Main: prune helper + rotation takes retentionDays + logAIEvent reads the
    // settings key and gates pruning to at most once per 6h per vault
    expect(
      has(log, 'export function pruneAIEventsOlderThan', 'retentionDays = 0', 'retentionDays > 0')
    ).toBe(true)
    expect(has(log, "RETENTION_SETTING_KEY = 'aiEventRetentionDays'")).toBe(true)
    expect(has(log, 'workspaceEngine.getSettings()', 'lastPruneAt', 'PRUNE_MIN_INTERVAL_MS')).toBe(
      true
    )
    // Settings: retention select loads the key and saves it back
    expect(has(set, 'aiEventRetentionDays', 'saveLogRetention', 'id="ai-log-retention"')).toBe(true)
    expect(has(set, 'Hapus otomatis event lebih tua dari', 'Off (simpan semua)')).toBe(true)
  })
  it('AI usage dashboard card: windowed stats wired end-to-end', () => {
    const log = read('src/main/ai/AIEventLog.ts')
    const ipc = read('src/main/ipc/handlers/ai.ts')
    const pre = read('src/preload/index.ts')
    const dash = read('src/renderer/src/components/dashboard/DashboardView.tsx')
    const css = read('src/renderer/src/styles/globals.css')
    // Main: 7-day windowed aggregation over terminal ops
    expect(
      has(log, 'export function getAIEventStatsWindow', 'errorRate', 'series', 'avgDurationMs')
    ).toBe(true)
    // IPC passes the window to the handler; preload forwards days
    expect(has(ipc, 'getAIEventStatsWindow(root,', 'windowed')).toBe(true)
    expect(has(pre, 'getAIEventStats: (days?: number)')).toBe(true)
    // Dashboard renders the card from the window + mini bars
    expect(has(dash, 'AiUsageCard', 'getAIEventStats(7)', 'dash-ai-bars', 'windowed')).toBe(true)
    expect(has(dash, 'stream', 'token', 'rata-rata')).toBe(true)
    expect(has(css, '.dash-ai-bars', '.dash-ai-stat-value', '.dash-ai-bar')).toBe(true)
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
  it('P1-runtime: Gemini abort signal + per-tool timeout + token fallback', () => {
    const gem = read('src/main/ai/providers/GeminiProvider.ts')
    // Cancel/watchdog must reach the SDK — abortSignal rides in the config
    expect(has(gem, 'abortSignal: signal', 'generateContentStream')).toBe(true)
    const mid = read('src/main/ai/AIMiddleware.ts')
    // Per-invocation tool timeout guards the loop (watchdog only runs BETWEEN rounds)
    expect(has(mid, 'EXECUTE_TOOL_TIMEOUT_MS', 'executeToolWithTimeout')).toBe(true)
    expect(has(mid, 'executeToolWithTimeout(p.action, agentRole, opts)')).toBe(true)
    // Claude/Gemini/Ollama don't report usage → char-based estimate on terminal chunk
    expect(has(mid, 'reportedTokens', 'estimatedTokens')).toBe(true)
    expect(has(mid, 'tokensUsed: reportedTokens ? undefined : estimatedTokens')).toBe(true)
  })
  it('P1-4: workspace context only in round 0 + measured savings end-to-end', () => {
    const mid = read('src/main/ai/AIMiddleware.ts')
    // Lean prompt for rounds 1+ (kernel/fence kept, context block dropped)
    expect(
      has(mid, 'leanSystemPrompt', 'systemPrompt: round === 0 ? systemPrompt : leanSystemPrompt')
    ).toBe(true)
    // Provider-call counter + savings reporter on every terminal chunk
    expect(
      has(mid, 'sentRounds', 'savedContextTokens', 'contextSavedTokens: savedContextTokens()')
    ).toBe(true)
    // The measurement travels: chunk → store message → chat UI
    const store = read('src/renderer/src/store/chatStore.ts')
    expect(has(store, 'contextSavedTokens')).toBe(true)
    const panel = read('src/renderer/src/components/chat/ChatPanel.tsx')
    expect(has(panel, 'hemat ~', 'savedTokens')).toBe(true)
    expect(
      read('src/renderer/src/components/chat/chatTokenBudget.ts').includes('savedTokens')
    ).toBe(true)
  })
  it('Ollama localhost + no key', () => {
    const ollama = read('src/main/ai/providers/OllamaProvider.ts')
    expect(ollama.includes('11434')).toBe(true)
  })
  it('BaseProvider contracts', () => {
    const base = read('src/main/ai/providers/BaseProvider.ts')
    expect(has(base, 'isConfigured()', 'configure(config', 'getApiKeyMasked')).toBe(true)
  })
  it('P-A1 native function calling: tools array + stream tool_calls parsed, fence fallback', () => {
    const mid = read('src/main/ai/AIMiddleware.ts')
    const tools = read('src/main/ai/AgentTools.ts')
    const base = read('src/main/ai/providers/BaseProvider.ts')
    const compat = read('src/main/ai/providers/openaiCompat.ts')
    // Middleware routes by provider capability and sends the native contract
    expect(
      has(
        mid,
        'capabilities.toolCalling',
        'buildToolSchemas(agentRole, undefined, opts)',
        "tool_choice = 'auto'"
      )
    ).toBe(true)
    // OpenAI-compat providers consume request.tools and parse stream deltas
    for (const p of ['OpenAI', 'Grok', 'OpenRouter']) {
      const src = read(`src/main/ai/providers/${p}Provider.ts`)
      expect(has(src, 'request.tools', 'delta?.tool_calls', 'finalizeToolCalls')).toBe(true)
    }
    // Schema builder + native→action conversion live in AgentTools
    expect(
      has(tools, 'export function buildToolSchemas', 'export function nativeCallsToActions')
    ).toBe(true)
    // Shared delta accumulation is unit-tested (never per-provider literal)
    expect(has(compat, 'export function accumulateToolCallDeltas')).toBe(true)
    // Message contract carries tool role + tool_calls for the loop
    expect(has(base, "role: 'user' | 'assistant' | 'system' | 'tool'", 'tool_calls?:')).toBe(true) // Fence fallback is explicit for providers without native tools
    expect(has(mid, "toolMode === 'fence'", "'native' | 'fence' | 'off'")).toBe(true)
    expect(has(read('src/main/ai/providers/ClaudeProvider.ts'), 'toolCalling: false')).toBe(true)
    expect(has(read('src/main/ai/providers/GeminiProvider.ts'), 'toolCalling: false')).toBe(true)
  })
  it('P-B2 proposals persist under .workspacegraph/proposals/ + dock hydrates on mount', () => {
    const tools = read('src/main/ai/AgentTools.ts')
    const store = read('src/renderer/src/store/chatStore.ts')
    const panel = read('src/renderer/src/components/chat/ChatPanel.tsx')
    // One JSON per proposal, root-scoped cache, terminal state removes the file
    expect(
      has(
        tools,
        "'.workspacegraph', 'proposals'",
        'persistProposal',
        'removeProposalFile',
        'ensureProposalsLoaded'
      )
    ).toBe(true)
    // Renderer pulls persisted proposals via the preload bridge on mount
    expect(has(store, 'refreshProposals', 'listWriteProposals')).toBe(true)
    expect(has(panel, 'refreshProposals', 'void refreshProposals()')).toBe(true)
  })
  it('R2-2 resume stream: checkpoint file + middleware round + Lanjutkan UI', () => {
    const cpStore = read('src/main/ai/CheckpointStore.ts')
    const mid = read('src/main/ai/AIMiddleware.ts')
    const chat = read('src/renderer/src/store/chatStore.ts')
    const panel = read('src/renderer/src/components/chat/ChatPanel.tsx')
    const pre = read('src/preload/index.ts')
    // Main-side persistence: one JSON per truncated message under checkpoints/
    expect(
      has(
        cpStore,
        "'.workspacegraph', 'checkpoints'",
        'checkpointIdFor',
        'saveCheckpoint',
        'loadCheckpoint',
        'deleteCheckpoint',
        // Shape guard — foreign/corrupt JSON in checkpoints/ is skipped, never
        // surfaced as a bogus "Lanjutkan" resume point
        'isStreamCheckpoint'
      )
    ).toBe(true)
    // Middleware resumes the tool loop from the saved round, not round 0
    expect(has(mid, 'resumeFrom', 'startRound', 'round < (enableTools ? MAX_TOOL_ROUNDS')).toBe(
      true
    )
    // Renderer stamps the checkpoint on truncation, exposes resumeStream, and
    // strips the truncation markers before continuing
    expect(
      has(chat, 'resumeStream:', 'checkpoint', 'makeStreamChunkHandler', 'stripTruncationMarkers')
    ).toBe(true)
    // UI offers Lanjutkan on truncated replies (via the resume action)
    expect(has(panel, 'Lanjutkan', 'resumeStream')).toBe(true)
    // IPC bridge round-trips the checkpoint
    expect(has(pre, 'saveCheckpoint', "invoke('checkpoint:save'", 'deleteCheckpoint')).toBe(true)
  })
  it('P2 knowledge promotion: Simpan sebagai Knowledge wired end-to-end', () => {
    const tools = read('src/main/ai/AgentTools.ts')
    // Main-side promotion: Knowledge/ proposal + automatic backlink Sumber section
    expect(has(tools, 'export function promoteToKnowledge', "'Knowledge'", '## Sumber')).toBe(true)
    expect(has(tools, '[[', 'type: knowledge')).toBe(true)
    // IPC handler + preload bridge
    expect(readIpcSource().includes("'ai:promoteKnowledge'")).toBe(true)
    const pre = read('src/preload/index.ts')
    expect(has(pre, 'promoteToKnowledge', "invoke('ai:promoteKnowledge'")).toBe(true)
    // Store action hydrates the dock + message trail from the returned proposal
    const store = read('src/renderer/src/store/chatStore.ts')
    expect(
      has(
        store,
        'promoteAnswer:',
        'promoteToKnowledge(',
        'pendingProposals: mergeProposals(state.pendingProposals, [p])',
        'Proposal Knowledge/'
      )
    ).toBe(true)
    // Button on assistant messages (never while streaming/error)
    const panel = read('src/renderer/src/components/chat/ChatPanel.tsx')
    expect(
      has(
        panel,
        'handlePromoteKnowledge',
        'Simpan sebagai Knowledge',
        'promptDialog',
        'promoteAnswer'
      )
    ).toBe(true)
  })
  it('P1: per-role tool permissions + sequential pipeline wired end-to-end', () => {
    const tools = read('src/main/ai/AgentTools.ts')
    // Permission matrix lives in AgentTools (single source), guard in executeTool
    expect(has(tools, 'ROLE_TOOL_PERMISSIONS', 'export function isToolAllowed')).toBe(true)
    expect(has(tools, 'tidak diizinkan untuk role')).toBe(true)
    // Role-filtered advertisement for BOTH protocols (fence prompt + native schemas)
    expect(has(tools, 'export function buildToolsSystemPrompt')).toBe(true)
    expect(has(tools, 'export function buildToolSchemas(')).toBe(true)
    // Middleware routes role → executeTool guard + per-role advertisement
    const mid = read('src/main/ai/AIMiddleware.ts')
    expect(has(mid, 'executeToolWithTimeout(p.action, agentRole, opts)')).toBe(true)
    expect(has(mid, 'buildToolSchemas(agentRole, undefined, opts)')).toBe(true)
    // Sequential pipeline: stages with roles, suppression of intermediate done
    expect(
      has(
        mid,
        'streamPipeline',
        'PipelineStage',
        'RESEARCH_TO_WRITER_STAGES',
        'Hasil Stage',
        'toolStatus: `Stage ${i + 1}/${stages.length} done`'
      )
    ).toBe(true)
    // IPC + preload bridge for the pipeline
    expect(readIpcSource().includes("'ai:streamPipeline'")).toBe(true)
    expect(read('src/preload/index.ts').includes('streamAIPipeline')).toBe(true)
    expect(read('src/preload/index.d.ts').includes('streamAIPipeline')).toBe(true)
  })
  it('P-A2 vision: image content blocks per provider + renderer attach UI', () => {
    const base = read('src/main/ai/providers/BaseProvider.ts')
    const compat = read('src/main/ai/providers/openaiCompat.ts')
    const mid = read('src/main/ai/AIMiddleware.ts')
    const store = read('src/renderer/src/store/chatStore.ts')
    const panel = read('src/renderer/src/components/chat/ChatPanel.tsx')
    // Contract: ImageAttachment type + images field on messages/requests
    expect(has(base, 'ImageAttachment', 'mimeType', 'dataBase64', 'images?:')).toBe(true)
    // OpenAI-compat builder turns images into image_url content parts
    expect(has(compat, "type: 'image_url'", 'data:${img.mimeType};base64')).toBe(true)
    // Middleware gates on the vision capability + attaches to the last user msg
    expect(has(mid, 'capabilities.vision', 'tidak mendukung vision', 'request.images')).toBe(true)
    // Renderer: paste/drop handlers, composer strip, message thumbnails
    expect(has(panel, 'handlePaste', 'handleDrop', 'chat-attach-strip', 'chat-msg-img')).toBe(true)
    expect(has(panel, 'onPaste={handlePaste}', 'onDrop={handleDrop}')).toBe(true)
    // Store: sendMessage accepts images and persists them with the chat
    expect(has(store, 'sendMessage: (text: string, activeFilePath?: string, images?:')).toBe(true)
    expect(has(store, 'images: m.images')).toBe(true)
  })
  it('P-C1 regenerate/rephrase per message wired in chat UI', () => {
    const store = read('src/renderer/src/store/chatStore.ts')
    const panel = read('src/renderer/src/components/chat/ChatPanel.tsx')
    // Store: rephrase truncates at the target assistant message then re-sends
    expect(has(store, 'rephraseMessage: async (msgId: string, activeFilePath?: string)')).toBe(true)
    expect(
      has(store, "m.id === msgId && m.role === 'assistant'", 'messages: msgs.slice(0, idx)')
    ).toBe(true)
    // Panel: Regenerate on the last assistant message, Rephrase on any assistant msg
    expect(has(panel, 'handleRetry', 'retryLastMessage(activeTab?.path)')).toBe(true)
    expect(has(panel, 'handleRephrase', 'rephraseMessage(msg.id, activeTab?.path)')).toBe(true)
    expect(has(panel, 'Regenerate', 'Rephrase', 'refresh')).toBe(true)
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
  it('R1-1 auto compaction: module + middleware wired end-to-end', () => {
    const mod = read('src/main/ai/contextCompaction.ts')
    // Core helpers with the threshold/tail constants
    expect(
      has(
        mod,
        'export const DEFAULT_COMPACTION_BUDGET',
        'export const COMPACT_THRESHOLD',
        'export const KEEP_RECENT',
        'export const RESERVED_OUTPUT_TOKENS',
        'export function compactMessages',
        'export function contextBudgetForModel',
        'export function messageTokens'
      )
    ).toBe(true)
    // Extractive block format + tool-pair boundary guard (no orphan tool msg)
    expect(has(mod, '[Compacted]', 'Topik awal', "messages[split].role === 'tool'")).toBe(true)
    expect(mod.includes("role: 'user', content: parts.join")).toBe(true) // Middleware: budget = model window − context − output headroom, compaction
    // runs before the tool loop and surfaces a visible note. The window comes
    // from ModelInfo.contextWindow (cached listModels) with the static family
    // map as fallback — never a hardcoded per-request literal.
    const mid = read('src/main/ai/AIMiddleware.ts')
    expect(
      has(
        mid,
        "from './contextCompaction'",
        'compactMessages(messages,',
        'resolveCompactionBudget(provider, request.model)'
      )
    ).toBe(true)
    expect(
      has(
        mid,
        'contextBudgetForModel(model)',
        'RESERVED_OUTPUT_TOKENS',
        'context di-compact',
        'Context compacted'
      )
    ).toBe(true)
    expect(has(mid, 'compact.compactedCount > 0', 'messages = compact.messages')).toBe(true)
  })
  it('R1-2 provider failover: helper + middleware + event log wired end-to-end', () => {
    // Pure helper module: terminal-error classification + candidate ordering
    const helper = read('src/main/ai/providerFailover.ts')
    expect(
      has(
        helper,
        'export function shouldFailoverError',
        'export function resolveFailoverCandidates',
        'export function failoverCandidatesFor'
      )
    ).toBe(true)
    // 401/403/429/5xx are failover-worthy; 400/404 are not; Ollama never a target
    expect(has(helper, 'status === 401', 'status === 429', 'status >= 500 && status < 600')).toBe(
      true
    )
    expect(has(helper, "id === 'ollama'", 'id === activeId')).toBe(true)
    // Middleware: failover wrapper restarts the stream on the next configured
    // provider; note chunk + AIEventLog 'failover' (provider → target); the
    // served provider id flows back into the stream_end event
    const mid = read('src/main/ai/AIMiddleware.ts')
    expect(has(mid, "from './providerFailover'", 'runStreamWithFailover')).toBe(true)
    expect(has(mid, 'shouldFailoverError(terminalError)', 'setActiveProvider(providerId)')).toBe(
      true
    )
    expect(has(mid, "kind: 'failover'", 'target: providerId', 'Failover ke ')).toBe(true)
    expect(has(mid, 'providerId = await this.runStreamWithFailover(')).toBe(true)
    // Event log: failover kind + target field exist
    const log = read('src/main/ai/AIEventLog.ts')
    expect(has(log, "| 'failover'", 'target?: string')).toBe(true)
    // Settings UI: drag-reorder chain persisted to settings.aiFailoverOrder —
    // helpers exclude active provider + Ollama, save/reset write the setting
    const ui = read('src/renderer/src/components/settings/failoverOrder.ts')
    expect(has(ui, 'export function buildFailoverCandidates', 'export function moveInOrder')).toBe(
      true
    )
    expect(has(ui, 'id !== activeId', 'FAILOVER_EXCLUDED')).toBe(true)
    const view = read('src/renderer/src/components/settings/SettingsView.tsx')
    expect(has(view, 'aiFailoverOrder', 'saveFailoverOrder', 'failover-row--active')).toBe(true)
  })
  it('R1-3 plan mode + sub-agent delegation: tools, gate, middleware, IPC, UI wired', () => {
    const tools = read('src/main/ai/AgentTools.ts')
    // Tool names + plan-mode toolset + shared gate between advertise & execute
    expect(has(tools, "| 'delegate_subagent'", "| 'create_plan'", 'isDelegateTool')).toBe(true)
    expect(
      has(
        tools,
        'export const PLAN_TOOLS',
        'export function buildAllowedTools',
        'opts: ToolAdvertOptions',
        'excludeDelegate'
      )
    ).toBe(true)
    expect(has(tools, "case 'create_plan':", 'Planning', 'steps harus berupa array')).toBe(true)
    expect(has(tools, "case 'delegate_subagent':", 'dijalankan oleh middleware')).toBe(true)
    // Middleware: runSubAgent nested stream (role-scoped, no recursion), delegate
    // interception in the tool loop, plan-mode contract in the system prompt
    const mid = read('src/main/ai/AIMiddleware.ts')
    expect(has(mid, 'private async runSubAgent', 'excludeDelegate: true', 'PLAN MODE — R1-3')).toBe(
      true
    )
    expect(has(mid, 'isDelegateTool(p.action.tool)', 'delegates.length === 0')).toBe(true)
    expect(has(mid, 'buildToolSchemas(agentRole, undefined, opts)')).toBe(true)
    // IPC + preload pass planMode through to the stream
    expect(read('src/main/ipc/handlers/ai.ts').includes('Boolean(planMode)')).toBe(true)
    const pre = read('src/preload/index.ts')
    expect(has(pre, 'planMode?: boolean')).toBe(true)
    // Renderer: plan toggle in the composer + chatStore wiring + /plan arms it
    expect(read('src/renderer/src/store/chatStore.ts').includes('planMode')).toBe(true)
    expect(read('src/renderer/src/components/chat/ChatPanel.tsx').includes('setPlanMode')).toBe(
      true
    )
    expect(
      read('src/renderer/src/components/chat/ChatPanel.tsx').includes("cmd.name === '/plan'")
    ).toBe(true)
  })
  it('R0-1 MCP client: manager + middleware + IPC + preload + Settings wired end-to-end', () => {
    const mgr = read('src/main/mcp/McpClientManager.ts')
    // Manager: naming, both transports, classification, write gate, registry
    expect(has(mgr, "export const MCP_TOOL_PREFIX = 'mcp__'", 'parseMcpToolName')).toBe(true)
    expect(has(mgr, 'StdioClientTransport', 'StreamableHTTPClientTransport')).toBe(true)
    expect(has(mgr, '.workspacegraph', 'mcp.json', 'allowWriteTools', 'readOnlyHint')).toBe(true)
    expect(
      has(mgr, 'getToolSchemas', 'getFenceDocs', 'callTool', 'connectAll', 'disconnectAll')
    ).toBe(true)
    expect(has(mgr, 'withTimeout', 'CONNECT_TIMEOUT_MS')).toBe(true)
    // AgentTools: dynamic routing + role-write gate, static tools untouched
    const tools = read('src/main/ai/AgentTools.ts')
    expect(has(tools, "from '../mcp/McpClientManager'", 'roleCanWriteMCP', 'executeMcpTool')).toBe(
      true
    )
    expect(has(tools, 'mcpManager.isMcpTool(tool)', 'return executeMcpTool(action, role)')).toBe(
      true
    )
    expect(has(tools, 'mcpManager.isWriteTool(tool) && !roleCanWriteMCP(role)')).toBe(true)
    expect(has(tools, 'mcpManager.isWriteAllowed(tool)')).toBe(true)
    // Middleware: schemas + fence docs appended for write-capable roles
    const mid = read('src/main/ai/AIMiddleware.ts')
    expect(
      has(
        mid,
        "from '../mcp/McpClientManager'",
        'mcpManager.getToolSchemas(opts.planMode ? false : roleCanWriteMCP(agentRole))',
        'mcpManager.getFenceDocs(toolOptions.planMode ? false : roleCanWriteMCP(agentRole))'
      )
    ).toBe(true)
    // IPC: four channels registered + wired into the registrar
    const mcpIpc = read('src/main/ipc/handlers/mcp.ts')
    for (const ch of ['mcp:getServers', 'mcp:saveServers', 'mcp:testServer', 'mcp:getTools']) {
      expect(mcpIpc).toContain(`'${ch}'`)
    }
    expect(read('src/main/ipc/index.ts').includes('registerMcpHandlers')).toBe(true)
    // Vault lifecycle connects/disconnects MCP servers
    expect(read('src/main/ipc/handlers/workspace.ts').includes('mcpManager.connectAll()')).toBe(
      true
    )
    expect(read('src/main/ipc/handlers/workspace.ts').includes('mcpManager.disconnectAll()')).toBe(
      true
    )
    // Preload bridge exposes the registry
    const pre = read('src/preload/index.ts')
    expect(has(pre, 'getMcpServers', 'saveMcpServers', 'testMcpServer', 'getMcpTools')).toBe(true)
    // Settings: MCP section with add/test/remove + write toggle
    const set = read('src/renderer/src/components/settings/SettingsView.tsx')
    expect(
      has(set, "id: 'mcp'", "label: 'MCP'", 'getMcpServers', 'testMcpServer', 'allowWriteTools')
    ).toBe(true)
    expect(has(set, 'Tambah server MCP', 'Izinkan tool write', 'mcp__server__tool')).toBe(true)
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
