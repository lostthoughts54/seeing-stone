@echo off
setlocal
cd /d "%~dp0"
title Seeing Stone Synthetic Live TV
echo Starting three local test channels for Jellyfin...
echo.
node scripts\live-tv-test-server.cjs
echo.
echo The test server stopped. Press any key to close.
pause >nul
