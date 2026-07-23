# Feature Audit Report

**Date:** 2026-07-22T12:44:38.108Z
**PASS:** 70 · **FAIL:** 0 · **MANUAL:** 9

| ID | Feature | Status | Detail |
|----|---------|--------|--------|
| 0.1 | package.json scripts (dev/typecheck/qa) | **PASS** |  |
| 0.2 | Blueprint constitution present | **PASS** |  |
| 0.3 | electron-vite config + better-sqlite3 external | **PASS** |  |
| 0.4 | SDK packages load (sqlite/gemini/openai/claude) | **PASS** |  |
| 1.1 | Open workspace (scan + config) | **PASS** |  |
| 1.2 | Create workspace + standard folders | **PASS** |  |
| 1.3 | Seed templates on create | **PASS** |  |
| 1.4 | Recent workspaces | **PASS** |  |
| 1.5 | IPC workspace open/create/close | **PASS** |  |
| 1.6 | Welcome UI open + create vault | **PASS** |  |
| 1.7 | UI: open/create vault in running app | **MANUAL** | npm run dev → Open/Create vault |
| 2.1 | Parse frontmatter title | **PASS** | Audit Note |
| 2.2 | Extract wikilinks | **PASS** | 2 |
| 2.3 | Merge tags fm+inline | **PASS** |  |
| 2.4 | Extract headings | **PASS** |  |
| 2.5 | Stable id (sha length) | **PASS** |  |
| 2.6 | Render wiki-link HTML | **PASS** |  |
| 2.7 | Note template frontmatter | **PASS** |  |
| 2.8 | Daily template | **PASS** |  |
| 2.9 | Editor live preview + autosave (UI) | **MANUAL** | Open note, type, split preview |
| 3.1 | Build nodes | **PASS** | 3 |
| 3.2 | Wiki edges A↔B | **PASS** |  |
| 3.3 | Backlinks of B include A | **PASS** |  |
| 3.4 | Outgoing from A include B | **PASS** |  |
| 3.5 | Orphan detection (C) | **PASS** |  |
| 3.6 | resolveTitleToPath | **PASS** |  |
| 3.7 | IPC graph:getBacklinks + resolveLink | **PASS** |  |
| 3.8 | GraphCanvas fluid UI present | **PASS** |  |
| 3.9 | UI: open Graph View, drag/zoom | **MANUAL** | Graph View in app |
| 4.1 | Empty query → recent | **PASS** |  |
| 4.2 | Fuzzy find Alpha | **PASS** |  |
| 4.3 | Tag operator #core | **PASS** |  |
| 4.4 | orphan:true | **PASS** |  |
| 4.5 | path: operator | **PASS** |  |
| 4.5b | path:Alpha results | **PASS** | 1 |
| 4.6 | backlink:Beta finds Alpha | **PASS** |  |
| 4.7 | getAllTags | **PASS** |  |
| 4.8 | IPC search:query + recent + rebuild | **PASS** |  |
| 4.9 | UI: Ctrl+K search | **MANUAL** | Search modal in app |
| 5.1 | FTS5 insert+match | **PASS** |  |
| 5.2 | IndexDatabase index.db path | **PASS** |  |
| 5.3 | IPC rebuild + stats | **PASS** |  |
| 5.4 | Settings Search Index UI | **PASS** |  |
| 6.1 | Tabs open/save/preview refresh | **PASS** |  |
| 6.2 | Backlinks panel + outline | **PASS** |  |
| 6.3 | Wikilink click in preview | **PASS** |  |
| 6.4 | File tree context menu | **PASS** |  |
| 6.5 | Hotkeys Ctrl+K/N/B/J | **PASS** |  |
| 6.6 | Material Icons (Google) system | **PASS** |  |
| 6.7 | UI: edit note, backlinks, hotkeys | **MANUAL** | Editor + inspector in app |
| 7.1 | Builtin project/task/people templates | **PASS** |  |
| 7.2 | Variable render {{title}} | **PASS** |  |
| 7.3 | Template var substitution runtime | **PASS** |  |
| 7.4 | IPC template:list/createNote | **PASS** |  |
| 7.5 | Template picker UI | **PASS** |  |
| 7.6 | Domain overview projects/tasks/people | **PASS** |  |
| 7.7 | Checkbox parse open/done | **PASS** |  |
| 7.8 | Dashboard domain widgets | **PASS** |  |
| 7.9 | UI: From template create Project | **MANUAL** | Dashboard → From template |
| 8.1 | 6 providers registered | **PASS** |  |
| 8.2 | Models listed even without key | **PASS** |  |
| 8.3 | Stream refuses unconfigured | **PASS** |  |
| 8.4 | testProvider for Settings Test | **PASS** |  |
| 8.5 | Stream error → done + error field | **PASS** |  |
| 8.6 | Context engine + token budget | **PASS** |  |
| 8.7 | Agent tools search/read/write proposals | **PASS** |  |
| 8.8 | Chat error display | **PASS** |  |
| 8.9 | Permissions gate aiAccess | **PASS** |  |
| 8.10 | LIVE: Save key + Test + chat reply | **MANUAL** | Settings → Save → Test → Chat "halo" |
| 8.11 | LIVE: Tools proposal Apply | **MANUAL** | Tools on → minta buat note → Apply |
| 9.1 | Path sandbox | **PASS** |  |
| 9.2 | Path sandbox runtime relative | **PASS** |  |
| 9.3 | Secrets encrypt (safeStorage) | **PASS** |  |
| 9.4 | Permissions flags | **PASS** |  |
| 9.5 | AutomationEngine | **PASS** |  |
| 9.6 | PluginHost declarative | **PASS** |  |
| 9.7 | InternalAPI health | **PASS** |  |
| 9.8 | Settings Security/Automation/Plugins UI | **PASS** |  |
| 9.9 | UI: toggle automation rule | **MANUAL** | Settings → Automation |
| 10.1 | Ollama running (optional) | **SKIP** | not running — OK if unused |

## Manual steps

```bash
cd C:\code\WorkspaceGraph
npm run dev
```

1. Open/create vault
2. Settings → AI → Save key → Test
3. Chat "halo"
4. Graph View drag/zoom
5. Ctrl+K search
6. From template → Project
7. Tools on → create note proposal → Apply
