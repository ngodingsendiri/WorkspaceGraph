// src/main/engine/GraphLayoutStore.ts
import fs from "fs";
import path from "path";
var GRAPH_LAYOUT_VERSION = 1;
var GRAPH_LAYOUT_FILENAME = "graph-layout.json";
function normalizeCamera(v) {
  if (!v || typeof v !== "object") return null;
  const o = v;
  const x = Number(o.x);
  const y = Number(o.y);
  const k = Number(o.k);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(k)) return null;
  if (k < 0.05 || k > 8) return null;
  return { x, y, k: Math.min(6, Math.max(0.08, k)) };
}
var DEFAULT_GRAPH_SETTINGS = {
  forces: {
    center: 0.06,
    charge: -90,
    linkDist: 68,
    linkStr: 0.4,
    collide: 0.6
  },
  display: {
    showLabels: true,
    showTagEdges: false,
    showLegend: false,
    dimHubs: true,
    hideOrphans: false,
    arrows: false,
    textFade: 1,
    nodeSize: 1,
    lineThickness: 1,
    existingFilesOnly: true,
    showTags: false,
    showAttachments: false,
    animateForces: false
  },
  filters: {
    hubDegreeThreshold: 15,
    localDepth: 1,
    orphanMode: "all",
    hubMode: "dim",
    searchMode: "spotlight"
  },
  groups: []
};
function clamp(n, min, max) {
  if (Number.isNaN(n)) return min;
  return Math.min(max, Math.max(min, n));
}
var ORPHAN_MODES = ["all", "hide", "only"];
var HUB_MODES = ["all", "dim", "hide"];
var SEARCH_MODES = ["spotlight", "filter"];
function normalizeOrphanMode(v, fallback = "all") {
  return ORPHAN_MODES.includes(v) ? v : fallback;
}
function normalizeHubMode(v, fallback = "dim") {
  return HUB_MODES.includes(v) ? v : fallback;
}
function normalizeSearchMode(v, fallback = "spotlight") {
  return SEARCH_MODES.includes(v) ? v : fallback;
}
var MAX_COLOR_GROUPS = 20;
function normalizeColorGroups(v) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const g of v) {
    if (!g || typeof g !== "object") continue;
    const query = typeof g.query === "string" ? g.query.trim().slice(0, 120) : "";
    if (!query) continue;
    const rawColor = typeof g.color === "string" ? g.color.trim() : "";
    const color = /^#[0-9a-fA-F]{3,8}$/.test(rawColor) ? rawColor : "#a882dd";
    const id = typeof g.id === "string" && g.id ? g.id.slice(0, 48) : `grp_${out.length}_${Math.random().toString(36).slice(2, 7)}`;
    out.push({ id, query, color });
    if (out.length >= MAX_COLOR_GROUPS) break;
  }
  return out;
}
function mergeGraphSettings(partial) {
  const p = partial || {};
  const f = p.forces || {};
  const d = p.display || {};
  const fil = p.filters || {};
  let orphanMode;
  if (fil.orphanMode != null) {
    orphanMode = normalizeOrphanMode(fil.orphanMode);
  } else if (d.hideOrphans === true) {
    orphanMode = "hide";
  } else {
    orphanMode = DEFAULT_GRAPH_SETTINGS.filters.orphanMode;
  }
  let hubMode;
  if (fil.hubMode != null) {
    hubMode = normalizeHubMode(fil.hubMode);
  } else if (d.dimHubs === false) {
    hubMode = "all";
  } else if (d.dimHubs === true) {
    hubMode = "dim";
  } else {
    hubMode = DEFAULT_GRAPH_SETTINGS.filters.hubMode;
  }
  return {
    forces: {
      center: clamp(f.center ?? DEFAULT_GRAPH_SETTINGS.forces.center, 0, 0.25),
      charge: clamp(f.charge ?? DEFAULT_GRAPH_SETTINGS.forces.charge, -400, -10),
      linkDist: clamp(f.linkDist ?? DEFAULT_GRAPH_SETTINGS.forces.linkDist, 20, 200),
      linkStr: clamp(f.linkStr ?? DEFAULT_GRAPH_SETTINGS.forces.linkStr, 0.05, 1),
      collide: clamp(f.collide ?? DEFAULT_GRAPH_SETTINGS.forces.collide, 0, 1)
    },
    display: {
      showLabels: d.showLabels ?? DEFAULT_GRAPH_SETTINGS.display.showLabels,
      showTagEdges: d.showTagEdges ?? DEFAULT_GRAPH_SETTINGS.display.showTagEdges,
      showLegend: d.showLegend ?? DEFAULT_GRAPH_SETTINGS.display.showLegend,
      arrows: d.arrows ?? DEFAULT_GRAPH_SETTINGS.display.arrows,
      textFade: clamp(d.textFade ?? DEFAULT_GRAPH_SETTINGS.display.textFade, 0.4, 2.5),
      nodeSize: clamp(d.nodeSize ?? DEFAULT_GRAPH_SETTINGS.display.nodeSize, 0.25, 2),
      lineThickness: clamp(
        d.lineThickness ?? DEFAULT_GRAPH_SETTINGS.display.lineThickness,
        0.25,
        3
      ),
      existingFilesOnly: d.existingFilesOnly ?? DEFAULT_GRAPH_SETTINGS.display.existingFilesOnly,
      showTags: d.showTags ?? DEFAULT_GRAPH_SETTINGS.display.showTags,
      showAttachments: d.showAttachments ?? DEFAULT_GRAPH_SETTINGS.display.showAttachments,
      animateForces: d.animateForces ?? DEFAULT_GRAPH_SETTINGS.display.animateForces,
      // Keep booleans in sync with modes (legacy consumers / dashboard)
      dimHubs: hubMode === "dim",
      hideOrphans: orphanMode === "hide"
    },
    filters: {
      hubDegreeThreshold: clamp(
        fil.hubDegreeThreshold ?? DEFAULT_GRAPH_SETTINGS.filters.hubDegreeThreshold,
        2,
        200
      ),
      localDepth: clamp(fil.localDepth ?? DEFAULT_GRAPH_SETTINGS.filters.localDepth, 1, 5),
      orphanMode,
      hubMode,
      searchMode: normalizeSearchMode(
        fil.searchMode,
        DEFAULT_GRAPH_SETTINGS.filters.searchMode
      )
    },
    groups: normalizeColorGroups(p.groups)
  };
}
function getLayoutFilePath(vaultRoot) {
  return path.join(vaultRoot, ".workspacegraph", GRAPH_LAYOUT_FILENAME);
}
function loadGraphLayout(vaultRoot) {
  const empty = {
    version: GRAPH_LAYOUT_VERSION,
    updatedAt: (/* @__PURE__ */ new Date()).toISOString(),
    nodes: {},
    camera: null
  };
  if (!vaultRoot) return empty;
  const filePath = getLayoutFilePath(vaultRoot);
  try {
    if (!fs.existsSync(filePath)) return { ...empty, vaultPath: vaultRoot };
    const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    const nodes = {};
    if (raw.nodes && typeof raw.nodes === "object") {
      for (const [id, pos] of Object.entries(raw.nodes)) {
        if (!pos || typeof pos !== "object") continue;
        const x = Number(pos.x);
        const y = Number(pos.y);
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        nodes[id] = {
          x,
          y,
          pinned: Boolean(pos.pinned)
        };
      }
    }
    return {
      version: GRAPH_LAYOUT_VERSION,
      vaultPath: vaultRoot,
      updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : empty.updatedAt,
      nodes,
      camera: normalizeCamera(raw.camera)
    };
  } catch (err) {
    console.error("[GraphLayoutStore] load failed:", err);
    return { ...empty, vaultPath: vaultRoot };
  }
}
function saveGraphLayout(vaultRoot, patch, options) {
  if (!vaultRoot) return { ok: false, error: "No vault open" };
  try {
    const dir = path.join(vaultRoot, ".workspacegraph");
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const existing = options?.replaceAll ? { nodes: {}, camera: null } : loadGraphLayout(vaultRoot);
    const nextNodes = options?.cameraOnly ? { ...existing.nodes } : { ...existing.nodes };
    if (!options?.cameraOnly) {
      for (const [id, pos] of Object.entries(patch.nodes || {})) {
        if (!id || !pos) continue;
        const x = Number(pos.x);
        const y = Number(pos.y);
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        nextNodes[id] = { x, y, pinned: Boolean(pos.pinned) };
      }
    }
    let camera = existing.camera ?? null;
    if (patch.camera !== void 0) {
      camera = patch.camera === null ? null : normalizeCamera(patch.camera);
    }
    const payload = {
      version: GRAPH_LAYOUT_VERSION,
      vaultPath: vaultRoot,
      updatedAt: (/* @__PURE__ */ new Date()).toISOString(),
      nodes: nextNodes,
      camera
    };
    const filePath = getLayoutFilePath(vaultRoot);
    const tmp = filePath + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), "utf-8");
    fs.renameSync(tmp, filePath);
    return { ok: true, path: filePath, count: Object.keys(nextNodes).length };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
