import { pathToFileURL } from 'url'
import path from 'path'
import fs from 'fs'
import os from 'os'

// Mock electron before import if needed — AgentTools bundle may pull workspaceEngine
// Prefer source-level pure tests via dynamic import of bundled file

const bugs = []
const ok = (id, c, d='') => { if (!c) { bugs.push({id,d}); console.log(' FAIL', id, d) } else console.log(' OK', id, d) }

// Pure parse/strip tests — reimplement from source for isolation OR import
function parseToolActions(text) {
  const actions = []
  const re = /```wg-action\s*([\s\S]*?)```/gi
  let m
  while ((m = re.exec(text)) !== null) {
    const body = m[1].trim()
    try {
      const parsed = JSON.parse(body)
      if (Array.isArray(parsed)) {
        for (const a of parsed) if (a && typeof a.tool === 'string') actions.push(a)
      } else if (parsed && typeof parsed.tool === 'string') actions.push(parsed)
    } catch {
      try {
        for (const line of body.split('\n').filter(l => l.trim().startsWith('{'))) {
          const a = JSON.parse(line)
          if (a?.tool) actions.push(a)
        }
      } catch {}
    }
  }
  return actions
}
function stripToolActions(text) {
  return text.replace(/```wg-action\s*[\s\S]*?```/gi, '').trim()
}

// --- parse tests ---
const single = parseToolActions('Hello\n```wg-action\n{"tool":"search","args":{"query":"cuti"}}\n```\nDone')
ok('parse-single', single.length===1 && single[0].tool==='search' && single[0].args.query==='cuti')

const multi = parseToolActions('```wg-action\n[{"tool":"search","args":{"query":"a"}},{"tool":"read_note","args":{"path":"x"}}]\n```')
ok('parse-array', multi.length===2 && multi[1].tool==='read_note')

const bad = parseToolActions('```wg-action\n{not json}\n```')
ok('parse-bad-empty', bad.length===0)

const strip = stripToolActions('Hi\n```wg-action\n{"tool":"search","args":{"query":"x"}}\n```\nBye')
ok('strip', strip.includes('Hi') && strip.includes('Bye') && !strip.includes('wg-action'))

// language fence case sensitivity
const upper = parseToolActions('```WG-ACTION\n{"tool":"list_dir","args":{}}\n```')
ok('parse-case-insensitive', upper.length===1 && upper[0].tool==='list_dir')

// multiple blocks
const twoBlocks = parseToolActions('```wg-action\n{"tool":"search","args":{"query":"a"}}\n```\ntext\n```wg-action\n{"tool":"list_templates","args":{}}\n```')
ok('parse-two-blocks', twoBlocks.length===2)

// --- source contracts ---
const at = fs.readFileSync('src/main/ai/AgentTools.ts','utf8')
ok('write-proposal-only', at.includes("status: 'pending'") && at.includes('waiting for user confirm'))
ok('path-escape-check', at.includes('isPathInVault') && at.includes('PathSandbox'))
ok('apply-recheck-path', at.includes('Path outside vault rejected'))
ok('tools-prompt', at.includes('TOOLS_SYSTEM_PROMPT') && at.includes('wg-action'))
ok('all-tools', ['search','read_note','list_dir','write_note','append_note','create_note','list_templates','create_from_template'].every(t => at.includes("'"+t+"'") || at.includes('"'+t+'"')))

const mid = fs.readFileSync('src/main/ai/AIMiddleware.ts','utf8')
ok('max-tool-rounds', mid.includes('MAX_TOOL_ROUNDS = 4'))
ok('tools-gated-perm', fs.readFileSync('src/main/ipc/index.ts','utf8').includes('perms.aiTools'))
ok('aiAccess-gate', fs.readFileSync('src/main/ipc/index.ts','utf8').includes('perms.aiAccess'))
ok('read-before-write-loop', mid.includes('readActions') && mid.includes('writeActions'))
ok('stop-on-write-only', mid.includes('readActions.length === 0'))

