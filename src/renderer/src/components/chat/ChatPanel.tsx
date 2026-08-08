import React, { useEffect, useState, useRef, useCallback } from 'react'
import { createPortal } from 'react-dom'
import {
  useChatStore,
  WriteProposalItem,
  ImageAttachment,
  ChatMessage,
  ToolRun,
  CitationItem,
  stripTruncationMarkers
} from '../../store/chatStore'
import { TooltipPreviewCache } from '../graph/graphTooltipPreview'
import { makeCitePreviewCache, citeNode, citeTipPos } from './chatCitationTip'
import {
  AUTO_MODEL,
  isAutoModel,
  autoLabel,
  resolveAutoModel,
  buildModelGroups,
  modelDetailSubtitle
} from './chatModelPicker'
import {
  contextBudgetForModel,
  sessionTokenStats,
  sessionCostStats,
  formatK,
  formatUsd,
  budgetFraction
} from './chatTokenBudget'
import { summarizeToolRuns, toolSummaryLabel } from './chatToolSummary'
import { followUpChipLabel } from './chatFollowUp'
import {
  SLASH_COMMANDS,
  filterSlashCommands,
  findSlashCommand,
  consumeComposerCommand,
  type SlashCommand
} from './chatSlashCommands'
import { useEditorStore } from '../../store/editorStore'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { MergeDialog } from '../editor/MergeDialog'
import { Icon } from '../ui/Icons'
import { confirmDialog, promptDialog } from '../ui/Dialog'
import { usePanelWidth } from '../../hooks/usePanelWidth'
import { renderStreamingMarkdown } from './streamingMarkdown'

type ChatListItem = { id: string; title?: string; updatedAt?: string }

/**
 * Render a completed assistant message as markdown via markdown:render (escaped in
 * main). Streaming messages render as plain pre-wrapped text to avoid IPC churn per
 * chunk. Results cached by content so history re-renders are cheap.
 */
/**
 * Bounded markdown cache (LRU) — long chats + history loads would otherwise grow
 * this Map without limit for the whole renderer session.
 */
const MD_CACHE_MAX = 200
const mdCache = new Map<string, string>()
function mdCacheGet(key: string): string | undefined {
  const v = mdCache.get(key)
  if (v !== undefined) {
    // Refresh recency so hot messages survive eviction.
    mdCache.delete(key)
    mdCache.set(key, v)
  }
  return v
}
function mdCacheSet(key: string, value: string): void {
  if (mdCache.has(key)) mdCache.delete(key)
  mdCache.set(key, value)
  if (mdCache.size > MD_CACHE_MAX) {
    const oldest = mdCache.keys().next().value
    if (oldest !== undefined) mdCache.delete(oldest)
  }
}
/**
 * Collapsible per-tool trail (P1-1): each invocation renders as a pill with a
 * live spinner while running, then ✓/✗ once done. Clicking a pill with a
 * detail expands the result preview — the Cursor-style visibility layer.
 */
function ToolRunList({
  runs,
  streaming
}: {
  runs: ToolRun[]
  streaming: boolean
}): React.ReactElement {
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const toggle = (runId: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(runId)) next.delete(runId)
      else next.add(runId)
      return next
    })
  }
  return (
    <div className="chat-toolruns">
      {runs.map((r) => {
        const isOpen = expanded.has(r.runId)
        const live = r.status === 'running' && streaming
        return (
          <div key={r.runId} className={`chat-toolrun is-${r.status}`}>
            <button
              type="button"
              className="chat-toolrun-head"
              onClick={() => toggle(r.runId)}
              disabled={!r.detail}
              title={r.detail ? (isOpen ? 'Tutup detail' : 'Lihat detail') : undefined}
            >
              <span className="chat-toolrun-icon" aria-hidden>
                {live ? <span className="chat-spinner" /> : r.status === 'ok' ? '✓' : '✗'}
              </span>
              <span className="chat-toolrun-name">{r.tool}</span>
              <span className={`chat-toolrun-tag${r.status === 'error' ? ' is-err' : ''}`}>
                {live ? '…' : r.status === 'ok' ? 'ok' : 'gagal'}
              </span>
              {r.detail && (
                <span className={`chat-toolrun-chev${isOpen ? ' open' : ''}`} aria-hidden>
                  ▸
                </span>
              )}
            </button>
            {isOpen && r.detail && <div className="chat-toolrun-detail">{r.detail}</div>}
          </div>
        )
      })}
    </div>
  )
}

/**
 * P2-4: collapsible streaming chain-of-thought ("Berpikir") block. Opens live
 * while the reply streams so the model's reasoning is visible as it happens;
 * once done the head becomes a plain toggle (collapsed only by user choice).
 */
function ReasoningBlock({
  text,
  streaming
}: {
  text: string
  streaming: boolean
}): React.ReactElement {
  const [open, setOpen] = useState(streaming)
  return (
    <div className={`chat-reasoning${open ? ' is-open' : ''}`}>
      <button
        type="button"
        className="chat-reasoning-head"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title={open ? 'Sembunyikan proses berpikir' : 'Lihat proses berpikir'}
      >
        <span className="chat-reasoning-chev" aria-hidden>
          {open ? '▾' : '▸'}
        </span>
        <span className="chat-reasoning-label">{streaming ? 'Berpikir…' : 'Berpikir'}</span>
        {!streaming && <span className="chat-reasoning-chars">{text.length} ch</span>}
      </button>
      {open && (
        <div className="chat-reasoning-body">
          {text}
          {streaming && <span className="chat-spinner" />}
        </div>
      )}
    </div>
  )
}

function ChatMessageBody({
  content,
  streaming
}: {
  content: string
  streaming: boolean
}): React.ReactElement {
  const [html, setHtml] = useState<string | null>(() => {
    const c = mdCacheGet(content)
    return c !== undefined ? c : null
  })

  useEffect(() => {
    if (streaming || !content) return
    const cached = mdCacheGet(content)
    if (cached !== undefined) {
      // Derived-state sync from the markdown cache — not an event-driven setState.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setHtml(cached)
      return
    }
    let cancelled = false
    window.api
      .renderMarkdown(content)
      .then((h) => {
        if (cancelled) return
        mdCacheSet(content, h)
        setHtml(h)
      })
      .catch(() => {
        if (!cancelled) setHtml(null)
      })
    return () => {
      cancelled = true
    }
  }, [content, streaming])

  if (streaming) {
    // Progressive render in renderer (no IPC churn per chunk) — replaces the old
    // plain pre-wrapped text. Escaped here; final done render takes over below.
    return (
      <div
        className="chat-msg-md md-content chat-msg-streaming"
        dangerouslySetInnerHTML={{ __html: renderStreamingMarkdown(content) }}
      />
    )
  }
  if (!html) {
    return <div className="chat-msg-plain">{content}</div>
  }
  // markdown:render escapes raw HTML — safe to inject
  return <div className="chat-msg-md md-content" dangerouslySetInnerHTML={{ __html: html }} />
}

