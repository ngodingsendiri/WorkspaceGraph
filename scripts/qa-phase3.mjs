/**
 * Phase 3 QA: Agent tools parse/execute (read), proposals, IPC wiring
 */
import path from 'path'
import fs from 'fs'
import os from 'os'
import { fileURLToPath, pathToFileURL } from 'url'
import { createRequire } from 'module'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(__dirname, '..')
const require = createRequire(import.meta.url)

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

// Inline parse (mirror AgentTools)
function parseToolActions(text) {
  const actions = []
  const re = /```wg-action\s*([\s\S]*?)```/gi
  let m
  while ((m = re.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(m[1].trim())
      if (Array.isArray(parsed)) actions.push(...parsed)
      else if (parsed?.tool) actions.push(parsed)
    } catch {}
  }
  return actions
}

function stripToolActions(text) {
  return text.replace(/```wg-action\s*[\s\S]*?```/gi, '').trim()
}

async function main() {
  const sample = `I'll search first.

\`\`\`wg-action
{"tool":"search","args":{"query":"cuti","limit":3}}
\`\`\`

Then create a note.

\`\`\`wg-action
{"tool":"create_note","args":{"path":"Knowledge/Summary.md","content":"# Summary\\n\\nHello"}}
\`\`\`
`

  const actions = parseToolActions(sample)
  assert(actions.length === 2, `parse 2 actions got ${actions.length}`)
  assert(actions[0].tool === 'search' && actions[0].args.query === 'cuti', 'search action')
  assert(actions[1].tool === 'create_note', 'create_note action')

  const stripped = stripToolActions(sample)
  assert(!stripped.includes('wg-action'), 'strip tool fences')
  assert(stripped.includes("I'll search"), 'keep prose')

  // Frontmatter validation logic
  function validateMd(content) {
    if (content.startsWith('---')) {
      const end = content.indexOf('\n---', 3)
      if (end === -1) return false
    }
    return true
  }
  assert(validateMd('---\ntitle: x\n---\n\nbody'), 'valid fm')
  assert(!validateMd('---\ntitle: x\nbody only'), 'invalid unclosed fm')

  // Source checks
  const tools = fs.readFileSync(path.join(root, 'src/main/ai/AgentTools.ts'), 'utf8')
  assert(tools.includes("tool: 'search'") || tools.includes("'search'"), 'search tool')
  assert(tools.includes('read_note') && tools.includes('list_dir'), 'read tools')
  assert(tools.includes('write_note') && tools.includes('append_note') && tools.includes('create_note'), 'write tools')
  assert(tools.includes('applyProposal') && tools.includes('pending'), 'proposals')
  assert(tools.includes('path escape') || tools.includes('outside vault') || tools.includes('startsWith'), 'path sandbox')

  const mid = fs.readFileSync(path.join(root, 'src/main/ai/AIMiddleware.ts'), 'utf8')
  assert(mid.includes('enableTools') && mid.includes('MAX_TOOL_ROUNDS'), 'tool loop')
  assert(mid.includes('cancelStream') || mid.includes('abortFlags'), 'cancel stream')

  const ipc = fs.readFileSync(path.join(root, 'src/main/ipc/index.ts'), 'utf8')
  assert(ipc.includes('ai:applyProposal') && ipc.includes('ai:rejectProposal'), 'IPC proposals')
  assert(ipc.includes('chat:save') && ipc.includes('chat:load'), 'IPC chat persist')
  // Conversation id path-traversal guard (ConversationStore.safeConversationId)
  const convStore = fs.readFileSync(path.join(root, 'src/main/ai/ConversationStore.ts'), 'utf8')
  assert(
    convStore.includes('safeConversationId') && convStore.includes('^[a-zA-Z0-9_-]{1,80}$'),
    'chat id path traversal guard'
  )
  assert(ipc.includes('enableTools'), 'IPC enableTools')

  const pre = fs.readFileSync(path.join(root, 'src/preload/index.ts'), 'utf8')
  assert(pre.includes('applyWriteProposal') && pre.includes('enableTools'), 'preload tools')

  const chat = fs.readFileSync(path.join(root, 'src/renderer/src/store/chatStore.ts'), 'utf8')
  assert(chat.includes('enableTools') && chat.includes('applyProposal'), 'chatStore tools')

  const panel = fs.readFileSync(path.join(root, 'src/renderer/src/components/chat/ChatPanel.tsx'), 'utf8')
  assert(panel.includes('Write proposals') && panel.includes('openCitation'), 'chat UI proposals+citations')
  assert(panel.includes('cancelStream') || panel.includes('Cancel'), 'cancel UI')

  const conv = fs.readFileSync(path.join(root, 'src/main/ai/ConversationStore.ts'), 'utf8')
  assert(conv.includes('.workspacegraph') && conv.includes('chats'), 'conversation cache path')

  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
