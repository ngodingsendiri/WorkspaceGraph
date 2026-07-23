/**
 * Adversarial / edge-case QA for engines + path sandbox.
 * Run: node scripts/qa-adversarial.mjs
 */
import fs from 'fs'
import path from 'path'
import os from 'os'
import { fileURLToPath, pathToFileURL } from 'url'
import { execSync } from 'child_process'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(__dirname, '..')
const engDir = path.join(__dirname, '.tmp-audit')

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

async function ensureBundle() {
  if (
    fs.existsSync(path.join(engDir, 'engine', 'MarkdownEngine.js')) &&
    fs.existsSync(path.join(engDir, 'engine', 'GraphEngine.js')) &&
    fs.existsSync(path.join(engDir, 'security', 'PathSandbox.js'))
  ) {
    return
  }
  execSync(
    'npx esbuild src/main/engine/MarkdownEngine.ts src/main/engine/GraphEngine.ts src/main/security/PathSandbox.ts --bundle --platform=node --outdir=scripts/.tmp-audit --format=esm --packages=external',
    { cwd: root, stdio: 'inherit' }
  )
}

async function main() {
  await ensureBundle()
  const { MarkdownEngine } = await import(
    pathToFileURL(path.join(engDir, 'engine', 'MarkdownEngine.js')).href
  )
  const { GraphEngine } = await import(
    pathToFileURL(path.join(engDir, 'engine', 'GraphEngine.js')).href
  )
  const { assertPathInVault, isPathInVault } = await import(
    pathToFileURL(path.join(engDir, 'security', 'PathSandbox.js')).href
  )

  const md = new MarkdownEngine()
  const g = new GraphEngine()
  const vault = path.join(os.tmpdir(), `wg-adv-${Date.now()}`)
  fs.mkdirSync(path.join(vault, 'Knowledge'), { recursive: true })

  const write = (rel, body) => {
    const p = path.join(vault, rel)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, body, 'utf8')
    return md.parseFile(p, body, vault)
  }

  // --- Path sandbox ---
  const inside = path.join(vault, 'Knowledge', 'a.md')
  fs.writeFileSync(inside, 'x')
  assert(isPathInVault(inside, vault), 'sandbox: inside vault')
  assert(!isPathInVault(path.join(vault, '..', 'evil.md'), vault), 'sandbox: parent escape')
  assert(
    !isPathInVault(path.join(vault, 'Knowledge', '..', '..', 'Windows', 'System32'), vault),
    'sandbox: traversal'
  )
  try {
    assertPathInVault('', vault)
    assert(false, 'sandbox: empty path throws')
  } catch {
    assert(true, 'sandbox: empty path throws')
  }
  const sibling = vault + '-evil'
  fs.mkdirSync(sibling, { recursive: true })
  fs.writeFileSync(path.join(sibling, 'x.md'), 'x')
  assert(!isPathInVault(path.join(sibling, 'x.md'), vault), 'sandbox: sibling prefix')

  // --- Markdown XSS ---
  const xss = md.renderToHtml(
    '# Hi\n<script>alert(1)</script>\n<img src=x onerror=alert(1)>\n[x](javascript:alert(1))\n[ok](https://example.com)'
  )
  assert(!xss.includes('<script>'), 'xss: no raw script tag')
  // Escaped text may contain the words onerror/javascript — only real HTML attrs are dangerous
  assert(!/<img\b[^>]*\bonerror\b/i.test(xss), 'xss: no live img onerror attr')
  assert(!/\shref=["']javascript:/i.test(xss), 'xss: no href=javascript:')
  assert(xss.includes('https://example.com'), 'xss: safe https link kept')

  // --- Wikilinks in code must NOT create edges (Obsidian) ---
  const codeNote = write(
    'Knowledge/CodeLinks.md',
    `---
title: CodeLinks
---
# CodeLinks

Inline \`[[ShouldNotLink]]\` and fence:

\`\`\`md
[[AlsoNotLink]]
\`\`\`

Real link: [[Alpha]]
`
  )
  assert(
    codeNote.wikiLinks.length === 1 && codeNote.wikiLinks[0].target === 'Alpha',
    `code wiki strip: expected 1 real link got ${codeNote.wikiLinks.length} [${codeNote.wikiLinks.map((w) => w.target).join(',')}]`
  )

  // --- Graph paths / aliases / local ---
  const Alpha = write(
    'Knowledge/Alpha.md',
    `---
title: Alpha
---
# Alpha
[[Beta]]
`
  )
  const Beta = write(
    'Knowledge/Beta.md',
    `---
title: Beta
aliases:
  - Bee
  - Beta Note
---
# Beta
[[Gamma]]
`
  )
  const Gamma = write(
    'Knowledge/Gamma.md',
    `---
title: Gamma
---
# Gamma
`
  )
  const Lonely = write(
    'Knowledge/Lonely.md',
    `---
title: Lonely
---
# Lonely
`
  )

  g.buildFromParsedFiles([Alpha, Beta, Gamma, Lonely, codeNote])

  const pathAC = g.findShortestPath(Alpha.id, Gamma.id)
  assert(pathAC?.found === true && pathAC.length === 2, 'path A→C length 2')

  const pathByPath = g.findShortestPath(Alpha.filePath, Gamma.filePath)
  assert(pathByPath?.found === true, `path by absolute file path (got ${pathByPath && pathByPath.found})`)

  const pathOrphan = g.findShortestPath(Alpha.id, Lonely.id)
  assert(pathOrphan?.found === false, 'no path to orphan')

  const selfPath = g.findShortestPath(Alpha.id, Alpha.id)
  assert(selfPath?.found === true && selfPath.length === 0, 'self path length 0')

  assert(g.findShortestPath('missing-id', Gamma.id) === null, 'missing endpoint → null')

  const bee = g.resolveTitleToPath('Bee')
  assert(!!bee && bee.replace(/\\/g, '/').endsWith('Knowledge/Beta.md'), `alias Bee → Beta (${bee})`)

  const local1 = g.getLocalGraph(Alpha.id, 1)
  assert(local1 && local1.centerId === Alpha.id && local1.nodes.length >= 2, 'local graph depth 1')

  const localByPath = g.getLocalGraph(Alpha.filePath, 2)
  assert(localByPath && localByPath.nodes.length >= 3, 'local graph depth 2 by path')

  const neigh = g.getNeighbors(Alpha.id, 1)
  assert(neigh.nodes.every((n) => n.id !== Alpha.id), 'neighbors exclude self')

  // Backlink preserve on update
  const beta2 = write(
    'Knowledge/Beta.md',
    `---
title: Beta
aliases:
  - Bee
---
# Beta
[[Gamma]]

edited body
`
  )
  g.updateNodeAndEdges(beta2)
  assert(
    g.getBacklinks(Beta.id).nodes.some((n) => n.id === Alpha.id),
    'updateNode preserves Alpha→Beta backlink'
  )
  assert(g.resolveTitleToPath('Bee'), 'alias still resolves after update')

  // CRLF
  const crlfPath = path.join(vault, 'Knowledge', 'CRLF.md')
  const crlfBody = '---\r\ntitle: CRLFNote\r\n---\r\n# CRLFNote\r\n[[Alpha]]\r\n'
  fs.writeFileSync(crlfPath, crlfBody)
  const crlf = md.parseFile(crlfPath, crlfBody, vault)
  assert(crlf.title === 'CRLFNote' && crlf.wikiLinks[0]?.target === 'Alpha', 'CRLF parse')

  // Cleanup
  try {
    fs.rmSync(vault, { recursive: true, force: true })
    fs.rmSync(sibling, { recursive: true, force: true })
  } catch {
    /* ignore */
  }

  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