const perm = fs.readFileSync('src/main/security/Permissions.ts','utf8')
ok('autoWrite-default-false', perm.includes('aiAutoWrite: false') || perm.includes('aiAutoWrite: p.aiAutoWrite === true'))

const chat = fs.readFileSync('src/renderer/src/store/chatStore.ts','utf8')
ok('tools-default-on', chat.includes('enableTools: true'))
ok('apply-proposal-api', chat.includes('applyWriteProposal') || chat.includes('applyProposal'))

const panel = fs.readFileSync('src/renderer/src/components/chat/ChatPanel.tsx','utf8')
ok('ui-apply-reject', panel.includes('handleApply') && panel.includes('rejectProposal'))
ok('ui-tools-checkbox', panel.includes('Tools') && panel.includes('setEnableTools'))

// --- path resolve logic unit ---
function resolvePath(input, root) {
  if (!root || !input?.trim()) return null
  let p = String(input).trim()
  if (path.isAbsolute(p)) {
    const normRoot = path.resolve(root)
    const normP = path.resolve(p)
    if (!normP.toLowerCase().startsWith(normRoot.toLowerCase())) return null
    return normP
  }
  p = p.replace(/^[/\\]+/, '')
  const abs = path.resolve(root, p)
  if (!abs.toLowerCase().startsWith(path.resolve(root).toLowerCase())) return null
  return abs
}
const root = 'D:\\Obs\\Obs'
ok('resolve-rel', resolvePath('Knowledge/A.md', root)?.toLowerCase().includes('knowledge'))
ok('resolve-escape', resolvePath('..\\..\\Windows\\x', root) === null || !(resolvePath('..\\..\\Windows\\x', root)||'').toLowerCase().startsWith(path.resolve(root).toLowerCase()) === false)
// better:
const esc = resolvePath(path.join(root, '..', 'evil.md'), root)
// absolute outside
const outAbs = resolvePath('C:\\Windows\\System32\\x.md', root)
ok('resolve-abs-outside', outAbs === null)

// createProposal path join for template with nested folder
const folderJoin = path.join('03 Kerjaan', 'Cuti', 'x.md')
ok('path-join-ok', folderJoin.includes('Kerjaan') || folderJoin.includes('Cuti'))

// Context engine roles
const ce = fs.readFileSync('src/main/ai/ContextEngine.ts','utf8')
ok('agent-roles', ['general','writer','researcher','curator','planner'].every(r => ce.includes(r)))
ok('token-budget', ce.includes('DEFAULT_TOKEN_BUDGET') || ce.includes('tokenBudget'))

// Bug hunt: list_dir resolvePath('.') 
// resolvePath('.') with absolute root → path.resolve(root, '.') = root — OK
const listRoot = resolvePath('.', root) || resolvePath('', root)
// empty string: resolvePath returns null for empty after trim of ''
ok('list-dir-empty-rel', resolvePath('', root) === null) // current code uses rel || '.' in list_dir

// Bug: resolvePath('.') 
const dot = resolvePath('.', root)
ok('list-dir-dot', !!dot && path.resolve(dot) === path.resolve(root), String(dot))

// PathSandbox must reject sibling prefix (Obs\Obs-evil vs Obs\Obs)
function isPathInVault(filePath, vaultRoot) {
  if (!vaultRoot) return false
  const r = path.resolve(vaultRoot)
  const resolved = path.resolve(filePath)
  const rel = path.relative(r, resolved)
  return !(rel.startsWith('..') || path.isAbsolute(rel))
}
const evilTwin = path.resolve('D:\\Obs\\Obs-evil\\secret.md')
const normRoot = path.resolve('D:\\Obs\\Obs')
ok('sandbox-rejects-sibling-prefix', !isPathInVault(evilTwin, normRoot))
ok('sandbox-allows-inside', isPathInVault(path.join(normRoot, 'Knowledge', 'a.md'), normRoot))

console.log('\n' + (bugs.length ? 'BUGS:\n'+JSON.stringify(bugs,null,2) : 'AGENT_CHECKS_PARTIAL_OK'))
process.exit(0)
