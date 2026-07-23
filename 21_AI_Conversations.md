# 21_AI_Conversations.md

# WorkspaceGraph AI Conversations

Version: 0.1 (Draft)

------------------------------------------------------------------------

# Purpose

AI Conversation System mengelola seluruh percakapan antara pengguna dan
AI sebagai bagian dari Workspace, bukan sebagai sesi chat yang terpisah.

Conversation diperlakukan sebagai aset yang dapat dicari, dihubungkan,
diringkas, dan dikembangkan menjadi Knowledge.

------------------------------------------------------------------------

# Objectives

-   Menyediakan percakapan yang memiliki konteks.
-   Menghubungkan percakapan dengan Workspace.
-   Mendukung banyak sesi secara bersamaan.
-   Memungkinkan evolusi percakapan menjadi pengetahuan permanen.

------------------------------------------------------------------------

# Core Principles

-   Conversation bukan Source of Truth.
-   Markdown tetap Source of Truth.
-   Knowledge lebih penting daripada history chat.
-   Conversation dapat dipromosikan menjadi Knowledge.

------------------------------------------------------------------------

# Conversation Lifecycle

1.  Create Session
2.  Build Context
3.  Exchange Messages
4.  AI Response
5.  Optional Write-back
6.  Summarize
7.  Archive

------------------------------------------------------------------------

# Conversation Structure

Setiap Conversation memiliki:

-   Conversation ID
-   Title
-   Created
-   Updated
-   Messages
-   Related Knowledge
-   Related Projects
-   Related Tasks
-   Related Documents
-   Summary
-   Status

------------------------------------------------------------------------

# Session Management

Workspace mendukung:

-   Multiple Sessions
-   Session Resume
-   Session Rename
-   Session Archive
-   Session Delete

Setiap sesi berdiri sendiri namun dapat berbagi konteks Workspace.

------------------------------------------------------------------------

# Context Switching

Pengguna dapat berpindah konteks tanpa kehilangan sesi.

Contoh:

-   Project A
-   Project B
-   Research
-   Personal Notes

Context Engine akan membangun konteks baru.

------------------------------------------------------------------------

# Conversation Memory

Memory percakapan hanya berlaku untuk sesi aktif.

Knowledge penting harus dipromosikan ke Workspace agar dapat digunakan
pada sesi lain.

------------------------------------------------------------------------

# Conversation Search

Search Engine harus mendukung pencarian:

-   Judul percakapan
-   Isi percakapan
-   Ringkasan
-   Entitas terkait

------------------------------------------------------------------------

# Knowledge Promotion

Pengguna atau AI dapat:

-   Mengubah jawaban menjadi Knowledge.
-   Membuat Project.
-   Membuat Task.
-   Membuat Daily Note.
-   Menambahkan backlink.

Perubahan memerlukan persetujuan pengguna.

------------------------------------------------------------------------

# AI Integration

AI dapat:

-   Merangkum percakapan.
-   Mengidentifikasi keputusan penting.
-   Menyarankan Knowledge baru.
-   Menghapus konteks yang tidak relevan.
-   Memulihkan konteks sesi.

------------------------------------------------------------------------

# Privacy

Conversation dapat:

-   Disimpan lokal.
-   Diekspor.
-   Dihapus permanen.
-   Tidak dikirim ke provider bila menggunakan model lokal.

------------------------------------------------------------------------

# Decision Record

-   Conversation adalah ruang kerja sementara.
-   Workspace adalah memori jangka panjang.
-   Semua Knowledge berasal dari Workspace, bukan history chat.

------------------------------------------------------------------------

# Future Considerations

-   Branch Conversations
-   Shared Conversations
-   Voice Conversations
-   Multi-Agent Discussions
-   Conversation Analytics
-   Timeline Replay

------------------------------------------------------------------------

# Acceptance Criteria

-   Mendukung banyak sesi.
-   Context dapat dipulihkan.
-   Conversation dapat dicari.
-   Knowledge dapat dibuat dari percakapan.
-   AI tetap menggunakan Context Engine.

------------------------------------------------------------------------

# Closing

AI Conversation System menjadikan percakapan sebagai bagian dari alur
kerja, bukan tujuan akhir.

Dengan pendekatan ini, setiap percakapan dapat berkembang menjadi
pengetahuan yang terstruktur dan bernilai jangka panjang.
