@echo off
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\launch-seeing-stone.ps1"
if errorlevel 1 (
  pause
  exit /b 1
)
