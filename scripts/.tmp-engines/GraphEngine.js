// src/main/engine/GraphEngine.ts
import path from "path";
function tagNodeId(tag) {
  const t = (tag || "").replace(/^#/, "").trim().toLowerCase();
  return t ? `tag:${t}` : "";
}
function ghostNodeId(rawTarget) {
  const key = normalizeLinkTarget(rawTarget);
  return key ? `ghost:${key}` : "";
}
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
    if (e.type !== "wiki_link" && e.type !== "tag") continue;
    if (!nodes.has(e.source) || !nodes.has(e.target)) continue;
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
function pruneGhostEdges(nodes, edges) {
  let removed = 0;
  for (const [edgeId, edge] of edges.entries()) {
    if (!nodes.has(edge.source) || !nodes.has(edge.target) || edge.source === edge.target) {
      edges.delete(edgeId);
      removed++;
    }
  }
  return removed;
}
var GraphEngine = class {
  nodes = /* @__PURE__ */ new Map();
  edges = /* @__PURE__ */ new Map();
  /** Last attachment list (for incremental rebuild after note update) */
  attachments = [];
  /** Whether co-tag star edges between notes are built (legacy toggle) */
  includeCoTagEdges = false;
  /** Drop all graph state (workspace close / switch). */
  clear() {
    this.nodes.clear();
    this.edges.clear();
    this.attachments = [];
    this.includeCoTagEdges = false;
  }
  buildLookupFromNodes() {
    return buildLookupMaps(
      Array.from(this.nodes.values()).filter((n) => !n.isGhost && !n.isTag).map((n) => ({
        id: n.id,
        title: n.title,
        path: n.path,
        relativePath: n.relativePath,
        aliases: n.aliases || []
      }))
    );
  }
  /** Remove all synthetic ghost nodes (and their edges will be rebuilt). */
  clearGhostNodes() {
    for (const [id, n] of this.nodes.entries()) {
      if (n.isGhost) this.nodes.delete(id);
    }
  }
  clearTagNodes() {
    for (const [id, n] of this.nodes.entries()) {
      if (n.isTag) this.nodes.delete(id);
    }
    for (const [edgeId] of this.edges.entries()) {
      if (edgeId.startsWith("tagnode:")) this.edges.delete(edgeId);
    }
  }
  clearAttachmentNodes() {
    for (const [id, n] of this.nodes.entries()) {
      if (n.isAttachment) this.nodes.delete(id);
    }
  }
  /**
   * Obsidian-like #tag nodes: one node per tag, edges from notes that use it.
   * Always built; UI hides via showTags filter.
   */
  rebuildTagNodes() {
    this.clearTagNodes();
    const tagToNotes = /* @__PURE__ */ new Map();
    for (const n of this.nodes.values()) {
      if (n.isGhost || n.isTag || n.isAttachment) continue;
      for (const raw of n.tags || []) {
        const t = String(raw).replace(/^#/, "").trim().toLowerCase();
        if (!t) continue;
        const list = tagToNotes.get(t) || [];
        list.push(n.id);
        tagToNotes.set(t, list);
      }
    }
    for (const [tag, noteIds] of tagToNotes) {
      const id = tagNodeId(tag);
      if (!id) continue;
      this.nodes.set(id, {
        id,
        title: `#${tag}`,
        type: "tag",
        path: "",
        relativePath: `#${tag}`,
        tags: [tag],
        isTag: true,
        degree: 0
      });
      for (const noteId of noteIds) {
        const edgeId = `tagnode:${noteId}->${id}`;
        this.edges.set(edgeId, {
          id: edgeId,
          source: noteId,
          target: id,
          type: "tag",
          weight: 1
        });
      }
    }
  }
  /**
   * Register non-md vault files as attachment nodes (Obsidian Attachments filter).
   * Re-resolves wiki edges so [[image.png]] links to real attachment nodes.
   */
  setAttachments(list) {
    this.attachments = Array.isArray(list) ? list.slice(0, 8e3) : [];
    this.clearAttachmentNodes();
    for (const a of this.attachments) {
      if (!a?.id || !a.path) continue;
      const existing = this.nodes.get(a.id);
      if (existing && !existing.isAttachment) continue;
      this.nodes.set(a.id, {
        id: a.id,
        title: a.title || path.basename(a.path),
        type: "attachment",
        path: a.path,
        relativePath: a.relativePath || "",
        tags: [],
        isAttachment: true,
        degree: 0
      });
    }
    this.rebuildWikiEdgesFromOutLinks();
    this.rebuildTagNodes();
    if (this.includeCoTagEdges) this.rebuildTagEdges();
    recomputeDegrees(this.nodes, this.edges);
  }
  /** Lightweight: upsert one attachment without wiping the rest. */
  upsertAttachment(meta) {
    if (!meta?.id || !meta.path) return;
    const existing = this.nodes.get(meta.id);
    if (existing && !existing.isAttachment) return;
    const idx = this.attachments.findIndex((a) => a.id === meta.id || a.path === meta.path);
    if (idx >= 0) this.attachments[idx] = meta;
    else {
      if (this.attachments.length >= 8e3) return;
      this.attachments.push(meta);
    }
    this.nodes.set(meta.id, {
      id: meta.id,
      title: meta.title || path.basename(meta.path),
      type: "attachment",
      path: meta.path,
      relativePath: meta.relativePath || "",
      tags: [],
      isAttachment: true,
      degree: existing?.degree ?? 0
    });
    this.rebuildWikiEdgesFromOutLinks();
    this.rebuildTagNodes();
    if (this.includeCoTagEdges) this.rebuildTagEdges();
    recomputeDegrees(this.nodes, this.edges);
  }
  /** Lightweight: remove one attachment by id or path. */
  removeAttachment(idOrPath) {
    if (!idOrPath) return;
    const node = this.nodes.get(idOrPath) || Array.from(this.nodes.values()).find(
      (n) => n.isAttachment && (n.path === idOrPath || n.id === idOrPath)
    );
    if (!node?.isAttachment) return;
    this.attachments = this.attachments.filter((a) => a.id !== node.id && a.path !== node.path);
    this.nodes.delete(node.id);
    for (const [edgeId, edge] of this.edges.entries()) {
      if (edge.source === node.id || edge.target === node.id) this.edges.delete(edgeId);
    }
    this.rebuildWikiEdgesFromOutLinks();
    this.rebuildTagNodes();
    if (this.includeCoTagEdges) this.rebuildTagEdges();
    recomputeDegrees(this.nodes, this.edges);
  }
  ensureGhostNode(rawTarget) {
    const key = normalizeLinkTarget(rawTarget);
    if (!key) return null;
    const id = ghostNodeId(rawTarget);
    if (!id) return null;
    const existing = this.nodes.get(id);
    if (existing?.isGhost) {
      return id;
    }
    const pretty = (rawTarget || "").trim().split("#")[0].split("^")[0].replace(/\\/g, "/").replace(/\.md$/i, "").split("/").filter(Boolean).pop();
    const title = (pretty || key).slice(0, 80);
    this.nodes.set(id, {
      id,
      title,
      type: "ghost",
      path: "",
      relativePath: `?/${key}`,
      tags: [],
      isGhost: true,
      degree: 0
    });
    return id;
  }
  /**
   * Rebuild ALL wiki edges from cached outLinks on every node.
   * Critical after add/rename/delete so notes that still say [[NewTitle]]
   * re-link without waiting for each source file to be re-parsed.
   *
   * Unresolved targets become ghost nodes (Obsidian non-existing files).
   */
  rebuildWikiEdgesFromOutLinks() {
    for (const [edgeId, edge] of this.edges.entries()) {
      if (edge.type === "wiki_link") this.edges.delete(edgeId);
    }
    this.clearGhostNodes();
    const maps = this.buildLookupFromNodes();
    let linked = 0;
    let unresolved = 0;
    for (const node of this.nodes.values()) {
      if (node.isGhost || node.isTag || node.isAttachment) continue;
      const outs = node.outLinks || [];
      for (const raw of outs) {
        if (!raw?.trim()) continue;
        const targetId = resolveLinkTarget(raw, maps);
        const tgt = targetId ? this.nodes.get(targetId) : void 0;
        if (targetId && targetId !== node.id && tgt && !tgt.isGhost && !tgt.isTag) {
          const edgeId = `${node.id}->${targetId}`;
          if (!this.edges.has(edgeId)) {
            this.edges.set(edgeId, {
              id: edgeId,
              source: node.id,
              target: targetId,
              type: "wiki_link",
              weight: 2
            });
            linked++;
          }
        } else if (raw.trim()) {
          const gid = this.ensureGhostNode(raw);
          if (gid && gid !== node.id) {
            const edgeId = `${node.id}->${gid}`;
            if (!this.edges.has(edgeId)) {
              this.edges.set(edgeId, {
                id: edgeId,
                source: node.id,
                target: gid,
                type: "wiki_link",
                weight: 1
              });
            }
            unresolved++;
          }
        }
      }
    }
    pruneGhostEdges(this.nodes, this.edges);
    recomputeDegrees(this.nodes, this.edges);
    return { linked, unresolved };
  }
  rebuildTagEdges() {
    for (const [edgeId, edge] of this.edges.entries()) {
      if (edge.type === "tag") this.edges.delete(edgeId);
    }
    const tagToNodeIds = /* @__PURE__ */ new Map();
    for (const n of this.nodes.values()) {
      if (n.isGhost) continue;
      for (const tag of n.tags || []) {
        const tagLower = tag.toLowerCase();
        const existing = tagToNodeIds.get(tagLower) || [];
        existing.push(n.id);
        tagToNodeIds.set(tagLower, existing);
      }
    }
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
  displayTitleFromParsed(parsedFile) {
    const fmTitle = parsedFile.title?.trim();
    if (fmTitle && fmTitle.length > 0 && fmTitle.length <= 48 && !/^#+\s/.test(fmTitle)) {
      return fmTitle;
    }
    return path.basename(parsedFile.filePath, path.extname(parsedFile.filePath));
  }
  outLinksFromParsed(parsedFile) {
    const seen = /* @__PURE__ */ new Set();
    const out = [];
    for (const link of parsedFile.wikiLinks || []) {
      const t = (link.target || "").trim();
      if (!t || seen.has(t)) continue;
      seen.add(t);
      out.push(t);
    }
    return out;
  }
  /**
   * Build graph.
   * Default includeTagEdges=false → co-tag star edges off; #tag nodes always built.
   */
  buildFromParsedFiles(parsedFiles, includeTagEdges = false) {
    this.nodes.clear();
    this.edges.clear();
    this.includeCoTagEdges = includeTagEdges;
    const savedAttachments = this.attachments;
    for (const file of parsedFiles) {
      const nodeAliases = Array.isArray(file.frontmatter?.aliases) ? file.frontmatter.aliases.map(String) : [];
      const node = {
        id: file.id,
        // Prefer filename for graph label (Obsidian-like); keep full title in data via path
        title: path.basename(file.filePath, path.extname(file.filePath)),
        type: nodeTypeFromPath(file.relativePath),
        path: file.filePath,
        relativePath: file.relativePath,
        tags: file.tags,
        aliases: nodeAliases,
        outLinks: this.outLinksFromParsed(file),
        degree: 0
      };
      const fmTitle = file.title?.trim();
      if (fmTitle && fmTitle.length > 0 && fmTitle.length <= 48 && !/^#+\s/.test(fmTitle)) {
        node.title = fmTitle;
      }
      this.nodes.set(file.id, node);
    }
    if (savedAttachments.length > 0) {
      for (const a of savedAttachments) {
        if (!a?.id || !a.path) continue;
        if (this.nodes.has(a.id)) continue;
        this.nodes.set(a.id, {
          id: a.id,
          title: a.title || path.basename(a.path),
          type: "attachment",
          path: a.path,
          relativePath: a.relativePath || "",
          tags: [],
          isAttachment: true,
          degree: 0
        });
      }
    }
    const { linked, unresolved } = this.rebuildWikiEdgesFromOutLinks();
    this.rebuildTagNodes();
    if (includeTagEdges) this.rebuildTagEdges();
    recomputeDegrees(this.nodes, this.edges);
    if (unresolved > 0) {
      console.log(`[GraphEngine] wiki edges=${linked}, unresolved=${unresolved}`);
    } else {
      console.log(`[GraphEngine] wiki edges=${linked} (all resolved)`);
    }
    return this.getGraphData();
  }
  updateNodeAndEdges(parsedFile) {
    const aliases = Array.isArray(parsedFile.frontmatter?.aliases) ? parsedFile.frontmatter.aliases.map(String) : [];
    const existing = this.nodes.get(parsedFile.id);
    const displayTitle = this.displayTitleFromParsed(parsedFile);
    const outLinks = this.outLinksFromParsed(parsedFile);
    const nodeType = nodeTypeFromPath(parsedFile.relativePath);
    if (existing && !existing.isAttachment && !existing.isTag && !existing.isGhost) {
      existing.title = displayTitle;
      existing.tags = parsedFile.tags;
      existing.aliases = aliases;
      existing.path = parsedFile.filePath;
      existing.relativePath = parsedFile.relativePath;
      existing.type = nodeType;
      existing.outLinks = outLinks;
    } else if (!existing) {
      this.nodes.set(parsedFile.id, {
        id: parsedFile.id,
        title: displayTitle,
        type: nodeType,
        path: parsedFile.filePath,
        relativePath: parsedFile.relativePath,
        tags: parsedFile.tags,
        aliases,
        outLinks,
        degree: 0
      });
    }
    this.rebuildWikiEdgesFromOutLinks();
    this.rebuildTagNodes();
    if (this.includeCoTagEdges) this.rebuildTagEdges();
    recomputeDegrees(this.nodes, this.edges);
  }
  removeNode(nodeId) {
    this.nodes.delete(nodeId);
    for (const [edgeId, edge] of this.edges.entries()) {
      if (edge.source === nodeId || edge.target === nodeId) this.edges.delete(edgeId);
    }
    this.rebuildWikiEdgesFromOutLinks();
    this.rebuildTagNodes();
    if (this.includeCoTagEdges) this.rebuildTagEdges();
    recomputeDegrees(this.nodes, this.edges);
  }
  /**
   * Export graph for UI / IPC.
   * Ghosts/tags/attachments always included; client filters (Existing files / Tags / Attachments).
   */
  getGraphData(options) {
    pruneGhostEdges(this.nodes, this.edges);
    const includeGhosts = options?.includeGhosts !== false;
    const all = Array.from(this.nodes.values());
    const realNodeCount = all.filter((n) => !n.isGhost && !n.isTag && !n.isAttachment).length;
    const ghostNodeCount = all.filter((n) => n.isGhost).length;
    const tagNodeCount = all.filter((n) => n.isTag).length;
    const attachmentNodeCount = all.filter((n) => n.isAttachment).length;
    const nodes = all.filter((n) => includeGhosts || !n.isGhost).map((n) => {
      const { outLinks: _ol, ...rest } = n;
      return rest;
    });
    const idSet = new Set(nodes.map((n) => n.id));
    const edges = Array.from(this.edges.values()).filter(
      (e) => idSet.has(e.source) && idSet.has(e.target) && e.source !== e.target
    );
    return {
      nodes,
      edges,
      nodeCount: nodes.length,
      edgeCount: edges.length,
      realNodeCount,
      ghostNodeCount,
      unresolvedLinkCount: ghostNodeCount,
      tagNodeCount,
      attachmentNodeCount
    };
  }
  getGhostNodeIds() {
    return Array.from(this.nodes.values()).filter((n) => n.isGhost).map((n) => n.id);
  }
  getRealNodeCount() {
    let c = 0;
    for (const n of this.nodes.values()) if (!n.isGhost) c++;
    return c;
  }
  getNeighbors(nodeId, depth = 1, options) {
    const maxDepth = Math.min(5, Math.max(1, Math.floor(depth) || 1));
    const includeTag = Boolean(options?.includeTagEdges);
    const includeGhosts = Boolean(options?.includeGhosts);
    const visitedNodes = /* @__PURE__ */ new Set([nodeId]);
    let currentLayer = [nodeId];
    const okNode = (id) => {
      const n = this.nodes.get(id);
      if (!n) return false;
      if (!includeGhosts && n.isGhost) return false;
      if (!includeTag && n.isTag) return false;
      return true;
    };
    for (let d = 0; d < maxDepth; d++) {
      const nextLayer = [];
      for (const currId of currentLayer) {
        for (const edge of this.edges.values()) {
          if (!includeTag && edge.type === "tag") continue;
          if (edge.type !== "wiki_link" && edge.type !== "tag") continue;
          let other = null;
          if (edge.source === currId) other = edge.target;
          else if (edge.target === currId) other = edge.source;
          if (other && !visitedNodes.has(other) && okNode(other)) {
            visitedNodes.add(other);
            nextLayer.push(other);
          }
        }
      }
      currentLayer = nextLayer;
    }
    const resultEdges = [];
    for (const edge of this.edges.values()) {
      if (!includeTag && edge.type === "tag") continue;
      if (edge.type !== "wiki_link" && edge.type !== "tag") continue;
      if (visitedNodes.has(edge.source) && visitedNodes.has(edge.target)) {
        if (!includeGhosts) {
          const a = this.nodes.get(edge.source);
          const b = this.nodes.get(edge.target);
          if (a?.isGhost || b?.isGhost) continue;
        }
        resultEdges.push(edge);
      }
    }
    const neighborNodes = Array.from(visitedNodes).filter((id) => id !== nodeId).map((id) => this.nodes.get(id)).filter((n) => n !== void 0).map((n) => this.stripInternal(n));
    return { nodes: neighborNodes, edges: resultEdges };
  }
  getNodeById(id) {
    return this.nodes.get(id);
  }
  getNodeByPath(filePath) {
    const normalizedSearch = filePath.replace(/\\/g, "/").toLowerCase();
    for (const node of this.nodes.values()) {
      if (node.path.replace(/\\/g, "/").toLowerCase() === normalizedSearch) return node;
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
    return Array.from(this.nodes.values()).filter((n) => !n.isGhost && !n.isTag && !n.isAttachment && n.degree === 0).map((n) => n.id);
  }
  /** High-degree hubs (wiki degree). Default threshold matches Obsidian-style “hairball” control. */
  getHubNodeIds(minDegree = 15) {
    const thr = Math.max(1, Math.floor(minDegree));
    return Array.from(this.nodes.values()).filter((n) => !n.isGhost && !n.isTag && !n.isAttachment && n.degree >= thr).sort((a, b) => b.degree - a.degree).map((n) => n.id);
  }
  getHubNodes(minDegree = 15) {
    const ids = new Set(this.getHubNodeIds(minDegree));
    return Array.from(this.nodes.values()).filter((n) => ids.has(n.id)).sort((a, b) => b.degree - a.degree);
  }
  /** Resolve node id from id or absolute/relative path */
  resolveNodeId(nodeIdOrPath) {
    if (!nodeIdOrPath?.trim()) return null;
    if (this.nodes.has(nodeIdOrPath)) return nodeIdOrPath;
    const byPath = this.getNodeByPath(nodeIdOrPath);
    if (byPath) return byPath.id;
    const norm = nodeIdOrPath.replace(/\\/g, "/").replace(/^\//, "").toLowerCase();
    for (const n of this.nodes.values()) {
      const rel = n.relativePath.replace(/\\/g, "/").toLowerCase();
      if (rel === norm || rel === norm + ".md" || rel.endsWith("/" + norm) || rel.endsWith("/" + norm + ".md")) {
        return n.id;
      }
    }
    return null;
  }
  /**
   * Local graph subgraph (Obsidian local graph foundation).
   * Includes center node + neighbors within depth (1–5, Obsidian-like).
   * Default: wiki_link edges only (tag edges optional).
   */
  getLocalGraph(nodeIdOrPath, depth = 1, options) {
    const centerId = this.resolveNodeId(nodeIdOrPath);
    if (!centerId || !this.nodes.has(centerId)) return null;
    const maxDepth = Math.min(5, Math.max(1, Math.floor(depth) || 1));
    const includeTag = Boolean(options?.includeTagEdges);
    const visited = /* @__PURE__ */ new Set([centerId]);
    let layer = [centerId];
    for (let d = 0; d < maxDepth; d++) {
      const next = [];
      for (const curr of layer) {
        for (const edge of this.edges.values()) {
          if (!includeTag && edge.type === "tag") continue;
          if (edge.type !== "wiki_link" && edge.type !== "tag") continue;
          let other = null;
          if (edge.source === curr) other = edge.target;
          else if (edge.target === curr) other = edge.source;
          if (other && !visited.has(other) && this.nodes.has(other)) {
            visited.add(other);
            next.push(other);
          }
        }
      }
      layer = next;
    }
    const nodes = Array.from(visited).map((id) => this.nodes.get(id)).filter((n) => n !== void 0).map((n) => this.stripInternal(n));
    const edges = [];
    for (const edge of this.edges.values()) {
      if (!includeTag && edge.type === "tag") continue;
      if (edge.type !== "wiki_link" && edge.type !== "tag") continue;
      if (visited.has(edge.source) && visited.has(edge.target)) {
        edges.push(edge);
      }
    }
    return {
      centerId,
      depth: maxDepth,
      nodes,
      edges,
      nodeCount: nodes.length,
      edgeCount: edges.length
    };
  }
  resolveTitleToPath(target) {
    const maps = buildLookupMaps(
      Array.from(this.nodes.values()).filter((n) => !n.isGhost && !n.isTag && Boolean(n.path)).map((n) => ({
        id: n.id,
        title: n.title,
        path: n.path,
        relativePath: n.relativePath,
        // Must include aliases — Ctrl+click [[alias]] was broken after graph updates
        aliases: n.aliases || []
      }))
    );
    const id = resolveLinkTarget(target, maps);
    if (!id) return null;
    const node = this.nodes.get(id);
    if (!node?.path || node.isGhost || node.isTag) return null;
    return node.path;
  }
  /**
   * Build undirected adjacency for wiki_link edges (tag optional).
   * Phase 4 path-finding foundation.
   */
  /**
   * Undirected adjacency for path / neighborhood.
   * Default: real notes + attachments only (no ghosts, no tag-hub hops).
   */
  buildAdj(includeTagEdges = false, options) {
    const includeGhosts = Boolean(options?.includeGhosts);
    const adj = /* @__PURE__ */ new Map();
    const ensure = (id) => {
      if (!adj.has(id)) adj.set(id, /* @__PURE__ */ new Set());
    };
    const allowed = (id) => {
      const n = this.nodes.get(id);
      if (!n) return false;
      if (!includeGhosts && n.isGhost) return false;
      if (n.isTag && !includeTagEdges) return false;
      return true;
    };
    for (const id of this.nodes.keys()) {
      if (allowed(id)) ensure(id);
    }
    for (const e of this.edges.values()) {
      if (!allowed(e.source) || !allowed(e.target)) continue;
      if (e.type === "wiki_link") {
        ensure(e.source);
        ensure(e.target);
        adj.get(e.source).add(e.target);
        adj.get(e.target).add(e.source);
      } else if (includeTagEdges && e.type === "tag") {
        ensure(e.source);
        ensure(e.target);
        adj.get(e.source).add(e.target);
        adj.get(e.target).add(e.source);
      }
    }
    return adj;
  }
  stripInternal(n) {
    const { outLinks: _ol, ...rest } = n;
    return rest;
  }
  /**
   * Shortest path (BFS) between two notes on wiki links (Obsidian-like path highlight).
   * Accepts node id or path for either endpoint.
   */
  findShortestPath(fromIdOrPath, toIdOrPath, options) {
    const fromId = this.resolveNodeId(fromIdOrPath);
    const toId = this.resolveNodeId(toIdOrPath);
    if (!fromId || !toId) return null;
    if (fromId === toId) {
      const n = this.nodes.get(fromId);
      return {
        fromId,
        toId,
        found: true,
        length: 0,
        nodeIds: [fromId],
        edgeKeys: [],
        nodes: n ? [n] : [],
        edges: []
      };
    }
    const maxDepth = Math.min(256, Math.max(1, options?.maxDepth ?? 64));
    const adj = this.buildAdj(Boolean(options?.includeTagEdges));
    const prev = /* @__PURE__ */ new Map();
    const q = [fromId];
    prev.set(fromId, null);
    let found = false;
    const depthAt = /* @__PURE__ */ new Map([[fromId, 0]]);
    while (q.length > 0) {
      const cur = q.shift();
      const d = depthAt.get(cur) ?? 0;
      if (d >= maxDepth) continue;
      for (const nb of adj.get(cur) || []) {
        if (prev.has(nb)) continue;
        prev.set(nb, cur);
        depthAt.set(nb, d + 1);
        if (nb === toId) {
          found = true;
          q.length = 0;
          break;
        }
        q.push(nb);
      }
    }
    if (!found) {
      return {
        fromId,
        toId,
        found: false,
        length: -1,
        nodeIds: [],
        edgeKeys: [],
        nodes: [],
        edges: []
      };
    }
    const nodeIds = [];
    let walk = toId;
    while (walk) {
      nodeIds.push(walk);
      walk = prev.get(walk) ?? null;
    }
    nodeIds.reverse();
    const edgeKey = (a, b) => a < b ? `${a}|${b}` : `${b}|${a}`;
    const edgeKeys = [];
    for (let i = 0; i < nodeIds.length - 1; i++) {
      edgeKeys.push(edgeKey(nodeIds[i], nodeIds[i + 1]));
    }
    const idSet = new Set(nodeIds);
    const edges = [];
    for (const e of this.edges.values()) {
      if (e.type !== "wiki_link" && !(options?.includeTagEdges && e.type === "tag")) continue;
      const k = edgeKey(e.source, e.target);
      if (edgeKeys.includes(k) && idSet.has(e.source) && idSet.has(e.target)) {
        edges.push(e);
      }
    }
    const nodes = nodeIds.map((id) => this.nodes.get(id)).filter((n) => n !== void 0);
    return {
      fromId,
      toId,
      found: true,
      length: nodeIds.length - 1,
      nodeIds,
      edgeKeys,
      nodes,
      edges
    };
  }
  /**
   * Neighborhood ids including center (paint focus). depth 1–5 (Obsidian local range).
   */
  getNeighborhoodIds(nodeIdOrPath, depth = 1, options) {
    const centerId = this.resolveNodeId(nodeIdOrPath);
    if (!centerId) return null;
    const maxDepth = Math.min(5, Math.max(1, Math.floor(depth) || 1));
    const adj = this.buildAdj(Boolean(options?.includeTagEdges));
    const visited = /* @__PURE__ */ new Set([centerId]);
    let layer = [centerId];
    for (let d = 0; d < maxDepth; d++) {
      const next = [];
      for (const cur of layer) {
        for (const nb of adj.get(cur) || []) {
          if (!visited.has(nb)) {
            visited.add(nb);
            next.push(nb);
          }
        }
      }
      layer = next;
    }
    const edgeKey = (a, b) => a < b ? `${a}|${b}` : `${b}|${a}`;
    const edgeKeys = [];
    for (const e of this.edges.values()) {
      if (e.type !== "wiki_link" && !(options?.includeTagEdges && e.type === "tag")) continue;
      if (visited.has(e.source) && visited.has(e.target)) {
        edgeKeys.push(edgeKey(e.source, e.target));
      }
    }
    return { centerId, ids: Array.from(visited), edgeKeys };
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
  ghostNodeId,
  graphEngine,
  normalizeLinkTarget,
  resolveLinkTarget,
  tagNodeId
};
