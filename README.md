<div align="center">

# WorkspaceGraph

**A local-first knowledge graph & AI workspace — built like Obsidian, powered by semantic RAG.**

[Download](#installation) · [Features](#features) · [AI Setup](#ai-setup) · [Development](#development)

</div>

---

## What is this?

WorkspaceGraph is an **Electron desktop application** that turns a folder of Markdown files into a living knowledge graph. Think Obsidian — but with a built-in AI assistant that uses your own notes as context through a full Retrieval-Augmented Generation (RAG) pipeline, entirely on your machine.

Your data never leaves your computer. The AI reads your vault, not the cloud.

---

## Features

### 📝 Markdown-native editor
- Live preview with split source/rendered modes
- Frontmatter support (YAML)
- WikiLink `[[Note Title]]` creation & navigation

### 🕸️ Knowledge Graph
- Interactive force-directed graph of your notes
- WikiLink edges + tag edges
- Local graph (neighbors of a single note)
- Ghost nodes for unresolved links
- Filter by type, tag, degree

### 🤖 AI Assistant (Multi-provider)
- Chat with your vault — AI gets relevant context automatically
- Supports: **Gemini, Claude, OpenAI, Ollama (local), OpenRouter**
- Agent roles: General, Writer, Researcher, Curator, Planner
- Tool use: AI can read and propose edits to your notes

### 🔍 Hybrid Search (FTS + Semantic)
- SQLite FTS5 full-text search (keyword)
- **Local vector embeddings** via `all-MiniLM-L6-v2` (semantic similarity)
  - Runs 100% offline after first model download (~25MB)
  - Vectors persisted to SQLite — no re-indexing on restart
  - Status badge shows indexing progress in real time

### 🔗 WikiLink Auto-Update
- Renaming a file automatically updates `[[links]]` across the entire vault
- Toast notification shows how many links were updated

### 🧠 AI Memory (Self-Feeding RAG)
- AI maintains its own index/sop/log notes in `AI Memory/`
- Memory grows over time, making the AI smarter about your specific vault

---

## Installation

### Prerequisites
- [Node.js](https://nodejs.org/) v18+
- [Git](https://git-scm.com/)

### Build from source

```bash
git clone https://github.com/your-username/WorkspaceGraph.git
cd WorkspaceGraph
npm install
npm run dev          # development mode
npm run build        # production build
```

---

## AI Setup

Go to **Settings → AI Providers** and configure at least one provider:

| Provider | What you need |
|----------|--------------|
| **Gemini** | Google AI API key from [ai.google.dev](https://ai.google.dev) |
| **Claude** | Anthropic API key from [console.anthropic.com](https://console.anthropic.com) |
| **OpenAI** | OpenAI API key from [platform.openai.com](https://platform.openai.com) |
| **Ollama** | [Ollama](https://ollama.com) running locally (free, fully offline) |
| **OpenRouter** | OpenRouter API key — access 100+ models |

### Recommended free setup
1. Install [Ollama](https://ollama.com) → `ollama pull llama3.2`
2. In WorkspaceGraph: Settings → AI Providers → Ollama → Save
3. The semantic embedding model downloads automatically on first vault open

---

## How the RAG pipeline works

```
User query
    │
    ├─► Active note (highest priority)
    ├─► WikiLink neighbors (graph traversal)
    ├─► Backlinks
    ├─► AI Memory notes (long-term workspace knowledge)
    ├─► Semantic search (vector similarity — all-MiniLM-L6-v2)
    └─► FTS keyword search (SQLite FTS5)
            │
            ▼
    Context package → AI provider → Streaming response
```

---

## Vault Structure

WorkspaceGraph works with **any folder of Markdown files**. There are no required folders.

Optionally, create these for best AI experience:
```
Your Vault/
├── AI Memory/          ← AI writes here; RAG reads here first
│   ├── 00 Index.md
│   ├── 01 SOP.md
│   └── 02 Log.md
├── .workspacegraph/    ← auto-created (config + SQLite DB)
│   ├── workspace.json
│   └── index.db
└── ... your notes ...
```

---

## Development

```bash
npm run dev          # Electron dev server with HMR
npm run typecheck    # TypeScript check (node + web)
npm run lint         # ESLint
npm run build        # Production build
```

### Architecture

| Layer | Technology |
|-------|-----------|
| App shell | Electron (main process) |
| UI | React + Zustand + Vite |
| Graph engine | Custom WikiLink parser + force-layout |
| Search | SQLite FTS5 + Fuse.js |
| Semantic RAG | `@xenova/transformers` (ONNX / WebAssembly) |
| AI providers | Gemini / Claude / OpenAI / Ollama / OpenRouter |
| File watching | chokidar |

---

## License

MIT — do whatever you want, attribution appreciated.
