import { create } from 'zustand'

export interface FileItem {
  id: string
  name: string
  path: string
  relativePath: string
  type: string
  extension: string
  size: number
  createdAt: string
  updatedAt: string
  isDirectory: boolean
  children?: FileItem[]
}

export interface WorkspaceStore {
  isOpen: boolean
  rootPath: string | null
  files: FileItem[]
  totalFiles: number
  totalFolders: number
  totalNotes: number
  recentWorkspaces: string[]
  activeView: 'dashboard' | 'editor' | 'graph' | 'settings' | 'welcome'
  showSidebar: boolean
  showAIChat: boolean

  openWorkspace: (folderPath: string) => Promise<boolean>
  closeWorkspace: () => Promise<void>
  fetchState: () => Promise<void>
  setActiveView: (view: 'dashboard' | 'editor' | 'graph' | 'settings' | 'welcome') => void
  toggleSidebar: () => void
  toggleAIChat: () => void
  fetchRecentWorkspaces: () => Promise<void>
  lastError: string | null
  clearError: () => void
}

export const useWorkspaceStore = create<WorkspaceStore>((set) => ({
  isOpen: false,
  rootPath: null,
  files: [],
  totalFiles: 0,
  totalFolders: 0,
  totalNotes: 0,
  recentWorkspaces: [],
  activeView: 'welcome',
  showSidebar: true,
  showAIChat: true,
  lastError: null,

  clearError: () => set({ lastError: null }),

  openWorkspace: async (folderPath: string) => {
    try {
      const state = await window.api.openWorkspace(folderPath)
      set({
        isOpen: true,
        rootPath: state.rootPath,
        files: state.files,
        totalFiles: state.totalFiles,
        totalFolders: state.totalFolders,
        totalNotes: state.totalNotes ?? 0,
        activeView: 'dashboard',
        lastError: null
      })
      // Keep recent list in sync with main process
      try {
        const recents = await window.api.getRecentWorkspaces()
        set({ recentWorkspaces: recents })
      } catch {
        /* ignore */
      }
      return true
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('Failed to open workspace:', err)
      set({ lastError: msg || 'Gagal membuka vault' })
      return false
    }
  },

  closeWorkspace: async () => {
    await window.api.closeWorkspace()
    set({
      isOpen: false,
      rootPath: null,
      files: [],
      totalFiles: 0,
      totalFolders: 0,
      totalNotes: 0,
      activeView: 'welcome'
    })
  },

  fetchState: async () => {
    try {
      if (!window.api?.getWorkspaceState) {
        console.warn('[workspace] window.api not ready')
        return
      }
      const state = await window.api.getWorkspaceState()
      if (state?.isOpen) {
        set({
          isOpen: true,
          rootPath: state.rootPath,
          files: state.files || [],
          totalFiles: state.totalFiles ?? 0,
          totalFolders: state.totalFolders ?? 0,
          totalNotes: state.totalNotes ?? 0
        })
      }
    } catch (err) {
      console.error('[workspace] fetchState failed:', err)
      set({ lastError: err instanceof Error ? err.message : String(err) })
    }
  },

  setActiveView: (view) => set({ activeView: view }),
  toggleSidebar: () => set((state) => ({ showSidebar: !state.showSidebar })),
  toggleAIChat: () => set((state) => ({ showAIChat: !state.showAIChat })),

  fetchRecentWorkspaces: async () => {
    try {
      if (!window.api?.getRecentWorkspaces) return
      const recents = await window.api.getRecentWorkspaces()
      set({ recentWorkspaces: recents || [] })
    } catch (err) {
      console.error('[workspace] fetchRecent failed:', err)
    }
  }
}))
