# 03_Product_Requirements.md

# WorkspaceGraph Product Requirements

Version: 0.1 (Draft)

------------------------------------------------------------------------

# Purpose

Dokumen ini mendefinisikan kebutuhan fungsional WorkspaceGraph. Seluruh
implementasi harus mengacu pada dokumen ini.

------------------------------------------------------------------------

# Product Goal

WorkspaceGraph harus menjadi AI Workspace yang mampu mengelola seluruh
pengetahuan, proyek, tugas, dan dokumentasi dalam satu Workspace
berbasis Markdown.

------------------------------------------------------------------------

# Functional Requirements

## FR-001 Workspace

Sistem harus mampu membuka, membuat, dan mengelola beberapa Workspace
(Vault).

Acceptance Criteria: - Membuat Workspace baru. - Membuka Workspace yang
sudah ada. - Menutup Workspace tanpa kehilangan data.

------------------------------------------------------------------------

## FR-002 Markdown Engine

Sistem harus membaca seluruh file Markdown sebagai sumber data utama.

Acceptance Criteria: - Membaca file .md secara otomatis. - Mendeteksi
perubahan file. - Menyegarkan indeks tanpa restart.

------------------------------------------------------------------------

## FR-003 AI Workspace Scan

Sebelum AI menerima prompt, middleware wajib:

1.  Mengidentifikasi Workspace aktif.
2.  Mencari file relevan.
3.  Membaca metadata.
4.  Membaca template.
5.  Menyusun konteks.

Acceptance Criteria: - AI tidak bekerja tanpa context builder. - Konteks
dapat dijelaskan kepada pengguna.

------------------------------------------------------------------------

## FR-004 Knowledge Graph

Sistem harus membangun Graph dari hubungan antar Markdown.

Acceptance Criteria: - Node dibuat otomatis. - Backlink menjadi Edge. -
Graph diperbarui setelah perubahan.

------------------------------------------------------------------------

## FR-005 Search

Workspace menyediakan pencarian cepat berdasarkan: - Judul - Isi - Tag -
Metadata - Backlink

------------------------------------------------------------------------

## FR-006 Projects

Workspace harus mendukung manajemen proyek.

Setiap proyek memiliki: - Overview - Tasks - Notes - Documents -
Timeline - AI Context

------------------------------------------------------------------------

## FR-007 Tasks

Task harus mendukung: - Todo - Doing - Done - Priority - Deadline -
Assignee - Project

Task disimpan sebagai Markdown.

------------------------------------------------------------------------

## FR-008 Templates

Pengguna dapat membuat Template untuk: - Surat - SOP - Meeting -
Project - Daily Note - Prompt - Laporan

AI wajib menggunakan Template bila tersedia.

------------------------------------------------------------------------

## FR-009 Daily Notes

Workspace mendukung Daily Notes sebagai jurnal aktivitas harian yang
dapat dijadikan konteks AI.

------------------------------------------------------------------------

## FR-010 AI Chat

AI Chat harus: - membaca Workspace, - mengutip sumber Markdown, -
menyimpan hasil penting kembali ke Workspace.

Chat bukan Source of Truth.

------------------------------------------------------------------------

## FR-011 Plugin System

Sistem harus dapat diperluas melalui plugin tanpa mengubah inti
aplikasi.

------------------------------------------------------------------------

## Non Functional Requirements

-   Startup cepat.
-   Responsif pada Workspace besar.
-   Offline-first.
-   Cross-platform pada tahap berikutnya.
-   Aman terhadap kehilangan data.

------------------------------------------------------------------------

# MVP Scope

Versi pertama WorkspaceGraph minimal memiliki:

-   Workspace
-   Markdown Engine
-   AI Chat
-   Graph
-   Search
-   Projects
-   Tasks
-   Templates
-   Daily Notes
-   Settings

------------------------------------------------------------------------

# Out of Scope

Versi pertama belum mencakup:

-   Kolaborasi real-time
-   Sinkronisasi cloud bawaan
-   Mobile App
-   Marketplace Plugin
-   AI Training

------------------------------------------------------------------------

# Success Criteria

WorkspaceGraph dianggap memenuhi kebutuhan produk apabila:

-   AI selalu bekerja berdasarkan konteks Workspace.
-   Seluruh data utama berada di Markdown.
-   Graph selalu sinkron.
-   Pengguna dapat mengelola proyek tanpa keluar dari Workspace.
-   Seluruh pengetahuan tetap dimiliki pengguna.
