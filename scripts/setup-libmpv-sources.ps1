[CmdletBinding()]
param([switch]$AllowDownload)

$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$lockPath = Join-Path $root "native\libmpv-runtime\source-lock.json"
$lock = Get-Content -LiteralPath $lockPath -Raw | ConvertFrom-Json
$buildRoot = Join-Path $root ".runtime\libmpv-build"
$archiveRoot = Join-Path $buildRoot "archives"
$sourceRoot = Join-Path $buildRoot "sources"
New-Item -ItemType Directory -Force -Path $archiveRoot, $sourceRoot | Out-Null

$allSources = @($lock.sources) + @($lock.referenceSources)
foreach ($source in $allSources) {
  $archive = Join-Path $archiveRoot $source.archiveFilename
  if (-not (Test-Path -LiteralPath $archive)) {
    if (-not $AllowDownload) {
      throw "LIBMPV_SOURCE_MISSING: $($source.archiveFilename). Run pnpm run setup:libmpv-sources to fetch the manifest-controlled source archive."
    }
    Write-Host "Downloading controlled $($source.name) source $($source.version)..."
    Invoke-WebRequest -UseBasicParsing -Uri $source.immutableUrl -OutFile $archive
  }
  $actual = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -ne $source.archiveSha256) {
    throw "LIBMPV_SOURCE_HASH_MISMATCH: $($source.archiveFilename)"
  }

  if ($source.extract -ne $false) {
    $extracted = Join-Path $sourceRoot $source.extractedDirectory
    if (-not (Test-Path -LiteralPath $extracted)) {
    & tar -xf $archive -C $sourceRoot
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $extracted)) {
      throw "LIBMPV_SOURCE_EXTRACTION_FAILED: $($source.archiveFilename)"
    }
    }
  }
}

[ordered]@{
  status = "ready"
  lock = $lockPath
  archiveRoot = $archiveRoot
  sourceRoot = $sourceRoot
  sources = @($allSources | ForEach-Object { "$($_.name) $($_.version) $($_.commit)" })
} | ConvertTo-Json -Depth 4
