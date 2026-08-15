@echo off
setlocal

set "PLAYER=%~dp0.runtime\cache-library-refresh-hotfix\win-unpacked\Seeing Stone Libmpv Test.exe"

if not exist "%PLAYER%" (
  set "PLAYER=%~dp0.runtime\video-surface-recovery-hotfix\win-unpacked\Seeing Stone Libmpv Test.exe"
)

if not exist "%PLAYER%" (
  set "PLAYER=%~dp0.runtime\live-tv-recording-time-hotfix\win-unpacked\Seeing Stone Libmpv Test.exe"
)

if not exist "%PLAYER%" (
  set "PLAYER=%~dp0.runtime\libmpv-dvr-recovery-hotfix\win-unpacked\Seeing Stone Libmpv Test.exe"
)

if not exist "%PLAYER%" (
  set "PLAYER=%~dp0.runtime\libmpv-test-release\win-unpacked\Seeing Stone Libmpv Test.exe"
)

if not exist "%PLAYER%" (
  set "PLAYER=%~dp0.runtime\libmpv-test-release-fullscreen-click\win-unpacked\Seeing Stone Libmpv Test.exe"
)

if not exist "%PLAYER%" (
  set "PLAYER=%~dp0.runtime\libmpv-test-release-episode-browser-fix\win-unpacked\Seeing Stone Libmpv Test.exe"
)

if not exist "%PLAYER%" (
  set "PLAYER=%~dp0.runtime\libmpv-test-release-episode-browser\win-unpacked\Seeing Stone Libmpv Test.exe"
)

if not exist "%PLAYER%" (
  set "PLAYER=%~dp0.runtime\libmpv-test-release-diagnostics\win-unpacked\Seeing Stone Libmpv Test.exe"
)

if not exist "%PLAYER%" (
  set "PLAYER=%~dp0.runtime\libmpv-test-release-autoplay-fix\win-unpacked\Seeing Stone Libmpv Test.exe"
)

if not exist "%PLAYER%" (
  set "PLAYER=%~dp0.runtime\libmpv-test-release-countdown\win-unpacked\Seeing Stone Libmpv Test.exe"
)

if not exist "%PLAYER%" (
  echo Seeing Stone's libmpv test build was not found.
  echo.
  echo Ask Codex to rebuild the libmpv test package, or run:
  echo   pnpm run package:windows:libmpv-test
  echo.
  pause
  exit /b 1
)

start "" "%PLAYER%"
exit /b 0
