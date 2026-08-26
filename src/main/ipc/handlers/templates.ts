import { ipcMain } from 'electron'
import fs from 'fs'
import path from 'path'
import { workspaceEngine } from '../../engine/WorkspaceEngine'
import { templateEngine } from '../../engine/TemplateEngine'
import { assertPathInVault } from '../../security/PathSandbox'
import { syncSingleFile, debounceEmit } from '../shared'

export function registerTemplateHandlers(): void {
  ipcMain.handle('template:list', async () => {
    const root = workspaceEngine.getState().rootPath
    return templateEngine.listTemplates(root).map((t) => ({
      id: t.id,
      name: t.name,
      kind: t.kind,
      description: t.description,
      defaultFolder: t.defaultFolder,
      sourcePath: t.sourcePath,
      builtin: t.builtin
    }))
  })

  ipcMain.handle(
    'template:render',
    async (_, { templateId, vars }: { templateId: string; vars?: Record<string, string> }) => {
      const root = workspaceEngine.getState().rootPath
      const content = templateEngine.renderById(templateId, root, vars || {})
      const tpl = templateEngine.getTemplate(templateId, root)
      return {
        content,
        template: tpl
          ? { id: tpl.id, kind: tpl.kind, defaultFolder: tpl.defaultFolder, name: tpl.name }
          : null
      }
    }
  )

  ipcMain.handle(
    'template:createNote',
    async (
      _,
      {
        templateId,
        title,
        folder,
        extraVars
      }: { templateId: string; title: string; folder?: string; extraVars?: Record<string, string> }
    ) => {
      const state = workspaceEngine.getState()
      if (!state.rootPath) return { ok: false, error: 'No workspace open' }
      const tpl = templateEngine.getTemplate(templateId, state.rootPath)
      if (!tpl) return { ok: false, error: 'Template not found' }

      const safeTitle = (title || 'Untitled').replace(/[<>:"/\\|?*]/g, '-').trim() || 'Untitled'
      // F-4: preview (template:render) and create MUST share the exact same
      // render path — renderById — so a note created from a template always
      // carries the same frontmatter (type/status/created/…) as the preview.
      const content = templateEngine.renderById(templateId, state.rootPath, {
        title: safeTitle,
        filename: safeTitle,
        workspace: path.basename(state.rootPath),
        ...(extraVars || {})
      })
      if (content == null) return { ok: false, error: 'Template not found' }

      const destFolder = folder || tpl.defaultFolder
      const root = assertPathInVault(state.rootPath, state.rootPath)
      let fileName = `${safeTitle}.md`
      if (tpl.kind === 'daily') {
        const d = extraVars?.date || new Date().toISOString().split('T')[0]
        fileName = `${d}.md`
      }
      const filePath = assertPathInVault(path.join(root, destFolder, fileName), root)
      if (fs.existsSync(filePath)) {
        return { ok: false, error: `File exists: ${destFolder}/${fileName}`, path: filePath }
      }
      workspaceEngine.createFile(filePath, content)
      syncSingleFile(filePath, state.rootPath)
      debounceEmit()
      // M6a PLT-1: fire domain triggers for template-kind creations
      try {
        const { automationEngine } = await import('../../engine/AutomationEngine')
        const { readPermissions } = await import('../../security/Permissions')
        const perms = readPermissions(workspaceEngine.getSettings() as never)
        if (perms.automation && automationEngine.isEnabled()) {
          if (tpl.kind === 'project') automationEngine.handleEvent('project_created', filePath)
          if (tpl.kind === 'daily') automationEngine.handleEvent('daily_note_created', filePath)
          if (tpl.kind === 'task') automationEngine.handleEvent('task_completed', filePath)
        }
      } catch {
        /* automation is best-effort */
      }
      return {
        ok: true,
        path: filePath,
        relativePath: `${destFolder}/${fileName}`.replace(/\\/g, '/')
      }
    }
  )

  ipcMain.handle('template:seed', async () => {
    const root = workspaceEngine.getState().rootPath
    if (!root) return { ok: false, error: 'No workspace open', count: 0 }
    const n = templateEngine.seedBuiltinToVault(root)
    debounceEmit()
    return { ok: true, count: n }
  })
}
