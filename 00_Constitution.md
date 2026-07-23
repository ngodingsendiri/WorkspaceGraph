# 00_Constitution.md

# WorkspaceGraph Constitution

Version: 0.1 (Draft)

------------------------------------------------------------------------

# Purpose

Dokumen ini adalah konstitusi WorkspaceGraph.

Semua keputusan desain, implementasi, AI Agent, plugin, dan fitur baru
HARUS mengikuti aturan dalam dokumen ini.

Apabila terdapat konflik antara dokumen lain dan Constitution ini, maka
Constitution selalu menjadi acuan utama.

------------------------------------------------------------------------

# Core Principles

## Law 001 --- Markdown First

Seluruh data utama WorkspaceGraph HARUS disimpan dalam file Markdown.

Markdown adalah Source of Truth.

------------------------------------------------------------------------

## Law 002 --- User Owns Data

Seluruh data dimiliki pengguna.

WorkspaceGraph tidak boleh mengunci data ke dalam format proprietary.

------------------------------------------------------------------------

## Law 003 --- AI Is A Worker

AI bukan pusat sistem.

AI hanyalah pekerja yang membaca, memahami, lalu memperbarui Workspace.

------------------------------------------------------------------------

## Law 004 --- Workspace First

Sebelum menjawab atau mengerjakan tugas, AI WAJIB memahami Workspace
yang relevan.

AI tidak boleh langsung menjawab tanpa konteks apabila konteks tersedia.

------------------------------------------------------------------------

## Law 005 --- Read Before Think

Urutan kerja AI wajib:

1.  Identifikasi proyek aktif.
2.  Cari file Markdown yang relevan.
3.  Baca Template jika ada.
4.  Baca SOP jika ada.
5.  Baca Rules jika ada.
6.  Baca Daily Note jika relevan.
7.  Baru melakukan analisis.

------------------------------------------------------------------------

## Law 006 --- Never Invent Existing Data

Jika data sudah ada di Vault, AI wajib menggunakan data tersebut.

AI tidak boleh mengarang nama pegawai, nomor surat, template, atau SOP.

------------------------------------------------------------------------

## Law 007 --- Write Back

Setiap pekerjaan yang menghasilkan pengetahuan baru harus disimpan
kembali ke Workspace dalam bentuk Markdown.

------------------------------------------------------------------------

## Law 008 --- Graph Integrity

Setiap hubungan baru antar catatan harus dibuat menggunakan backlink
sehingga Graph selalu mencerminkan kondisi Workspace.

------------------------------------------------------------------------

## Law 009 --- Database Is Cache

Database hanya digunakan untuk:

-   cache
-   indexing
-   pencarian cepat
-   metadata sementara

Database bukan Source of Truth.

------------------------------------------------------------------------

## Law 010 --- AI Independence

WorkspaceGraph tidak boleh bergantung pada satu model AI.

Engine AI harus dapat diganti tanpa mengubah struktur Workspace.

------------------------------------------------------------------------

## Law 011 --- Human Readable

Seluruh data utama harus tetap dapat dibaca manusia menggunakan editor
Markdown biasa.

------------------------------------------------------------------------

## Law 012 --- Offline First

Workspace tetap dapat dibuka, dicari, dan diedit tanpa koneksi internet.

AI online adalah fitur tambahan, bukan syarat utama.

------------------------------------------------------------------------

## Law 013 --- Plugin First

Integrasi dengan layanan lain sebaiknya dilakukan melalui sistem plugin
agar mudah dikembangkan dan dipelihara.

------------------------------------------------------------------------

## Law 014 --- Preserve Knowledge

AI tidak boleh menghapus pengetahuan secara permanen tanpa konfirmasi
pengguna.

Lebih baik menandai sebagai usang daripada menghapus.

------------------------------------------------------------------------

## Law 015 --- Long-Term Compatibility

Workspace yang dibuat hari ini harus tetap dapat digunakan
bertahun-tahun ke depan, bahkan jika model AI atau teknologi berubah.

------------------------------------------------------------------------

# Closing Statement

WorkspaceGraph dibangun agar pengetahuan menjadi aset jangka panjang.

Model AI dapat berganti.

Plugin dapat berganti.

Teknologi dapat berubah.

Namun Vault Markdown milik pengguna harus tetap menjadi pusat seluruh
sistem.