function readGraphSettingsFromAppSettings(settings) {
  const g = settings?.graph;
  if (g && typeof g === "object") {
    return mergeGraphSettings(g);
  }
  return mergeGraphSettings(null);
}
var GRAPH_VIEWS_VERSION = 1;
var GRAPH_VIEWS_FILENAME = "graph-views.json";
var DEFAULT_VIEW_SNAPSHOT = {
  orphanMode: "all",
  hubMode: "dim",
  hubDegreeThreshold: 15,
  selectedType: "all",
  selectedTag: "all",
  showLabels: true,
  showTagEdges: false,
  showLegend: false,
  colorBy: "type",
  forces: { ...DEFAULT_GRAPH_SETTINGS.forces },
  perfMode: "auto",
  arrows: DEFAULT_GRAPH_SETTINGS.display.arrows,
  textFade: DEFAULT_GRAPH_SETTINGS.display.textFade,
  nodeSize: DEFAULT_GRAPH_SETTINGS.display.nodeSize,
  lineThickness: DEFAULT_GRAPH_SETTINGS.display.lineThickness,
  existingFilesOnly: DEFAULT_GRAPH_SETTINGS.display.existingFilesOnly,
  searchMode: DEFAULT_GRAPH_SETTINGS.filters.searchMode,
  showTags: DEFAULT_GRAPH_SETTINGS.display.showTags,
  showAttachments: DEFAULT_GRAPH_SETTINGS.display.showAttachments,
  animateForces: DEFAULT_GRAPH_SETTINGS.display.animateForces,
  camera: null,
  groups: []
};
function getViewsFilePath(vaultRoot) {
  return path.join(vaultRoot, ".workspacegraph", GRAPH_VIEWS_FILENAME);
}
function sanitizeSnapshot(raw) {
  const s = raw || {};
  const disp = {
    arrows: s.arrows ?? DEFAULT_VIEW_SNAPSHOT.arrows,
    textFade: clamp(Number(s.textFade ?? DEFAULT_VIEW_SNAPSHOT.textFade), 0.4, 2.5),
    nodeSize: clamp(Number(s.nodeSize ?? DEFAULT_VIEW_SNAPSHOT.nodeSize), 0.25, 2),
    lineThickness: clamp(
      Number(s.lineThickness ?? DEFAULT_VIEW_SNAPSHOT.lineThickness),
      0.25,
      3
    ),
    existingFilesOnly: s.existingFilesOnly ?? DEFAULT_VIEW_SNAPSHOT.existingFilesOnly,
    showTags: s.showTags ?? DEFAULT_VIEW_SNAPSHOT.showTags,
    showAttachments: s.showAttachments ?? DEFAULT_VIEW_SNAPSHOT.showAttachments,
    animateForces: s.animateForces ?? DEFAULT_VIEW_SNAPSHOT.animateForces
  };
  const forces = mergeGraphSettings({ forces: s.forces }).forces;
  return {
    orphanMode: normalizeOrphanMode(s.orphanMode, DEFAULT_VIEW_SNAPSHOT.orphanMode),
    hubMode: normalizeHubMode(s.hubMode, DEFAULT_VIEW_SNAPSHOT.hubMode),
    hubDegreeThreshold: clamp(
      Number(s.hubDegreeThreshold ?? DEFAULT_VIEW_SNAPSHOT.hubDegreeThreshold),
      2,
      200
    ),
    selectedType: typeof s.selectedType === "string" && s.selectedType ? s.selectedType : "all",
    selectedTag: typeof s.selectedTag === "string" && s.selectedTag ? s.selectedTag : "all",
    showLabels: s.showLabels ?? true,
    showTagEdges: s.showTagEdges ?? false,
    showLegend: s.showLegend ?? false,
    colorBy: s.colorBy === "folder" ? "folder" : "type",
    forces,
    perfMode: s.perfMode === "quality" || s.perfMode === "speed" ? s.perfMode : "auto",
    arrows: disp.arrows,
    textFade: disp.textFade,
    nodeSize: disp.nodeSize,
    lineThickness: disp.lineThickness,
    existingFilesOnly: disp.existingFilesOnly,
    searchMode: normalizeSearchMode(s.searchMode, DEFAULT_VIEW_SNAPSHOT.searchMode),
    showTags: disp.showTags,
    showAttachments: disp.showAttachments,
    animateForces: disp.animateForces,
    camera: normalizeCamera(s.camera),
    groups: normalizeColorGroups(s.groups)
  };
}
function loadGraphViews(vaultRoot) {
  const empty = {
    version: GRAPH_VIEWS_VERSION,
    updatedAt: (/* @__PURE__ */ new Date()).toISOString(),
    views: []
  };
  if (!vaultRoot) return empty;
  const filePath = getViewsFilePath(vaultRoot);
  try {
    if (!fs.existsSync(filePath)) return { ...empty, vaultPath: vaultRoot };
    const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    const views = [];
    if (Array.isArray(raw.views)) {
      for (const v of raw.views) {
        if (!v || typeof v !== "object") continue;
        const id = typeof v.id === "string" && v.id ? v.id : null;
        const name = typeof v.name === "string" && v.name.trim() ? v.name.trim() : null;
        if (!id || !name) continue;
        views.push({
          id,
          name: name.slice(0, 80),
          updatedAt: typeof v.updatedAt === "string" ? v.updatedAt : empty.updatedAt,
          snapshot: sanitizeSnapshot(v.snapshot)
        });
      }
    }
    return {
      version: GRAPH_VIEWS_VERSION,
      vaultPath: vaultRoot,
      updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : empty.updatedAt,
      views
    };
  } catch (err) {
    console.error("[GraphLayoutStore] load views failed:", err);
    return { ...empty, vaultPath: vaultRoot };
  }
}
function writeViewsFile(vaultRoot, views) {
  try {
    const dir = path.join(vaultRoot, ".workspacegraph");
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const payload = {
      version: GRAPH_VIEWS_VERSION,
      vaultPath: vaultRoot,
      updatedAt: (/* @__PURE__ */ new Date()).toISOString(),
      views
    };
    const filePath = getViewsFilePath(vaultRoot);
    const tmp = filePath + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), "utf-8");
    fs.renameSync(tmp, filePath);
    return { ok: true, path: filePath, count: views.length };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
