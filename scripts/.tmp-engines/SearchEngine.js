var __require = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : typeof Proxy !== "undefined" ? new Proxy(x, {
  get: (a, b) => (typeof require !== "undefined" ? require : a)[b]
}) : x)(function(x) {
  if (typeof require !== "undefined") return require.apply(this, arguments);
  throw Error('Dynamic require of "' + x + '" is not supported');
});

// src/main/engine/SearchEngine.ts
import Fuse from "fuse.js";

// src/main/engine/IndexDatabase.ts
import fs from "fs";
import path from "path";
var IndexDatabase = class {
  db = null;
  dbPath = null;
  available = false;
  isOpen() {
    return this.db !== null && this.available;
  }
  getPath() {
    return this.dbPath;
  }
  open(workspaceRoot) {
    this.close();
    try {
      const Database = __require("better-sqlite3");
      const dir = path.join(workspaceRoot, ".workspacegraph");
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      this.dbPath = path.join(dir, "index.db");
      this.db = new Database(this.dbPath);
      this.db.pragma("journal_mode = WAL");
      this.db.pragma("synchronous = NORMAL");
      this.migrate();
      this.available = true;
      return true;
    } catch (err) {
      console.error("[IndexDatabase] open failed, Fuse-only mode:", err);
      this.db = null;
      this.available = false;
      return false;
    }
  }
  close() {
    if (this.db) {
      try {
        this.db.close();
      } catch {
      }
    }
    this.db = null;
    this.dbPath = null;
    this.available = false;
  }
  migrate() {
    if (!this.db) return;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT
      );

      CREATE TABLE IF NOT EXISTS notes (
        id TEXT PRIMARY KEY,
        path TEXT NOT NULL UNIQUE,
        relative_path TEXT NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        tags TEXT NOT NULL DEFAULT '[]',
        type TEXT NOT NULL DEFAULT 'note',
        headings TEXT NOT NULL DEFAULT '',
        frontmatter TEXT NOT NULL DEFAULT '{}',
        updated_at TEXT NOT NULL DEFAULT ''
      );

      CREATE INDEX IF NOT EXISTS idx_notes_updated ON notes(updated_at);
      CREATE INDEX IF NOT EXISTS idx_notes_type ON notes(type);

      CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
        title,
        content,
        tags,
        relative_path,
        headings,
        content='notes',
        content_rowid='rowid',
        tokenize='porter unicode61'
      );

      CREATE TRIGGER IF NOT EXISTS notes_ai AFTER INSERT ON notes BEGIN
        INSERT INTO notes_fts(rowid, title, content, tags, relative_path, headings)
        VALUES (new.rowid, new.title, new.content, new.tags, new.relative_path, new.headings);
      END;

      CREATE TRIGGER IF NOT EXISTS notes_ad AFTER DELETE ON notes BEGIN
        INSERT INTO notes_fts(notes_fts, rowid, title, content, tags, relative_path, headings)
        VALUES ('delete', old.rowid, old.title, old.content, old.tags, old.relative_path, old.headings);
      END;

      CREATE TRIGGER IF NOT EXISTS notes_au AFTER UPDATE ON notes BEGIN
        INSERT INTO notes_fts(notes_fts, rowid, title, content, tags, relative_path, headings)
        VALUES ('delete', old.rowid, old.title, old.content, old.tags, old.relative_path, old.headings);
        INSERT INTO notes_fts(rowid, title, content, tags, relative_path, headings)
        VALUES (new.rowid, new.title, new.content, new.tags, new.relative_path, new.headings);
      END;
    `);
  }
  clear() {
    if (!this.db) return;
    this.db.exec("DELETE FROM notes");
    try {
      this.db.exec(`INSERT INTO notes_fts(notes_fts) VALUES('rebuild')`);
    } catch {
    }
  }
  upsertNote(file) {
    if (!this.db) return;
    const tags = JSON.stringify(file.tags || []);
    const headings = (file.headings || []).map((h) => h.text).join(" ");
    const fm = JSON.stringify(file.frontmatter || {});
    const updated = String(file.frontmatter.updated || file.frontmatter.date || "") || (/* @__PURE__ */ new Date()).toISOString();
    const type = file.frontmatter.type || "note";
    this.db.prepare("DELETE FROM notes WHERE path = ? AND id != ?").run(file.filePath, file.id);
    this.db.prepare(
      `INSERT INTO notes (id, path, relative_path, title, content, tags, type, headings, frontmatter, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           path=excluded.path,
           relative_path=excluded.relative_path,
           title=excluded.title,
           content=excluded.content,
           tags=excluded.tags,
           type=excluded.type,
           headings=excluded.headings,
           frontmatter=excluded.frontmatter,
           updated_at=excluded.updated_at`
    ).run(
      file.id,
      file.filePath,
      file.relativePath,
      file.title,
      file.content,
      tags,
      type,
      headings,
      fm,
      updated
    );
  }
  /** Full rebuild from parsed files (transaction) */
  rebuild(parsedFiles) {
    if (!this.db) return 0;
    const run = this.db.transaction(() => {
      this.clear();
      for (const f of parsedFiles) {
        this.upsertNote(f);
      }
      this.db.prepare(
        `INSERT INTO meta(key, value) VALUES('last_rebuild', ?)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value`
      ).run((/* @__PURE__ */ new Date()).toISOString());
      return parsedFiles.length;
    });
    return run();
  }
  removeById(id) {
    if (!this.db) return;
    this.db.prepare("DELETE FROM notes WHERE id = ?").run(id);
  }
  removeByPath(filePath) {
    if (!this.db) return;
    this.db.prepare("DELETE FROM notes WHERE path = ?").run(filePath);
  }
  count() {
    if (!this.db) return 0;
    const row = this.db.prepare("SELECT COUNT(*) as c FROM notes").get();
    return row?.c || 0;
  }
  getStats() {
    if (!this.db) {
      return { count: 0, path: this.dbPath, lastRebuild: null, open: false };
    }
    const meta = this.db.prepare(`SELECT value FROM meta WHERE key = 'last_rebuild'`).get();
    return {
      count: this.count(),
      path: this.dbPath,
      lastRebuild: meta?.value || null,
      open: true
    };
  }
  /**
   * FTS5 query. Escapes user input to safe token query (AND of terms).
   */
  searchFts(query, limit = 20) {
    if (!this.db || !query.trim()) return [];
    const terms = query.trim().split(/\s+/).map((t) => t.replace(/["']/g, "")).filter((t) => t.length > 0 && !t.includes(":")).slice(0, 12);
    if (terms.length === 0) return [];
    const ftsQuery = terms.map((t) => `"${t.replace(/"/g, "")}"*`).join(" ");
    try {
      const rows = this.db.prepare(
        `SELECT n.id, n.path, n.relative_path, n.title, n.type, n.tags, n.updated_at,
                  bm25(notes_fts) AS rank,
                  snippet(notes_fts, 1, '\xAB', '\xBB', '\u2026', 12) AS snip
           FROM notes_fts
           JOIN notes n ON n.rowid = notes_fts.rowid
           WHERE notes_fts MATCH ?
           ORDER BY rank
           LIMIT ?`
      ).all(ftsQuery, limit);
      return rows.map((r) => ({
        id: r.id,
        path: r.path,
        relativePath: r.relative_path,
        title: r.title,
        type: r.type,
        tags: this.parseTags(r.tags),
        updatedAt: r.updated_at,
        rank: typeof r.rank === "number" ? r.rank : 0,
        snippet: (r.snip || "").replace(/\n/g, " ")
      }));
    } catch (err) {
      console.error("[IndexDatabase] FTS query failed:", err);
      return [];
    }
  }
  searchByTag(tag, limit = 50) {
    if (!this.db) return [];
    const needle = tag.toLowerCase();
    const rows = this.db.prepare(`SELECT * FROM notes ORDER BY updated_at DESC LIMIT 2000`).all();
    return rows.filter((r) => this.parseTags(r.tags).some((t) => t.toLowerCase() === needle)).slice(0, limit).map((r) => ({
      id: r.id,
      path: r.path,
      relativePath: r.relative_path,
      title: r.title,
      type: r.type,
      tags: this.parseTags(r.tags),
      updatedAt: r.updated_at,
      rank: 0,
      snippet: this.parseTags(r.tags).join(", ")
    }));
  }
  getRecent(limit = 10) {
    if (!this.db) return [];
    const rows = this.db.prepare(
      `SELECT id, path, relative_path, title, type, tags, updated_at, content
         FROM notes ORDER BY updated_at DESC LIMIT ?`
    ).all(limit);
    return rows.map((r) => ({
      id: r.id,
      path: r.path,
      relativePath: r.relative_path,
      title: r.title,
      type: r.type,
      tags: this.parseTags(r.tags),
      updatedAt: r.updated_at,
      rank: 0,
      snippet: (r.content || "").slice(0, 100).replace(/\n/g, " ").trim()
    }));
  }
  getByIds(ids) {
    if (!this.db || ids.length === 0) return [];
    const out = [];
    const stmt = this.db.prepare(
      `SELECT id, path, relative_path, title, type, tags, updated_at, content FROM notes WHERE id = ?`
    );
    for (const id of ids) {
      const r = stmt.get(id);
      if (!r) continue;
      out.push({
        id: r.id,
        path: r.path,
        relativePath: r.relative_path,
        title: r.title,
        type: r.type,
        tags: this.parseTags(r.tags),
        updatedAt: r.updated_at,
        rank: 0,
        snippet: (r.content || "").slice(0, 100).replace(/\n/g, " ").trim()
      });
    }
    return out;
  }
  /** Notes under Rules/, SOP/, Templates/, Prompt/ for Context Engine auto-include */
  listSystemNotes(limit = 20) {
    if (!this.db) return [];
    const rows = this.db.prepare(
      `SELECT id, path, relative_path, title, type, tags, updated_at, content
         FROM notes
         WHERE lower(relative_path) LIKE 'rules/%'
            OR lower(relative_path) LIKE 'sop/%'
            OR lower(relative_path) LIKE 'templates/%'
            OR lower(relative_path) LIKE 'prompt/%'
         ORDER BY relative_path
         LIMIT ?`
    ).all(limit);
    return rows.map((r) => ({
      id: r.id,
      path: r.path,
      relativePath: r.relative_path,
      title: r.title,
      type: r.type,
      tags: this.parseTags(r.tags),
      updatedAt: r.updated_at,
      rank: 0,
      snippet: (r.content || "").slice(0, 400).replace(/\n/g, " ").trim()
    }));
  }
  parseTags(raw) {
    try {
      const arr = JSON.parse(raw || "[]");
      return Array.isArray(arr) ? arr.map(String) : [];
    } catch {
      return [];
    }
  }
};
var indexDatabase = new IndexDatabase();

