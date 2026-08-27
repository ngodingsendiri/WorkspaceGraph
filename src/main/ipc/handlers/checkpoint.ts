import { ipcMain } from 'electron'
import {
  saveCheckpoint,
  loadCheckpoint,
  listCheckpoints,
  deleteCheckpoint,
  type StreamCheckpoint
} from '../../ai/CheckpointStore'
import { validateShape, type FieldSpec } from '../../api/ipcValidation'

const CP_SHAPE: Record<string, FieldSpec> = {
  id: { type: 'string' },
  conversationId: { type: 'string' },
  messageId: { type: 'string' },
  messageIndex: { type: 'number' },
  round: { type: 'number' },
  reason: { type: 'string', optional: true },
  timestamp: { type: 'string' },
  contextTokens: { type: 'number', optional: true },
  model: { type: 'string', optional: true },
  agentRole: { type: 'string', optional: true },
  useContext: { type: 'boolean', optional: true },
  enableTools: { type: 'boolean', optional: true }
}

export function registerCheckpointHandlers(): void {
  // --- R2-2: stream resume checkpoints (.workspacegraph/checkpoints) ---
  ipcMain.handle('checkpoint:save', async (_, cp: unknown) => {
    const checked = validateShape<StreamCheckpoint>(cp, CP_SHAPE)
    if (!checked.ok) return { ok: false, error: checked.error }
    return saveCheckpoint(checked.value)
  })

  ipcMain.handle('checkpoint:list', async () => {
    return listCheckpoints()
  })

  ipcMain.handle('checkpoint:load', async (_, id: string) => {
    return loadCheckpoint(id)
  })

  ipcMain.handle('checkpoint:delete', async (_, id: string) => {
    return deleteCheckpoint(id)
  })
}
