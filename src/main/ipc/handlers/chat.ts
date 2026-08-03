import { ipcMain } from 'electron'
import {
  saveConversation,
  listConversations,
  loadConversation,
  newConversationId,
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

  ipcMain.handle('chat:newId', async () => {
    return newConversationId()
  })
}
