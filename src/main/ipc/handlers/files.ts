import { ipcMain, shell } from 'electron'
import fs from 'fs'
import { workspaceEngine, isTrashPath } from '../../engine/WorkspaceEngine'
import { markdownEngine } from '../../engine/MarkdownEngine'
import { assertPathInVault } from '../../security/PathSandbox'
import {
  requireOpenVault,
  syncSingleFile,
  markSelfWrite,
  debounceEmit,
  handleFileRemove,
  handleDirRemove
} from '../shared'

export function registerFileHandlers(): void {
  /** Open any vault file (attachments) with OS default app — sandboxed to vault. */
  ipcMain.handle('file:openExternal', async (_, filePath: string) => {
    const root = requireOpenVault()
    assertPathInVault(filePath, root)
    if (!fs.existsSync(filePath)) {
      return { ok: false, error: 'File not found' }
    }
    const err = await shell.openPath(filePath)
    if (err) return { ok: false, error: err }
    return { ok: true }
  })

  ipcMain.handle('file:read', async (_, filePath: string) => {
    const root = requireOpenVault()
    assertPathInVault(filePath, root)
    const { content: raw } = workspaceEngine.readFile(filePath)
    const state = workspaceEngine.getState()
    // light:true — no wiki/heading scan, no HTML. Opening notes must stay snappy.
    const parsed = markdownEngine.parseFile(filePath, raw, state.rootPath || '', {
      light: true
    })
    return { ...parsed, html: '' }
  })

  ipcMain.handle('markdown:render', async (_, content: string) => {
    try {
      if (typeof content !== 'string') return ''
      // Cap size so a pathological note cannot freeze the main process
      const capped = content.length > 500_000 ? content.slice(0, 500_000) : content
      // Strip frontmatter for preview body if present (LF-normalized inside engine)
      let body = capped
      if (body.startsWith('---')) {
        const end = body.indexOf('\n---', 3)
        if (end !== -1) body = body.slice(end + 4)
        else {
          // CRLF frontmatter close: \r\n---
          const endCr = body.indexOf('\r\n---', 3)
          if (endCr !== -1) body = body.slice(endCr + 5)
        }
      }
      return markdownEngine.renderToHtml(body)
    } catch (err) {
      console.error('markdown:render failed:', err)
      return '<p><em>Preview failed</em></p>'
    }
  })

  ipcMain.handle(
    'file:write',
    async (
      _,
      {
        filePath,
        content,
        expectedMtime
      }: { filePath: string; content: string; expectedMtime?: number }
    ) => {
      const root = requireOpenVault()
      assertPathInVault(filePath, root)
      if (typeof content !== 'string' || content.length > 5_000_000) {
        throw new Error('Invalid or oversized file content')
      }
      // Conflict detection: if file exists and expectedMtime provided, check it matches
      let existingMtime: number | undefined
      if (expectedMtime !== undefined) {
        try {
          const stats = fs.statSync(filePath)
          existingMtime = stats.mtimeMs
        } catch {
          existingMtime = undefined
        }
        if (existingMtime !== undefined && existingMtime !== expectedMtime) {
          // Conflict! Return both versions for merge UI
          const theirs = workspaceEngine.readFile(filePath).content
          return {
            conflict: true,
            existingMtime,
            theirs,
            yours: content
          }
        }
      }
      workspaceEngine.writeFile(filePath, content)
      const state = workspaceEngine.getState()
      if (state.rootPath) {
        markSelfWrite(filePath)
        syncSingleFile(filePath, state.rootPath)
        debounceEmit()
      }
      return { conflict: false }
    }
  )

  ipcMain.handle('file:delete', async (_, filePath: string) => {
    const root = requireOpenVault()
    assertPathInVault(filePath, root)
    const settings = workspaceEngine.getSettings()
    const trashEnabled = settings.trashEnabled !== false
    // WA-2: deleting a FOLDER must cascade to its children in graph/search.
    let wasDir = false
    try {
      wasDir = fs.statSync(filePath).isDirectory()
    } catch {
      /* already gone */
    }
    if (trashEnabled && !isTrashPath(filePath)) {
      const trashPath = workspaceEngine.moveToTrash(filePath)
      if (wasDir) handleDirRemove(filePath)
      else handleFileRemove(filePath)
      debounceEmit()
      return { ok: true, trashed: true, trashPath }
    }
    workspaceEngine.deleteFile(filePath)
    if (wasDir) handleDirRemove(filePath)
    else handleFileRemove(filePath)
    debounceEmit()
    return { ok: true, trashed: false }
  })

  ipcMain.handle('file:restore', async (_, filePath: string) => {
    const root = requireOpenVault()
    assertPathInVault(filePath, root)
    const restoredPath = workspaceEngine.restoreFromTrash(filePath)
    const state = workspaceEngine.getState()
    if (state.rootPath) {
      markSelfWrite(restoredPath)
      syncSingleFile(restoredPath, state.rootPath)
      debounceEmit()
    }
    return { ok: true, path: restoredPath }
  })

  ipcMain.handle('file:emptyTrash', async () => {
    requireOpenVault()
    const count = workspaceEngine.emptyTrash()
    debounceEmit()
    return { ok: true, count }
  })

  ipcMain.handle(
    'file:create',
    async (_, { filePath, content }: { filePath: string; content?: string }) => {
      const root = requireOpenVault()
      assertPathInVault(filePath, root)
      if (content !== undefined && (typeof content !== 'string' || content.length > 5_000_000)) {
        throw new Error('Invalid or oversized file content')
      }
      workspaceEngine.createFile(filePath, content || '')
      const state = workspaceEngine.getState()
      if (state.rootPath) {
        markSelfWrite(filePath)
        syncSingleFile(filePath, state.rootPath)
        debounceEmit()
      }
      return true
    }
  )

  ipcMain.handle('file:createFolder', async (_, folderPath: string) => {
    const root = requireOpenVault()
    assertPathInVault(folderPath, root)
    workspaceEngine.createFolder(folderPath)
    debounceEmit()
    return true
  })

  ipcMain.handle(
    'file:rename',
    async (_, { oldPath, newPath }: { oldPath: string; newPath: string }) => {
      const root = requireOpenVault()
      assertPathInVault(oldPath, root)
      assertPathInVault(newPath, root)
      // Auto-updates WikiLinks across vault; returns affected file list for toast notification
      const result = workspaceEngine.renameFile(oldPath, newPath)
      const state = workspaceEngine.getState()
      if (state.rootPath) {
        // AE-1: every file whose [[link]] was rewritten must be RE-SYNCED into
        // graph/search — markSelfWrite only suppresses the chokidar echo, it
        // does not update the index. Without this the nodes keep stale outLinks
        // (ghost [[OldTitle]]) until a full rebuild.
        for (const f of result.affectedFiles) {
          markSelfWrite(f)
          syncSingleFile(f, state.rootPath)
        }
        markSelfWrite(newPath)
        handleFileRemove(oldPath)
        syncSingleFile(newPath, state.rootPath)
        debounceEmit()
      }
      return { ok: true, renamedLinks: result.renamedLinks, affectedFiles: result.affectedFiles }
    }
  )
}
