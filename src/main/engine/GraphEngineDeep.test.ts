import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import { tmpdir } from 'os'
import crypto from 'crypto'
import { GraphEngine } from './GraphEngine'
import { MarkdownEngine, type ParsedMarkdown } from './MarkdownEngine'

/**
 * Deep / adversarial GraphEngine behaviors ported from the QA chain
 * (qa-graph-deep, qa-graph-audit-wide, qa-adversarial, qa-runtime).
 */

describe('GraphEngine deep behaviors', () => {
  let graph: GraphEngine
  let md: MarkdownEngine
  let tmp: string

  beforeEach(() => {
    graph = new GraphEngine()
    md = new MarkdownEngine()
    tmp = fs.mkdtempSync(path.join(tmpdir(), 'wg-graph-deep-'))
  })

  afterEach(() => {
    try {
      fs.rmSync(tmp, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  })

  const write = (rel: string, body: string): ParsedMarkdown => {
    const p = path.join(tmp, rel)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, body, 'utf8')
    return md.parseFile(p, body, tmp)
  }

  const idOf = (filePath: string): string =>
    crypto
      .createHash('sha256')
      .update(filePath.replace(/\\/g, '/').toLowerCase())
      .digest('hex')
      .slice(0, 24)

  it('preserves backlinks after editing a note (no wipe)', () => {
    const a = write('Knowledge/A.md', '# Alpha\n[[Beta]] [[Gamma]]\n')
    const b = write('Knowledge/B.md', '# Beta\n[[Alpha]]\n')
    const c = write('Knowledge/C.md', '# Gamma\nSee [[Alpha]]\n')
    const data = graph.buildFromParsedFiles([a, b, c])
    const aNode = graph.getNodeByPath(path.join(tmp, 'Knowledge', 'A.md'))
    const bNode = graph.getNodeByPath(path.join(tmp, 'Knowledge', 'B.md'))
    expect(data.realNodeCount).toBe(3)
    expect(aNode && bNode).toBeTruthy()

    // Edit B — backlink A→B must remain
    const b2 = write('Knowledge/B.md', '# Beta\n[[Alpha]]\nedited body\n')
    graph.updateNodeAndEdges(b2)
    expect(graph.getBacklinks(bNode!.id).nodes.some((n) => n.id === aNode!.id)).toBe(true)
  })

  it('re-resolves outLinks when a previously-missing note is created', () => {
    const a = write('Knowledge/A.md', '# Alpha\n[[Beta]] [[Gamma]] [[Delta]]\n')
    graph.buildFromParsedFiles([a])
    expect(graph.resolveTitleToPath('Delta')).toBeNull()

    const d = write('Knowledge/D.md', '# Delta\nLinked from A\n')
    graph.updateNodeAndEdges(d)
    const dNode = graph.getNodeByPath(d.filePath)
    const aNode = graph.getNodeByPath(path.join(tmp, 'Knowledge', 'A.md'))
    expect(dNode).toBeTruthy()
    // A was NOT re-parsed after Delta create — outLinks cache must re-resolve
    expect(graph.getBacklinks(dNode!.id).nodes.some((n) => n.id === aNode!.id)).toBe(true)
  })

  it('removeNode drops node and leaves no ghost edges', () => {
    const a = write('Knowledge/A.md', '# Alpha\n[[Beta]]\n')
    const b = write('Knowledge/B.md', '# Beta\n[[Alpha]]\n')
    graph.buildFromParsedFiles([a, b])
    const bNode = graph.getNodeByPath(b.filePath)!
    graph.removeNode(bNode.id)
    const after = graph.getGraphData()
    expect(after.nodes.some((n) => n.id === bNode.id)).toBe(false)
    expect(
      after.edges.every(
        (e) =>
          after.nodes.some((n) => n.id === e.source) && after.nodes.some((n) => n.id === e.target)
      )
    ).toBe(true)
  })

  it('WB-3: removeNode re-resolves remaining [[links]] into ghosts incrementally', () => {
    const a = write('Knowledge/A.md', '# Alpha\n[[Beta]]\n')
    const b = write('Knowledge/B.md', '# Beta\n')
    graph.buildFromParsedFiles([a, b])
    graph.removeNode(graph.getNodeByPath(b.filePath)!.id)
    const data = graph.getGraphData()
    // A was NOT re-parsed — its cached outLink must now resolve to a ghost.
    expect(data.nodes.some((n) => n.isGhost && n.id === 'ghost:beta')).toBe(true)
    expect(data.edges.some((e) => e.type === 'wiki_link' && e.target === 'ghost:beta')).toBe(true)
  })

  it('WB-3: rename flow (remove old + add new) re-resolves other notes incrementally', () => {
    const a = write('Knowledge/A.md', '# Alpha\n[[Beta]] [[Gamma]]\n')
    const b = write('Knowledge/B.md', '# Beta\n')
    const g = write('Knowledge/G.md', '# Gamma\n')
    graph.buildFromParsedFiles([a, b, g])
    graph.removeNode(graph.getNodeByPath(b.filePath)!.id)
    const b2 = write('Knowledge/Beta2.md', '# Beta2\n[[Gamma]]\n')
    graph.updateNodeAndEdges(b2)
    const data = graph.getGraphData()
    // A's cached [[Beta]] no longer resolves → ghost (its content was untouched).
    expect(data.nodes.some((n) => n.isGhost && n.id === 'ghost:beta')).toBe(true)
    expect(data.edges.some((e) => e.type === 'wiki_link' && e.target === 'ghost:beta')).toBe(true)
    // Gamma still receives backlinks from A AND the renamed note.
    expect(graph.getBacklinks(graph.getNodeByPath(g.filePath)!.id).nodes).toHaveLength(2)
  })

  it('local graph depth clamps to 1–5 and grows with depth', () => {
    const chain = []
    for (const [name, links] of [
      ['A', '[[B]]'],
      ['B', '[[C]] [[A]]'],
      ['C', '[[D]]'],
      ['D', '[[E]]'],
      ['E', '[[F]]'],
      ['F', '']
    ] as [string, string][]) {
      chain.push(write(`Knowledge/${name}.md`, `# ${name}\n${links}\n`))
    }
    graph.buildFromParsedFiles(chain)
    const center = graph.getNodeByPath(path.join(tmp, 'Knowledge', 'A.md'))!
    const d1 = graph.getLocalGraph(center.id, 1)!
    const d2 = graph.getLocalGraph(center.id, 2)!
    const d3 = graph.getLocalGraph(center.id, 3)!
    const d9 = graph.getLocalGraph(center.id, 9)!
    expect(d1.depth).toBe(1)
    expect(d1.nodeCount).toBeGreaterThanOrEqual(2)
    expect(d2.nodeCount).toBeGreaterThanOrEqual(d1.nodeCount)
    expect(d3.nodeCount).toBeGreaterThanOrEqual(d2.nodeCount)
    expect(d9.depth).toBe(5)
    expect(d9.nodeCount).toBeGreaterThanOrEqual(d3.nodeCount)
  })

  it('getNeighbors excludes self and default excludes ghosts', () => {
    write('Knowledge/A.md', '# A\n[[Missing]]\n')
    write('Knowledge/B.md', '# B\n[[A]]\n')
    const files = [path.join(tmp, 'Knowledge', 'A.md'), path.join(tmp, 'Knowledge', 'B.md')].map(
      (p) => md.parseFile(p, fs.readFileSync(p, 'utf8'), tmp)
    )
    graph.buildFromParsedFiles(files)
    const a = graph.getNodeByPath(path.join(tmp, 'Knowledge', 'A.md'))!
    const neigh = graph.getNeighbors(a.id, 1)
    expect(neigh.nodes.every((n) => n.id !== a.id)).toBe(true)
    expect(neigh.nodes.some((n) => n.isGhost)).toBe(false)
  })

  it('ghost promotion: creating the missing file turns ghost into real node', () => {
    write('Knowledge/Real.md', '# Real\n[[MissingNote]] [[AlsoMissing]]\n')
    write('Knowledge/Linked.md', '# Linked\n[[Real]]\n')
    const files = ['Real.md', 'Linked.md'].map((n) => {
      const p = path.join(tmp, 'Knowledge', n)
      return md.parseFile(p, fs.readFileSync(p, 'utf8'), tmp)
    })
    const gd = graph.buildFromParsedFiles(files)
    expect(gd.ghostNodeCount || 0).toBeGreaterThanOrEqual(2)
    expect(gd.nodes.filter((n) => n.isGhost).length).toBeGreaterThanOrEqual(2)
    expect(gd.nodes.some((n) => n.isGhost && n.id === 'ghost:missingnote')).toBe(true)

    const miss = write('Knowledge/MissingNote.md', '# MissingNote\nnow exists\n')
    graph.updateNodeAndEdges(miss)
    const after = graph.getGraphData()
    expect(after.nodes.some((n) => n.title === 'MissingNote' && !n.isGhost)).toBe(true)
    expect(after.ghostNodeCount || 0).toBeLessThan(gd.ghostNodeCount || 99)
  })

  it('includeGhosts:false filters ghosts', () => {
    write('Knowledge/Real.md', '# Real\n[[MissingNote]]\n')
    write('Knowledge/Linked.md', '# Linked\n[[Real]]\n')
    const files = ['Real.md', 'Linked.md'].map((n) => {
      const p = path.join(tmp, 'Knowledge', n)
      return md.parseFile(p, fs.readFileSync(p, 'utf8'), tmp)
    })
    graph.buildFromParsedFiles(files)
    const realOnly = graph.getGraphData({ includeGhosts: false })
    expect(realOnly.nodes.every((n) => !n.isGhost)).toBe(true)
    expect(realOnly.nodeCount).toBe(2)
  })

  it('resolveTitleToPath returns null for ghosts/missing', () => {
    write('Knowledge/Y.md', '# Y\n[[MissingZ]]\n')
    const yp = path.join(tmp, 'Knowledge', 'Y.md')
    graph.buildFromParsedFiles([md.parseFile(yp, fs.readFileSync(yp, 'utf8'), tmp)])
    expect(graph.resolveTitleToPath('MissingZ')).toBeNull()
  })

  it('aliases resolve and survive updates', () => {
    write(
      'Knowledge/Beta.md',
      '---\ntitle: Beta\naliases:\n  - Bee\n  - Beta Note\n---\n# Beta\n[[Gamma]]\n'
    )
    write('Knowledge/Gamma.md', '# Gamma\n')
    const files = ['Beta.md', 'Gamma.md'].map((n) => {
      const p = path.join(tmp, 'Knowledge', n)
      return md.parseFile(p, fs.readFileSync(p, 'utf8'), tmp)
    })
    graph.buildFromParsedFiles(files)
    const bee = graph.resolveTitleToPath('Bee')
    expect(bee && bee.replace(/\\/g, '/').endsWith('Knowledge/Beta.md')).toBe(true)

    const beta2 = write(
      'Knowledge/Beta.md',
      '---\ntitle: Beta\naliases:\n  - Bee\n---\n# Beta\n[[Gamma]]\n\nedited\n'
    )
    graph.updateNodeAndEdges(beta2)
    expect(graph.resolveTitleToPath('Bee')).toBeTruthy()
  })

  it('path must not hop through ghosts', () => {
    write('Knowledge/A.md', '# A\n[[MissingBridge]]\n')
    write('Knowledge/B.md', '# B\n[[MissingBridge]]\n')
    const files = ['A.md', 'B.md'].map((n) => {
      const p = path.join(tmp, 'Knowledge', n)
      return md.parseFile(p, fs.readFileSync(p, 'utf8'), tmp)
    })
    graph.buildFromParsedFiles(files)
    const a = graph.getNodeByPath(path.join(tmp, 'Knowledge', 'A.md'))!
    const b = graph.getNodeByPath(path.join(tmp, 'Knowledge', 'B.md'))!
    const pathAB = graph.findShortestPath(a.id, b.id)
    expect(pathAB?.found).toBe(false)
  })

  it('self-links and empty links do not create loop edges', () => {
    write('Knowledge/Self.md', '---\naliases: [Me]\n---\n# Self\n[[Self]] [[]] [[Me]]\n')
    const p = path.join(tmp, 'Knowledge', 'Self.md')
    const data = graph.buildFromParsedFiles([md.parseFile(p, fs.readFileSync(p, 'utf8'), tmp)])
    expect(data.edges.some((e) => e.source === e.target)).toBe(false)
  })

  it('API surfaces strip internal outLinks', () => {
    write('Knowledge/P.md', '# P\n[[Q]]\n')
    write('Knowledge/Q.md', '# Q\n')
    const files = ['P.md', 'Q.md'].map((n) => {
      const p = path.join(tmp, 'Knowledge', n)
      return md.parseFile(p, fs.readFileSync(p, 'utf8'), tmp)
    })
    graph.buildFromParsedFiles(files)
    const gd = graph.getGraphData()
    expect(gd.nodes.every((n) => n.outLinks === undefined)).toBe(true)
    const local = graph.getLocalGraph(files[0].id, 1)
    expect(local && local.nodes.every((n) => n.outLinks === undefined)).toBe(true)
  })

  it('attachment lifecycle: upsert idempotent, remove cleans edges', () => {
    write('Knowledge/R.md', '# R\n[[doc.pdf]]\n')
    const rp = path.join(tmp, 'Knowledge', 'R.md')
    graph.buildFromParsedFiles([md.parseFile(rp, fs.readFileSync(rp, 'utf8'), tmp)])
    const ap = path.join(tmp, 'Knowledge', 'doc.pdf')
    fs.writeFileSync(ap, '%PDF-1.4')
    const aid = idOf(ap)
    graph.upsertAttachment({
      id: aid,
      path: ap,
      relativePath: 'Knowledge/doc.pdf',
      title: 'doc.pdf'
    })
    expect(graph.getGraphData().edges.some((e) => e.target === aid)).toBe(true)
    graph.upsertAttachment({
      id: aid,
      path: ap,
      relativePath: 'Knowledge/doc.pdf',
      title: 'doc.pdf'
    })
    expect(graph.getGraphData().nodes.filter((n) => n.id === aid)).toHaveLength(1)
    graph.removeAttachment(aid)
    expect(graph.getGraphData().nodes.some((n) => n.id === aid)).toBe(false)
    expect(graph.getGraphData().edges.some((e) => e.source === aid || e.target === aid)).toBe(false)
  })

  it('setAttachments builds attachment nodes and resolves wiki links', () => {
    write('Knowledge/T1.md', '---\ntags: [alpha]\n---\n# T1\n[[pic.png]]\n')
    const t1p = path.join(tmp, 'Knowledge', 'T1.md')
    graph.buildFromParsedFiles([md.parseFile(t1p, fs.readFileSync(t1p, 'utf8'), tmp)])
    const imgPath = path.join(tmp, 'Knowledge', 'pic.png')
    fs.writeFileSync(imgPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    const attachId = idOf(imgPath)
    graph.setAttachments([
      { id: attachId, path: imgPath, relativePath: 'Knowledge/pic.png', title: 'pic.png' }
    ])
    const after = graph.getGraphData()
    expect(after.nodes.some((n) => n.isAttachment && n.title === 'pic.png')).toBe(true)
    expect(after.edges.some((e) => after.nodes.find((n) => n.id === e.target)?.isAttachment)).toBe(
      true
    )
  })

  it('tag nodes always built with tagnode edges', () => {
    write('Knowledge/T.md', '---\ntags: [alpha]\n---\n# T\n#alpha\n')
    const p = path.join(tmp, 'Knowledge', 'T.md')
    const parsed = md.parseFile(p, fs.readFileSync(p, 'utf8'), tmp)
    graph.buildFromParsedFiles([parsed])
    const data = graph.getGraphData()
    const tagNodes = data.nodes.filter((n) => n.isTag)
    const tagEdges = data.edges.filter((e) => e.id.startsWith('tagnode:'))
    expect(tagNodes.length).toBeGreaterThanOrEqual(1)
    expect(tagEdges.length).toBeGreaterThanOrEqual(1)
  })

  it('large graph (1000 notes) builds and updates fast', () => {
    const big = new GraphEngine()
    const parsed: ReturnType<typeof md.parseFile>[] = []
    const N = 1000
    for (let i = 0; i < N; i++) {
      const name = `N${String(i).padStart(4, '0')}`
      const links = []
      if (i > 0) links.push(`[[N${String(i - 1).padStart(4, '0')}]]`)
      if (i % 7 === 0 && i + 3 < N) links.push(`[[N${String(i + 3).padStart(4, '0')}]]`)
      const body = `# ${name}\n${links.join(' ')}\n`
      const p = path.join(tmp, 'Big', `${name}.md`)
      fs.mkdirSync(path.dirname(p), { recursive: true })
      fs.writeFileSync(p, body)
      parsed.push(md.parseFile(p, body, tmp))
    }
    const t0 = Date.now()
    const bigData = big.buildFromParsedFiles(parsed)
    const tBuild = Date.now()
    expect(bigData.realNodeCount ?? bigData.nodes.filter((n) => !n.isGhost).length).toBe(N)
    expect(bigData.edgeCount).toBeGreaterThan(N / 2)
    expect(tBuild - t0).toBeLessThan(5000)

    const mid = parsed[500]
    mid.wikiLinks = [...(mid.wikiLinks || []), { target: 'N0001', display: 'N0001' }]
    const tUp0 = Date.now()
    big.updateNodeAndEdges(mid)
    expect(Date.now() - tUp0).toBeLessThan(2000)
    const afterBig = big.getGraphData()
    expect(afterBig.realNodeCount ?? afterBig.nodes.filter((n) => !n.isGhost).length).toBe(N)
  })

  it('CRLF markdown parses cleanly', () => {
    const crlfPath = path.join(tmp, 'Knowledge', 'CRLF.md')
    fs.mkdirSync(path.dirname(crlfPath), { recursive: true })
    const crlfBody = '---\r\ntitle: CRLFNote\r\n---\r\n# CRLFNote\r\n[[Alpha]]\r\n'
    fs.writeFileSync(crlfPath, crlfBody)
    const crlf = md.parseFile(crlfPath, crlfBody, tmp)
    expect(crlf.title).toBe('CRLFNote')
    expect(crlf.wikiLinks[0]?.target).toBe('Alpha')
  })

  it('wiki links in code blocks and inline code are NOT extracted', () => {
    const codeNote = write(
      'Knowledge/CodeLinks.md',
      '---\ntitle: CodeLinks\n---\n# CodeLinks\n\nInline `[[ShouldNotLink]]` and fence:\n\n```md\n[[AlsoNotLink]]\n```\n\nReal link: [[Alpha]]\n'
    )
    expect(codeNote.wikiLinks).toHaveLength(1)
    expect(codeNote.wikiLinks[0].target).toBe('Alpha')
  })

  it('renderToHtml escapes XSS vectors', () => {
    const xss = md.renderToHtml(
      '# Hi\n<script>alert(1)</script>\n<img src=x onerror=alert(1)>\n[x](javascript:alert(1))\n[ok](https://example.com)'
    )
    expect(xss).not.toContain('<script>')
    expect(/<img\b[^>]*\bonerror\b/i.test(xss)).toBe(false)
    expect(/\shref=["']javascript:/i.test(xss)).toBe(false)
    expect(xss).toContain('https://example.com')
  })
})
