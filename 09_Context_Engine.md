# 09_Context_Engine.md

# WorkspaceGraph Context Engine

Version: 0.1 (Draft)

------------------------------------------------------------------------

# Purpose

Context Engine bertanggung jawab membangun konteks yang tepat sebelum AI
dipanggil.

AI tidak boleh membaca seluruh Workspace secara langsung. Context Engine
memilih hanya informasi yang paling relevan sehingga AI tetap cepat,
akurat, dan hemat token.

------------------------------------------------------------------------

# Objectives

-   Mengurangi penggunaan token.
-   Menghindari informasi yang tidak relevan.
-   Menyediakan konteks yang konsisten.
-   Menjadi satu-satunya penyedia konteks bagi AI Middleware.

------------------------------------------------------------------------

# Context Sources

Context dapat dibangun dari:

-   Current Document
-   Linked Notes
-   Backlinks
-   Related Projects
-   Related Tasks
-   Daily Notes
-   Search Results
-   Graph Relationships
-   Frontmatter
-   User Selection

------------------------------------------------------------------------

# Context Pipeline

1.  User melakukan aksi.
2.  AI Middleware mengirim permintaan.
3.  Search Engine mencari dokumen relevan.
4.  Graph Engine mencari hubungan.
5.  Markdown Engine membaca isi.
6.  Context Engine menyusun paket konteks.
7.  AI menerima konteks.

------------------------------------------------------------------------

# Context Package

Minimal berisi:

-   Primary Document
-   Related Documents
-   Metadata
-   Backlinks
-   Outbound Links
-   Project Information
-   Relevant Tasks
-   Workspace Rules
-   Token Estimate

------------------------------------------------------------------------

# Prioritization

Urutan prioritas:

1.  Dokumen aktif
2.  Dokumen yang dipilih pengguna
3.  Wiki Link langsung
4.  Backlink
5.  Hasil Search
6.  Hubungan Graph
7.  Dokumen pendukung lainnya

------------------------------------------------------------------------

# Context Limits

Engine harus mampu:

-   Membatasi jumlah dokumen.
-   Membatasi ukuran token.
-   Menghapus duplikasi.
-   Mengurutkan berdasarkan relevansi.

------------------------------------------------------------------------

# AI Safety

Context Engine harus:

-   Tidak mengirim seluruh Workspace tanpa alasan.
-   Tidak mengirim file yang tidak relevan.
-   Menjaga struktur Markdown tetap utuh.

------------------------------------------------------------------------

# Decision Record

-   AI selalu bekerja menggunakan Context Package.
-   Workspace adalah sumber data.
-   Context bersifat sementara dan dibangun ulang setiap permintaan.

------------------------------------------------------------------------

# Future Considerations

Versi berikutnya dapat mendukung:

-   Semantic Context
-   Long-term Memory
-   Personal Preferences
-   Conversation Memory
-   Multi-Workspace Context
-   Hybrid Vector Retrieval

------------------------------------------------------------------------

# Acceptance Criteria

-   AI menerima Context Package yang konsisten.
-   Token digunakan secara efisien.
-   Dokumen relevan selalu diprioritaskan.
-   Context dapat dibangun ulang kapan saja.

------------------------------------------------------------------------

# Closing

Context Engine adalah jembatan antara Workspace dan AI.

Kualitas jawaban AI sangat bergantung pada kualitas Context Package yang
dibangun oleh modul ini.
