param([switch]$ResolveOnly)
$ErrorActionPreference = 'Stop'
$workspace = Split-Path -Parent $PSScriptRoot
$candidates = @(
  (Join-Path $workspace '.runtime\release\win-unpacked\Seeing Stone.exe'),
  (Join-Path $workspace '.runtime\release-texture-fix\win-unpacked\Seeing Stone.exe')
)
$player = $candidates | Where-Object { Test-Path -LiteralPath $_ } |
  ForEach-Object { Get-Item -LiteralPath $_ } |
  Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
if (-not $player) { throw 'Seeing Stone has not been built. Run pnpm run package:windows:dir.' }
if ($ResolveOnly) { $player.FullName; return }
$env:ELECTRON_RUN_AS_NODE = $null
Start-Process -FilePath $player.FullName -WorkingDirectory $player.DirectoryName -WindowStyle Hidden