function upsertGraphView(vaultRoot, input) {
  if (!vaultRoot) return { ok: false, error: "No vault open" };
  const name = (input.name || "").trim().slice(0, 80);
  if (!name) return { ok: false, error: "Name required" };
  const file = loadGraphViews(vaultRoot);
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const snapshot = sanitizeSnapshot(input.snapshot);
  let views = [...file.views];
  let view;
  if (input.id) {
    const idx = views.findIndex((v) => v.id === input.id);
    if (idx >= 0) {
      view = { ...views[idx], name, updatedAt: now, snapshot };
      views[idx] = view;
    } else {
      view = { id: input.id, name, updatedAt: now, snapshot };
      views.push(view);
    }
  } else {
    const idx = views.findIndex((v) => v.name.toLowerCase() === name.toLowerCase());
    if (idx >= 0) {
      view = { ...views[idx], name, updatedAt: now, snapshot };
      views[idx] = view;
    } else {
      view = {
        id: `view_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
        name,
        updatedAt: now,
        snapshot
      };
      views.push(view);
    }
  }
  if (views.length > 40) views = views.slice(-40);
  const res = writeViewsFile(vaultRoot, views);
  if (!res.ok) return { ok: false, error: res.error };
  return { ok: true, view, views };
}
function deleteGraphView(vaultRoot, id) {
  if (!vaultRoot) return { ok: false, error: "No vault open" };
  if (!id) return { ok: false, error: "id required" };
  const file = loadGraphViews(vaultRoot);
  const views = file.views.filter((v) => v.id !== id);
  const res = writeViewsFile(vaultRoot, views);
  if (!res.ok) return { ok: false, error: res.error };
  return { ok: true, views };
}
function resolveGraphLod(nodeCount, perfMode = "auto") {
  if (perfMode === "quality") return "full";
  if (perfMode === "speed") {
    if (nodeCount > 40) return "low";
    if (nodeCount > 15) return "medium";
    return "full";
  }
  if (nodeCount > 400) return "low";
  if (nodeCount > 150) return "medium";
  return "full";
}
export {
  DEFAULT_GRAPH_SETTINGS,
  DEFAULT_VIEW_SNAPSHOT,
  GRAPH_LAYOUT_FILENAME,
  GRAPH_LAYOUT_VERSION,
  GRAPH_VIEWS_FILENAME,
  GRAPH_VIEWS_VERSION,
  deleteGraphView,
  getLayoutFilePath,
  getViewsFilePath,
  loadGraphLayout,
  loadGraphViews,
  mergeGraphSettings,
  normalizeCamera,
  normalizeColorGroups,
  normalizeHubMode,
  normalizeOrphanMode,
  normalizeSearchMode,
  readGraphSettingsFromAppSettings,
  resolveGraphLod,
  saveGraphLayout,
  upsertGraphView
};
