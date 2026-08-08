$ErrorActionPreference = "Stop"

$root = (Resolve-Path (Split-Path -Parent $PSScriptRoot)).Path
$runtimeRoot = Join-Path $root ".runtime"
$stage = Join-Path $runtimeRoot "package\LocalFirst Jellyfin-win32-x64"
$resources = Join-Path $stage "resources"
$appDirectory = Join-Path $resources "app"
$mpvDirectory = Join-Path $resources "mpv"

if (-not $stage.StartsWith($runtimeRoot, [StringComparison]::OrdinalIgnoreCase)) {
  throw "Refusing to stage outside the workspace runtime directory."
}
if (-not (Test-Path -LiteralPath (Join-Path $root ".runtime\mpv\mpv.exe"))) {
  throw "Run pnpm setup:mpv before staging the package."
}
if (-not (Test-Path -LiteralPath (Join-Path $root "dist\main\index.js"))) {
  throw "Run pnpm build before staging the package."
}

if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
New-Item -ItemType Directory -Force -Path $stage, $resources, $appDirectory, $mpvDirectory | Out-Null

Copy-Item -Path (Join-Path $root "node_modules\electron\dist\*") -Destination $stage -Recurse -Force
Move-Item -LiteralPath (Join-Path $stage "electron.exe") -Destination (Join-Path $stage "LocalFirst Jellyfin.exe")
Copy-Item -LiteralPath (Join-Path $root "dist") -Destination $appDirectory -Recurse -Force
Copy-Item -LiteralPath (Join-Path $root "package.json") -Destination $appDirectory -Force
New-Item -ItemType Directory -Force -Path (Join-Path $appDirectory "node_modules\zod") | Out-Null
$zodSource = (Resolve-Path (Join-Path $root "node_modules\zod")).Path
Copy-Item -Path (Join-Path $zodSource "*") -Destination (Join-Path $appDirectory "node_modules\zod") -Recurse -Force
Copy-Item -Path (Join-Path $root ".runtime\mpv\*") -Destination $mpvDirectory -Recurse -Force
Copy-Item -LiteralPath (Join-Path $root "assets\mpv\input.conf") -Destination $mpvDirectory -Force
Copy-Item -LiteralPath (Join-Path $root "assets\mpv\NOTICE.md") -Destination $mpvDirectory -Force
Copy-Item -LiteralPath (Join-Path $root "legacy-mpv-runtime.json") -Destination $mpvDirectory -Force

Write-Host "Unpacked mpv spike staged at $stage"
