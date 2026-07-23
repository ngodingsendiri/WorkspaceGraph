# 04_System_Architecture.md

# WorkspaceGraph System Architecture

Version: 0.1 (Draft)

------------------------------------------------------------------------

# Purpose

Dokumen ini menjelaskan arsitektur tingkat tinggi WorkspaceGraph.
Dokumen ini tidak membahas implementasi kode, tetapi menjelaskan
bagaimana setiap komponen saling berhubungan.

------------------------------------------------------------------------

# High-Level Architecture

``` text
+------------------------------------------------+
|                 WorkspaceGraph                 |
+------------------------------------------------+
| UI Layer                                       |
| Sidebar • Editor • Graph • Chat • Search       |
+------------------------------------------------+
| Application Layer                              |
| Workspace | Project | Task | Template | Plugin |
+------------------------------------------------+
| AI Middleware                                  |
| Context Builder | Prompt Builder | Validator   |
+------------------------------------------------+
| Core Engine                                    |
| Markdown | Graph | Search | Index | File Watch |
+------------------------------------------------+
| Storage Layer                                  |
| Markdown Files | Cache DB | Assets             |
+------------------------------------------------+
| AI Engine                                      |
| Gemini CLI (Default)                           |
+------------------------------------------------+
```

------------------------------------------------------------------------

# Component Overview

## UI Layer

Berfungsi sebagai antarmuka pengguna.

Tanggung jawab: - Menampilkan editor Markdown. - Menampilkan Graph. -
Menampilkan AI Chat. - Menampilkan Dashboard. - Menampilkan Search.

UI tidak boleh menyimpan logika bisnis.

------------------------------------------------------------------------

## Application Layer

Mengelola fitur utama:

-   Workspace
-   Projects
-   Tasks
-   Templates
-   Daily Notes
-   Rules
-   Settings
-   Plugin Manager

Layer ini berkomunikasi dengan Core Engine dan AI Middleware.

------------------------------------------------------------------------

## AI Middleware

Merupakan jembatan antara Workspace dan AI.

AI tidak pernah mengakses file secara langsung.

Semua akses dilakukan melalui middleware.

Tanggung jawab:

-   Workspace Scan
-   Context Builder
-   Prompt Builder
-   AI Response Validation
-   Markdown Writer
-   Graph Update Trigger

------------------------------------------------------------------------

## Core Engine

Berisi mesin utama aplikasi.

### Markdown Engine

-   Membaca file
-   Menulis file
-   Metadata
-   Frontmatter
-   Link parser

### Graph Engine

-   Node
-   Edge
-   Cluster
-   Relationship

### Search Engine

-   Full text search
-   Tag search
-   Metadata search
-   Backlink search

### File Watcher

Mendeteksi perubahan file secara real-time.

------------------------------------------------------------------------

## Storage Layer

Storage terdiri dari:

### Markdown Vault

Source of Truth.

### Cache Database

Digunakan untuk: - indeks - cache - performa

Bukan penyimpanan utama.

### Assets

Folder untuk gambar, PDF, lampiran, dan media lainnya.

------------------------------------------------------------------------

## AI Engine

Versi pertama menggunakan Gemini CLI.

Namun AI Engine harus dapat diganti tanpa mengubah Workspace.

Contoh:

-   Gemini CLI
-   Claude CLI
-   OpenAI API
-   Ollama
-   LM Studio
-   OpenRouter

------------------------------------------------------------------------

# Data Flow

Saat pengguna meminta AI mengerjakan sesuatu:

1.  User mengirim permintaan.
2.  Middleware melakukan Workspace Scan.
3.  Middleware membaca Markdown relevan.
4.  Middleware membangun konteks.
5.  Prompt dikirim ke AI Engine.
6.  Respons divalidasi.
7.  Hasil ditulis ke Markdown jika diperlukan.
8.  Graph diperbarui.
9.  UI diperbarui.

------------------------------------------------------------------------

# Design Principles

-   Modular
-   Replaceable AI Engine
-   Markdown First
-   Graph Native
-   Offline First
-   Plugin Ready
-   Maintainable
-   Testable

------------------------------------------------------------------------

# Future Expansion

Arsitektur harus memungkinkan penambahan:

-   Multi AI
-   Multi Workspace
-   Cloud Sync
-   Collaboration
-   Voice Assistant
-   Automation
-   MCP Integration
-   Background AI Agents

Tanpa mengubah fondasi sistem.

------------------------------------------------------------------------

# Closing

Seluruh arsitektur WorkspaceGraph dirancang agar AI menjadi komponen
yang dapat diganti, sementara Workspace Markdown tetap menjadi pusat
dari seluruh ekosistem.
