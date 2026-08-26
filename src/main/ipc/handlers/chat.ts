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

export function registerChatHandlers(): void {
  // --- Chat persistence (cache under .workspacegraph/chats) ---
  ipcMain.handle('chat:save', async (_, conv: StoredConversation) => {
    if (!conv.id) conv.id = newConversationId()
    conv.updatedAt = new Date().toISOString()
    if (!conv.createdAt) conv.createdAt = conv.updatedAt
    return saveConversation(conv)
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
