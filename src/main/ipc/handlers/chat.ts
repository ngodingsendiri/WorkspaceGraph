import { ipcMain } from 'electron'
import {
  saveConversation,
  listConversations,
  loadConversation,
  deleteConversation,
  newConversationId,
  renameConversation,
  archiveConversation,
  exportConversation,
  searchConversations,
  type StoredConversation
} from '../../ai/ConversationStore'
import { validateShape, type FieldSpec } from '../../api/ipcValidation'

const CHAT_SHAPE: Record<string, FieldSpec> = {
  id: { type: 'string', optional: true },
  title: { type: 'string', optional: true },
  createdAt: { type: 'string', optional: true },
  updatedAt: { type: 'string', optional: true },
  agentRole: { type: 'string', optional: true },
  messages: { type: 'array', optional: true },
  relatedKnowledge: { type: 'array', optional: true },
  relatedProjects: { type: 'array', optional: true },
  relatedTasks: { type: 'array', optional: true },
  relatedDocuments: { type: 'array', optional: true },
  summary: { type: 'string', optional: true },
  status: { type: 'string', optional: true }
}

export function registerChatHandlers(): void {
  // --- Chat persistence (cache under .workspacegraph/chats) ---
  ipcMain.handle('chat:save', async (_, conv: unknown) => {
    const checked = validateShape<StoredConversation>(conv, CHAT_SHAPE)
    if (!checked.ok) return { ok: false, error: checked.error }
    if (!checked.value.id) checked.value.id = newConversationId()
    checked.value.updatedAt = new Date().toISOString()
    if (!checked.value.createdAt) checked.value.createdAt = checked.value.updatedAt
    return saveConversation(checked.value)
  })

  ipcMain.handle('chat:list', async () => {
    return listConversations(40)
  })

  ipcMain.handle('chat:load', async (_, id: string) => {
    return loadConversation(id)
  })

  ipcMain.handle('chat:delete', async (_, id: string) => {
    return deleteConversation(id)
  })

  ipcMain.handle('chat:newId', async () => {
    return newConversationId()
  })

  // M3.4 (AI-20/21/22)
  ipcMain.handle('chat:rename', async (_, id: string, title: string) => {
    return renameConversation(id, title)
  })

  ipcMain.handle('chat:archive', async (_, id: string) => {
    return archiveConversation(id)
  })

  ipcMain.handle('chat:export', async (_, id: string, format?: string) => {
    return exportConversation(id, format === 'json' ? 'json' : 'markdown')
  })

  ipcMain.handle('chat:search', async (_, query: string, limit?: number) => {
    return searchConversations(query, limit)
  })
}
