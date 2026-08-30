@echo off
rem dev-env-sync 一键上传（双击运行）
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0sync.ps1"
echo.
pause
