import { describe, it, expect, beforeEach } from 'vitest'
import { GraphEngine } from './GraphEngine'
import { MarkdownEngine, type ParsedMarkdown } from './MarkdownEngine'

describe('GraphEngine', () => {
  let graph: GraphEngine
  let markdown: MarkdownEngine

  beforeEach(() => {
    graph = new GraphEngine()
    markdown = new MarkdownEngine()
  })

  const parseNote = (filePath: string, content: string, rootPath = '/vault'): ParsedMarkdown => {
    return markdown.parseFile(filePath, content, rootPath)
  }

  const buildGraph = (notes: ReturnType<typeof parseNote>[]): void => {
    graph.buildFromParsedFiles(notes, false)
  }

  describe('WikiLink resolution', () => {
    it('resolves exact title match', () => {
      const notes = [parseNote('/vault/A.md', '# A\n\n[[B]]'), parseNote('/vault/B.md', '# B')]
      buildGraph(notes)

      const edges = graph.getGraphData().edges
      expect(edges.length).toBe(1)
      expect(edges[0].type).toBe('wiki_link')
    })

    it('resolves unique basename', () => {
      const notes = [
        parseNote('/vault/Knowledge/A.md', '# A\n\n[[B]]'),
        parseNote('/vault/Projects/B.md', '# B')
      ]
      buildGraph(notes)

      const edges = graph.getGraphData().edges
      expect(edges.length).toBe(1)
    })

    it('creates ghost node for unresolved link', () => {
      const notes = [parseNote('/vault/A.md', '# A\n\n[[NonExistent]]')]
      buildGraph(notes)

      const data = graph.getGraphData()
      const ghostNodes = data.nodes.filter((n) => n.isGhost)
      expect(ghostNodes.length).toBe(1)
      expect(ghostNodes[0].title).toBe('NonExistent')
    })

    it('preserves aliases in link resolution', () => {
      const notes = [
        parseNote('/vault/A.md', '# A\n\n[[B|Alias]]'),
        parseNote('/vault/B.md', '# B')
      ]
      buildGraph(notes)

      const data = graph.getGraphData()
      const aNode = data.nodes.find((n) => n.title === 'A')
      expect(aNode).toBeDefined()
    })

    it('handles path suffix match', () => {
      const notes = [
        parseNote('/vault/A.md', '# A\n\n[[Folder/B]]'),
        parseNote('/vault/Folder/B.md', '# B')
      ]
      buildGraph(notes)

      const edges = graph.getGraphData().edges
      expect(edges.length).toBe(1)
    })
  })

  describe('Tag nodes', () => {
    it('creates tag nodes from frontmatter tags', () => {
      const notes = [
        parseNote('/vault/A.md', '---\ntags: [tag1, tag2]\n---\n# A'),
        parseNote('/vault/B.md', '---\ntags: [tag1]\n---\n# B')
      ]
      buildGraph(notes)

      const data = graph.getGraphData()
      const tagNodes = data.nodes.filter((n) => n.isTag)
      expect(tagNodes.length).toBe(2)
      expect(tagNodes.map((n) => n.title).sort()).toEqual(['#tag1', '#tag2'])
    })

    it('creates edges from notes to tag nodes', () => {
      const notes = [
        parseNote('/vault/A.md', '---\ntags: [shared]\n---\n# A'),
        parseNote('/vault/B.md', '---\ntags: [shared]\n---\n# B')
      ]
      buildGraph(notes)

      const edges = graph.getGraphData().edges
      const tagEdges = edges.filter((e) => e.type === 'tag')
      expect(tagEdges.length).toBe(2)
    })

    it('creates inline tag nodes from #tag in content', () => {
      const notes = [parseNote('/vault/A.md', '# A\n\nContent with #inline-tag')]
      buildGraph(notes)

      const data = graph.getGraphData()
      expect(data.nodes.some((n) => n.isTag && n.title === '#inline-tag')).toBe(true)
    })
  })

  describe('Local graph', () => {
    it('returns neighbors within depth', () => {
      const notes = [
        parseNote('/vault/A.md', '# A\n\n[[B]]'),
        parseNote('/vault/B.md', '# B\n\n[[C]]'),
        parseNote('/vault/C.md', '# C\n\n[[D]]'),
        parseNote('/vault/D.md', '# D')
      ]
      buildGraph(notes)

      const local = graph.getLocalGraph('A', 1)
      expect(local).not.toBeNull()
      expect(local!.nodeCount).toBe(2) // A + B
    })

    it('includes deeper neighbors with higher depth', () => {
      const notes = [
        parseNote('/vault/A.md', '# A\n\n[[B]]'),
        parseNote('/vault/B.md', '# B\n\n[[C]]'),
        parseNote('/vault/C.md', '# C\n\n[[D]]'),
        parseNote('/vault/D.md', '# D')
      ]
      buildGraph(notes)

      const local = graph.getLocalGraph('A', 2)
      expect(local!.nodeCount).toBe(3) // A + B + C
    })
  })

  describe('Neighbors / backlinks / outgoing', () => {
    it('returns backlinks', () => {
      const notes = [
        parseNote('/vault/A.md', '# A\n\n[[B]]'),
        parseNote('/vault/B.md', '# B'),
        parseNote('/vault/C.md', '# C\n\n[[B]]')
      ]
      buildGraph(notes)

      const bNode = graph.getGraphData().nodes.find((n) => n.title === 'B')
      const backlinks = graph.getBacklinks(bNode!.id)
      expect(backlinks.nodes.length).toBe(2)
    })

    it('returns outgoing links', () => {
      const notes = [
        parseNote('/vault/A.md', '# A\n\n[[B]]\n\n[[C]]'),
        parseNote('/vault/B.md', '# B'),
        parseNote('/vault/C.md', '# C')
      ]
      buildGraph(notes)

      const aNode = graph.getGraphData().nodes.find((n) => n.title === 'A')
      const outgoing = graph.getOutgoingLinks(aNode!.id)
      expect(outgoing.nodes.length).toBe(2)
    })
  })

  describe('Orphans', () => {
    it('identifies orphan nodes', () => {
      const notes = [
        parseNote('/vault/A.md', '# A\n\n[[B]]'),
        parseNote('/vault/B.md', '# B'),
        parseNote('/vault/C.md', '# C') // no connections
      ]
      buildGraph(notes)

      const orphans = graph.getOrphanNodeIds()
      expect(orphans.length).toBe(1)
      const cNode = graph.getGraphData().nodes.find((n) => n.title === 'C')
      expect(orphans).toContain(cNode!.id)
    })
  })

  describe('Hubs', () => {
    it('identifies high-degree hubs', () => {
      const notes = [
        parseNote('/vault/Hub.md', '# Hub\n\n[[A]]\n[[B]]\n[[C]]'),
        parseNote('/vault/A.md', '# A\n\n[[Hub]]'),
        parseNote('/vault/B.md', '# B\n\n[[Hub]]'),
        parseNote('/vault/C.md', '# C\n\n[[Hub]]')
      ]
      buildGraph(notes)

      const hubs = graph.getHubNodeIds(3)
      expect(hubs.length).toBe(1)
      const hubNode = graph.getGraphData().nodes.find((n) => n.title === 'Hub')
      expect(hubs).toContain(hubNode!.id)
    })

    it('does not treat shared #tags as hub connections — WB-4', () => {
      // TagHub shares a tag with 5 notes (under the 8-node co-tag cap so star
      // edges ARE built) but has ZERO wiki links. WikiHub has 3 wiki links and
      // no tags. Co-tag star edges are ON like the real app, so TagHub's
      // VISUAL degree is inflated — it must not be reported as a hub.
      const notes = [
        parseNote('/vault/TagHub.md', '---\ntags: [shared]\n---\n# TagHub'),
        parseNote('/vault/WikiHub.md', '# WikiHub\n\n[[A]]\n[[B]]\n[[C]]')
      ]
      for (let i = 0; i < 5; i++) {
        notes.push(parseNote(`/vault/Spoke${i}.md`, '---\ntags: [shared]\n---\n# Spoke' + i))
      }
      notes.push(parseNote('/vault/A.md', '# A\n\n[[WikiHub]]'))
      notes.push(parseNote('/vault/B.md', '# B\n\n[[WikiHub]]'))
      notes.push(parseNote('/vault/C.md', '# C\n\n[[WikiHub]]'))
      graph.buildFromParsedFiles(notes, true)

      const hubs = graph.getHubNodeIds(3)
      const tagHub = graph.getGraphData().nodes.find((n) => n.title === 'TagHub')
      const wikiHub = graph.getGraphData().nodes.find((n) => n.title === 'WikiHub')
      expect(tagHub!.degree).toBeGreaterThanOrEqual(5)
      expect(hubs).not.toContain(tagHub!.id)
      expect(hubs).toContain(wikiHub!.id)
    })
  })

  describe('removeNodesUnderPath (WA-2 cascade)', () => {
    it('removes every node under a deleted folder, keeps the rest', () => {
      const notes = [
        parseNote('/vault/Projects/Sub/A.md', '# A\n\n[[B]]'),
        parseNote('/vault/Projects/Sub/B.md', '# B'),
        parseNote('/vault/Outside.md', '# Outside\n\n[[A]]')
      ]
      buildGraph(notes)
      const before = graph.getGraphData()
      expect(before.nodes.length).toBe(3)

      const removed = graph.removeNodesUnderPath('/vault/Projects')
      expect(removed).toBe(2)

      const after = graph.getGraphData()
      // No real note remains under the deleted folder (A survives only as an
      // unresolved GHOST — Outside still says [[A]] — correct Obsidian behavior)
      expect(after.nodes.some((n) => n.path.toLowerCase().includes('projects'))).toBe(false)
      expect(after.nodes.some((n) => n.title === 'Outside')).toBe(true)
      const ghostA = after.nodes.find((n) => n.isGhost && n.title === 'A')
      expect(ghostA).toBeDefined()
      // No edges point at removed nodes
      expect(after.edges.every((e) => after.nodes.some((n) => n.id === e.source))).toBe(true)
    })

    it('leaves state untouched when nothing lives under the path', () => {
      const notes = [parseNote('/vault/A.md', '# A')]
      buildGraph(notes)
      const removed = graph.removeNodesUnderPath('/vault/Empty')
      expect(removed).toBe(0)
      expect(graph.getGraphData().nodes.length).toBe(1)
    })
  })

  describe('Shortest path', () => {
    it('finds path between connected nodes', () => {
      const notes = [
        parseNote('/vault/A.md', '# A\n\n[[B]]'),
        parseNote('/vault/B.md', '# B\n\n[[C]]'),
        parseNote('/vault/C.md', '# C')
      ]
      buildGraph(notes)

      const aNode = graph.getGraphData().nodes.find((n) => n.title === 'A')
      const cNode = graph.getGraphData().nodes.find((n) => n.title === 'C')
      const path = graph.findShortestPath(aNode!.id, cNode!.id)

      expect(path).not.toBeNull()
      expect(path!.found).toBe(true)
      expect(path!.length).toBe(2)
    })

    it('returns null for disconnected nodes', () => {
      const notes = [parseNote('/vault/A.md', '# A'), parseNote('/vault/B.md', '# B')]
      buildGraph(notes)

      const aNode = graph.getGraphData().nodes.find((n) => n.title === 'A')
      const bNode = graph.getGraphData().nodes.find((n) => n.title === 'B')
      const path = graph.findShortestPath(aNode!.id, bNode!.id)

      expect(path).not.toBeNull()
      expect(path!.found).toBe(false)
    })
  })

  describe('Node types from folder', () => {
    it('assigns correct type from folder name', () => {
      const notes = [
        parseNote('/vault/Knowledge/A.md', '# A'),
        parseNote('/vault/Projects/B.md', '# B'),
        parseNote('/vault/Tasks/C.md', '# C'),
        parseNote('/vault/Daily/D.md', '# D'),
        parseNote('/vault/Templates/E.md', '# E'),
        parseNote('/vault/Documents/F.md', '# F'),
        parseNote('/vault/People/G.md', '# G'),
        parseNote('/vault/SOP/H.md', '# H'),
        parseNote('/vault/Other/I.md', '# I')
      ]
      buildGraph(notes)

      const data = graph.getGraphData()
      expect(data.nodes.find((n) => n.title === 'A')!.type).toBe('knowledge')
      expect(data.nodes.find((n) => n.title === 'B')!.type).toBe('project')
      expect(data.nodes.find((n) => n.title === 'C')!.type).toBe('task')
      expect(data.nodes.find((n) => n.title === 'D')!.type).toBe('daily')
      expect(data.nodes.find((n) => n.title === 'E')!.type).toBe('template')
      expect(data.nodes.find((n) => n.title === 'F')!.type).toBe('document')
      expect(data.nodes.find((n) => n.title === 'G')!.type).toBe('people')
      expect(data.nodes.find((n) => n.title === 'H')!.type).toBe('sop')
      expect(data.nodes.find((n) => n.title === 'I')!.type).toBe('other')
    })
  })

  describe('Incremental updates', () => {
    it('updates node on file change', () => {
      const notes = [parseNote('/vault/A.md', '# A\n\nContent')]
      buildGraph(notes)

      const updated = parseNote('/vault/A.md', '# A Updated\n\nNew content')
      graph.updateNodeAndEdges(updated)

      const node = graph.getGraphData().nodes.find((n) => n.title === 'A Updated')
      expect(node).toBeDefined()
    })

    it('removes node on file delete', () => {
      const notes = [parseNote('/vault/A.md', '# A')]
      buildGraph(notes)

      graph.removeNode(notes[0].id)
      const data = graph.getGraphData()
      expect(data.nodes.find((n) => n.id === notes[0].id)).toBeUndefined()
    })
  })

  describe('Co-tag star edges — WB-3 M5 incremental (inverted index)', () => {
    const starEdgeIds = (g: GraphEngine): string[] =>
      g
        .getGraphData()
        .edges.filter((e) => e.id.startsWith('tag:'))
        .map((e) => e.id)
        .sort()

    it("tag membership change rebuilds only the affected tag's star edges", () => {
      const notes = [
        parseNote('/vault/Hub.md', '---\ntags: [shared]\n---\n# Hub'),
        parseNote('/vault/A.md', '---\ntags: [shared]\n---\n# A'),
        parseNote('/vault/B.md', '---\ntags: [shared]\n---\n# B'),
        parseNote('/vault/C.md', '---\ntags: [other]\n---\n# C')
      ]
      graph.buildFromParsedFiles(notes, true)
      const [hub, a, b, c] = notes.map((n) => n.id)
      const before = starEdgeIds(graph)
      // Hub+A+B share 'shared' (2 star edges), C is alone on 'other' (none)
      expect(before).toEqual([`tag:${hub}<->${a}`, `tag:${hub}<->${b}`])

      // C drops 'other' and joins 'shared' → the 'shared' star set grows; the
      // untouched 'other' tag must not linger as a stale edge anywhere.
      const updated = parseNote('/vault/C.md', '---\ntags: [shared]\n---\n# C')
      graph.updateNodeAndEdges(updated)
      expect(starEdgeIds(graph)).toEqual(
        [`tag:${hub}<->${a}`, `tag:${hub}<->${b}`, `tag:${hub}<->${c}`].sort()
      )

      // A leaves 'shared' → its spoke disappears (hub stays stable).
      const aUpdated = parseNote('/vault/A.md', '---\ntags: [solo]\n---\n# A')
      graph.updateNodeAndEdges(aUpdated)
      expect(starEdgeIds(graph)).toEqual([`tag:${hub}<->${b}`, `tag:${hub}<->${c}`].sort())
    })

    it('removing a node drops its star edges and re-hubs the tag (WB-3 M5)', () => {
      const notes = [
        parseNote('/vault/Hub.md', '---\ntags: [shared]\n---\n# Hub'),
        parseNote('/vault/A.md', '---\ntags: [shared]\n---\n# A'),
        parseNote('/vault/B.md', '---\ntags: [shared]\n---\n# B')
      ]
      graph.buildFromParsedFiles(notes, true)
      const [hub, a, b] = notes.map((n) => n.id)
      expect(starEdgeIds(graph)).toEqual([`tag:${hub}<->${a}`, `tag:${hub}<->${b}`])

      graph.removeNode(hub) // Hub leaves the graph entirely
      // Remaining members A+B re-hub to A → one star edge.
      expect(starEdgeIds(graph)).toEqual([`tag:${a}<->${b}`])
    })

    it('cascade folder delete updates star edges for affected tags only (WB-3 M5)', () => {
      const notes = [
        parseNote('/vault/Sub/Hub.md', '---\ntags: [shared]\n---\n# Hub'),
        parseNote('/vault/Sub/A.md', '---\ntags: [shared]\n---\n# A'),
        parseNote('/vault/Keep.md', '---\ntags: [shared]\n---\n# Keep')
      ]
      graph.buildFromParsedFiles(notes, true)
      const [hub, a, keep] = notes.map((n) => n.id)
      expect(starEdgeIds(graph)).toEqual([`tag:${hub}<->${a}`, `tag:${hub}<->${keep}`].sort())

      graph.removeNodesUnderPath('/vault/Sub')
      // Hub+A gone → Keep is alone on 'shared' → no star edges left.
      expect(starEdgeIds(graph)).toEqual([])
    })
  })

  describe('Attachment nodes', () => {
    it('registers attachment nodes', () => {
      const notes = [parseNote('/vault/A.md', '# A')]
      buildGraph(notes)

      graph.setAttachments([
        { id: 'attach-1', path: '/vault/image.png', relativePath: 'image.png', title: 'image.png' }
      ])

      const data = graph.getGraphData()
      const attachNode = data.nodes.find((n) => n.isAttachment)
      expect(attachNode).toBeDefined()
      expect(attachNode!.title).toBe('image.png')
    })

    it('WB-10: converts an attachment node to a note in place when a parsed file arrives with the same id', () => {
      const notes = [parseNote('/vault/A.md', '# A\n\nSee [[image.png]]')]
      buildGraph(notes)

      // Attachment registered under the same path a parsed note will later claim.
      const imgId = parseNote('/vault/image.png', '').id
      graph.setAttachments([
        { id: imgId, path: '/vault/image.png', relativePath: 'image.png', title: 'image.png' }
      ])
      expect(graph.getGraphData().nodes.find((n) => n.id === imgId)?.isAttachment).toBe(true)

      // File flips to a note at that path (id collision) — convert in place
      // instead of leaving a stale attachment node until a full rebuild.
      graph.updateNodeAndEdges(parseNote('/vault/image.png', '# Image\n\nNow a note'))

      const node = graph.getGraphData().nodes.find((n) => n.id === imgId)
      expect(node).toBeDefined()
      expect(node!.isAttachment).toBeFalsy()
      expect(node!.title).toBe('Image')
      expect(node!.type).toBe('other')
    })
  })

  describe('filterByType / filterByTag', () => {
    it('filters by node type', () => {
      const notes = [
        parseNote('/vault/Knowledge/A.md', '# A'),
        parseNote('/vault/Projects/B.md', '# B')
      ]
      buildGraph(notes)

      const filtered = graph.filterByType(['knowledge'])
      expect(filtered.nodes.length).toBe(1)
      expect(filtered.nodes[0].title).toBe('A')
    })

    it('filters by tag', () => {
      const notes = [
        parseNote('/vault/A.md', '---\ntags: [tag1]\n---\n# A'),
        parseNote('/vault/B.md', '---\ntags: [tag2]\n---\n# B')
      ]
      buildGraph(notes)

      const filtered = graph.filterByTag('tag1')
      expect(filtered.nodes.length).toBe(1)
      expect(filtered.nodes[0].title).toBe('A')
    })
  })
})