export const ChatPanel: React.FC = () => {
  const {
    width: chatWidth,
    onHandleMouseDown: chatResize,
    resizing
  } = usePanelWidth('wg.chatWidth', 360, 280, 640, (x) => window.innerWidth - x)
  const {
    messages,
    providers,
    activeProviderId,
    selectedModelId,
    agentRole,
    isGenerating,
    useContext,
    enableTools,
    planMode,
    pendingProposals,
    lastToolStatus,
    lastKernelStatus,
    fetchProviders,
    setActiveProvider,
    setSelectedModel,
    setAgentRole,
    setUseContext,
    setEnableTools,
    setPlanMode,
    sendMessage,
    cancelStream,
    clearHistory,
    refreshProposals,
    applyProposal,
    rejectProposal,
    promoteAnswer,
    saveCurrentChat,
    loadChat,
    deleteChat,
    retryLastMessage,
    rephraseMessage,
    resumeStream,
    learnWorkspace,
    followUpMessageId,
    setFollowUp
  } = useChatStore()

  const getActiveTab = useEditorStore((s) => s.getActiveTab)
  const updateContent = useEditorStore((s) => s.updateContent)
  const saveTab = useEditorStore((s) => s.saveTab)
  const openTab = useEditorStore((s) => s.openTab)
  const { setActiveView, fetchState, toggleAIChat } = useWorkspaceStore()
  /**
   * MUST return primitives (or stable store refs). Returning a new object from a
   * zustand selector each call breaks React useSyncExternalStore equality and
   * causes "Maximum update depth exceeded".
   */
  const activeTabId = useEditorStore((s) => s.activeTabId)
  const activeTabPath = useEditorStore((s) => s.tabs.find((x) => x.id === s.activeTabId)?.path)
  const activeTabTitle = useEditorStore((s) => s.tabs.find((x) => x.id === s.activeTabId)?.title)
  const activeTab =
    activeTabId && activeTabPath
      ? { id: activeTabId, path: activeTabPath, title: activeTabTitle || '' }
      : null

  const [inputText, setInputText] = useState('')
  const [applyMsg, setApplyMsg] = useState('')
  const [applyOk, setApplyOk] = useState(true)
  const [history, setHistory] = useState<ChatListItem[]>([])
  const [showHistory, setShowHistory] = useState(false)
  const [historyQuery, setHistoryQuery] = useState('')
  const [copyFlash, setCopyFlash] = useState<string | null>(null)
  // P-A2: images queued in the composer (paste / drag) before sending
  const [attachments, setAttachments] = useState<ImageAttachment[]>([])
  /** P1-3: inline model picker — chip + portaled dropdown (opens upward) */
  const [modelOpen, setModelOpen] = useState(false)
  const [modelPos, setModelPos] = useState<{ left: number; bottom: number } | null>(null)
  const modelChipRef = useRef<HTMLButtonElement | null>(null)
  const modelPickerRef = useRef<HTMLDivElement | null>(null)
  /** Minimal chrome: secondary actions (history/save/clear/learn/memori) live
   * in a small portaled ⋮ menu so the header stays a single clean row. */
  const [menuOpen, setMenuOpen] = useState(false)
  const [menuPos, setMenuPos] = useState<{ top: number; right: number } | null>(null)
  const menuBtnRef = useRef<HTMLButtonElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  /** P2-6: proposal diff preview — the MergeDialog shell with Disk/Proposal/Diff tabs */
  const [diffTarget, setDiffTarget] = useState<{
    p: WriteProposalItem
    theirs: string
  } | null>(null)
  /** P2-3: composer slash commands — mini palette over the textarea */
  const [slashOpen, setSlashOpen] = useState(false)
  const [slashQuery, setSlashQuery] = useState('')
  const [slashActive, setSlashActive] = useState(0)
  const [slashPos, setSlashPos] = useState<{ left: number; bottom: number } | null>(null)

  const messagesEndRef = useRef<HTMLDivElement>(null)
  const messagesBoxRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const stickToBottom = useRef(true)
  /** P1-2: cite-on-hover tooltip — portal to body so the scrolling messages
   * box can never clip it. Cache + fetch are shared with the graph's preview. */
  const [citeTip, setCiteTip] = useState<{
    x: number
    y: number
    path: string
    title: string
    weak: boolean
    /** true once the preview promise settled — distinguishes 'memuat…' from
     * a resolved-null (missing note / no vault) that must NOT spin forever */
    loaded: boolean
    text: string | null
  } | null>(null)
  const citeCacheRef = useRef<TooltipPreviewCache | null>(null)
  const citeHoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** P1-2: monotonic guard — a slow read must never paint into a stale/closed tooltip */
  const citeSeqRef = useRef(0)
  const citeCache = (): TooltipPreviewCache => {
    if (!citeCacheRef.current) {
      citeCacheRef.current = makeCitePreviewCache(async (p) => {
        const res = await window.api.readFile(p)
        return res ? { content: res.content ?? '' } : null
      })
    }
    return citeCacheRef.current
  }

  useEffect(() => {
    fetchProviders()
  }, [fetchProviders])

  // P2-7: hydrate/re-hydrate the proposal dock whenever the vault changes — on
  // mount AND when a workspace opens later (restart flow). A stream's live
  // chunks only cover this session; disk holds pending proposals from before.
  const rootPath = useWorkspaceStore((s) => s.rootPath)
  useEffect(() => {
    void refreshProposals()
  }, [rootPath, refreshProposals])

  const refreshHistory = useCallback(async () => {
    try {
      const list = (await window.api.listChats()) as ChatListItem[]
      setHistory(Array.isArray(list) ? list : [])
    } catch {
      setHistory([])
    }
  }, [])

  // Fetch-on-toggle: history is (re)loaded whenever the panel is shown.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-on-toggle pattern
    if (showHistory) void refreshHistory()
  }, [showHistory, refreshHistory])

  // Smart auto-scroll: only if user is near bottom
  useEffect(() => {
    const el = messagesBoxRef.current
    if (!el) return
    const onScroll = (): void => {
      const gap = el.scrollHeight - el.scrollTop - el.clientHeight
      stickToBottom.current = gap < 80
      // P1-2: a scroll moves the chips — dismiss a floating cite tooltip so it
      // never hangs over the wrong spot (fixed coords would go stale)
      citeSeqRef.current++
      setCiteTip(null)
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [])

  useEffect(() => {
    if (!stickToBottom.current) return
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [messages, isGenerating, lastToolStatus])

  // Auto-grow textarea
  useEffect(() => {
    const ta = inputRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = `${Math.min(160, Math.max(56, ta.scrollHeight))}px`
  }, [inputText])

  const activeProvider = providers.find((p) => p.id === activeProviderId)
  const modelOptions = activeProvider?.models || []
  // P1-3: the composer chip label — 'auto' shows as Auto, otherwise the name
  // of the concrete model (falls back to the raw id for stale picks).
  const modelName = isAutoModel(selectedModelId)
    ? 'Auto'
    : modelOptions.find((m) => m.id === selectedModelId)?.name || selectedModelId
  const modelGroups = buildModelGroups(providers)
  // P2-1: per-session token budget — chunk data already carries both numbers
  const { outputTokens, contextTokens, savedTokens } = sessionTokenStats(messages)
  // R2-1: per-session estimated cost (sum of per-reply costUsd from the stream)
  const sessionCost = sessionCostStats(messages)
  const budgetModel = isAutoModel(selectedModelId)
    ? resolveAutoModel(activeProvider)
    : selectedModelId
  const budget = contextBudgetForModel(budgetModel)
  const budgetPct = budgetFraction(outputTokens, budget)

  const openModelPicker = (): void => {
    const el = modelChipRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    // Composer sits at the panel bottom — anchor the dropdown's BOTTOM edge
    // above the chip and clamp so it never overflows the right viewport edge.
    const width = 250
    const left = Math.min(rect.left, Math.max(0, window.innerWidth - width - 8))
    setModelPos({ left, bottom: window.innerHeight - rect.top + 6 })
    setModelOpen(true)
  }
  const closeModelPicker = (): void => {
    setModelOpen(false)
    setModelPos(null)
  }

  // P1-3: dismiss the picker on outside mousedown or Escape
  useEffect(() => {
    if (!modelOpen) return
    const onDown = (e: MouseEvent): void => {
      const t = e.target as Node
      if (modelPickerRef.current?.contains(t)) return
      if (modelChipRef.current?.contains(t)) return
      setModelOpen(false)
      setModelPos(null)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        setModelOpen(false)
        setModelPos(null)
      }
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [modelOpen])

  const pickModel = async (providerId: string, modelId: string): Promise<void> => {
    closeModelPicker()
    // Switching provider resets the model to its default — re-apply the pick
    if (providerId !== activeProviderId) await setActiveProvider(providerId)
    setSelectedModel(modelId)
    // Persist the pick as THIS provider's default so the next session (and the
    // Auto label) resolves to it — no re-picking every time. Silent + best-effort.
    if (!isAutoModel(modelId) && modelId) {
      window.api.setAIProviderDefaultModel(providerId, modelId).catch(() => {
        /* non-critical — the in-session pick already applied */
      })
    }
  }
  const pickAuto = (): void => {
    closeModelPicker()
    setSelectedModel(AUTO_MODEL)
  }

  const openMenu = (): void => {
    const el = menuBtnRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    // Anchor below the button, right-aligned so it never overflows the left edge
    setMenuPos({ top: rect.bottom + 4, right: window.innerWidth - rect.right })
    setMenuOpen(true)
  }
  const closeMenu = (): void => {
    setMenuOpen(false)
    setMenuPos(null)
  }

  // ⋮ menu: dismiss on outside mousedown or Escape (same pattern as the picker)
  useEffect(() => {
    if (!menuOpen) return
    const onDown = (e: MouseEvent): void => {
      const t = e.target as Node
      if (menuRef.current?.contains(t)) return
      if (menuBtnRef.current?.contains(t)) return
      closeMenu()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') closeMenu()
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [menuOpen])

  const imgDataUrl = (a: ImageAttachment): string => `data:${a.mimeType};base64,${a.dataBase64}`

  const IMAGE_MAX_BYTES = 4 * 1024 * 1024
  const IMAGE_MIME_OK = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']

  const flashError = (msg: string): void => {
    setApplyOk(false)
    setApplyMsg(msg)
    setTimeout(() => setApplyMsg(''), 4000)
  }

  /** Read an image File into an attachment (size + type + count guarded). */
  const addImageFile = (file: File): void => {
    if (!IMAGE_MIME_OK.includes(file.type)) {
      flashError(`${file.name || 'Gambar'}: format tidak didukung (png/jpeg/webp/gif)`)
      return
    }
    if (file.size > IMAGE_MAX_BYTES) {
      flashError(`${file.name || 'Gambar'}: terlalu besar (>4MB)`)
      return
    }
    if (attachments.length >= 4) {
      flashError('Maksimal 4 gambar per pesan')
      return
    }
    const reader = new FileReader()
    reader.onload = () => {
      const dataUrl = String(reader.result || '')
      const match = dataUrl.match(/^data:([^;,]+)(?:;[^,]*)?,/)
      if (!match) return
      setAttachments((prev) => [
        ...prev,
        { mimeType: match[1], dataBase64: dataUrl.slice(dataUrl.indexOf(',') + 1), name: file.name }
      ])
    }
    reader.readAsDataURL(file)
  }

  const handlePaste = (e: React.ClipboardEvent): void => {
    const items = e.clipboardData?.items
    if (!items) return
    const imgs = Array.from(items).filter((i) => i.type.startsWith('image/'))
    if (imgs.length === 0) return
    e.preventDefault()
    for (const item of imgs) {
      const file = item.getAsFile()
      if (file) addImageFile(file)
    }
  }

  const handleDrop = (e: React.DragEvent): void => {
    e.preventDefault()
    const files = Array.from(e.dataTransfer?.files || [])
    for (const f of files) {
      if (f.type.startsWith('image/')) addImageFile(f)
    }
  }

  const handleSend = (): void => {
    if ((!inputText.trim() && attachments.length === 0) || isGenerating) return
    stickToBottom.current = true
    sendMessage(inputText, activeTab?.path, attachments.length ? attachments : undefined)
    setInputText('')
    setAttachments([])
    closeSlash()
    requestAnimationFrame(() => inputRef.current?.focus())
  }

  // P2-3: anchor the slash popover above the textarea (bottom of the panel)
  const updateSlashPos = (): void => {
    const el = inputRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const width = 280
    const left = Math.min(rect.left, Math.max(0, window.innerWidth - width - 8))
    setSlashPos({ left, bottom: window.innerHeight - rect.top + 6 })
  }

  const closeSlash = useCallback((): void => {
    setSlashOpen(false)
    setSlashPos(null)
  }, [])

  /** Shared fill path for BOTH the composer popover (P2-3) and the global
   * CommandPalette bridge (P2-5): template in, caret to the end, focus. */
  const fillComposer = useCallback(
    (cmd: SlashCommand): void => {
      setInputText(cmd.template)
      closeSlash()
      // Move the caret to the end so typing continues after the template
      requestAnimationFrame(() => {
        const ta = inputRef.current
        if (ta) {
          ta.focus()
          ta.setSelectionRange(ta.value.length, ta.value.length)
        }
      })
    },
    [closeSlash]
  )

  const selectSlash = (cmd: SlashCommand): void => {
    fillComposer(cmd)
    // R1-3: /plan arms plan mode — write tools off, analysis → steps →
    // create_plan proposal. The toggle stays on so the user sees it is armed.
    if (cmd.name === '/plan') setPlanMode(true)
  }

  // P2-5: global CommandPalette (Ctrl+P) slash commands → composer. The panel
  // unmounts while hidden, so the palette's request is stashed in the bridge
  // and consumed here — either by this listener (panel already mounted) or by
  // the mount catch-up below (panel was hidden when the palette fired).
  useEffect(() => {
    // R1-3: /plan arms plan mode wherever it is selected (composer popover AND
    // the global Ctrl+P palette) so both paths behave identically.
    const armPlanIfNeeded = (cmd: SlashCommand): void => {
      if (cmd.name === '/plan') setPlanMode(true)
    }
    const applyGlobal = (name: string): void => {
      consumeComposerCommand()
      const cmd = findSlashCommand(name)
      if (cmd) {
        fillComposer(cmd)
        armPlanIfNeeded(cmd)
      }
    }
    const onCmd = (e: Event): void => {
      applyGlobal(String((e as CustomEvent<string>).detail ?? ''))
    }
    window.addEventListener('wg:composer-command', onCmd)
    // Already consumed here — hand the command straight to the shared fill path.
    // One-shot mount catch-up from the bridge stash (same pattern as the
    // fetch-on-toggle hydration above), not an event-driven setState.
    const pending = consumeComposerCommand()
    if (pending) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      fillComposer(pending)
      armPlanIfNeeded(pending)
    }
    return () => window.removeEventListener('wg:composer-command', onCmd)
  }, [fillComposer, setPlanMode])

  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>): void => {
    const v = e.target.value
    setInputText(v)
    const trimmed = v.replace(/^\s+/, '')
    // Open while the input starts with '/command' and no space follows yet
    if (trimmed.startsWith('/') && !/^\S+\s/.test(trimmed)) {
      setSlashQuery(trimmed.split(/\s+/)[0] || '/')
      setSlashActive(0)
      setSlashOpen(true)
      updateSlashPos()
    } else {
      closeSlash()
    }
  }

  const slashFiltered = slashOpen ? filterSlashCommands(SLASH_COMMANDS, slashQuery) : []

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (slashOpen && slashFiltered.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSlashActive((i) => (i + 1) % slashFiltered.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSlashActive((i) => (i - 1 + slashFiltered.length) % slashFiltered.length)
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        const cmd = slashFiltered[slashActive]
        if (cmd) selectSlash(cmd)
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        closeSlash()
        return
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const handleCopy = async (text: string, id: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text)
      setCopyFlash(id)
      setTimeout(() => setCopyFlash(null), 1200)
    } catch {
      /* ignore */
    }
  }

  const handleAppend = (text: string): void => {
    // Read full content at click time — subscription only keeps path/title to avoid keystroke re-renders
    const tab = getActiveTab()
    if (tab) {
      updateContent(tab.id, tab.content + '\n\n' + text)
      void saveTab(tab.id)
    }
  }

  const openCitation = async (path: string): Promise<void> => {
    hideCiteTip()
    await openTab(path)
    setActiveView('editor')
  }

  /** P1-2: dismiss the cite tooltip (also cancels the pending hover timer). */
  const hideCiteTip = useCallback((): void => {
    if (citeHoverTimerRef.current) {
      clearTimeout(citeHoverTimerRef.current)
      citeHoverTimerRef.current = null
    }
    citeSeqRef.current++
    setCiteTip(null)
  }, [])

  /** P1-2: show the cite tooltip after a short rest (no flicker on chip sweeps). */
  const showCiteTip = useCallback((c: CitationItem, el: HTMLButtonElement, weak: boolean): void => {
    if (citeHoverTimerRef.current) clearTimeout(citeHoverTimerRef.current)
    citeHoverTimerRef.current = setTimeout(() => {
      citeHoverTimerRef.current = null
      const rect = el.getBoundingClientRect()
      const pos = citeTipPos(rect, { width: window.innerWidth, height: window.innerHeight })
      const seq = ++citeSeqRef.current
      setCiteTip({
        x: pos.x,
        y: pos.y,
        path: c.path,
        title: c.title,
        weak,
        loaded: false,
        text: null
      })
      void citeCache()
        .get(citeNode(c.path))
        .then((text) => {
          // A newer hover/leave bumped the seq — never overwrite a fresh tooltip
          if (seq !== citeSeqRef.current) return
          setCiteTip((cur) => (cur && cur.path === c.path ? { ...cur, loaded: true, text } : cur))
        })
    }, 180)
  }, [])

  // Cleanup the hover timer if the panel unmounts mid-delay
  useEffect(() => {
    return () => {
      if (citeHoverTimerRef.current) clearTimeout(citeHoverTimerRef.current)
    }
  }, [])

  const openDiff = async (p: WriteProposalItem): Promise<void> => {
    // Read the current disk content for the diff — create proposals have none
    let theirs = ''
    try {
      const res = await window.api.readFile(p.absolutePath)
      theirs = res?.content ?? ''
    } catch {
      /* create mode / file missing — diff vs empty */
    }
    setDiffTarget({ p, theirs })
  }

  const handleApply = async (p: WriteProposalItem, content?: string): Promise<void> => {
    const res = await applyProposal(p.id, content)
    if (res.ok) {
      setApplyOk(true)
      setApplyMsg(`Diterapkan · graph/search ter-update · ${p.relativePath}`)
      await fetchState()
      if (p.absolutePath) {
        await openTab(p.absolutePath)
        // Stay on editor so user sees memory/domain note — graph densifies via wikilinks
        setActiveView('editor')
      }
    } else {
      setApplyOk(false)
      setApplyMsg(res.error || 'Gagal menerapkan')
    }
    setTimeout(() => setApplyMsg(''), 4000)
  }

  const handleLearn = async (): Promise<void> => {
    if (isGenerating) return
    stickToBottom.current = true
    const res = await learnWorkspace(activeTab?.path)
    if (!res.ok) {
      setApplyOk(false)
      setApplyMsg(res.error || 'Bootstrap gagal')
      setTimeout(() => setApplyMsg(''), 4000)
    }
  }

  const openMemoryIndex = async (): Promise<void> => {
    try {
      await window.api.ensureAiMemory()
      const list = await window.api.listAiMemory()
      const index =
        list.files?.find((f) => /00\s*Index/i.test(f)) || list.core?.[0] || list.files?.[0]
      if (!index) return
      const rootPath = useWorkspaceStore.getState().rootPath
      if (!rootPath) return
      const sep = rootPath.includes('\\') ? '\\' : '/'
      const abs = `${rootPath.replace(/[/\\]$/, '')}${sep}${index.replace(/\//g, sep)}`
      await openTab(abs)
      setActiveView('editor')
    } catch (err) {
      console.error(err)
    }
  }

  const handleClear = async (): Promise<void> => {
    if (messages.length === 0) return
    const ok = await confirmDialog({
      title: 'Hapus percakapan?',
      message: 'Percakapan ini akan dihapus dari sesi ini.',
      danger: true,
      okLabel: 'Hapus'
    })
    if (!ok) return
    clearHistory()
    setShowHistory(false)
  }

  const handleNewChat = (): void => {
    if (isGenerating) return
    if (messages.length > 0) {
      void saveCurrentChat()
    }
    clearHistory()
    setShowHistory(false)
    inputRef.current?.focus()
  }

  const handleLoadChat = async (id: string): Promise<void> => {
    if (isGenerating) return
    await loadChat(id)
    setShowHistory(false)
    stickToBottom.current = true
  }

  const handleDeleteChat = async (id: string): Promise<void> => {
    if (isGenerating) return
    const res = await deleteChat(id)
    if (res.ok) {
      setApplyOk(true)
      setApplyMsg('Chat terhapus')
    } else {
      setApplyOk(false)
      setApplyMsg(res.error || 'Gagal menghapus chat')
    }
    setTimeout(() => setApplyMsg(''), 3000)
    void refreshHistory()
  }

  const handleRetry = (): void => {
    if (isGenerating) return
    stickToBottom.current = true
    void retryLastMessage(activeTab?.path)
  }

  const handleRephrase = (msg: ChatMessage): void => {
    if (isGenerating) return
    stickToBottom.current = true
    void rephraseMessage(msg.id, activeTab?.path)
  }

  /** P3-1: arm composer follow-up mode for a proposal-bearing message. */
  const startFollowUp = (msg: ChatMessage): void => {
    setFollowUp(msg.id)
    inputRef.current?.focus()
  }

  /** R2-2: continue a truncated reply from its saved checkpoint. */
  const handleResume = (msg: ChatMessage): void => {
    if (isGenerating) return
    stickToBottom.current = true
    void resumeStream(msg.id, activeTab?.path)
  }

  /** P2: promote this answer into a Knowledge/ note proposal (+ backlinks). */
  const handlePromoteKnowledge = async (msg: ChatMessage): Promise<void> => {
    if (isGenerating) return
    // Optional title — defaults to the answer's first line (promoteToKnowledge)
    const title = await promptDialog({
      title: 'Simpan sebagai Knowledge',
      message: 'Judul catatan (kosongkan untuk memakai baris pertama jawaban):',
      okLabel: 'Buat proposal',
      initialValue: ''
    })
    if (title === null) return // user cancelled
    const res = await promoteAnswer(msg.id, title.trim() || undefined)
    if (res.ok) {
      setApplyOk(true)
      setApplyMsg(`Proposal Knowledge dibuat — Apply di panel untuk menyimpan`)
    } else {
      setApplyOk(false)
      setApplyMsg(res.error || 'Gagal menyimpan ke Knowledge')
    }
    setTimeout(() => setApplyMsg(''), 4000)
  }

  // P3-1: composer chip source — the message must still exist (rephrase/clear
  // removes it); sendMessage also tolerates a missing source (plain send).
  const followUpMsg = followUpMessageId
    ? messages.find((m) => m.id === followUpMessageId)
    : undefined
  const followUpChip = followUpMsg ? followUpChipLabel(followUpMsg.proposals) : ''

  const openProposals = pendingProposals.filter(
    (p) => p.status === 'pending' || p.status === undefined
  )
  // P2-2: after the stream settles, the status line reports what the agent did
  // (from the LAST assistant message's tool trail) instead of a bare 'idle'.
  const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant')
  const toolSummaryText = isGenerating
    ? ''
    : toolSummaryLabel(summarizeToolRuns(lastAssistant?.toolRuns))
  const statusLine = isGenerating
    ? lastToolStatus || lastKernelStatus || 'kernel: running…'
    : toolSummaryText || lastKernelStatus || lastToolStatus || 'kernel: idle'
  // R2-1: append the session cost to the status line when the session billed
  const costSuffix = sessionCost > 0 ? ` · ${formatUsd(sessionCost)}` : ''

  return (
    <aside
      className={`chat-panel chat-panel--kernel ${resizing ? 'is-resizing' : ''}`}
      style={{ '--chat-w': `${chatWidth}px` } as React.CSSProperties}
      aria-label="AI kernel assistant"
    >
      <div
        className="wg-resize-handle wg-resize-handle--left"
        onMouseDown={chatResize}
        role="separator"
        aria-orientation="vertical"
        aria-label="Ubah lebar panel AI"
      />
      {/* ── Kernel chrome — single clean row: title + (live status only while
          working) + three icons. Secondary actions live in the ⋮ menu. ── */}
      <div className="chat-toolbar">
        <div className="chat-toolbar-top">
          <div className="chat-toolbar-title">
            <span className="chat-kernel-badge" aria-hidden>
              $
            </span>
            <span>AI Kernel</span>
            {isGenerating && <span className="chat-live-dot" title="Generating" />}
            {(isGenerating || toolSummaryText) && (
              <span className="chat-kernel-status" title={statusLine + costSuffix}>
                <span className="chat-kernel-prompt">wg</span>
                <span className="truncate">{statusLine}</span>
                {costSuffix && <span className="chat-cost-chip">{costSuffix}</span>}
              </span>
            )}
          </div>
          <div className="chat-toolbar-icons">
            <button
              type="button"
              className="btn btn-ghost btn-sm btn-icon"
              onClick={handleNewChat}
              data-tooltip="New session"
              aria-label="New chat"
              disabled={isGenerating}
            >
              <Icon name="plus" size={14} />
            </button>
            <button
              type="button"
              ref={menuBtnRef}
              className={`btn btn-ghost btn-sm btn-icon${menuOpen ? ' active' : ''}`}
              onClick={() => (menuOpen ? closeMenu() : openMenu())}
              data-tooltip="Opsi chat"
              aria-label="Opsi chat"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
            >
              <Icon name="more" size={14} />
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm btn-icon"
              onClick={toggleAIChat}
              data-tooltip="Close (Ctrl+J)"
              aria-label="Close AI panel"
            >
              <Icon name="close" size={14} />
            </button>
          </div>
        </div>
        {activeTab && (
          <div className="chat-context-chip" title={activeTab.path}>
            <Icon name="file" size={11} />
            <span className="truncate">{activeTab.title}</span>
          </div>
        )}
      </div>
      {/* History drawer */}{' '}
      {showHistory && (
        <div className="chat-history">
          <div className="chat-history-head">
            <span>Riwayat chat</span>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => void refreshHistory()}
            >
              Muat ulang
            </button>
          </div>
          <input
            className="chat-history-search"
            placeholder="Cari chat…"
            value={historyQuery}
            onChange={(e) => setHistoryQuery(e.target.value)}
            aria-label="Cari riwayat chat"
          />
          {history.length === 0 ? (
            <div className="chat-history-empty">Belum ada chat tersimpan.</div>
          ) : (
            history
              .filter((h) =>
                historyQuery.trim()
                  ? (h.title || '').toLowerCase().includes(historyQuery.trim().toLowerCase())
                  : true
              )
              .slice(0, 20)
              .map((h) => (
                <div key={h.id} className="chat-history-item">
                  <button
                    type="button"
                    className="chat-history-load"
                    onClick={() => void handleLoadChat(h.id)}
                  >
                    <span className="truncate">{h.title || h.id}</span>
                    {h.updatedAt && (
                      <span className="chat-history-meta">
                        {new Date(h.updatedAt).toLocaleString(undefined, {
                          month: 'short',
                          day: 'numeric',
                          hour: '2-digit',
                          minute: '2-digit'
                        })}
                      </span>
                    )}
                  </button>
                  <button
                    type="button"
                    className="chat-history-del"
                    aria-label="Hapus chat"
                    title="Hapus chat tersimpan"
                    onClick={() => void handleDeleteChat(h.id)}
                  >
                    <Icon name="trash" size={12} />
                  </button>
                </div>
              ))
          )}
        </div>
      )}
      {/* Write proposals — dock */}
      {openProposals.length > 0 && (
        <div className="chat-proposals">
          <div className="chat-proposals-title">
            <Icon name="warning" size={13} />
            Proposal · Terapkan agar memori/graph ter-update
          </div>
          {openProposals.map((p) => (
            <div key={p.id} className="chat-proposal-card">
              <div className="chat-proposal-path">
                <strong>{p.mode}</strong> · {p.relativePath}
              </div>
              <div className="chat-proposal-preview truncate" title={p.preview}>
                {p.preview}
              </div>
              <div className="chat-proposal-actions">
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => void openDiff(p)}
                  title="Lihat diff disk vs proposal sebelum terapkan"
                >
                  Diff
                </button>
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  onClick={() => void handleApply(p)}
                >
                  Terapkan
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => void rejectProposal(p.id)}
                >
                  Tolak
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
      {applyMsg && <div className={`chat-banner ${applyOk ? 'ok' : 'err'}`}>{applyMsg}</div>}
      {isGenerating && lastToolStatus && (
        <div className="chat-tool-status">
          <span className="chat-spinner" />
          {lastToolStatus}
        </div>
      )}
      {/* Messages */}
      <div className="chat-messages" ref={messagesBoxRef}>
        {messages.length === 0 ? (
          <div className="chat-empty chat-empty--kernel">
            <div className="chat-empty-kernel-line">
              <span className="chat-kernel-prompt">wg</span>
              <span>asisten workspace · memori di AI Memory/ · graph = peta link</span>
            </div>
            <p>
              Semakin banyak note + [[wikilink]], semakin padat graph dan semakin tajam context AI.
              Mulai dengan bootstrap memori, atau tanya langsung (Tools on).
            </p>
            <div className="chat-empty-hints">
              <button
                type="button"
                className="chat-hint"
                disabled={isGenerating}
                onClick={() => void handleLearn()}
              >
                Pelajari workspace
              </button>
              <button
                type="button"
                className="chat-hint"
                onClick={() => setInputText('Apa yang sudah ada di AI Memory?')}
              >
                Cek memori
              </button>
              <button
                type="button"
                className="chat-hint"
                onClick={() => setInputText('Ringkas struktur vault dan usulkan update Cara Kerja')}
              >
                Map vault
              </button>
            </div>
          </div>
        ) : (
          messages.map((msg) => {
            const isErr =
              msg.content?.includes('**Error:**') ||
              msg.content?.startsWith('Error:') ||
              msg.content?.includes('*(cancelled)*')
            const streamingThis =
              isGenerating &&
              msg.role === 'assistant' &&
              msg.id === messages[messages.length - 1]?.id
            return (
              <div key={msg.id} className={`chat-message ${msg.role}`}>
                <div className="message-role">
                  {msg.role === 'user' ? 'you' : 'kernel'} · {msg.timestamp}
                  {msg.tokensUsed ? ` · ${msg.tokensUsed} tok` : ''}
                  {msg.contextTokens ? ` · ctx ~${msg.contextTokens}` : ''}
                  {/* P1-4: measured context savings from the round-0-only prompt */}
                  {msg.contextSavedTokens ? ` · hemat ~${formatK(msg.contextSavedTokens)}` : ''}
                  {/* Old saved chats carry toolStatus without the structured trail */}
                  {!msg.toolRuns?.length && msg.toolStatus ? ` · ${msg.toolStatus}` : ''}
                </div>
                <div className={`message-bubble ${isErr ? 'is-error' : ''}`}>
                  {/* P2-4: chain-of-thought renders BEFORE the answer */}
                  {msg.role === 'assistant' && msg.reasoning && (
                    <ReasoningBlock text={msg.reasoning} streaming={streamingThis} />
                  )}
                  {msg.content ? (
                    <ChatMessageBody content={msg.content} streaming={streamingThis} />
                  ) : streamingThis && !msg.reasoning ? (
                    // The live ReasoningBlock already carries its own spinner —
                    // don't show a second "working…" indicator underneath it
                    <span className="chat-thinking">
                      <span className="chat-spinner" /> working…
                    </span>
                  ) : (
                    ''
                  )}

                  {msg.role === 'assistant' && msg.toolRuns && msg.toolRuns.length > 0 && (
                    <ToolRunList runs={msg.toolRuns} streaming={streamingThis} />
                  )}

                  {msg.images && msg.images.length > 0 && (
                    <div className="chat-msg-images">
                      {msg.images.map((img, i) => (
                        <img
                          key={`${msg.id}-img-${i}`}
                          className="chat-msg-img"
                          src={imgDataUrl(img)}
                          alt={img.name || `lampiran ${i + 1}`}
                          loading="lazy"
                        />
                      ))}
                    </div>
                  )}

                  {msg.citations && msg.citations.length > 0 && (
                    <div className="chat-citations">
                      <span className="chat-citations-label">refs</span>
                      {msg.citations.map((c) => {
                        const v = msg.verifications?.find((x) => x.path === c.path)
                        const weak = v !== undefined && !v.supported
                        return (
                          <button
                            key={c.path}
                            type="button"
                            className={`chat-citation-chip${weak ? ' is-weak' : ''}`}
                            onClick={() => void openCitation(c.path)}
                            onMouseEnter={(e) => showCiteTip(c, e.currentTarget, weak)}
                            onMouseLeave={hideCiteTip}
                            // Custom tooltip already shows path + weak warning — the
                            // native title would double-tooltip; keep aria-label for
                            // keyboard a11y (the portaled tooltip is pointer-none)
                            aria-label={`${c.path}${weak ? ' (verifikasi lemah)' : ''}`}
                          >
                            [[{c.title}]]{weak ? ' ⚠' : ''}
                          </button>
                        )
                      })}
                      {msg.verifications?.some((x) => !x.supported) && (
                        <span
                          className="chat-citations-weak-hint"
                          title="Cek manual catatan sebelum mempercayai klaim"
                        >
                          ⚠ beberapa ref lemah
                        </span>
                      )}
                    </div>
                  )}

                  {msg.role === 'assistant' && msg.content && !isGenerating && (
                    <div className="chat-msg-actions">
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        onClick={() => void handleCopy(msg.content, msg.id)}
                      >
                        {copyFlash === msg.id ? 'Copied' : 'Copy'}
                      </button>
                      {/* R2-2: continue a truncated reply from its checkpoint —
                          only when there is real partial content to append to
                          (markers stripped), not an empty/error stub. */}
                      {msg.checkpoint && stripTruncationMarkers(msg.content).length > 0 && (
                        <button
                          type="button"
                          className="btn btn-surface btn-sm chat-resume-btn"
                          onClick={() => handleResume(msg)}
                          title={`Lanjutkan dari checkpoint (round ${msg.checkpoint.round} · ${msg.checkpoint.reason}) — stream terputus, lanjut dari titik terakhir tanpa mulai ulang`}
                        >
                          <Icon name="play" size={12} /> Lanjutkan
                        </button>
                      )}
                      {isErr ? (
                        <button
                          type="button"
                          className="btn btn-surface btn-sm"
                          onClick={() => void handleRetry()}
                          title="Kirim ulang pertanyaan terakhir"
                        >
                          <Icon name="sync" size={12} /> Retry
                        </button>
                      ) : (
                        msg.id === messages[messages.length - 1]?.id && (
                          <button
                            type="button"
                            className="btn btn-ghost btn-sm"
                            onClick={handleRetry}
                            title="Buat ulang jawaban ini (jalankan ulang prompt terakhir)"
                          >
                            <Icon name="sync" size={12} /> Regenerate
                          </button>
                        )
                      )}
                      {!isErr && (
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          onClick={() => handleRephrase(msg)}
                          title="Minta model menulis ulang jawaban ini dengan gaya berbeda (percakapan setelah pesan ini dihapus)"
                        >
                          <Icon name="refresh" size={12} /> Rephrase
                        </button>
                      )}
                      {activeTab && (
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          onClick={() => handleAppend(msg.content)}
                        >
                          Append
                        </button>
                      )}
                      {msg.proposals && msg.proposals.length > 0 && (
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          onClick={() => startFollowUp(msg)}
                          title="Lanjutkan dari proposal pesan ini — konteksnya ikut pada pertanyaan berikutnya"
                        >
                          Follow-up
                        </button>
                      )}
                      {!isErr && (
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          onClick={() => void handlePromoteKnowledge(msg)}
                          title="Simpan jawaban ini sebagai catatan Knowledge/ dengan backlink ke sumbernya (proposal — Apply di panel)"
                        >
                          <Icon name="plus" size={12} /> Simpan sebagai Knowledge
                        </button>
                      )}
                    </div>
                  )}
                </div>
              </div>
            )
          })
        )}
        <div ref={messagesEndRef} />
      </div>
      {/* P1-2: cite-on-hover preview — portaled to body, never clipped by the scroll box */}
      {citeTip &&
        createPortal(
          <div className="chat-cite-tooltip" style={{ left: citeTip.x, top: citeTip.y }}>
            <div className="cct-title">[[{citeTip.title}]]</div>
            <div className="cct-path">{citeTip.path}</div>
            {citeTip.loaded ? (
              citeTip.text ? (
                <div className="cct-preview">{citeTip.text}</div>
              ) : null
            ) : (
              <div className="cct-preview cct-loading">memuat…</div>
            )}
            {citeTip.weak && <div className="cct-weak">⚠ klaim jawaban lemah — cek manual</div>}
          </div>,
          document.body
        )}
      {/* P2-1: per-session token budget bar — hidden until there is usage to show.
          The budget is a rough model-family estimate, so the label marks it with
          ~ and only genuinely near-limit usage turns critical (red). */}
      {outputTokens > 0 && (
        <div
          className={`chat-budget${budgetPct >= 0.95 ? ' is-critical' : budgetPct >= 0.6 ? ' is-warn' : ''}`}
          title={`Model ${budgetModel || 'auto'} · budget ~${formatK(budget)} token · output sesi ${formatK(outputTokens)}${contextTokens ? ` · ctx terakhir ~${formatK(contextTokens)}` : ''}${savedTokens ? ` · hemat ~${formatK(savedTokens)}` : ''}${sessionCost > 0 ? ` · ~${formatUsd(sessionCost)}` : ''}`}
          role="progressbar"
          aria-valuenow={Math.round(budgetPct * 100)}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={`Output sesi ${formatK(outputTokens)} dari ~${formatK(budget)} token`}
        >
          <div className="chat-budget-track" aria-hidden>
            <div className="chat-budget-fill" style={{ width: `${budgetPct * 100}%` }} />
          </div>
          <span className="chat-budget-label">
            out {formatK(outputTokens)}/~{formatK(budget)}
            {contextTokens ? ` · ctx ~${formatK(contextTokens)}` : ''}
            {savedTokens ? ` · −${formatK(savedTokens)}` : ''}
            {sessionCost > 0 ? ` · ~${formatUsd(sessionCost)}` : ''}
          </span>
        </div>
      )}
      {/* Composer */}
      <div className="chat-input-area">
        {/* P3-1: follow-up mode chip — shows the armed source, dismissible */}
        {followUpMsg && followUpChip && (
          <div
            className="chat-followup-chip"
            title="Proposal pesan ini akan jadi konteks pertanyaan berikutnya"
          >
            <Icon name="command" size={11} />
            <span className="truncate">{followUpChip}</span>
            <button
              type="button"
              className="chat-followup-clear"
              aria-label="Batal follow-up"
              onClick={() => setFollowUp(null)}
            >
              <Icon name="close" size={10} />
            </button>
          </div>
        )}
        {attachments.length > 0 && (
          <div className="chat-attach-strip">
            {attachments.map((a, i) => (
              <div key={`${a.name || 'img'}-${i}`} className="chat-attach-item">
                <img className="chat-attach-thumb" src={imgDataUrl(a)} alt={a.name || 'gambar'} />
                <button
                  type="button"
                  className="chat-attach-remove"
                  aria-label="Hapus lampiran"
                  title="Hapus lampiran"
                  onClick={() => setAttachments((prev) => prev.filter((_, idx) => idx !== i))}
                >
                  <Icon name="close" size={10} />
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="chat-composer">
          <textarea
            ref={inputRef}
            className="chat-input"
            placeholder="perintah / tanya kernel… (ketik / untuk perintah · Enter kirim · paste/drag gambar)"
            value={inputText}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            onBlur={closeSlash}
            onPaste={handlePaste}
            onDrop={handleDrop}
            disabled={isGenerating}
            aria-label="Chat message"
            rows={2}
          />
          {/* P2-3: slash command popover — portaled so .chat-panel clipping never hits it */}
          {slashOpen &&
            slashPos &&
            slashFiltered.length > 0 &&
            createPortal(
              <div
                className="chat-slash-picker"
                style={{ left: slashPos.left, bottom: slashPos.bottom }}
                role="listbox"
                aria-label="Perintah chat"
              >
                {slashFiltered.map((cmd, i) => (
                  <button
                    key={cmd.name}
                    type="button"
                    className={`chat-slash-row${i === slashActive ? ' active' : ''}`}
                    onMouseDown={(e) => {
                      // mousedown fires before blur — select without losing focus
                      e.preventDefault()
                      selectSlash(cmd)
                    }}
                    onMouseEnter={() => setSlashActive(i)}
                    role="option"
                    aria-selected={i === slashActive}
                  >
                    <span className="chat-slash-name">{cmd.name}</span>
                    <span className="chat-slash-label">{cmd.label}</span>
                  </button>
                ))}
              </div>,
              document.body
            )}

          <div className="chat-input-footer">
            <button
              ref={modelChipRef}
              type="button"
              className={`chat-model-chip${modelOpen ? ' open' : ''}`}
              onClick={() => (modelOpen ? closeModelPicker() : openModelPicker())}
              title={
                isAutoModel(selectedModelId)
                  ? `Model default provider (${resolveAutoModel(activeProvider) || 'belum tersedia'})`
                  : `Model: ${modelName}`
              }
              aria-haspopup="listbox"
              aria-expanded={modelOpen}
            >
              <span className="chat-model-chip-name">{modelName}</span>
              <span className="chat-model-chip-chev" aria-hidden>
                ▾
              </span>
            </button>

            {isGenerating ? (
              <button
                type="button"
                className="btn btn-surface btn-sm chat-cancel-btn"
                onClick={() => void cancelStream()}
              >
                <Icon name="cancel" size={12} />
                Cancel
              </button>
            ) : (
              <button
                type="button"
                className="chat-send-btn"
                onClick={handleSend}
                disabled={!inputText.trim() && attachments.length === 0}
                aria-label="Kirim pesan"
                title="Kirim (Enter)"
              >
                <Icon name="send" size={16} />
              </button>
            )}
          </div>
        </div>
      </div>
      {/* P2-6: proposal diff preview — reuses the MergeDialog shell (portaled) */}
      {diffTarget && (
        <MergeDialog
          isOpen={true}
          onClose={() => setDiffTarget(null)}
          onResolve={(resolved) => {
            const t = diffTarget
            setDiffTarget(null)
            void handleApply(t.p, resolved)
          }}
          variant="proposal"
          mode={diffTarget.p.mode}
          filePath={diffTarget.p.relativePath}
          theirs={diffTarget.theirs}
          yours={diffTarget.p.content}
        />
      )}
      {/* P1-3: inline model picker — portaled so .chat-panel's overflow:hidden
          never clips the upward dropdown */}
      {modelOpen &&
        modelPos &&
        createPortal(
          <div
            ref={modelPickerRef}
            className="chat-model-picker"
            style={{ left: modelPos.left, bottom: modelPos.bottom }}
            role="listbox"
            aria-label="Pilih model"
          >
            <button
              type="button"
              className={`chat-model-row chat-model-row--auto${isAutoModel(selectedModelId) ? ' active' : ''}`}
              onClick={() => void pickAuto()}
              role="option"
              aria-selected={isAutoModel(selectedModelId)}
              title="Ikuti model default provider yang aktif"
            >
              <span className="chat-model-row-check" aria-hidden>
                {isAutoModel(selectedModelId) ? '✓' : ''}
              </span>
              <span className="chat-model-row-name">{autoLabel(activeProvider)}</span>
            </button>
            {modelGroups.map((g) => (
              <div key={g.providerId} className="chat-model-group">
                <div className="chat-model-group-title">{g.providerName}</div>
                {g.models.map((m) => {
                  const active =
                    !isAutoModel(selectedModelId) &&
                    selectedModelId === m.id &&
                    g.providerId === activeProviderId
                  const subtitle = modelDetailSubtitle(m)
                  return (
                    <button
                      key={`${g.providerId}:${m.id}`}
                      type="button"
                      className={`chat-model-row${active ? ' active' : ''}`}
                      onClick={() => void pickModel(g.providerId, m.id)}
                      role="option"
                      aria-selected={active}
                    >
                      <span className="chat-model-row-check" aria-hidden>
                        {active ? '✓' : ''}
                      </span>
                      <span className="chat-model-row-name">{m.name}</span>
                      {subtitle && (
                        <span className="chat-model-row-sub" title={subtitle}>
                          {subtitle}
                        </span>
                      )}
                      {m.free && <span className="chat-model-free-badge">Gratis</span>}
                    </button>
                  )
                })}
              </div>
            ))}
            {/* Mode + Role: session controls live with the model list so the
                composer stays a single clean row (model chip + send). */}
            <div className="chat-picker-section">
              <div className="chat-picker-section-title">Mode</div>
              <div className="chat-picker-toggles">
                <button
                  type="button"
                  className={`chat-picker-toggle${useContext ? ' on' : ''}`}
                  title="Context: inject vault context + AI Memory"
                  aria-pressed={useContext}
                  onClick={() => setUseContext(!useContext)}
                >
                  <Icon name="psychology" size={13} />
                  Context
                </button>
                <button
                  type="button"
                  className={`chat-picker-toggle${enableTools ? ' on' : ''}`}
                  title="Tools: search / read / write proposals"
                  aria-pressed={enableTools}
                  onClick={() => setEnableTools(!enableTools)}
                >
                  <Icon name="construction" size={13} />
                  Tools
                </button>
                <button
                  type="button"
                  className={`chat-picker-toggle chat-picker-toggle--plan${planMode ? ' on' : ''}`}
                  title="Plan mode (R1-3): write tools diblokir — model hanya menganalisis, menyusun langkah, lalu create_plan jadi proposal yang bisa ditinjau"
                  aria-pressed={planMode}
                  onClick={() => setPlanMode(!planMode)}
                >
                  <Icon name="planner" size={13} />
                  Plan
                </button>
              </div>
            </div>
            <div className="chat-picker-section">
              <div className="chat-picker-section-title">Role</div>
              <select
                className="chat-select chat-picker-role"
                value={agentRole}
                onChange={(e) => setAgentRole(e.target.value as never)}
                aria-label="Agent role"
              >
                <option value="general">General</option>
                <option value="writer">Writer</option>
                <option value="researcher">Researcher</option>
                <option value="curator">Curator</option>
                <option value="planner">Planner</option>
              </select>
            </div>
          </div>,
          document.body
        )}
      {/* ⋮ menu — portaled under the header button */}
      {menuOpen &&
        menuPos &&
        createPortal(
          <div
            ref={menuRef}
            className="chat-menu"
            style={{ top: menuPos.top, right: menuPos.right }}
            role="menu"
            aria-label="Opsi chat"
          >
            <button
              type="button"
              className="chat-menu-item"
              onClick={() => {
                closeMenu()
                handleNewChat()
              }}
              role="menuitem"
              disabled={isGenerating}
            >
              <Icon name="plus" size={13} />
              New chat
            </button>
            <button
              type="button"
              className="chat-menu-item"
              onClick={() => {
                closeMenu()
                setShowHistory((v) => !v)
              }}
              role="menuitem"
            >
              <Icon name="file" size={13} />
              History
            </button>
            <button
              type="button"
              className="chat-menu-item"
              onClick={() => {
                closeMenu()
                void saveCurrentChat()
              }}
              role="menuitem"
              disabled={messages.length === 0}
            >
              <Icon name="save" size={13} />
              Save session
            </button>
            <button
              type="button"
              className="chat-menu-item"
              onClick={() => {
                closeMenu()
                handleClear()
              }}
              role="menuitem"
              disabled={messages.length === 0 || isGenerating}
            >
              <Icon name="trash" size={13} />
              Clear chat
            </button>
            <div className="chat-menu-sep" role="separator" />
            <button
              type="button"
              className="chat-menu-item"
              onClick={() => {
                closeMenu()
                void handleLearn()
              }}
              role="menuitem"
              disabled={isGenerating}
              title="Scan vault → proposal isi AI Memory + wikilink (graph tumbuh)"
            >
              <Icon name="psychology" size={13} />
              Pelajari workspace
            </button>
            <button
              type="button"
              className="chat-menu-item"
              onClick={() => {
                closeMenu()
                void openMemoryIndex()
              }}
              role="menuitem"
              title="Buka AI Memory/00 Index.md"
            >
              <Icon name="note" size={13} />
              Memori
            </button>
          </div>,
          document.body
        )}
    </aside>
  )
}
