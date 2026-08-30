@echo off
rem dev-env-sync 一键部署（双击运行）
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0deploy.ps1"
echo.
pause
