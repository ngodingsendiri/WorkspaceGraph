# 20_AI_Agents.md

# WorkspaceGraph AI Agents

Version: 0.1 (Draft)

------------------------------------------------------------------------

# Purpose

AI Agents mendefinisikan kumpulan agen cerdas yang memiliki peran,
tanggung jawab, dan batasan yang jelas di dalam WorkspaceGraph.

Agent bukan sekadar model AI, melainkan pekerja digital yang menggunakan
Workspace sebagai sumber pengetahuan.

------------------------------------------------------------------------

# Objectives

-   Memecah pekerjaan kompleks menjadi agen khusus.
-   Mengurangi prompt yang terlalu besar.
-   Meningkatkan konsistensi hasil.
-   Memungkinkan orkestrasi banyak agen.

------------------------------------------------------------------------

# Core Principles

-   Setiap Agent memiliki satu tanggung jawab utama.
-   Agent selalu menggunakan Context Engine.
-   Agent tidak mengakses filesystem secara langsung.
-   Agent harus mematuhi Constitution.

------------------------------------------------------------------------

# Agent Lifecycle

1.  Receive Request
2.  Request Context
3.  Plan
4.  Execute
5.  Validate
6.  Return Result
7.  Write Back (bila disetujui)

------------------------------------------------------------------------

# Built-in Agents

## Writing Agent

-   Menulis dokumen
-   Merevisi Markdown
-   Menyesuaikan gaya bahasa

## Research Agent

-   Mengumpulkan informasi
-   Menyusun ringkasan
-   Membuat referensi

## Knowledge Curator

-   Menghubungkan catatan
-   Menemukan duplikasi
-   Menyarankan backlink

## Project Manager Agent

-   Memecah proyek
-   Membuat milestone
-   Meninjau progres

## Task Planner

-   Membuat task
-   Menentukan prioritas
-   Mengelompokkan pekerjaan

## Document Analyst

-   Menganalisis PDF, DOCX, gambar, dan dokumen lain
-   Mengekstrak informasi penting

------------------------------------------------------------------------

# Agent Capabilities

Setiap Agent mendeklarasikan:

-   Name
-   Purpose
-   Allowed Tools
-   Required Context
-   Output Format
-   Permission Level

------------------------------------------------------------------------

# Orchestration

AI Middleware dapat menjalankan:

-   Single Agent
-   Sequential Agents
-   Parallel Agents

Contoh:

Research Agent ↓ Knowledge Curator ↓ Writing Agent

------------------------------------------------------------------------

# Permissions

Agent hanya dapat:

-   Membaca konteks yang diberikan.
-   Menggunakan tool yang diizinkan.
-   Menulis kembali jika mendapat persetujuan pengguna.

------------------------------------------------------------------------

# Communication

Agent saling bertukar data melalui struktur yang terdefinisi.

Tidak ada komunikasi langsung antar-agent tanpa koordinasi AI
Middleware.

------------------------------------------------------------------------

# Failure Handling

Jika Agent gagal:

-   Retry bila memungkinkan.
-   Gunakan Agent alternatif.
-   Kembalikan laporan kesalahan yang jelas.

------------------------------------------------------------------------

# Decision Record

-   Agent adalah pekerja spesialis.
-   AI Middleware bertindak sebagai koordinator.
-   Workspace tetap menjadi sumber kebenaran.

------------------------------------------------------------------------

# Future Considerations

-   Multi-Agent Collaboration
-   Agent Marketplace
-   User-defined Agents
-   Learning Agents
-   Autonomous Review
-   Long-running Agents

------------------------------------------------------------------------

# Acceptance Criteria

-   Agent memiliki kontrak yang jelas.
-   Agent dapat dijalankan secara individual maupun berantai.
-   Permission diterapkan.
-   Hasil konsisten dan dapat diaudit.

------------------------------------------------------------------------

# Closing

AI Agents adalah lapisan eksekusi cerdas WorkspaceGraph.

Dengan membagi tanggung jawab ke dalam agen-agen spesialis, sistem
menjadi lebih modular, mudah dikembangkan, dan mampu menangani alur
kerja kompleks tanpa kehilangan konsistensi.
