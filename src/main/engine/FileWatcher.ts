import chokidar, { FSWatcher } from 'chokidar'
import path from 'path'
import { EventEmitter } from 'events'

export type FileEvent = 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir'

export interface FileChangeEvent {
  type: FileEvent
  path: string
  relativePath: string
}

export class FileWatcher extends EventEmitter {
  private watcher: FSWatcher | null = null
  private rootPath: string | null = null

  start(rootPath: string): void {
    this.stop()
    this.rootPath = rootPath

    this.watcher = chokidar.watch(rootPath, {
      ignored: [
        /(^|[/\\])\..+/, // dotfiles
        /node_modules/,
        /\.workspacegraph\/index\.db/,
        /\.workspacegraph\/cache/,
        /\.workspacegraph\/logs/
      ],
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 300,
        pollInterval: 100
      }
    })

    const emitEvent = (type: FileEvent, filePath: string) => {
      const relativePath = this.rootPath
        ? path.relative(this.rootPath, filePath).replace(/\\/g, '/')
        : filePath
      const event: FileChangeEvent = { type, path: filePath, relativePath }
      this.emit('change', event)
      this.emit(type, event)
    }

    this.watcher
      .on('add', (p) => emitEvent('add', p))
      .on('change', (p) => emitEvent('change', p))
      .on('unlink', (p) => emitEvent('unlink', p))
      .on('addDir', (p) => emitEvent('addDir', p))
      .on('unlinkDir', (p) => emitEvent('unlinkDir', p))
      .on('error', (err) => {
        console.error('FileWatcher error:', err)
        this.emit('error', err)
      })

    console.log(`[FileWatcher] Watching: ${rootPath}`)
  }

  stop(): void {
    if (this.watcher) {
      this.watcher.close()
      this.watcher = null
    }
    this.rootPath = null
  }

  isWatching(): boolean {
    return this.watcher !== null
  }

  getRootPath(): string | null {
    return this.rootPath
  }
}

export const fileWatcher = new FileWatcher()
