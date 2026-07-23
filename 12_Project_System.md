# 12_Project_System.md

# WorkspaceGraph Project System

Version: 0.1 (Draft)

------------------------------------------------------------------------

# Purpose

Project System menyediakan kerangka kerja untuk mengelola proyek dari
perencanaan hingga arsip. Project menjadi pusat koordinasi antara
Knowledge, Task, Document, People, dan AI.

------------------------------------------------------------------------

# Objectives

-   Mengelola proyek secara terstruktur.
-   Menyatukan seluruh informasi proyek dalam satu tempat.
-   Memudahkan kolaborasi dan pelacakan progres.
-   Menjadi pusat konteks untuk AI.

------------------------------------------------------------------------

# Project Definition

Project adalah sekumpulan tujuan, pekerjaan, dan pengetahuan yang
memiliki ruang lingkup, status, dan target penyelesaian.

------------------------------------------------------------------------

# Standard Structure

Setiap Project minimal memiliki:

-   Project ID
-   Title
-   Description
-   Status
-   Owner
-   Start Date
-   Target Date
-   Tags
-   Related Knowledge
-   Related Tasks
-   Related Documents

------------------------------------------------------------------------

# Lifecycle

1.  Planning
2.  Active
3.  On Hold
4.  Completed
5.  Archived

Semua perubahan status harus tercatat.

------------------------------------------------------------------------

# Relationships

Project dapat terhubung dengan:

-   Knowledge
-   Task
-   Daily Note
-   People
-   Document
-   Template

Seluruh relasi menggunakan Wiki Link.

------------------------------------------------------------------------

# Dashboard

Dashboard Project menampilkan:

-   Ringkasan
-   Progress
-   Task aktif
-   Milestone
-   Aktivitas terbaru
-   Dokumen terkait
-   Knowledge terkait

------------------------------------------------------------------------

# Milestones

Project dapat memiliki banyak milestone.

Setiap milestone memiliki:

-   Nama
-   Status
-   Target
-   Task pendukung

------------------------------------------------------------------------

# AI Integration

AI dapat membantu:

-   Membuat rencana proyek.
-   Memecah pekerjaan menjadi task.
-   Membuat ringkasan progres.
-   Mengidentifikasi risiko.
-   Menyarankan knowledge yang relevan.

AI tidak mengubah status proyek tanpa persetujuan pengguna.

------------------------------------------------------------------------

# Decision Record

-   Project adalah wadah koordinasi, bukan tempat menyimpan seluruh
    informasi.
-   Knowledge dan Task tetap menjadi entitas terpisah.
-   Markdown tetap menjadi Source of Truth.

------------------------------------------------------------------------

# Future Considerations

-   Kanban View
-   Gantt Timeline
-   Dependency Tracking
-   Project Analytics
-   Resource Planning
-   Multi-workspace Projects

------------------------------------------------------------------------

# Acceptance Criteria

-   Project dapat dibuat, diubah, dan diarsipkan.
-   Seluruh relasi dapat divisualisasikan pada Graph.
-   Dashboard menampilkan informasi terkini.
-   AI dapat menggunakan Project sebagai konteks.

------------------------------------------------------------------------

# Closing

Project System menghubungkan tujuan, pekerjaan, dan pengetahuan menjadi
satu kesatuan sehingga WorkspaceGraph dapat berfungsi sebagai pusat
pengelolaan proyek jangka panjang.
