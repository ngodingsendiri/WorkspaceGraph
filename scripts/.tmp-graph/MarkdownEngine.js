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
function generateId(filePath) {
  return crypto.createHash("sha256").update(filePath).digest("hex").slice(0, 24);
}
var MarkdownEngine = class {
  parseFile(filePath, rawContent, rootPath) {
    let parsed;
    try {
      parsed = matter(rawContent);
    } catch {
      parsed = { data: {}, content: rawContent, orig: rawContent };
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
    const content = parsed.content;
    const wikiLinks = extractWikiLinks(content);
    const headings = extractHeadings(content);
    const inlineTags = extractInlineTags(content);
    const fmTags = Array.isArray(frontmatter.tags) ? frontmatter.tags.map(String) : [];
    const tags = Array.from(/* @__PURE__ */ new Set([...fmTags, ...inlineTags]));
    const title = inferTitle(frontmatter, filePath, content);
    const relativePath = rootPath ? path.relative(rootPath, filePath).replace(/\\/g, "/") : filePath;
    return {
      id: generateId(filePath),
      filePath,
      relativePath,
      title,
      frontmatter,
      content,
      rawContent,
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
  renderToHtml(content) {
    const escapeHtml = (value) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
    const safeUrl = (value) => {
      const url = value.trim();
      if (/^(https?:|mailto:)/i.test(url)) return escapeHtml(url);
      return "#";
    };
    let html = escapeHtml(content).replace(/\[\[([^\]]+?)\]\]/g, (_raw, inner) => {
      const normalized = inner.replace(/\\\|/g, "|");
      const pipe = normalized.indexOf("|");
      let target = (pipe >= 0 ? normalized.slice(0, pipe) : normalized).trim();
      const alias = pipe >= 0 ? normalized.slice(pipe + 1).trim() : "";
      target = target.split("#")[0].split("^")[0].trim().replace(/\\/g, "/").replace(/\/+$/g, "");
      const label = alias || target;
      return `<span class="wiki-link" data-target="${escapeHtml(target)}">${escapeHtml(label)}</span>`;
    });
    html = html.replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code class="language-$1">$2</code></pre>').replace(/`([^`]+)`/g, "<code>$1</code>").replace(/^###### (.+)$/gm, "<h6>$1</h6>").replace(/^##### (.+)$/gm, "<h5>$1</h5>").replace(/^#### (.+)$/gm, "<h4>$1</h4>").replace(/^### (.+)$/gm, "<h3>$1</h3>").replace(/^## (.+)$/gm, "<h2>$1</h2>").replace(/^# (.+)$/gm, "<h1>$1</h1>").replace(/\*\*\*(.+?)\*\*\*/g, "<strong><em>$1</em></strong>").replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/\*(.+?)\*/g, "<em>$1</em>").replace(/__(.+?)__/g, "<strong>$1</strong>").replace(/_(.+?)_/g, "<em>$1</em>").replace(
      /!\[(.+?)\]\((.+?)\)/g,
      (_raw, alt, url) => `<img src="${safeUrl(url)}" alt="${alt}" />`
    ).replace(
      /\[(.+?)\]\((.+?)\)/g,
      (_raw, label, url) => `<a href="${safeUrl(url)}" target="_blank" rel="noopener noreferrer">${label}</a>`
    ).replace(/^> (.+)$/gm, "<blockquote>$1</blockquote>").replace(/^---+$/gm, "<hr />").replace(/^[*-] (.+)$/gm, "<li>$1</li>").replace(/(<li>.*<\/li>\n?)+/g, "<ul>$&</ul>").replace(/^\d+\. (.+)$/gm, "<li>$1</li>").replace(/\n\n([^<\n].*)/g, "\n\n<p>$1</p>").replace(/~~(.+?)~~/g, "<del>$1</del>");
    return html;
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
