$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$manifest = Get-Content (Join-Path $root "mpv-runtime.json") -Raw | ConvertFrom-Json
$downloadDirectory = Join-Path $root ".runtime\mpv-download"
$runtimeDirectory = Join-Path $root ".runtime\mpv"
$archivePath = Join-Path $downloadDirectory $manifest.archive

New-Item -ItemType Directory -Force -Path $downloadDirectory, $runtimeDirectory | Out-Null

if (-not (Test-Path -LiteralPath $archivePath)) {
  curl.exe -L --fail --show-error --output $archivePath $manifest.url
  if ($LASTEXITCODE -ne 0) { throw "mpv download failed." }
}

$actualHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $archivePath).Hash.ToLowerInvariant()
if ($actualHash -ne $manifest.sha256) { throw "mpv archive checksum mismatch." }

Expand-Archive -LiteralPath $archivePath -DestinationPath $runtimeDirectory -Force
if (-not (Test-Path -LiteralPath (Join-Path $runtimeDirectory "mpv.exe"))) {
  throw "mpv.exe was not present in the verified archive."
}

Write-Host "mpv $($manifest.version) is ready at $runtimeDirectory"
