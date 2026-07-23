# 16_People_System.md

# WorkspaceGraph People System

Version: 0.1 (Draft)

------------------------------------------------------------------------

# Purpose

People System memperlakukan setiap orang sebagai entitas yang memiliki
hubungan dengan Knowledge, Project, Task, Meeting, dan Document.

Tujuannya adalah menjaga konteks hubungan, bukan sekadar menyimpan
informasi kontak.

------------------------------------------------------------------------

# Objectives

-   Mengelola informasi orang secara terstruktur.
-   Mencatat hubungan dengan pekerjaan dan pengetahuan.
-   Menyediakan konteks bagi AI.
-   Memudahkan penelusuran riwayat interaksi.

------------------------------------------------------------------------

# People Definition

People mewakili individu yang memiliki hubungan dengan Workspace.

Contoh:

-   Rekan kerja
-   Klien
-   Mentor
-   Vendor
-   Teman
-   Anggota keluarga (opsional)

------------------------------------------------------------------------

# Standard Structure

Setiap People Note minimal memiliki:

-   Person ID
-   Name
-   Role
-   Organization
-   Contact (opsional)
-   Tags
-   Created
-   Updated

------------------------------------------------------------------------

# Relationships

People dapat terhubung dengan:

-   Project
-   Task
-   Knowledge
-   Meeting
-   Daily Note
-   Document
-   People lainnya

Seluruh hubungan menggunakan Wiki Link.

------------------------------------------------------------------------

# Timeline

Setiap People memiliki timeline yang dapat menampilkan:

-   Meeting
-   Aktivitas
-   Project yang pernah dikerjakan
-   Knowledge yang berkaitan
-   Catatan penting

------------------------------------------------------------------------

# Meeting Integration

Meeting dapat otomatis menautkan peserta ke People terkait.

Riwayat pertemuan tetap dapat ditelusuri.

------------------------------------------------------------------------

# AI Integration

AI dapat membantu:

-   Membuat ringkasan profil.
-   Menampilkan riwayat interaksi.
-   Menemukan Project terkait.
-   Menghubungkan catatan yang relevan.
-   Menyarankan tindak lanjut setelah meeting.

AI tidak mengubah data People tanpa persetujuan pengguna.

------------------------------------------------------------------------

# Privacy

People System harus:

-   Mendukung field opsional.
-   Menghindari penyimpanan data sensitif secara default.
-   Memungkinkan pengguna menghapus atau mengekspor data.

------------------------------------------------------------------------

# Decision Record

-   People adalah entitas Workspace.
-   Relasi lebih penting daripada banyaknya informasi profil.
-   Markdown tetap menjadi Source of Truth.

------------------------------------------------------------------------

# Future Considerations

-   Organization System
-   Contact Synchronization
-   Relationship Strength
-   Social Graph
-   AI Networking Insights
-   Team Collaboration

------------------------------------------------------------------------

# Acceptance Criteria

-   People dapat dibuat dan dihubungkan.
-   Timeline dapat ditampilkan.
-   AI dapat menggunakan People sebagai konteks.
-   Graph menampilkan hubungan antar People dan entitas lain.

------------------------------------------------------------------------

# Closing

People System memperkaya konteks WorkspaceGraph dengan menghubungkan
manusia, pekerjaan, dan pengetahuan dalam satu jaringan yang saling
terhubung.
