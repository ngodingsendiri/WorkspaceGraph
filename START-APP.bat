@echo off
cd /d C:\code\WorkspaceGraph
echo Stopping old Electron...
taskkill /F /IM electron.exe >nul 2>&1
timeout /t 1 /nobreak >nul
echo Starting WorkspaceGraph (npm run dev)...
call npm run dev
