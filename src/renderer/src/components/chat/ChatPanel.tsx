import React, { useEffect, useState, useRef, useCallback } from 'react'
import { useChatStore, WriteProposalItem } from '../../store/chatStore'
import { useEditorStore } from '../../store/editorStore'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { Icon } from '../ui/Icons'

type ChatListItem = { id: string; title?: string; updatedAt?: string }

export const ChatPanel: React.FC = () => {
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
    loadChat
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
  const activeTabPath = useEditorStore(
    (s) => s.tabs.find((x) => x.id === s.activeTabId)?.path
  )
  const activeTabTitle = useEditorStore(
    (s) => s.tabs.find((x) => x.id === s.activeTabId)?.title
  )
  const activeTab =
    activeTabId && activeTabPath
      ? { id: activeTabId, path: activeTabPath, title: activeTabTitle || '' }
      : null

  const [inputText, setInputText] = useState('')
  const [applyMsg, setApplyMsg] = useState('')
  const [applyOk, setApplyOk] = useState(true)
  const [history, setHistory] = useState<ChatListItem[]>([])
  const [showHistory, setShowHistory] = useState(false)
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
      setHistory(Array.isArray(list) ? list.slice(0, 20) : [])
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
      setApplyMsg(`Applied: ${p.relativePath}`)
      await fetchState()
      if (p.absolutePath) {
        await openTab(p.absolutePath)
        setActiveView('editor')
      }
    } else {
      setApplyOk(false)
      setApplyMsg(res.error || 'Apply failed')
    }
    setTimeout(() => setApplyMsg(''), 3000)
  }

  const handleClear = () => {
    if (messages.length === 0) return
    if (!window.confirm('Hapus percakapan ini?')) return
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

  return (
    <aside className="chat-panel" aria-label="AI chat panel">
      {/* ── Header: title + actions ── */}
      <div className="chat-toolbar">
        <div className="chat-toolbar-top">
          <div className="chat-toolbar-title">
            <Icon name="bot" size={15} />
            <span>AI Worker</span>
            {isGenerating && <span className="chat-live-dot" title="Generating" />}
          </div>
          <div className="chat-toolbar-icons">
            <button
              type="button"
              className="btn btn-ghost btn-sm btn-icon"
              onClick={handleNewChat}
              data-tooltip="New chat"
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
              data-tooltip="Save chat"
              aria-label="Save chat"
              disabled={messages.length === 0}
            >
              <Icon name="save" size={14} />
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm btn-icon"
              onClick={handleClear}
              data-tooltip="Clear chat"
              aria-label="Clear chat"
              disabled={messages.length === 0 || isGenerating}
            >
              <Icon name="trash" size={14} />
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm btn-icon"
              onClick={toggleAIChat}
              data-tooltip="Close panel (Ctrl+J)"
              aria-label="Close AI panel"
            >
              <Icon name="close" size={14} />
            </button>
          </div>
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

        {activeTab && (
          <div className="chat-context-chip" title={activeTab.path}>
            <Icon name="file" size={11} />
            <span className="truncate">{activeTab.title}</span>
          </div>
        )}
      </div>

      {/* History drawer */}
      {showHistory && (
        <div className="chat-history">
          <div className="chat-history-head">
            <span>Riwayat chat</span>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => void refreshHistory()}
            >
              Refresh
            </button>
          </div>
          {history.length === 0 ? (
            <div className="chat-history-empty">Belum ada chat tersimpan.</div>
          ) : (
            history.map((h) => (
              <button
                key={h.id}
                type="button"
                className="chat-history-item"
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
            ))
          )}
        </div>
      )}

      {/* Write proposals */}
      {openProposals.length > 0 && (
        <div className="chat-proposals">
          <div className="chat-proposals-title">
            <Icon name="warning" size={13} />
            Write proposals — konfirmasi dulu
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
                  Apply
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => void rejectProposal(p.id)}
                >
                  Reject
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {applyMsg && <div className={`chat-banner ${applyOk ? 'ok' : 'err'}`}>{applyMsg}</div>}

      {lastToolStatus && isGenerating && (
        <div className="chat-tool-status">
          <span className="chat-spinner" />
          {lastToolStatus}
        </div>
      )}

      {/* Messages */}
      <div className="chat-messages" ref={messagesBoxRef}>
        {messages.length === 0 ? (
          <div className="chat-empty">
            <Icon name="bot" size={36} />
            <p>
              Tanyakan apa saja tentang vault. Aktifkan <b>Tools</b> agar AI bisa search / usulkan
              tulis note.
            </p>
            <div className="chat-empty-hints">
              <button
                type="button"
                className="chat-hint"
                onClick={() => setInputText('Ringkas notes cuti')}
              >
                Ringkas cuti
              </button>
              <button
                type="button"
                className="chat-hint"
                onClick={() => setInputText('Cari note tentang KGB')}
              >
                Cari KGB
              </button>
              <button
                type="button"
                className="chat-hint"
                onClick={() => setInputText('Buat checklist kerja hari ini')}
              >
                Checklist harian
              </button>
            </div>
          </div>
        ) : (
          messages.map((msg) => {
            const isErr =
              msg.content?.includes('**Error:**') ||
              msg.content?.startsWith('Error:') ||
              msg.content?.includes('*(cancelled)*')
            return (
              <div key={msg.id} className={`chat-message ${msg.role}`}>
                <div className="message-role">
                  {msg.role === 'user' ? 'You' : 'AI'} · {msg.timestamp}
                </div>
                <div className={`message-bubble ${isErr ? 'is-error' : ''}`}>
                  {msg.content ||
                    (isGenerating && msg.role === 'assistant' ? (
                      <span className="chat-thinking">
                        <span className="chat-spinner" /> Thinking…
                      </span>
                    ) : (
                      ''
                    ))}

                  {msg.citations && msg.citations.length > 0 && (
                    <div className="chat-citations">
                      <span className="chat-citations-label">Citations</span>
                      {msg.citations.map((c) => (
                        <button
                          key={c.path}
                          type="button"
                          className="chat-citation-chip"
                          onClick={() => void openCitation(c.path)}
                          title={c.path}
                        >
                          [[{c.title}]]
                        </button>
                      ))}
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
          placeholder="Tanya AI… (Enter kirim · Shift+Enter baris baru)"
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
              title="Sertakan konteks vault"
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
              title="Izinkan search/read/write proposals"
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
              Send
            </button>
          )}
        </div>
      </div>
    </aside>
  )
}
