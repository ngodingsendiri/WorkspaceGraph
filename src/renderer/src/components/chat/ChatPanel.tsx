import React, { useEffect, useState, useRef, useCallback } from 'react'
import { useChatStore, WriteProposalItem } from '../../store/chatStore'
import { useEditorStore } from '../../store/editorStore'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { Icon } from '../ui/Icons'
import { confirmDialog } from '../ui/Dialog'
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
  const { width: chatWidth, onHandleMouseDown: chatResize, resizing } = usePanelWidth(
    'wg.chatWidth',
    360,
    280,
    640,
    (x) => window.innerWidth - x
  )
  const {
    messages,
    providers,
    activeProviderId,
    selectedModelId,
    agentRole,
    isGenerating,
    useContext,
    enableTools,
    pendingProposals,
    lastToolStatus,
    lastKernelStatus,
    fetchProviders,
    setActiveProvider,
    setSelectedModel,
    setAgentRole,
    setUseContext,
    setEnableTools,
    sendMessage,
    cancelStream,
    clearHistory,
    applyProposal,
    rejectProposal,
    saveCurrentChat,
    loadChat,
    deleteChat,
    retryLastMessage,
    learnWorkspace
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

  const messagesEndRef = useRef<HTMLDivElement>(null)
  const messagesBoxRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const stickToBottom = useRef(true)

  useEffect(() => {
    fetchProviders()
  }, [fetchProviders])

  const refreshHistory = useCallback(async () => {
    try {
      const list = (await window.api.listChats()) as ChatListItem[]
      setHistory(Array.isArray(list) ? list : [])
    } catch {
      setHistory([])
    }
  }, [])

  useEffect(() => {
    if (showHistory) void refreshHistory()
  }, [showHistory, refreshHistory])

  // Smart auto-scroll: only if user is near bottom
  useEffect(() => {
    const el = messagesBoxRef.current
    if (!el) return
    const onScroll = () => {
      const gap = el.scrollHeight - el.scrollTop - el.clientHeight
      stickToBottom.current = gap < 80
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
  const modelValue = modelOptions.some((m) => m.id === selectedModelId)
    ? selectedModelId
    : modelOptions[0]?.id || ''

  const handleSend = () => {
    if (!inputText.trim() || isGenerating) return
    stickToBottom.current = true
    sendMessage(inputText, activeTab?.path)
    setInputText('')
    requestAnimationFrame(() => inputRef.current?.focus())
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const handleCopy = async (text: string, id: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopyFlash(id)
      setTimeout(() => setCopyFlash(null), 1200)
    } catch {
      /* ignore */
    }
  }

  const handleAppend = (text: string) => {
    // Read full content at click time — subscription only keeps path/title to avoid keystroke re-renders
    const tab = getActiveTab()
    if (tab) {
      updateContent(tab.id, tab.content + '\n\n' + text)
      void saveTab(tab.id)
    }
  }

  const openCitation = async (path: string) => {
    await openTab(path)
    setActiveView('editor')
  }

  const handleApply = async (p: WriteProposalItem) => {
    const res = await applyProposal(p.id)
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

  const handleLearn = async () => {
    if (isGenerating) return
    stickToBottom.current = true
    const res = await learnWorkspace(activeTab?.path)
    if (!res.ok) {
      setApplyOk(false)
      setApplyMsg(res.error || 'Bootstrap gagal')
      setTimeout(() => setApplyMsg(''), 4000)
    }
  }

  const openMemoryIndex = async () => {
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

  const handleClear = async () => {
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

  const handleNewChat = () => {
    if (isGenerating) return
    if (messages.length > 0) {
      void saveCurrentChat()
    }
    clearHistory()
    setShowHistory(false)
    inputRef.current?.focus()
  }

  const handleLoadChat = async (id: string) => {
    if (isGenerating) return
    await loadChat(id)
    setShowHistory(false)
    stickToBottom.current = true
  }

  const handleDeleteChat = async (id: string) => {
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

  const handleRetry = () => {
    if (isGenerating) return
    stickToBottom.current = true
    void retryLastMessage(activeTab?.path)
  }

  const openProposals = pendingProposals.filter(
    (p) => p.status === 'pending' || p.status === undefined
  )
  const providerLabel = (p: {
    id: string
    name: string
    connected?: boolean
    configured?: boolean
  }) => {
    // Ollama: live probe. Cloud: key saved (not same as live Test).
    if (p.id === 'ollama') return p.connected ? p.name : `${p.name} · offline`
    if (p.configured) return p.name
    return `${p.name} · setup`
  }

  const statusLine =
    lastToolStatus || lastKernelStatus || (isGenerating ? 'kernel: running…' : 'kernel: idle')

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
      {/* ── Kernel chrome ── */}
      <div className="chat-toolbar">
        <div className="chat-toolbar-top">
          <div className="chat-toolbar-title">
            <span className="chat-kernel-badge" aria-hidden>
              $
            </span>
            <span>AI Kernel</span>
            {isGenerating && <span className="chat-live-dot" title="Generating" />}
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
              className={`btn btn-ghost btn-sm btn-icon ${showHistory ? 'active' : ''}`}
              onClick={() => setShowHistory((v) => !v)}
              data-tooltip="History"
              aria-label="Chat history"
            >
              <Icon name="file" size={14} />
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm btn-icon"
              onClick={() => void saveCurrentChat()}
              data-tooltip="Save session"
              aria-label="Save chat"
              disabled={messages.length === 0}
            >
              <Icon name="save" size={14} />
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm btn-icon"
              onClick={handleClear}
              data-tooltip="Clear"
              aria-label="Clear chat"
              disabled={messages.length === 0 || isGenerating}
            >
              <Icon name="trash" size={14} />
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

        <div className="chat-kernel-status" title={statusLine}>
          <span className="chat-kernel-prompt">wg</span>
          <span className="truncate">{statusLine}</span>
        </div>

        <div className="chat-toolbar-selects">
          <label className="chat-field">
            <span className="chat-field-label">Provider</span>
            <select
              className="chat-select"
              value={activeProviderId}
              onChange={(e) => void setActiveProvider(e.target.value)}
              aria-label="AI provider"
            >
              {providers.length === 0 && <option value={activeProviderId}>Loading…</option>}
              {providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {providerLabel(p)}
                </option>
              ))}
            </select>
          </label>

          <label className="chat-field">
            <span className="chat-field-label">Model</span>
            <select
              className="chat-select"
              value={modelValue}
              onChange={(e) => setSelectedModel(e.target.value)}
              aria-label="Model"
              disabled={modelOptions.length === 0}
            >
              {modelOptions.length === 0 && <option value="">—</option>}
              {modelOptions.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </label>

          <label className="chat-field">
            <span className="chat-field-label">Role</span>
            <select
              className="chat-select"
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
          </label>
        </div>

        <div className="chat-kernel-actions">
          <button
            type="button"
            className="local-graph-chip chat-kernel-chip"
            onClick={() => void handleLearn()}
            disabled={isGenerating}
            title="Scan vault → proposal isi AI Memory + wikilink (graph tumbuh)"
          >
            Pelajari workspace
          </button>
          <button
            type="button"
            className="local-graph-chip chat-kernel-chip"
            onClick={() => void openMemoryIndex()}
            title="Buka AI Memory/00 Index.md"
          >
            Memori
          </button>
        </div>

        {activeTab && (
          <div className="chat-context-chip" title={activeTab.path}>
            <Icon name="file" size={11} />
            <span className="truncate">{activeTab.title}</span>
          </div>
        )}
      </div>

      {/* History drawer */}        {showHistory && (
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
              isGenerating && msg.role === 'assistant' && msg.id === messages[messages.length - 1]?.id
            return (
              <div key={msg.id} className={`chat-message ${msg.role}`}>
                <div className="message-role">
                  {msg.role === 'user' ? 'you' : 'kernel'} · {msg.timestamp}
                  {msg.tokensUsed ? ` · ${msg.tokensUsed} tok` : ''}
                  {msg.contextTokens ? ` · ctx ~${msg.contextTokens}` : ''}
                  {msg.toolStatus ? ` · ${msg.toolStatus}` : ''}
                </div>
                <div className={`message-bubble ${isErr ? 'is-error' : ''}`}>
                  {msg.content ? (
                    <ChatMessageBody content={msg.content} streaming={streamingThis} />
                  ) : streamingThis ? (
                    <span className="chat-thinking">
                      <span className="chat-spinner" /> working…
                    </span>
                  ) : (
                    ''
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
                            title={
                              weak
                                ? `${c.path}\n⚠ klaim jawaban lemah terhadap isi catatan ini`
                                : c.path
                            }
                          >
                            [[{c.title}]]{weak ? ' ⚠' : ''}
                          </button>
                        )
                      })}
                      {msg.verifications?.some((x) => !x.supported) && (
                        <span className="chat-citations-weak-hint" title="Cek manual catatan sebelum mempercayai klaim">
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
                      {isErr && (
                        <button
                          type="button"
                          className="btn btn-surface btn-sm"
                          onClick={() => void handleRetry()}
                          title="Kirim ulang pertanyaan terakhir"
                        >
                          <Icon name="sync" size={12} /> Retry
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
                    </div>
                  )}
                </div>
              </div>
            )
          })
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Composer */}
      <div className="chat-input-area">
        <textarea
          ref={inputRef}
          className="chat-input"
          placeholder="perintah / tanya kernel… (Enter kirim · Shift+Enter baris baru)"
          value={inputText}
          onChange={(e) => setInputText(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={isGenerating}
          aria-label="Chat message"
          rows={2}
        />

        <div className="chat-input-footer">
          <div className="chat-toggles">
            <label
              className={`chat-toggle ${useContext ? 'on' : ''}`}
              title="Inject vault context + AI Memory"
            >
              <input
                type="checkbox"
                checked={useContext}
                onChange={(e) => setUseContext(e.target.checked)}
              />
              Context
            </label>
            <label
              className={`chat-toggle ${enableTools ? 'on' : ''}`}
              title="Tools: search / read / write proposals"
            >
              <input
                type="checkbox"
                checked={enableTools}
                onChange={(e) => setEnableTools(e.target.checked)}
              />
              Tools
            </label>
          </div>

          {isGenerating ? (
            <button
              type="button"
              className="btn btn-surface btn-sm"
              onClick={() => void cancelStream()}
            >
              Cancel
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={handleSend}
              disabled={!inputText.trim()}
            >
              Run
            </button>
          )}
        </div>
      </div>
    </aside>
  )
}
