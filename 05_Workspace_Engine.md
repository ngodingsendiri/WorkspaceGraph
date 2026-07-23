# 05_Workspace_Engine.md

# WorkspaceGraph Workspace Engine

Version: 0.1 (Draft)

------------------------------------------------------------------------

# Purpose

Workspace Engine adalah jantung WorkspaceGraph.

Seluruh fitur harus bekerja melalui Workspace Engine. Tidak ada komponen
yang boleh mengakses Vault secara langsung tanpa melalui engine ini.

------------------------------------------------------------------------

# Objective

Workspace Engine bertanggung jawab untuk:

-   Mengelola Workspace (Vault).
-   Mengelola struktur folder.
-   Memantau perubahan file.
-   Menyediakan konteks bagi AI.
-   Menjadi penghubung antara Markdown Engine, Graph Engine, Search
    Engine, dan AI Middleware.

------------------------------------------------------------------------

# Core Responsibilities

## 1. Workspace Management

Workspace Engine harus mampu:

-   Membuat Workspace baru.
-   Membuka Workspace.
-   Menutup Workspace.
-   Berpindah Workspace.
-   Memvalidasi struktur Workspace.

------------------------------------------------------------------------

## 2. Standard Workspace Structure

Contoh struktur awal:

``` text
Workspace/

Knowledge/
Projects/
Tasks/
Templates/
Daily/
Journal/
People/
Rules/
Prompt/
SOP/
Documents/
Assets/
Archive/

.workspacegraph/
```

Folder dapat ditambah oleh pengguna, tetapi struktur standar harus
tersedia.

------------------------------------------------------------------------

## 3. Workspace Manifest

Setiap Workspace memiliki berkas konfigurasi sendiri.

Contoh:

``` text
.workspacegraph/

workspace.json
settings.json
plugins.json
index.db
cache/
logs/
```

Konfigurasi Workspace dipisahkan dari data pengguna.

------------------------------------------------------------------------

## 4. Workspace Scan

Saat Workspace dibuka, engine harus:

1.  Memindai seluruh folder.
2.  Mengidentifikasi file Markdown.
3.  Membaca metadata.
4.  Membuat indeks.
5.  Mengirim informasi ke Graph Engine.
6.  Mengirim informasi ke Search Engine.

------------------------------------------------------------------------

## 5. Workspace Watcher

Workspace Engine harus memantau perubahan secara real-time.

Perubahan yang harus terdeteksi:

-   File dibuat.
-   File dihapus.
-   File dipindahkan.
-   File diubah.
-   Folder baru.
-   Folder dihapus.

Seluruh perubahan harus memicu pembaruan indeks yang diperlukan.

------------------------------------------------------------------------

## 6. Workspace Index

Workspace Engine menyimpan indeks sementara untuk mempercepat:

-   Search
-   Graph
-   AI Context
-   Metadata Query

Indeks dapat dibangun ulang kapan saja dari Markdown.

------------------------------------------------------------------------

## 7. Context Provider

Workspace Engine menjadi penyedia konteks utama.

Ketika AI membutuhkan informasi:

AI tidak membaca Vault secara langsung.

AI meminta konteks kepada Workspace Engine.

Workspace Engine menentukan file mana yang relevan.

------------------------------------------------------------------------

## 8. Metadata Management

Workspace Engine harus memahami Frontmatter Markdown.

Contoh:

``` yaml
---
title: Project Alpha
type: project
status: active
tags:
  - ai
  - desktop
owner: xmlze
---
```

Metadata harus dapat digunakan oleh Search, Graph, dan AI.

------------------------------------------------------------------------

## 9. Link Resolution

Workspace Engine bertanggung jawab menyelesaikan:

-   Wiki Link
-   Backlink
-   Broken Link
-   Relative Path
-   Attachment Reference

------------------------------------------------------------------------

## 10. Asset Management

Assets seperti:

-   gambar
-   PDF
-   video
-   audio

harus tetap terhubung dengan catatan yang menggunakannya.

------------------------------------------------------------------------

# Rules

Workspace Engine HARUS:

-   Menganggap Markdown sebagai Source of Truth.
-   Tidak mengubah isi file tanpa instruksi yang jelas.
-   Menjaga kompatibilitas Git.
-   Mendukung ribuan file tanpa penurunan performa yang signifikan.
-   Tetap berfungsi saat AI tidak tersedia.

------------------------------------------------------------------------

# Acceptance Criteria

Workspace Engine dianggap selesai apabila mampu:

-   Membuka Workspace besar.
-   Mengindeks seluruh Markdown.
-   Mendeteksi perubahan file secara otomatis.
-   Menyediakan konteks untuk AI.
-   Memperbarui Search.
-   Memperbarui Graph.
-   Memisahkan data pengguna dan data sistem.
-   Memulihkan indeks hanya dari Markdown.

------------------------------------------------------------------------

# Future Direction

Workspace Engine dirancang agar mendukung:

-   Multi Vault
-   Cloud Sync
-   Background Indexing
-   Version History
-   Workspace Snapshot
-   Shared Workspace
-   Workspace Encryption

tanpa mengubah fondasi sistem.

------------------------------------------------------------------------

# Closing

Workspace Engine adalah fondasi seluruh WorkspaceGraph.

Seluruh fitur bergantung pada Workspace Engine, sementara Workspace
Engine bergantung pada satu prinsip utama:

**Markdown adalah sumber kebenaran utama (Source of Truth).**