// src/main/engine/GraphEngine.ts
import path2 from "path";
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
    const baseName = path2.basename(file.path, path2.extname(file.path));
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
      const nodeAliases = Array.isArray(file.frontmatter?.aliases) ? file.frontmatter.aliases.map(String) : [];
      const node = {
        id: file.id,
        // Prefer filename for graph label (Obsidian-like); keep full title in data via path
        title: path2.basename(file.filePath, path2.extname(file.filePath)),
        type: nodeTypeFromPath(file.relativePath),
        path: file.filePath,
        relativePath: file.relativePath,
        tags: file.tags,
        aliases: nodeAliases,
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
            unresolvedSamples.push(`${file.relativePath} -> [[${link.target}]]`);
          }
        }
      }
    }
    if (unresolved > 0) {
      console.log(`[GraphEngine] wiki edges=${linked}, unresolved=${unresolved}`, unresolvedSamples);
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
    const displayTitle = parsedFile.title && parsedFile.title.length <= 48 ? parsedFile.title : path2.basename(parsedFile.filePath, path2.extname(parsedFile.filePath));
    if (existing) {
      existing.title = displayTitle;
      existing.tags = parsedFile.tags;
      existing.aliases = aliases;
      existing.path = parsedFile.filePath;
      existing.relativePath = parsedFile.relativePath;
    } else {
      this.nodes.set(parsedFile.id, {
        id: parsedFile.id,
        title: displayTitle,
        type: nodeTypeFromPath(parsedFile.relativePath),
        path: parsedFile.filePath,
        relativePath: parsedFile.relativePath,
        tags: parsedFile.tags,
        aliases,
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
        aliases: n.aliases || []
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
    return Array.from(this.nodes.values()).filter((n) => n.degree === 0).map((n) => n.id);
  }
  /** High-degree hubs (wiki degree). Default threshold matches Obsidian-style “hairball” control. */
  getHubNodeIds(minDegree = 15) {
    const thr = Math.max(1, Math.floor(minDegree));
    return Array.from(this.nodes.values()).filter((n) => n.degree >= thr).sort((a, b) => b.degree - a.degree).map((n) => n.id);
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
   * Includes center node + neighbors within depth (1–2).
   * Default: wiki_link edges only (tag edges optional).
   */
  getLocalGraph(nodeIdOrPath, depth = 1, options) {
    const centerId = this.resolveNodeId(nodeIdOrPath);
    if (!centerId || !this.nodes.has(centerId)) return null;
    const maxDepth = Math.min(2, Math.max(1, Math.floor(depth) || 1));
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
    const nodes = Array.from(visited).map((id) => this.nodes.get(id)).filter((n) => n !== void 0);
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
      Array.from(this.nodes.values()).map((n) => ({
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
    return this.nodes.get(id)?.path || null;
  }
  /**
   * Build undirected adjacency for wiki_link edges (tag optional).
   * Phase 4 path-finding foundation.
   */
  buildAdj(includeTagEdges = false) {
    const adj = /* @__PURE__ */ new Map();
    const ensure = (id) => {
      if (!adj.has(id)) adj.set(id, /* @__PURE__ */ new Set());
    };
    for (const n of this.nodes.keys()) ensure(n);
    for (const e of this.edges.values()) {
      if (e.type === "wiki_link" || includeTagEdges && e.type === "tag") {
        ensure(e.source);
        ensure(e.target);
        adj.get(e.source).add(e.target);
        adj.get(e.target).add(e.source);
      }
    }
    return adj;
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
    const maxDepth = Math.min(50, Math.max(1, options?.maxDepth ?? 32));
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
   * Neighborhood ids including center (paint focus). depth 1–3.
   */
  getNeighborhoodIds(nodeIdOrPath, depth = 1, options) {
    const centerId = this.resolveNodeId(nodeIdOrPath);
    if (!centerId) return null;
    const maxDepth = Math.min(3, Math.max(1, Math.floor(depth) || 1));
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

// src/main/engine/SearchEngine.ts
var SearchEngine = class {
  index = /* @__PURE__ */ new Map();
  fuse = null;
  useFts = true;
  initFuse() {
    this.fuse = new Fuse(Array.from(this.index.values()), {
      keys: [
        { name: "title", weight: 0.4 },
        { name: "tags", weight: 0.2 },
        { name: "content", weight: 0.3 },
        { name: "relativePath", weight: 0.1 }
      ],
      includeScore: true,
      includeMatches: true,
      threshold: 0.4,
      ignoreLocation: true
    });
  }
  setUseFts(enabled) {
    this.useFts = enabled;
  }
  buildIndex(parsedFiles) {
    this.index.clear();
    for (const file of parsedFiles) {
      this.addToIndex(file, false, false);
    }
    this.initFuse();
    if (indexDatabase.isOpen()) {
      indexDatabase.rebuild(parsedFiles);
    }
  }
  coerceDate(val) {
    if (val == null || val === "") return void 0;
    if (val instanceof Date) return val.toISOString();
    if (typeof val === "number") return new Date(val).toISOString();
    if (typeof val === "string") return val;
    return String(val);
  }
  addToIndex(file, rebuildFuse = true, writeDb = true) {
    this.index.set(file.id, {
      id: file.id,
      title: file.title,
      path: file.filePath,
      relativePath: file.relativePath,
      content: file.content,
      tags: file.tags,
      type: file.frontmatter.type || "note",
      rawContent: file.content,
      updatedAt: this.coerceDate(file.frontmatter.updated) || this.coerceDate(file.frontmatter.date) || void 0,
      headings: (file.headings || []).map((h) => h.text).join(" ")
    });
    if (writeDb && indexDatabase.isOpen()) {
      indexDatabase.upsertNote(file);
    }
    if (rebuildFuse) {
      this.initFuse();
    }
  }
  removeFromIndex(fileId) {
    this.index.delete(fileId);
    if (indexDatabase.isOpen()) {
      indexDatabase.removeById(fileId);
    }
    this.initFuse();
  }
  rebuildSqliteFromMemory() {
    if (!indexDatabase.isOpen()) return 0;
    const files = Array.from(this.index.values()).map((e) => ({
      id: e.id,
      filePath: e.path,
      relativePath: e.relativePath,
      title: e.title,
      frontmatter: { type: e.type, updated: e.updatedAt },
      content: e.content,
      rawContent: e.rawContent,
      wikiLinks: [],
      tags: e.tags,
      wordCount: 0,
      headings: (e.headings || "").split(/\s+/).filter(Boolean).map((text) => ({ level: 1, text }))
    }));
    return indexDatabase.rebuild(files);
  }
  search(options) {
    const { query, limit = 20, filterType, filterTag } = options;
    const q = (query || "").trim();
    if (!q) {
      return this.getRecentFiles(limit);
    }
    const lower = q.toLowerCase();
    if (lower === "orphan:true" || lower === "is:orphan") {
      return this.searchOrphans(limit);
    }
    const backMatch = q.match(/^backlinks?:(.+)$/i);
    if (backMatch) {
      return this.searchBacklinks(backMatch[1].trim(), limit);
    }
    const pathMatch = q.match(/^path:(.+)$/i);
    if (pathMatch) {
      return this.searchByPathFragment(pathMatch[1].trim(), limit);
    }
    const tagMatch = q.match(/^#([a-zA-Z0-9_/-]+)$/);
    if (tagMatch) {
      return this.searchByTagExact(tagMatch[1], limit);
    }
    const results = [];
    const seen = /* @__PURE__ */ new Set();
    if (this.useFts && indexDatabase.isOpen()) {
      const ftsHits = indexDatabase.searchFts(q, limit);
      for (const hit of ftsHits) {
        if (filterType && hit.type !== filterType) continue;
        if (filterTag && !hit.tags.some((t) => t.toLowerCase() === filterTag.toLowerCase()))
          continue;
        seen.add(hit.id);
        const score = Math.max(0, Math.min(100, 80 + hit.rank * -2));
        results.push({
          id: hit.id,
          title: hit.title,
          path: hit.path,
          relativePath: hit.relativePath,
          score,
          type: hit.type,
          tags: hit.tags,
          preview: hit.snippet || void 0,
          matchedField: "content",
          source: "fts"
        });
      }
    }
    if (results.length < limit && this.fuse) {
      const fuseResults = this.fuse.search(q);
      for (const res of fuseResults) {
        const entry = res.item;
        if (seen.has(entry.id)) continue;
        if (filterType && entry.type !== filterType) continue;
        if (filterTag && !entry.tags.some((t) => t.toLowerCase() === filterTag.toLowerCase()))
          continue;
        let preview;
        let matchedField = "content";
        if (res.matches && res.matches.length > 0) {
          const match = res.matches[0];
          if (match.key === "title") matchedField = "title";
          else if (match.key === "tags") matchedField = "tag";
          else if (match.key === "relativePath") matchedField = "path";
          if (match.key === "content" && match.indices && match.indices.length > 0) {
            const matchStart = match.indices[0][0];
            const start = Math.max(0, matchStart - 60);
            const end = Math.min(entry.rawContent.length, matchStart + q.length + 60);
            preview = "..." + entry.rawContent.slice(start, end).replace(/\n/g, " ").trim() + "...";
          }
        }
        if (!preview) {
          preview = entry.rawContent.slice(0, 120).replace(/\n/g, " ").trim();
        }
        results.push({
          id: entry.id,
          title: entry.title,
          path: entry.path,
          relativePath: entry.relativePath,
          score: (1 - (res.score || 0)) * 100,
          type: entry.type,
          tags: entry.tags,
          preview,
          matchedField,
          source: "fuse"
        });
        seen.add(entry.id);
        if (results.length >= limit) break;
      }
    }
    return results.slice(0, limit);
  }
  searchBacklinks(targetTitle, limit = 50) {
    const key = targetTitle.toLowerCase().replace(/\.md$/, "").trim();
    if (!key) return [];
    let targetId = null;
    for (const entry of this.index.values()) {
      if (entry.title.toLowerCase() === key) {
        targetId = entry.id;
        break;
      }
      const base = entry.relativePath.replace(/\\/g, "/").split("/").pop()?.replace(/\.md$/i, "") || "";
      if (base.toLowerCase() === key) {
        targetId = entry.id;
        break;
      }
    }
    if (!targetId) {
      const p = graphEngine.resolveTitleToPath(targetTitle);
      if (p) {
        const node = graphEngine.getNodeByPath(p);
        if (node) targetId = node.id;
      }
    }
    if (targetId) {
      const { nodes } = graphEngine.getBacklinks(targetId);
      if (nodes.length > 0) {
        return nodes.slice(0, limit).map((n) => ({
          id: n.id,
          title: n.title,
          path: n.path,
          relativePath: n.relativePath,
          score: 100,
          type: n.type,
          tags: n.tags,
          matchedField: "backlink",
          preview: `\u2192 links to [[${targetTitle}]]`,
          source: "meta"
        }));
      }
    }
    const wikiRe = /\[\[([^\]]+?)\]\]/g;
    const results = [];
    for (const e of this.index.values()) {
      if (targetId && e.id === targetId) continue;
      if (e.title.toLowerCase() === key) continue;
      const body = (e.content || e.rawContent || "").replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]+`/g, "");
      wikiRe.lastIndex = 0;
      let m;
      let hit = false;
      while ((m = wikiRe.exec(body)) !== null) {
        const inner = m[1].replace(/\\\|/g, "|");
        const pipe = inner.indexOf("|");
        let t = (pipe >= 0 ? inner.slice(0, pipe) : inner).split("#")[0].split("^")[0].trim();
        t = t.replace(/\\/g, "/").replace(/\/+$/g, "").toLowerCase();
        const base = t.includes("/") ? t.split("/").pop() : t;
        if (t === key || base === key) {
          hit = true;
          break;
        }
      }
      if (hit) {
        results.push({
          id: e.id,
          title: e.title,
          path: e.path,
          relativePath: e.relativePath,
          score: 100,
          type: e.type,
          tags: e.tags,
          matchedField: "backlink",
          preview: `\u2192 links to [[${targetTitle}]]`,
          source: "meta"
        });
        if (results.length >= limit) break;
      }
    }
    return results;
  }
  searchByPathFragment(fragment, limit) {
    const f = fragment.toLowerCase().replace(/\\/g, "/");
    return Array.from(this.index.values()).filter((e) => e.relativePath.toLowerCase().replace(/\\/g, "/").includes(f)).slice(0, limit).map((e) => ({
      id: e.id,
      title: e.title,
      path: e.path,
      relativePath: e.relativePath,
      score: 90,
      type: e.type,
      tags: e.tags,
      matchedField: "path",
      preview: e.relativePath,
      source: "meta"
    }));
  }
  searchByTag(tag) {
    return this.searchByTagExact(tag.replace(/^#/, ""), 50);
  }
  searchByTagExact(tag, limit) {
    if (indexDatabase.isOpen()) {
      return indexDatabase.searchByTag(tag, limit).map((e) => ({
        id: e.id,
        title: e.title,
        path: e.path,
        relativePath: e.relativePath,
        score: 100,
        type: e.type,
        tags: e.tags,
        matchedField: "tag",
        preview: e.tags.join(", "),
        source: "fts"
      }));
    }
    const t = tag.toLowerCase();
    return Array.from(this.index.values()).filter((e) => e.tags.some((x) => x.toLowerCase() === t)).slice(0, limit).map((e) => ({
      id: e.id,
      title: e.title,
      path: e.path,
      relativePath: e.relativePath,
      score: 100,
      type: e.type,
      tags: e.tags,
      matchedField: "tag",
      preview: e.tags.join(", "),
      source: "meta"
    }));
  }
  orphanIds = /* @__PURE__ */ new Set();
  setOrphanIds(ids) {
    this.orphanIds = new Set(ids);
  }
  searchOrphans(limit = 50) {
    return Array.from(this.index.values()).filter((e) => this.orphanIds.has(e.id)).slice(0, limit).map((e) => ({
      id: e.id,
      title: e.title,
      path: e.path,
      relativePath: e.relativePath,
      score: 0,
      type: e.type,
      tags: e.tags,
      matchedField: "title",
      preview: "Orphan note (no graph connections)",
      source: "meta"
    }));
  }
  getRecentFiles(limit = 10) {
    if (indexDatabase.isOpen()) {
      const hits = indexDatabase.getRecent(limit);
      if (hits.length > 0) {
        return hits.map((e) => ({
          id: e.id,
          title: e.title,
          path: e.path,
          relativePath: e.relativePath,
          score: 0,
          type: e.type,
          tags: e.tags,
          matchedField: "title",
          preview: e.snippet,
          source: "fts"
        }));
      }
    }
    return Array.from(this.index.values()).sort((a, b) => {
      const ta = String(a.updatedAt || "");
      const tb = String(b.updatedAt || "");
      if (ta !== tb) return tb.localeCompare(ta);
      return a.title.localeCompare(b.title);
    }).slice(0, limit).map((e) => ({
      id: e.id,
      title: e.title,
      path: e.path,
      relativePath: e.relativePath,
      score: 0,
      type: e.type,
      tags: e.tags,
      matchedField: "title",
      preview: e.rawContent.slice(0, 100).replace(/\n/g, " ").trim(),
      source: "meta"
    }));
  }
  getIndexSize() {
    return this.index.size;
  }
  getIndexStats() {
    return {
      memoryCount: this.index.size,
      sqlite: indexDatabase.getStats()
    };
  }
  getAllTags() {
    const tagMap = /* @__PURE__ */ new Map();
    for (const entry of this.index.values()) {
      for (const tag of entry.tags) {
        tagMap.set(tag, (tagMap.get(tag) || 0) + 1);
      }
    }
    return Array.from(tagMap.entries()).map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count);
  }
  /** Paths under Rules/SOP/Templates for context auto-include */
  getSystemFolderNotes() {
    return Array.from(this.index.values()).filter((e) => {
      const p = e.relativePath.replace(/\\/g, "/").toLowerCase();
      return p.startsWith("rules/") || p.startsWith("sop/") || p.startsWith("templates/") || p.startsWith("prompt/");
    });
  }
  getEntryByPath(filePath) {
    const norm = filePath.replace(/\\/g, "/");
    for (const e of this.index.values()) {
      if (e.path.replace(/\\/g, "/") === norm) return e;
    }
    return void 0;
  }
};
var searchEngine = new SearchEngine();
export {
  SearchEngine,
  searchEngine
};
