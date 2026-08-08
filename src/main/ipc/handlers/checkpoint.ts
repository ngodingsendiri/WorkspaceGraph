import { ipcMain } from 'electron'
import {
  saveCheckpoint,
  loadCheckpoint,
  listCheckpoints,
  deleteCheckpoint,
  type StreamCheckpoint
} from '../../ai/CheckpointStore'

export function registerCheckpointHandlers(): void {
  // --- R2-2: stream resume checkpoints (.workspacegraph/checkpoints) ---
  ipcMain.handle('checkpoint:save', async (_, cp: StreamCheckpoint) => {
    return saveCheckpoint(cp)
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
