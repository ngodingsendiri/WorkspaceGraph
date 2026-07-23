// src/main/engine/MarkdownEngine.ts
import matter from "gray-matter";
import path from "path";
import crypto from "crypto";
var WIKI_LINK_INNER_REGEX = /\[\[([^\]]+?)\]\]/g;
var TAG_INLINE_REGEX = /#([a-zA-Z0-9_/-]+)/g;
function stripCodeRegions(content) {
  return content.replace(/```[\s\S]*?```/g, (m) => " ".repeat(m.length)).replace(/`[^`\n]+`/g, (m) => " ".repeat(m.length));
}
function extractWikiLinks(content) {
  const links = [];
  const scan = stripCodeRegions(content);
  let match;
  const regex = new RegExp(WIKI_LINK_INNER_REGEX.source, "g");
  while ((match = regex.exec(scan)) !== null) {
    const inner = match[1];
    const normalized = inner.replace(/\\\|/g, "|");
    const pipe = normalized.indexOf("|");
    const targetPart = pipe >= 0 ? normalized.slice(0, pipe) : normalized;
    const aliasPart = pipe >= 0 ? normalized.slice(pipe + 1).trim() : void 0;
    let target = targetPart.split("#")[0].split("^")[0].trim();
    target = target.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\/+|\/+$/g, "").trim();
    if (!target) continue;
    const rawText = content.slice(match.index, match.index + match[0].length) || match[0];
    links.push({
      target,
      alias: aliasPart || void 0,
      rawText,
      position: { start: match.index, end: match.index + match[0].length }
    });
  }
  return links;
}
function extractHeadings(content) {
  const headings = [];
  const lines = content.split("\n");
  for (const line of lines) {
    const m = line.match(/^(#{1,6})\s+(.+)$/);
    if (m) {
      headings.push({ level: m[1].length, text: m[2].trim() });
    }
  }
  return headings;
}
function extractInlineTags(content) {
  const tags = /* @__PURE__ */ new Set();
  let match;
  const regex = new RegExp(TAG_INLINE_REGEX.source, "g");
  while ((match = regex.exec(content)) !== null) {
    tags.add(match[1]);
  }
  return Array.from(tags);
}
function inferTitle(frontmatter, filePath, content) {
  if (frontmatter.title && typeof frontmatter.title === "string") {
    return frontmatter.title;
  }
  const h1 = content.match(/^#\s+(.+)$/m);
  if (h1) return h1[1].trim();
  return path.basename(filePath, path.extname(filePath));
}
function countWords(text) {
  return text.split(/\s+/).filter((w) => w.length > 0).length;
}
function normalizeNewlines(text) {
  if (!text) return "";
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}
function generateId(filePath) {
  const key = filePath.replace(/\\/g, "/").toLowerCase();
  return crypto.createHash("sha256").update(key).digest("hex").slice(0, 24);
}
function escapeHtml(value) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function headingId(raw) {
  return raw.replace(/<[^>]+>/g, "").trim().toLowerCase().replace(/[^\w\u00C0-\u024f\s-]/gi, "").replace(/\s+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || "h";
}
function isGfmSepRow(line) {
  const t = line.trim();
  if (!t.includes("-") || !t.includes("|")) return false;
  return /^[\s|:=-]+$/.test(t) && /:-|-+/.test(t);
}
function isGfmTableRow(line) {
  const t = line.trim();
  if (!t || t.startsWith("```") || t.startsWith("#")) return false;
  if (!(t.startsWith("|") || t.endsWith("|"))) return false;
  return t.split("|").length >= 3;
}
function splitGfmCells(line) {
  let t = line.trim();
  if (t.startsWith("|")) t = t.slice(1);
  if (t.endsWith("|")) t = t.slice(0, -1);
  const cells = [];
  let cur = "";
  for (let i = 0; i < t.length; i++) {
    if (t[i] === "\\" && t[i + 1] === "|") {
      cur += "|";
      i++;
      continue;
    }
    if (t[i] === "|") {
      cells.push(cur.trim());
      cur = "";
      continue;
    }
    cur += t[i];
  }
  cells.push(cur.trim());
  return cells;
}
function parseGfmAligns(sep) {
  return splitGfmCells(sep).map((c) => {
    const left = c.startsWith(":");
    const right = c.endsWith(":");
    if (left && right) return "center";
    if (right) return "right";
    if (left) return "left";
    return null;
  });
}
function renderInline(text) {
  let s = text.length > 2e4 ? text.slice(0, 2e4) : text;
  s = s.replace(/`([^`\n]+?)`/g, "<code>$1</code>");
  s = s.replace(/\*\*\*([^*]+?)\*\*\*/g, "<strong><em>$1</em></strong>");
  s = s.replace(/\*\*([^*]+?)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*])\*([^*\n]+?)\*(?!\*)/g, "$1<em>$2</em>");
  s = s.replace(/__([^_]+?)__/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^_])_([^_\n]+?)_(?!_)/g, "$1<em>$2</em>");
  s = s.replace(/~~([^~]+?)~~/g, "<del>$1</del>");
  s = s.replace(/==([^=]+?)==/g, "<mark>$1</mark>");
  return s;
}
function renderMarkdownToHtml(content) {
  const normalized = normalizeNewlines(content);
  const codeBlocks = [];
  let src = normalized.replace(/```([^\n`]*)\n([\s\S]*?)```/g, (_m, langRaw, body) => {
    const lang = String(langRaw || "").trim().replace(/[^a-zA-Z0-9_+#.-]/g, "");
    const i2 = codeBlocks.length;
    const cls = lang ? ` class="language-${escapeHtml(lang)}"` : "";
    codeBlocks.push(`<pre><code${cls}>${escapeHtml(body.replace(/\n$/, ""))}</code></pre>`);
    return `
\xA7\xA7CODE${i2}\xA7\xA7
`;
  });
  const wikiSlots = [];
  src = src.replace(/!?\[\[([^\]]+?)\]\]/g, (_raw, inner) => {
    const normalized2 = String(inner).replace(/\\\|/g, "|");
    const pipe = normalized2.indexOf("|");
    let target = (pipe >= 0 ? normalized2.slice(0, pipe) : normalized2).trim();
    const alias = pipe >= 0 ? normalized2.slice(pipe + 1).trim() : "";
    target = target.split("#")[0].split("^")[0].trim().replace(/\\/g, "/").replace(/\/+$/g, "");
    const label = alias || target;
    const idx = wikiSlots.length;
    wikiSlots.push({ target, label });
    return `\xA7\xA7WIKI${idx}\xA7\xA7`;
  });
  const extSlots = [];
  src = src.replace(
    /!\[([^\]]*?)\]\((https?:[^)\s]+|mailto:[^)\s]+)\)/gi,
    (_m, alt, url) => {
      const idx = extSlots.length;
      extSlots.push(`<img src="${escapeHtml(url)}" alt="${escapeHtml(alt)}" />`);
      return `\xA7\xA7EXT${idx}\xA7\xA7`;
    }
  );
  src = src.replace(
    /\[([^\]]+?)\]\((https?:[^)\s]+|mailto:[^)\s]+)\)/gi,
    (_m, label, url) => {
      const idx = extSlots.length;
      extSlots.push(
        `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`
      );
      return `\xA7\xA7EXT${idx}\xA7\xA7`;
    }
  );
  const lines = src.split("\n");
  const out = [];
  let i = 0;
  const flushParagraph = (buf) => {
    if (!buf.length) return;
    const text = buf.join("\n").trim();
    if (text) out.push(`<p>${renderInline(escapeHtml(text).replace(/\n/g, "<br />"))}</p>`);
    buf.length = 0;
  };
  let guard = 0;
  const maxSteps = Math.max(lines.length * 4, 64);
  while (i < lines.length) {
    if (++guard > maxSteps) {
      console.warn("[MarkdownEngine] render aborted: step guard (possible loop)");
      break;
    }
    const lineStart = i;
    const line = lines[i];
    const codePh = /^§§CODE(\d+)§§$/.exec(line.trim());
    if (codePh) {
      out.push(codeBlocks[Number(codePh[1])] || "");
      i++;
      continue;
    }
    if (i + 1 < lines.length && isGfmTableRow(line) && isGfmSepRow(lines[i + 1])) {
      const header = splitGfmCells(line);
      const aligns = parseGfmAligns(lines[i + 1]);
      const body = [];
      let j = i + 2;
      while (j < lines.length && isGfmTableRow(lines[j]) && !isGfmSepRow(lines[j])) {
        body.push(splitGfmCells(lines[j]));
        j++;
      }
      const ths = header.map((c, idx) => {
        const a = aligns[idx];
        const align = a ? ` align="${a}"` : "";
        return `<th${align}>${renderInline(escapeHtml(c))}</th>`;
      }).join("");
      const trs = body.map((row) => {
        const cols = Math.max(header.length, row.length);
        let cells = "";
        for (let c = 0; c < cols; c++) {
          const a = aligns[c];
          const align = a ? ` align="${a}"` : "";
          cells += `<td${align}>${renderInline(escapeHtml(row[c] ?? ""))}</td>`;
        }
        return `<tr>${cells}</tr>`;
      }).join("");
      out.push(`<table><thead><tr>${ths}</tr></thead><tbody>${trs}</tbody></table>`);
      i = j;
      continue;
    }
    const hm = /^(#{1,6})\s+(.+)$/.exec(line);
    if (hm) {
      const level = hm[1].length;
      const text = hm[2].trim();
      const id = headingId(text);
      out.push(`<h${level} id="${id}">${renderInline(escapeHtml(text))}</h${level}>`);
      i++;
      continue;
    }
    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line.trim()) && line.trim().length >= 3) {
      out.push("<hr />");
      i++;
      continue;
    }
    if (line.startsWith(">")) {
      const q = [];
      while (i < lines.length && lines[i].startsWith(">")) {
        q.push(lines[i].replace(/^>\s?/, ""));
        i++;
      }
      out.push(`<blockquote>${renderInline(escapeHtml(q.join("\n")).replace(/\n/g, "<br />"))}</blockquote>`);
      continue;
    }
    if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
      const items = [];
      let ordered = /^\s*\d+\.\s+/.test(line);
      while (i < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[i])) {
        const L = lines[i];
        const task = /^\s*[-*+]\s+\[([ xX])\]\s+(.*)$/.exec(L);
        if (task) {
          ordered = false;
          const checked = task[1].toLowerCase() === "x";
          items.push({
            ordered: false,
            html: `<li class="task-list-item"><input type="checkbox" disabled${checked ? " checked" : ""} /> ${renderInline(escapeHtml(task[2]))}</li>`
          });
        } else {
          const um = /^\s*[-*+]\s+(.*)$/.exec(L);
          const om = /^\s*\d+\.\s+(.*)$/.exec(L);
          if (um) {
            ordered = false;
            items.push({ ordered: false, html: `<li>${renderInline(escapeHtml(um[1]))}</li>` });
          } else if (om) {
            ordered = true;
            items.push({ ordered: true, html: `<li>${renderInline(escapeHtml(om[1]))}</li>` });
          } else {
            items.push({ ordered: false, html: `<li>${renderInline(escapeHtml(L.trim()))}</li>` });
          }
        }
        i++;
      }
      const tag = ordered ? "ol" : "ul";
      out.push(`<${tag}>${items.map((x) => x.html).join("")}</${tag}>`);
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    const buf = [];
    while (i < lines.length) {
      const L = lines[i];
      if (!L.trim()) break;
      if (/^(#{1,6})\s+/.test(L)) break;
      if (L.startsWith(">")) break;
      if (/^\s*([-*+]|\d+\.)\s+/.test(L)) break;
      if (/^§§CODE\d+§§$/.test(L.trim())) break;
      if (i + 1 < lines.length && isGfmTableRow(L) && isGfmSepRow(lines[i + 1])) {
        break;
      }
      if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(L.trim()) && L.trim().length >= 3) break;
      buf.push(L);
      i++;
    }
    if (buf.length === 0) {
      out.push(`<p>${renderInline(escapeHtml(line))}</p>`);
      i = lineStart + 1;
      continue;
    }
    flushParagraph(buf);
  }
  let html = out.join("\n");
  html = html.replace(/§§WIKI(\d+)§§/g, (_m, n) => {
    const slot = wikiSlots[Number(n)];
    if (!slot) return "[[?]]";
    return `<span class="wiki-link" data-target="${escapeHtml(slot.target)}">${escapeHtml(slot.label)}</span>`;
  });
  html = html.replace(/§§EXT(\d+)§§/g, (_m, n) => {
    return extSlots[Number(n)] || "";
  });
  return html;
}
var MarkdownEngine = class {
  /**
   * @param opts.light — skip wiki/heading/tag scans (fast path for editor open)
   */
  parseFile(filePath, rawContent, rootPath, opts) {
    const rawNorm = normalizeNewlines(rawContent);
    let parsed;
    try {
      parsed = matter(rawNorm);
    } catch {
      parsed = { data: {}, content: rawNorm, orig: rawNorm };
    }
    const frontmatter = { ...parsed.data };
    for (const key of ["date", "created", "updated"]) {
      const v = frontmatter[key];
      if (Object.prototype.toString.call(v) === "[object Date]") {
        frontmatter[key] = v.toISOString().split("T")[0];
      } else if (typeof v === "number") {
        frontmatter[key] = new Date(v).toISOString().split("T")[0];
      }
    }
    const content = normalizeNewlines(parsed.content);
    const relativePath = rootPath ? path.relative(rootPath, filePath).replace(/\\/g, "/") : filePath;
    const title = inferTitle(frontmatter, filePath, content);
    const fmTags = Array.isArray(frontmatter.tags) ? frontmatter.tags.map(String) : [];
    if (opts?.light) {
      return {
        id: generateId(filePath),
        filePath,
        relativePath,
        title,
        frontmatter,
        content,
        rawContent: rawNorm,
        wikiLinks: [],
        tags: fmTags,
        wordCount: 0,
        headings: []
      };
    }
    const wikiLinks = extractWikiLinks(content);
    const headings = extractHeadings(content);
    const inlineTags = extractInlineTags(content);
    const tags = Array.from(/* @__PURE__ */ new Set([...fmTags, ...inlineTags]));
    return {
      id: generateId(filePath),
      filePath,
      relativePath,
      title,
      frontmatter,
      content,
      rawContent: rawNorm,
      wikiLinks,
      tags,
      wordCount: countWords(content),
      headings
    };
  }
  resolveWikiLink(target, allFiles) {
    for (const [filePath, title] of allFiles.entries()) {
      if (title.toLowerCase() === target.toLowerCase()) return filePath;
      const baseName = path.basename(filePath, path.extname(filePath));
      if (baseName.toLowerCase() === target.toLowerCase()) return filePath;
    }
    return null;
  }
  /**
   * Obsidian/GFM-compatible HTML (pure TS — safe in electron-vite main bundle).
   * Supports: GFM tables, task lists, strikethrough, wikilinks, headings, code, lists.
   */
  renderToHtml(content) {
    return renderMarkdownToHtml(content);
  }
  buildFrontmatterString(meta) {
    const lines = ["---"];
    for (const [key, val] of Object.entries(meta)) {
      if (val === void 0 || val === null) continue;
      if (Array.isArray(val)) {
        lines.push(`${key}:`);
        for (const v of val) lines.push(`  - ${v}`);
      } else {
        lines.push(`${key}: ${val}`);
      }
    }
    lines.push("---", "");
    return lines.join("\n");
  }
  createNoteTemplate(title, type = "note") {
    const now = (/* @__PURE__ */ new Date()).toISOString().split("T")[0];
    return `---
title: ${title}
type: ${type}
created: ${now}
updated: ${now}
tags: []
---

# ${title}

`;
  }
  createDailyNoteTemplate(date) {
    return `---
title: ${date}
type: daily
date: ${date}
---

# ${date}

## \u{1F3AF} Today's Focus


## \u{1F4DD} Notes


## \u2705 Tasks

- [ ] 

## \u{1F517} Links


`;
  }
};
var markdownEngine = new MarkdownEngine();
export {
  MarkdownEngine,
  markdownEngine
};
