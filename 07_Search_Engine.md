# 07_Search_Engine.md

# WorkspaceGraph Search Engine

Version: 0.1 (Draft)

------------------------------------------------------------------------

# Purpose

Search Engine memungkinkan pengguna dan AI menemukan informasi secara
cepat, akurat, dan kontekstual di seluruh Workspace.

Search bukan sekadar pencarian teks, tetapi mesin pencarian pengetahuan.

------------------------------------------------------------------------

# Objectives

Search Engine harus mampu:

-   Menemukan informasi dalam hitungan milidetik.
-   Mendukung Workspace berisi ribuan hingga puluhan ribu catatan.
-   Menjadi sumber pencarian utama bagi AI Middleware.
-   Mengembalikan hasil yang relevan beserta konteksnya.

------------------------------------------------------------------------

# Search Sources

Search Engine harus mengindeks:

-   Markdown
-   Frontmatter
-   Wiki Link
-   Backlink
-   Tags
-   Folder
-   File Name
-   Heading
-   Tasks
-   Template
-   Daily Notes
-   Projects
-   People
-   Documents

------------------------------------------------------------------------

# Search Types

## Full Text Search

Mencari isi dokumen.

## File Search

Mencari berdasarkan nama file.

## Tag Search

Mencari berdasarkan tag.

## Metadata Search

Mencari berdasarkan Frontmatter.

## Link Search

Mencari hubungan antar dokumen.

## Backlink Search

Menampilkan seluruh dokumen yang mengarah ke dokumen tertentu.

## Recent Search

Menampilkan dokumen yang baru diubah atau dibuka.

------------------------------------------------------------------------

# AI Search

Ketika AI membutuhkan konteks:

1.  AI Middleware mengirim query.
2.  Search Engine mencari dokumen relevan.
3.  Search Engine memberi skor relevansi.
4.  Dokumen terbaik dikirim ke Context Engine.

AI tidak melakukan pencarian langsung ke filesystem.

------------------------------------------------------------------------

# Ranking Strategy

Urutan relevansi mempertimbangkan:

-   Kecocokan judul
-   Kecocokan isi
-   Tag
-   Metadata
-   Jumlah backlink
-   Kedekatan graph
-   Status proyek
-   Waktu pembaruan
-   Preferensi pengguna (masa depan)

------------------------------------------------------------------------

# Incremental Indexing

Engine harus:

-   Mengindeks saat startup.
-   Memperbarui indeks ketika file berubah.
-   Tidak membangun ulang seluruh indeks jika hanya satu file berubah.

------------------------------------------------------------------------

# Performance Goals

Target:

-   Startup indexing efisien.
-   Pencarian instan pada Workspace besar.
-   Konsumsi memori terkendali.
-   Mendukung background indexing.

------------------------------------------------------------------------

# API Responsibilities

Search Engine menyediakan layanan untuk:

-   Workspace Engine
-   Graph Engine
-   AI Middleware
-   Dashboard
-   Plugin
-   UI Search Bar

------------------------------------------------------------------------

# Error Handling

Harus menangani:

-   File rusak
-   Metadata tidak valid
-   Link putus
-   File dihapus saat proses indeks
-   Workspace sangat besar

Tanpa menghentikan proses pencarian.

------------------------------------------------------------------------

# Decision Record

Keputusan:

-   Search menggunakan indeks, bukan membaca file setiap kali pencarian.
-   Markdown tetap Source of Truth.
-   Indeks dapat dibangun ulang kapan saja dari Workspace.

------------------------------------------------------------------------

# Future Considerations

Versi berikutnya dapat menambahkan:

-   Semantic Search
-   Vector Search
-   Embedding lokal
-   AI-assisted ranking
-   Similar Notes
-   Duplicate Detection
-   Natural Language Search

------------------------------------------------------------------------

# Acceptance Criteria

Search Engine dianggap selesai apabila:

-   Seluruh Markdown dapat dicari.
-   Metadata dapat dicari.
-   Backlink dapat dicari.
-   AI memperoleh dokumen relevan.
-   Indeks diperbarui otomatis.
-   Performa tetap baik pada Workspace besar.

------------------------------------------------------------------------

# Closing

Search Engine bukan hanya fitur pencarian.

Search Engine adalah mekanisme utama yang menghubungkan pengguna dan AI
dengan seluruh pengetahuan yang tersimpan di dalam Workspace.
