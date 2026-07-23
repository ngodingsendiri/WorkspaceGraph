# 17_Document_System.md

# WorkspaceGraph Document System

Version: 0.1 (Draft)

------------------------------------------------------------------------

# Purpose

Document System mengelola seluruh dokumen non-Markdown yang menjadi
bagian dari Workspace, seperti PDF, DOCX, spreadsheet, presentasi,
gambar, dan media lainnya.

Markdown tetap menjadi sumber pengetahuan utama, sedangkan Document
System memastikan aset pendukung tetap terorganisasi dan mudah
ditemukan.

------------------------------------------------------------------------

# Objectives

-   Mengelola aset dokumen secara terpusat.
-   Menghubungkan dokumen dengan Knowledge, Project, Task, dan People.
-   Menyediakan metadata untuk Search, Graph, dan AI.
-   Menjaga struktur Workspace tetap rapi.

------------------------------------------------------------------------

# Supported Document Types

WorkspaceGraph mendukung pengelolaan:

-   PDF
-   DOCX
-   XLSX
-   PPTX
-   Images (PNG, JPG, SVG, WebP)
-   Audio
-   Video
-   ZIP
-   Source Code
-   File lain melalui Plugin.

------------------------------------------------------------------------

# Document Metadata

Setiap dokumen minimal memiliki:

-   Document ID
-   Title
-   File Path
-   MIME Type
-   Size
-   Created
-   Updated
-   Tags
-   Related Notes

Metadata disimpan tanpa mengubah isi file asli.

------------------------------------------------------------------------

# Relationships

Dokumen dapat terhubung dengan:

-   Knowledge
-   Project
-   Task
-   Daily Note
-   People
-   Template
-   Document lainnya

Relasi menggunakan Wiki Link atau referensi metadata.

------------------------------------------------------------------------

# Preview

WorkspaceGraph sebaiknya mendukung:

-   Thumbnail gambar
-   Preview PDF
-   Preview Markdown Attachment
-   Metadata Preview
-   Plugin Preview untuk format lain

------------------------------------------------------------------------

# Search Integration

Search Engine harus dapat mencari:

-   Nama file
-   Metadata
-   Tag
-   Dokumen terkait
-   (Opsional) Isi dokumen melalui plugin OCR atau parser.

------------------------------------------------------------------------

# AI Integration

AI dapat:

-   Membaca dokumen melalui parser yang didukung.
-   Membuat ringkasan.
-   Mengekstrak informasi penting.
-   Menghubungkan dokumen dengan Knowledge.
-   Menyarankan klasifikasi dokumen.

AI tidak mengubah file asli tanpa persetujuan pengguna.

------------------------------------------------------------------------

# Storage Principles

-   File asli tidak dimodifikasi.
-   Metadata dapat dibangun ulang.
-   Struktur folder tetap dihormati.
-   Mendukung file lokal dan penyimpanan eksternal di masa depan.

------------------------------------------------------------------------

# Decision Record

-   Markdown adalah Source of Truth untuk knowledge.
-   Dokumen adalah aset pendukung.
-   Metadata lebih diutamakan daripada database khusus.

------------------------------------------------------------------------

# Future Considerations

-   OCR
-   Full-text indexing
-   Version History
-   Cloud Storage
-   Duplicate Detection
-   Digital Asset Management
-   AI Document Classification

------------------------------------------------------------------------

# Acceptance Criteria

-   Dokumen dapat ditambahkan.
-   Metadata dibuat otomatis.
-   Dokumen dapat dihubungkan ke entitas lain.
-   Search menemukan dokumen dengan cepat.
-   AI dapat menggunakan dokumen yang didukung sebagai konteks.

------------------------------------------------------------------------

# Closing

Document System menjadikan WorkspaceGraph mampu mengelola pengetahuan
sekaligus seluruh aset pendukungnya dalam satu Workspace yang konsisten,
terbuka, dan mudah dikembangkan.
