# 10_AI_Middleware.md

# WorkspaceGraph AI Middleware

Version: 0.1 (Draft)

------------------------------------------------------------------------

# Purpose

AI Middleware adalah lapisan yang menghubungkan WorkspaceGraph dengan
berbagai penyedia AI.

Seluruh komunikasi AI harus melalui AI Middleware. Tidak ada modul lain
yang boleh memanggil model AI secara langsung.

------------------------------------------------------------------------

# Objectives

-   Menyediakan antarmuka AI yang konsisten.
-   Mendukung banyak provider.
-   Memisahkan logika aplikasi dari implementasi model.
-   Memungkinkan pergantian model tanpa mengubah modul lain.

------------------------------------------------------------------------

# Architecture

User Action

↓

Context Engine

↓

AI Middleware

↓

Provider Adapter

↓

AI Model

↓

Response Parser

↓

WorkspaceGraph

------------------------------------------------------------------------

# Responsibilities

AI Middleware bertanggung jawab untuk:

-   Menerima permintaan AI.
-   Meminta Context Package.
-   Memilih provider.
-   Menyusun prompt.
-   Mengirim request.
-   Mengelola streaming.
-   Memproses response.
-   Menulis hasil kembali ke Workspace bila diperlukan.

------------------------------------------------------------------------

# Provider Adapters

Harus mendukung adapter terpisah untuk:

-   Gemini CLI
-   OpenAI
-   Claude
-   Ollama
-   OpenRouter
-   Provider tambahan melalui Plugin SDK

------------------------------------------------------------------------

# Request Pipeline

1.  Terima permintaan.
2.  Validasi permission.
3.  Ambil Context Package.
4.  Pilih provider.
5.  Susun prompt.
6.  Kirim request.
7.  Terima response.
8.  Validasi output.
9.  Kembalikan hasil.

------------------------------------------------------------------------

# Prompt Assembly

Prompt terdiri dari:

-   System Prompt
-   Workspace Rules
-   User Instruction
-   Context Package
-   Tool Definitions (opsional)

------------------------------------------------------------------------

# Model Routing

Middleware dapat memilih model berdasarkan:

-   Jenis tugas
-   Ketersediaan provider
-   Biaya
-   Kecepatan
-   Preferensi pengguna

------------------------------------------------------------------------

# Streaming

Harus mendukung:

-   Token streaming
-   Cancel request
-   Retry
-   Timeout
-   Progress event

------------------------------------------------------------------------

# Security

Middleware harus:

-   Menyembunyikan API Key.
-   Memvalidasi izin akses.
-   Membatasi tool yang dapat dipanggil AI.
-   Mencatat aktivitas penting.

------------------------------------------------------------------------

# Logging

Catat:

-   Provider
-   Model
-   Durasi
-   Token
-   Status
-   Error

Tanpa menyimpan data sensitif secara default.

------------------------------------------------------------------------

# Error Handling

Menangani:

-   Provider offline
-   Timeout
-   Rate limit
-   Invalid response
-   Network error

Dengan fallback bila tersedia.

------------------------------------------------------------------------

# Decision Record

-   AI Middleware adalah satu-satunya gerbang menuju AI.
-   Modul lain tidak mengetahui detail provider.
-   Provider dapat diganti tanpa memengaruhi Workspace Engine.

------------------------------------------------------------------------

# Future Considerations

-   MCP compatibility
-   Multi-model orchestration
-   Local + Cloud hybrid
-   Automatic model benchmarking
-   Intelligent provider selection
-   Response caching

------------------------------------------------------------------------

# Acceptance Criteria

-   Mendukung lebih dari satu provider.
-   Context selalu dikirim melalui Context Engine.
-   Provider dapat diganti tanpa perubahan pada modul lain.
-   Mendukung streaming dan retry.
-   Menangani error dengan aman.

------------------------------------------------------------------------

# Closing

AI Middleware menjaga WorkspaceGraph tetap independen dari vendor AI
tertentu.

Dengan pendekatan ini, aplikasi dapat berkembang mengikuti perubahan
ekosistem AI tanpa mengubah fondasi arsitekturnya.
