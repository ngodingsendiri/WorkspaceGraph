// src/main/engine/GraphEngine.ts
import path from "path";
function nodeTypeFromPath(relativePath) {
  const lower = relativePath.toLowerCase().replace(/\\/g, "/");
  if (lower.startsWith("knowledge") || lower.includes("/knowledge/")) return "knowledge";
  if (lower.startsWith("projects") || lower.includes("/projects/")) return "project";
  if (lower.startsWith("tasks") || lower.includes("/tasks/")) return "task";
  if (lower.startsWith("daily") || lower.startsWith("02 harian") || lower.includes("/02 harian/"))
    return "daily";
  if (lower.startsWith("templates") || lower.startsWith("99 templates") || lower.includes("/templates/"))
    return "template";
  if (lower.startsWith("documents") || lower.includes("/documents/")) return "document";
  if (lower.startsWith("people") || lower.startsWith("05 pegawai") || lower.includes("/05 pegawai/"))
    return "people";
  if (lower.startsWith("sop") || lower.startsWith("06 sop") || lower.includes("/sop")) return "sop";
  if (lower.startsWith("03 kerjaan") || lower.includes("/03 kerjaan/")) return "project";
  return "other";
}
function normalizeLinkTarget(raw) {
  let t = (raw || "").trim();
  t = t.split("#")[0].split("^")[0].trim();
  t = t.replace(/\\/g, "/");
  t = t.replace(/\.md$/i, "");
  t = t.replace(/\/+/g, "/").replace(/^\/+|\/+$/g, "");
  t = t.replace(/\\+$/g, "").trim();
  return t.toLowerCase();
}
function addKey(maps, key, id) {
  if (!key) return;
  const k = key.toLowerCase().trim();
  if (!k) return;
  const list = maps.multi.get(k) || [];
  if (!list.includes(id)) list.push(id);
  maps.multi.set(k, list);
  if (list.length === 1) {
    maps.unique.set(k, id);
  } else {
    maps.unique.delete(k);
  }
}
function resolveLinkTarget(rawTarget, maps) {
  const key = normalizeLinkTarget(rawTarget);
  if (!key) return null;
  if (maps.unique.has(key)) return maps.unique.get(key);
  if (key.includes("/")) {
    const base = key.split("/").pop();
    for (const [p, id] of maps.unique.entries()) {
      if (p === key || p.endsWith("/" + key)) return id;
    }
    if (maps.unique.has(base)) return maps.unique.get(base);
  }
  for (const [p, id] of maps.unique.entries()) {
    if (p.endsWith("/" + key) || p === key) return id;
  }
  const candidates = /* @__PURE__ */ new Set();
  for (const [p, ids] of maps.multi.entries()) {
    if (p === key || p.endsWith("/" + key)) {
      for (const id of ids) candidates.add(id);
    }
  }
  if (candidates.size === 1) return [...candidates][0];
  return null;
}
function buildLookupMaps(items) {
  const maps = { unique: /* @__PURE__ */ new Map(), multi: /* @__PURE__ */ new Map() };
  for (const file of items) {
    const id = file.id;
    addKey(maps, file.title.toLowerCase().trim(), id);
    const baseName = path.basename(file.path, path.extname(file.path));
    addKey(maps, baseName, id);
    const rel = file.relativePath.replace(/\\/g, "/").replace(/\.md$/i, "");
    addKey(maps, rel, id);
    const parts = rel.split("/").filter(Boolean);
    for (let i = 0; i < parts.length; i++) {
      const suffix = parts.slice(i).join("/");
      addKey(maps, suffix, id);
    }
    if (file.aliases) {
      for (const a of file.aliases) {
        if (a) addKey(maps, String(a), id);
      }
    }
  }
  for (const [k, ids] of maps.multi.entries()) {
    const uniq = [...new Set(ids)];
    if (uniq.length === 1) maps.unique.set(k, uniq[0]);
  }
  return maps;
}
function recomputeDegrees(nodes, edges) {
  for (const n of nodes.values()) n.degree = 0;
  const neighbors = /* @__PURE__ */ new Map();
  for (const e of edges.values()) {
    if (e.type !== "wiki_link") continue;
    if (!neighbors.has(e.source)) neighbors.set(e.source, /* @__PURE__ */ new Set());
    if (!neighbors.has(e.target)) neighbors.set(e.target, /* @__PURE__ */ new Set());
    neighbors.get(e.source).add(e.target);
    neighbors.get(e.target).add(e.source);
  }
  for (const [id, set] of neighbors) {
    const n = nodes.get(id);
    if (n) n.degree = set.size;
  }
}
var GraphEngine = class {
  nodes = /* @__PURE__ */ new Map();
  edges = /* @__PURE__ */ new Map();
  /**
   * Build graph.
   * Default includeTagEdges=false → match Obsidian global graph (wikilinks only).
   */
  buildFromParsedFiles(parsedFiles, includeTagEdges = false) {
    this.nodes.clear();
    this.edges.clear();
    const tagToNodeIds = /* @__PURE__ */ new Map();
    for (const file of parsedFiles) {
      const node = {
        id: file.id,
        // Prefer filename for graph label (Obsidian-like); keep full title in data via path
        title: path.basename(file.filePath, path.extname(file.filePath)),
        type: nodeTypeFromPath(file.relativePath),
        path: file.filePath,
        relativePath: file.relativePath,
        tags: file.tags,
        degree: 0
      };
      const fmTitle = file.title?.trim();
      if (fmTitle && fmTitle.length > 0 && fmTitle.length <= 48 && !/^#+\s/.test(fmTitle)) {
        node.title = fmTitle;
      }
      this.nodes.set(file.id, node);
      for (const tag of file.tags) {
        const tagLower = tag.toLowerCase();
        const existing = tagToNodeIds.get(tagLower) || [];
        existing.push(file.id);
        tagToNodeIds.set(tagLower, existing);
      }
    }
    const maps = buildLookupMaps(
      parsedFiles.map((f) => ({
        id: f.id,
        title: f.title,
        path: f.filePath,
        relativePath: f.relativePath,
        aliases: Array.isArray(f.frontmatter?.aliases) ? f.frontmatter.aliases.map(String) : []
      }))
    );
    let linked = 0;
    let unresolved = 0;
    const unresolvedSamples = [];
    for (const file of parsedFiles) {
      for (const link of file.wikiLinks) {
        const targetId = resolveLinkTarget(link.target, maps);
        if (targetId && targetId !== file.id) {
          const edgeId = `${file.id}->${targetId}`;
          if (!this.edges.has(edgeId)) {
            this.edges.set(edgeId, {
              id: edgeId,
              source: file.id,
              target: targetId,
              type: "wiki_link",
              weight: 2
            });
            linked++;
          }
        } else if (link.target?.trim()) {
          unresolved++;
          if (unresolvedSamples.length < 12) {
            unresolvedSamples.push(`${file.relativePath} \u2192 [[${link.target}]]`);
          }
        }
      }
    }
    if (unresolved > 0) {
      console.log(
        `[GraphEngine] wiki edges=${linked}, unresolved=${unresolved}`,
        unresolvedSamples
      );
    } else {
      console.log(`[GraphEngine] wiki edges=${linked} (all resolved)`);
    }
    if (includeTagEdges) {
      for (const [, nodeIds] of tagToNodeIds.entries()) {
        if (nodeIds.length < 2 || nodeIds.length > 8) continue;
        const hub = nodeIds[0];
        for (let i = 1; i < nodeIds.length; i++) {
          const tgtId = nodeIds[i];
          const edgeId = `tag:${hub}<->${tgtId}`;
          const wiki1 = `${hub}->${tgtId}`;
          const wiki2 = `${tgtId}->${hub}`;
          if (!this.edges.has(edgeId) && !this.edges.has(wiki1) && !this.edges.has(wiki2)) {
            this.edges.set(edgeId, {
              id: edgeId,
              source: hub,
              target: tgtId,
              type: "tag",
              weight: 1
            });
          }
        }
      }
    }
    recomputeDegrees(this.nodes, this.edges);
    return this.getGraphData();
  }
  updateNodeAndEdges(parsedFile) {
    const aliases = Array.isArray(parsedFile.frontmatter?.aliases) ? parsedFile.frontmatter.aliases.map(String) : [];
    const existing = this.nodes.get(parsedFile.id);
    const displayTitle = parsedFile.title && parsedFile.title.length <= 48 ? parsedFile.title : path.basename(parsedFile.filePath, path.extname(parsedFile.filePath));
    if (existing) {
      existing.title = displayTitle;
      existing.tags = parsedFile.tags;
    } else {
      this.nodes.set(parsedFile.id, {
        id: parsedFile.id,
        title: displayTitle,
        type: nodeTypeFromPath(parsedFile.relativePath),
        path: parsedFile.filePath,
        relativePath: parsedFile.relativePath,
        tags: parsedFile.tags,
        degree: 0
      });
    }
    for (const [edgeId, edge] of this.edges.entries()) {
      if (edge.type === "wiki_link" && (edge.source === parsedFile.id || edge.target === parsedFile.id)) {
        this.edges.delete(edgeId);
      } else if (edge.type === "tag" && (edge.source === parsedFile.id || edge.target === parsedFile.id)) {
        this.edges.delete(edgeId);
      }
    }
    const maps = buildLookupMaps(
      Array.from(this.nodes.values()).map((n) => ({
        id: n.id,
        title: n.title,
        path: n.path,
        relativePath: n.relativePath,
        aliases: n.id === parsedFile.id ? aliases : []
      }))
    );
    for (const link of parsedFile.wikiLinks) {
      const targetId = resolveLinkTarget(link.target, maps);
      if (targetId && targetId !== parsedFile.id) {
        const edgeId = `${parsedFile.id}->${targetId}`;
        if (!this.edges.has(edgeId)) {
          this.edges.set(edgeId, {
            id: edgeId,
            source: parsedFile.id,
            target: targetId,
            type: "wiki_link",
            weight: 2
          });
        }
      }
    }
    recomputeDegrees(this.nodes, this.edges);
  }
  removeNode(nodeId) {
    this.nodes.delete(nodeId);
    for (const [edgeId, edge] of this.edges.entries()) {
      if (edge.source === nodeId || edge.target === nodeId) this.edges.delete(edgeId);
    }
    recomputeDegrees(this.nodes, this.edges);
  }
  getGraphData() {
    return {
      nodes: Array.from(this.nodes.values()),
      edges: Array.from(this.edges.values()),
      nodeCount: this.nodes.size,
      edgeCount: this.edges.size
    };
  }
  getNeighbors(nodeId, depth = 1) {
    const visitedNodes = /* @__PURE__ */ new Set([nodeId]);
    const resultEdges = [];
    let currentLayer = [nodeId];
    for (let d = 0; d < depth; d++) {
      const nextLayer = [];
      for (const currId of currentLayer) {
        for (const edge of this.edges.values()) {
          if (edge.source === currId && !visitedNodes.has(edge.target)) {
            visitedNodes.add(edge.target);
            nextLayer.push(edge.target);
            resultEdges.push(edge);
          } else if (edge.target === currId && !visitedNodes.has(edge.source)) {
            visitedNodes.add(edge.source);
            nextLayer.push(edge.source);
            resultEdges.push(edge);
          }
        }
      }
      currentLayer = nextLayer;
    }
    const neighborNodes = Array.from(visitedNodes).filter((id) => id !== nodeId).map((id) => this.nodes.get(id)).filter((n) => n !== void 0);
    return { nodes: neighborNodes, edges: resultEdges };
  }
  getNodeById(id) {
    return this.nodes.get(id);
  }
  getNodeByPath(filePath) {
    const normalizedSearch = filePath.replace(/\\/g, "/");
    for (const node of this.nodes.values()) {
      if (node.path.replace(/\\/g, "/") === normalizedSearch) return node;
    }
    return void 0;
  }
  getBacklinks(nodeId) {
    const edges = [];
    const nodeIds = /* @__PURE__ */ new Set();
    for (const edge of this.edges.values()) {
      if (edge.type === "wiki_link" && edge.target === nodeId) {
        edges.push(edge);
        nodeIds.add(edge.source);
      }
    }
    const nodes = Array.from(nodeIds).map((id) => this.nodes.get(id)).filter((n) => n !== void 0);
    return { nodes, edges };
  }
  getOutgoingLinks(nodeId) {
    const edges = [];
    const nodeIds = /* @__PURE__ */ new Set();
    for (const edge of this.edges.values()) {
      if (edge.type === "wiki_link" && edge.source === nodeId) {
        edges.push(edge);
        nodeIds.add(edge.target);
      }
    }
    const nodes = Array.from(nodeIds).map((id) => this.nodes.get(id)).filter((n) => n !== void 0);
    return { nodes, edges };
  }
  getOrphanNodeIds() {
    return Array.from(this.nodes.values()).filter((n) => n.degree === 0).map((n) => n.id);
  }
  resolveTitleToPath(target) {
    const maps = buildLookupMaps(
      Array.from(this.nodes.values()).map((n) => ({
        id: n.id,
        title: n.title,
        path: n.path,
        relativePath: n.relativePath
      }))
    );
    const id = resolveLinkTarget(target, maps);
    if (!id) return null;
    return this.nodes.get(id)?.path || null;
  }
  filterByType(types) {
    const filteredNodes = Array.from(this.nodes.values()).filter((n) => types.includes(n.type));
    const filteredIds = new Set(filteredNodes.map((n) => n.id));
    const filteredEdges = Array.from(this.edges.values()).filter(
      (e) => filteredIds.has(e.source) && filteredIds.has(e.target)
    );
    return {
      nodes: filteredNodes,
      edges: filteredEdges,
      nodeCount: filteredNodes.length,
      edgeCount: filteredEdges.length
    };
  }
  filterByTag(tag) {
    const filteredNodes = Array.from(this.nodes.values()).filter(
      (n) => n.tags.some((t) => t.toLowerCase() === tag.toLowerCase())
    );
    const filteredIds = new Set(filteredNodes.map((n) => n.id));
    const filteredEdges = Array.from(this.edges.values()).filter(
      (e) => filteredIds.has(e.source) && filteredIds.has(e.target)
    );
    return {
      nodes: filteredNodes,
      edges: filteredEdges,
      nodeCount: filteredNodes.length,
      edgeCount: filteredEdges.length
    };
  }
};
var graphEngine = new GraphEngine();
export {
  GraphEngine,
  graphEngine,
  normalizeLinkTarget,
  resolveLinkTarget
};
