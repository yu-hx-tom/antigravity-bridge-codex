@echo off
chcp 65001 >nul 2>&1
title Codex API Service - Antigravity
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0launch-codex-api-service.ps1"
if errorlevel 1 (
  echo.
  pause
)
