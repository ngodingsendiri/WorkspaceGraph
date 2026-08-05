/**
 * JS plugin worker — runs untrusted plugin code on a dedicated thread.
 * Bundled by electron-vite (see electron.vite.config.ts) to
 * out/main/workers/js-plugin.worker.js.
 */
import { parentPort, workerData } from 'worker_threads'
import { createPluginRuntime } from './runtime'

const { entry, handler, args, plugin } = workerData as {
  entry: string
  handler: string
  args: Record<string, unknown>
  plugin?: { id: string; name: string; version?: string; dir: string }
}

const port = parentPort
if (port) {
  createPluginRuntime({
    entry,
    handler,
    args,
    plugin,
    transport: {
      post: (msg) => port.postMessage(msg),
      onMessage: (cb) => port.on('message', cb)
    }
  })
}
