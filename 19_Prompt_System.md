# 19_Prompt_System.md

# WorkspaceGraph Prompt System

Version: 0.1 (Draft)

------------------------------------------------------------------------

# Purpose

Prompt System mendefinisikan bagaimana seluruh prompt AI dibuat,
disimpan, diuji, digunakan, dan dipelihara di dalam WorkspaceGraph.

Prompt diperlakukan sebagai aset sistem, bukan string yang ditulis
langsung di source code.

------------------------------------------------------------------------

# Objectives

-   Menstandarkan seluruh prompt.
-   Mempermudah pengelolaan dan versioning.
-   Menghasilkan output AI yang konsisten.
-   Memungkinkan evaluasi dan peningkatan prompt secara berkelanjutan.

------------------------------------------------------------------------

# Core Principles

-   Prompt bersifat modular.
-   Prompt dapat digunakan ulang.
-   Prompt dapat diuji.
-   Prompt dapat diberi versi.
-   Prompt dapat dikombinasikan.

------------------------------------------------------------------------

# Prompt Architecture

Setiap request AI disusun dari beberapa lapisan:

1.  System Prompt
2.  Workspace Rules
3.  Tool Instructions
4.  Context Package
5.  User Instruction
6.  Output Constraints

Setiap lapisan memiliki tanggung jawab yang jelas.

------------------------------------------------------------------------

# Prompt Registry

Seluruh prompt disimpan dalam Prompt Registry.

Setiap prompt memiliki:

-   Prompt ID
-   Name
-   Category
-   Version
-   Author
-   Description
-   Status
-   Last Updated

------------------------------------------------------------------------

# Prompt Categories

Contoh kategori:

-   Chat
-   Writing
-   Research
-   Refactoring
-   Knowledge
-   Project
-   Task
-   Search
-   Automation
-   Agent

------------------------------------------------------------------------

# Prompt Templates

Prompt dapat menggunakan placeholder seperti:

-   {{workspace}}
-   {{project}}
-   {{knowledge}}
-   {{task}}
-   {{date}}
-   {{context}}

Placeholder diganti saat runtime.

------------------------------------------------------------------------

# Prompt Composition

Prompt dapat dibangun dari beberapa komponen kecil.

Contoh:

System Prompt + Workspace Rules + Knowledge Context + User Request +
Output Schema

↓

Final Prompt

------------------------------------------------------------------------

# Output Specification

Prompt dapat menentukan format output:

-   Markdown
-   JSON
-   YAML
-   Plain Text
-   Checklist
-   Table

Bila diperlukan, output harus mengikuti schema yang telah ditentukan.

------------------------------------------------------------------------

# Prompt Versioning

Setiap perubahan prompt:

-   Menambah versi.
-   Menyimpan riwayat.
-   Dapat dikembalikan ke versi sebelumnya.

Prompt lama tidak dihapus secara otomatis.

------------------------------------------------------------------------

# Prompt Testing

Prompt System harus mendukung:

-   Test Case
-   Expected Output
-   Regression Test
-   Manual Review
-   Performance Comparison

------------------------------------------------------------------------

# Prompt Evaluation

Kriteria evaluasi:

-   Akurasi
-   Konsistensi
-   Kejelasan
-   Kepatuhan terhadap aturan
-   Efisiensi token

------------------------------------------------------------------------

# AI Middleware Integration

AI Middleware meminta Prompt System untuk:

-   Memilih prompt.
-   Mengisi variabel.
-   Menggabungkan komponen.
-   Menghasilkan Final Prompt.

Middleware tidak menyusun prompt secara manual.

------------------------------------------------------------------------

# Security

Prompt System harus:

-   Memisahkan instruksi sistem dan pengguna.
-   Mencegah modifikasi prompt inti tanpa izin.
-   Mendukung validasi sebelum prompt dikirim.

------------------------------------------------------------------------

# Decision Record

-   Prompt adalah aset sistem.
-   Prompt dipisahkan dari logika aplikasi.
-   Seluruh request AI harus melewati Prompt System.

------------------------------------------------------------------------

# Future Considerations

-   Prompt Marketplace
-   Prompt Analytics
-   AI Prompt Optimizer
-   Multi-language Prompt
-   A/B Prompt Testing
-   Prompt Recommendation Engine

------------------------------------------------------------------------

# Acceptance Criteria

-   Prompt dapat disimpan dan diberi versi.
-   Prompt dapat digunakan ulang.
-   Placeholder diproses otomatis.
-   AI Middleware menggunakan Prompt System untuk seluruh request.
-   Prompt dapat diuji dan dievaluasi.

------------------------------------------------------------------------

# Closing

Prompt System memastikan setiap interaksi AI memiliki struktur yang
konsisten, dapat dipelihara, dan mudah dikembangkan.

Dengan memperlakukan prompt sebagai aset utama, WorkspaceGraph dapat
meningkatkan kualitas AI secara sistematis tanpa mengubah arsitektur
aplikasi.
