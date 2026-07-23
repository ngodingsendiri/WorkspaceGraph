# 13_Task_System.md

# WorkspaceGraph Task System

Version: 0.1 (Draft)

------------------------------------------------------------------------

# Purpose

Task System mengelola seluruh pekerjaan yang harus dilakukan pengguna,
baik yang berdiri sendiri maupun yang menjadi bagian dari Project.

Task dirancang agar terhubung dengan Knowledge, Project, Daily Note, dan
AI.

------------------------------------------------------------------------

# Objectives

-   Mengelola pekerjaan secara terstruktur.
-   Mendukung perencanaan jangka pendek dan panjang.
-   Mempermudah pelacakan progres.
-   Menjadi sumber konteks operasional bagi AI.

------------------------------------------------------------------------

# Task Definition

Task adalah unit pekerjaan yang memiliki tujuan, status, dan kemungkinan
batas waktu.

Task dapat berdiri sendiri atau menjadi bagian dari Project.

------------------------------------------------------------------------

# Standard Structure

Setiap Task minimal memiliki:

-   Task ID
-   Title
-   Description
-   Status
-   Priority
-   Due Date
-   Created
-   Updated
-   Tags
-   Related Project
-   Related Knowledge

------------------------------------------------------------------------

# Lifecycle

1.  Inbox
2.  To Do
3.  In Progress
4.  Review
5.  Done
6.  Archived

Seluruh perubahan status harus tercatat.

------------------------------------------------------------------------

# Priority

Prioritas standar:

-   Critical
-   High
-   Medium
-   Low

Priority membantu Dashboard dan AI menentukan urutan pekerjaan.

------------------------------------------------------------------------

# Relationships

Task dapat terhubung dengan:

-   Project
-   Knowledge
-   Daily Note
-   Document
-   People
-   Task lain

Seluruh relasi menggunakan Wiki Link.

------------------------------------------------------------------------

# Subtasks

Task dapat memiliki:

-   Subtask tanpa batas jumlah.
-   Parent Task.
-   Dependency (blocked by / blocks).

------------------------------------------------------------------------

# Dashboard

Dashboard Task menampilkan:

-   Task hari ini.
-   Task terlambat.
-   Task berdasarkan prioritas.
-   Task berdasarkan Project.
-   Progress keseluruhan.

------------------------------------------------------------------------

# AI Integration

AI dapat membantu:

-   Memecah pekerjaan besar menjadi subtask.
-   Menyarankan prioritas.
-   Mengestimasi langkah berikutnya.
-   Membuat ringkasan progres.
-   Mengidentifikasi pekerjaan yang terhambat.

AI tidak boleh menandai Task selesai tanpa persetujuan pengguna.

------------------------------------------------------------------------

# Decision Record

-   Task adalah unit kerja terkecil.
-   Knowledge dan Task dipisahkan agar informasi jangka panjang tidak
    bercampur dengan pekerjaan sementara.
-   Markdown tetap menjadi Source of Truth.

------------------------------------------------------------------------

# Future Considerations

-   Recurring Tasks
-   Calendar Integration
-   Time Tracking
-   Pomodoro Support
-   Workload Balancing
-   AI Daily Planner

------------------------------------------------------------------------

# Acceptance Criteria

-   Task dapat dibuat, diperbarui, dan diarsipkan.
-   Task dapat dihubungkan dengan Project dan Knowledge.
-   Dashboard menampilkan status terbaru.
-   AI dapat menggunakan Task sebagai konteks.

------------------------------------------------------------------------

# Closing

Task System menjadi pusat pengelolaan pekerjaan di WorkspaceGraph.

Dengan integrasi yang erat dengan Project, Knowledge, dan AI, pengguna
dapat mengelola pekerjaan tanpa kehilangan konteks maupun informasi
jangka panjang.
