[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
& (Join-Path $PSScriptRoot "setup-libmpv-sources.ps1")

$candidates = @($env:MSYS2_ROOT, "C:\msys64", "D:\msys64") | Where-Object { $_ }
$msysRoot = $candidates | Where-Object { Test-Path (Join-Path $_ "usr\bin\bash.exe") } | Select-Object -First 1
if (-not $msysRoot) { throw "LIBMPV_RUNTIME_MSYS2_MISSING" }

$bash = Join-Path $msysRoot "usr\bin\bash.exe"
$msysHome = Join-Path $root ".runtime\msys2-home"
New-Item -ItemType Directory -Force -Path $msysHome | Out-Null
$env:MSYSTEM = "UCRT64"
$env:CHERE_INVOKING = "1"
$env:HOME = $msysHome
$buildDrive = "S:"
if (Test-Path "$buildDrive\") {
  throw "LIBMPV_BUILD_DRIVE_IN_USE: the temporary $buildDrive drive mapping is unavailable."
}
& subst.exe $buildDrive $root
if ($LASTEXITCODE -ne 0) { throw "LIBMPV_BUILD_DRIVE_CREATE_FAILED" }
try {
  & $bash "/s/scripts/build-libmpv-runtime.sh" "/s"
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} finally {
  & subst.exe $buildDrive /D
}
