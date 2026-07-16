$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$manifest = Get-Content (Join-Path $root "mpv-runtime.json") -Raw | ConvertFrom-Json
$downloadDirectory = Join-Path $root ".runtime\mpv-download"
$runtimeDirectory = Join-Path $root ".runtime\mpv"
$licenseDirectory = Join-Path $root "assets\mpv\licenses"
$archivePath = Join-Path $downloadDirectory $manifest.archive

New-Item -ItemType Directory -Force -Path $downloadDirectory | Out-Null

if (-not (Test-Path -LiteralPath $archivePath)) {
  curl.exe -L --fail --show-error --output $archivePath $manifest.url
  if ($LASTEXITCODE -ne 0) { throw "mpv download failed." }
}

$actualHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $archivePath).Hash.ToLowerInvariant()
if ($actualHash -ne $manifest.sha256) { throw "mpv archive checksum mismatch." }

$licenseRoot = [IO.Path]::GetFullPath($licenseDirectory).TrimEnd([IO.Path]::DirectorySeparatorChar)
foreach ($license in $manifest.licenseFiles) {
  $licensePath = [IO.Path]::GetFullPath((Join-Path $licenseRoot $license.path))
  if (-not $licensePath.StartsWith("$licenseRoot$([IO.Path]::DirectorySeparatorChar)", [StringComparison]::OrdinalIgnoreCase)) {
    throw "An mpv license path escaped the controlled license directory."
  }
  if (-not (Test-Path -LiteralPath $licensePath -PathType Leaf)) {
    throw "Required mpv license file is missing: $($license.path)"
  }
  $licenseHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $licensePath).Hash.ToLowerInvariant()
  if ($licenseHash -ne $license.sha256) {
    throw "mpv license checksum mismatch: $($license.path)"
  }
}

$rootPath = [IO.Path]::GetFullPath($root).TrimEnd([IO.Path]::DirectorySeparatorChar)
$runtimePath = [IO.Path]::GetFullPath($runtimeDirectory)
if (-not $runtimePath.StartsWith("$rootPath$([IO.Path]::DirectorySeparatorChar)", [StringComparison]::OrdinalIgnoreCase)) {
  throw "Refusing to replace an mpv runtime outside the project workspace."
}
if (Test-Path -LiteralPath $runtimePath) {
  Remove-Item -LiteralPath $runtimePath -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $runtimePath | Out-Null

Expand-Archive -LiteralPath $archivePath -DestinationPath $runtimeDirectory -Force
if (-not (Test-Path -LiteralPath (Join-Path $runtimeDirectory "mpv.exe"))) {
  throw "mpv.exe was not present in the verified archive."
}
$executableHash = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $runtimeDirectory "mpv.exe")).Hash.ToLowerInvariant()
if ($executableHash -ne $manifest.executableSha256) {
  throw "Extracted mpv.exe checksum mismatch."
}

Write-Host "mpv $($manifest.version) is ready at $runtimeDirectory"
