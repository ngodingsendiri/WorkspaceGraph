/**
 * Source-level smoke for AI Memory + kernel chat.
 * Run: node scripts/qa-ai-memory.mjs
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(__dirname, '..')
let failed = 0
let passed = 0
function assert(cond, msg) {
  if (!cond) {
    console.error('FAIL:', msg)
    failed++
  } else {
    console.log('OK  ', msg)
    passed++
  }
}

const memSrc = fs.readFileSync(path.join(root, 'src/main/ai/WorkspaceMemory.ts'), 'utf8')
assert(memSrc.includes("AI_MEMORY_DIR = 'AI Memory'"), 'AI Memory dir constant')
assert(memSrc.includes('ensureAiMemoryScaffold'), 'scaffold export')
assert(memSrc.includes('KERNEL_SYSTEM_PROMPT'), 'kernel system prompt')
assert(memSrc.includes('00 Index.md'), 'index seed')

const tools = fs.readFileSync(path.join(root, 'src/main/ai/AgentTools.ts'), 'utf8')
assert(tools.includes('```(?:wg-action|json|javascript)?'), 'robust tool fence parse')
assert(tools.includes('AI Memory'), 'tools prompt mentions AI Memory')

const ctx = fs.readFileSync(path.join(root, 'src/main/ai/ContextEngine.ts'), 'utf8')
assert(ctx.includes('listAiMemoryPaths'), 'context injects memory paths')
assert(ctx.includes("'ai-memory'"), 'memory tier label')

const mid = fs.readFileSync(path.join(root, 'src/main/ai/AIMiddleware.ts'), 'utf8')
assert(mid.includes('KERNEL_SYSTEM_PROMPT'), 'middleware uses kernel prompt')
assert(mid.includes('unknown tools skipped'), 'unknown tool handling')

const ipc = fs.readFileSync(path.join(root, 'src/main/ipc/index.ts'), 'utf8')
assert(ipc.includes('ai:ensureMemory'), 'IPC ensureMemory')
assert(ipc.includes('ai:listMemory'), 'IPC listMemory')

const pre = fs.readFileSync(path.join(root, 'src/preload/index.ts'), 'utf8')
assert(pre.includes('ensureAiMemory'), 'preload ensureAiMemory')

const chat = fs.readFileSync(path.join(root, 'src/renderer/src/components/chat/ChatPanel.tsx'), 'utf8')
assert(chat.includes('Pelajari workspace'), 'UI bootstrap')
assert(chat.includes('chat-panel--kernel'), 'kernel panel class')
assert(chat.includes('learnWorkspace'), 'wired learnWorkspace')

const store = fs.readFileSync(path.join(root, 'src/renderer/src/store/chatStore.ts'), 'utf8')
assert(store.includes('learnWorkspace:'), 'store learnWorkspace')

const css = fs.readFileSync(path.join(root, 'src/renderer/src/styles/globals.css'), 'utf8')
assert(css.includes('chat-kernel-status'), 'kernel CSS')

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
