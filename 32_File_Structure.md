# 32_File_Structure.md

# WorkspaceGraph File Structure

Version: 0.1 (Draft)

------------------------------------------------------------------------

# Purpose

File Structure mendefinisikan organisasi direktori, file, cache,
konfigurasi, dan aset WorkspaceGraph agar konsisten, mudah dipelihara,
serta aman terhadap perubahan versi.

------------------------------------------------------------------------

# Objectives

-   Struktur direktori yang jelas.
-   Memisahkan data pengguna dari data aplikasi.
-   Mempermudah backup dan migrasi.
-   Mendukung pengembangan jangka panjang.

------------------------------------------------------------------------

# Core Principles

-   Markdown First
-   User Data First
-   Cache Is Disposable
-   Predictable Layout
-   Clear Separation of Concerns

------------------------------------------------------------------------

# Root Structure

WorkspaceGraph terdiri dari:

-   Workspace/
-   Config/
-   Cache/
-   Logs/
-   Plugins/
-   Themes/
-   Backups/
-   Temp/

------------------------------------------------------------------------

# Workspace Directory

Berisi aset utama pengguna:

-   Knowledge/
-   Projects/
-   Tasks/
-   Daily Notes/
-   People/
-   Documents/
-   Attachments/
-   Templates/

Seluruh Markdown disimpan di area ini.

------------------------------------------------------------------------

# Configuration

Folder Config menyimpan:

-   Application Settings
-   Workspace Settings
-   Keyboard Shortcuts
-   AI Providers
-   Automation Rules

Konfigurasi dipisahkan dari Workspace.

------------------------------------------------------------------------

# Cache

Cache bersifat sementara:

-   Search Index
-   Graph Cache
-   AI Cache
-   Preview Cache
-   Thumbnail Cache

Seluruh cache dapat dibangun ulang.

------------------------------------------------------------------------

# Plugins

Setiap plugin memiliki direktori sendiri:

-   Manifest
-   Assets
-   Settings
-   Runtime Data

Plugin tidak boleh mengubah Core.

------------------------------------------------------------------------

# Themes

Menyimpan:

-   Theme Definitions
-   Design Tokens
-   Fonts
-   Icons
-   Images

------------------------------------------------------------------------

# Logs

Kategori log:

-   Application
-   AI
-   Plugin
-   Automation
-   Installer
-   Error

Log dapat dirotasi dan dibersihkan otomatis.

------------------------------------------------------------------------

# Backups

Mendukung:

-   Manual Backup
-   Scheduled Backup
-   Versioned Backup
-   Restore Point

Workspace menjadi prioritas utama.

------------------------------------------------------------------------

# Temporary Files

Digunakan untuk:

-   Import
-   Export
-   Conversion
-   AI Processing

Temp dibersihkan otomatis.

------------------------------------------------------------------------

# Decision Record

-   Workspace dipisahkan dari konfigurasi.
-   Cache tidak dianggap sebagai data permanen.
-   Struktur direktori harus stabil antar versi.

------------------------------------------------------------------------

# Future Considerations

-   Multi Workspace
-   Cloud Storage Layout
-   Shared Workspace
-   Enterprise Directory Policy
-   Remote Cache

------------------------------------------------------------------------

# Acceptance Criteria

-   Struktur mudah dipahami.
-   Backup hanya memerlukan direktori penting.
-   Cache dapat dihapus tanpa kehilangan data.
-   Plugin dan Theme memiliki area terpisah.

------------------------------------------------------------------------

# Closing

File Structure menjadi fondasi organisasi data WorkspaceGraph sehingga
aplikasi tetap rapi, aman, dan mudah dipelihara sepanjang siklus hidup
produk.
