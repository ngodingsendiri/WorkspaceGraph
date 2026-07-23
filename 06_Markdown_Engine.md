# 06_Markdown_Engine.md

# WorkspaceGraph Markdown Engine

Version: 0.1 (Draft)

------------------------------------------------------------------------

# Purpose

Markdown Engine adalah komponen yang bertanggung jawab membaca, menulis,
memvalidasi, dan mengelola seluruh dokumen Markdown di dalam Workspace.

Markdown adalah Source of Truth. Oleh karena itu seluruh modul harus
menggunakan Markdown Engine untuk berinteraksi dengan file.

------------------------------------------------------------------------

# Responsibilities

Markdown Engine bertanggung jawab untuk:

-   Membaca file Markdown.
-   Menulis perubahan secara aman.
-   Memahami Frontmatter.
-   Memahami Wiki Link.
-   Mengelola Backlink.
-   Mengelola Attachment.
-   Memberikan data kepada Search, Graph, dan AI.

------------------------------------------------------------------------

# Design Principles

## 1. Markdown First

Seluruh informasi utama disimpan sebagai Markdown.

## 2. Human Readable

Semua file harus tetap mudah dibaca menggunakan editor Markdown biasa.

## 3. Git Friendly

Perubahan file harus menghasilkan diff yang bersih dan mudah ditinjau.

## 4. Non Destructive

Markdown Engine tidak boleh menghapus atau mengubah isi file tanpa
instruksi yang jelas.

------------------------------------------------------------------------

# Supported Markdown Features

Engine harus mendukung:

-   Heading
-   Paragraph
-   List
-   Table
-   Blockquote
-   Code Block
-   Task List
-   Footnote
-   Horizontal Rule
-   Image
-   Link
-   Wiki Link
-   Frontmatter YAML

------------------------------------------------------------------------

# Frontmatter Specification

Contoh standar:

``` yaml
---
id: project-alpha
title: Project Alpha
type: project
status: active
tags:
  - desktop
  - ai
created:
updated:
---
```

Field tambahan diperbolehkan.

------------------------------------------------------------------------

# Wiki Link

Engine harus mengenali:

``` text
[[Knowledge]]
[[Project Alpha]]
[[People/John]]
[[Meeting#Agenda]]
```

Semua link harus dapat di-resolve.

------------------------------------------------------------------------

# Backlink Engine

Setiap Wiki Link otomatis menghasilkan backlink.

Backlink harus tersedia untuk:

-   Graph Engine
-   Search Engine
-   AI Middleware

------------------------------------------------------------------------

# File Watch Integration

Jika file berubah dari editor lain:

-   perubahan dideteksi,
-   indeks diperbarui,
-   graph diperbarui,
-   context diperbarui.

Restart aplikasi tidak diperlukan.

------------------------------------------------------------------------

# AI Integration

AI tidak membaca file secara langsung.

AI meminta dokumen melalui Markdown Engine.

Markdown Engine mengembalikan:

-   isi
-   metadata
-   backlink
-   outbound link
-   attachment
-   status

------------------------------------------------------------------------

# Writing Rules

Saat AI menulis:

1.  Pertahankan format Markdown.
2.  Pertahankan Frontmatter.
3.  Jangan menghapus metadata tanpa alasan.
4.  Pertahankan komentar pengguna.
5.  Tambahkan backlink bila diperlukan.

------------------------------------------------------------------------

# Error Handling

Engine harus mampu menangani:

-   Frontmatter rusak
-   Wiki Link rusak
-   File kosong
-   Encoding UTF-8
-   Konflik perubahan file

Tanpa merusak isi dokumen.

------------------------------------------------------------------------

# Acceptance Criteria

Markdown Engine dianggap selesai apabila mampu:

-   Membaca seluruh Markdown.
-   Menulis perubahan dengan aman.
-   Memahami Frontmatter.
-   Mengelola Wiki Link.
-   Menghasilkan Backlink.
-   Memberikan data ke AI, Search, dan Graph.
-   Menangani perubahan file secara real-time.

------------------------------------------------------------------------

# Closing

Markdown Engine adalah fondasi data WorkspaceGraph.

Seluruh modul harus memperlakukan Markdown sebagai sumber kebenaran
utama sehingga Workspace tetap terbuka, portabel, dan bertahan dalam
jangka panjang.
