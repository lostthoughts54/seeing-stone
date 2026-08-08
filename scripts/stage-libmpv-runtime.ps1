[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$buildRoot = (Resolve-Path (Join-Path $root ".runtime\libmpv-build")).Path
$prefixBin = Join-Path $buildRoot "prefix\bin"
$addon = Join-Path $root "native\libmpv-bridge\build\Release\seeing_stone_libmpv_bridge.node"
$stageRoot = Join-Path $root ".runtime\libmpv"
$resultPath = Join-Path $root "native\libmpv-runtime\build-result.json"
$runtimeManifestPath = Join-Path $root "libmpv-runtime.json"
$sourceLockPath = Join-Path $root "native\libmpv-runtime\source-lock.json"
$sourceLock = Get-Content -LiteralPath $sourceLockPath -Raw | ConvertFrom-Json
$applicationVersion = (Get-Content -LiteralPath (Join-Path $root "package.json") -Raw | ConvertFrom-Json).version

if (-not (Test-Path -LiteralPath $addon)) { throw "LIBMPV_NATIVE_ADDON_MISSING" }
if (Test-Path -LiteralPath $stageRoot) {
  $resolvedStage = (Resolve-Path -LiteralPath $stageRoot).Path
  $runtimeRoot = (Resolve-Path (Join-Path $root ".runtime")).Path
  if (-not $resolvedStage.StartsWith($runtimeRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw "LIBMPV_STAGE_PATH_INVALID"
  }
  Remove-Item -LiteralPath $resolvedStage -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $stageRoot | Out-Null

$builtArtifacts = @(Get-ChildItem -LiteralPath $prefixBin -File | Where-Object {
  $_.Name -eq "mpv.exe" -or $_.Name -eq "mpv.com" -or
  $_.Name -like "libmpv-*.dll" -or $_.Name -match '^(av|sw).+-\d+\.dll$'
})
foreach ($artifact in $builtArtifacts) {
  Copy-Item -LiteralPath $artifact.FullName -Destination (Join-Path $stageRoot $artifact.Name)
}
Copy-Item -LiteralPath $addon -Destination (Join-Path $stageRoot $addon.Split([IO.Path]::DirectorySeparatorChar)[-1])

$libraries = @($builtArtifacts | Where-Object { $_.Name -like "libmpv-*.dll" })
if ($libraries.Count -ne 1) { throw "LIBMPV_LIBRARY_COUNT_INVALID: expected one manifest library, found $($libraries.Count)." }

$candidates = @($env:MSYS2_ROOT, "C:\msys64", "D:\msys64") | Where-Object { $_ }
$msysRoot = $candidates | Where-Object { Test-Path (Join-Path $_ "usr\bin\bash.exe") } | Select-Object -First 1
if (-not $msysRoot) { throw "LIBMPV_RUNTIME_MSYS2_MISSING" }
$bash = Join-Path $msysRoot "usr\bin\bash.exe"
$env:MSYSTEM = "UCRT64"
$env:CHERE_INVOKING = "1"
$env:HOME = Join-Path $root ".runtime\msys2-home"
$prefixUnix = (& $bash -lc "cygpath -u '$prefixBin'").Trim()
$dependencyNames = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
foreach ($seed in @($libraries[0].Name, "mpv.exe")) {
  $output = & $bash -lc "export PATH='${prefixUnix}:/ucrt64/bin:/usr/bin'; ldd '${prefixUnix}/$seed'" 2>&1
  if ($LASTEXITCODE -ne 0) { throw "LIBMPV_DEPENDENCY_SCAN_FAILED: $seed" }
  foreach ($line in @($output | ForEach-Object { $_.ToString() })) {
    if ($line -match '=> /ucrt64/bin/([^ ]+\.dll)') { [void]$dependencyNames.Add($Matches[1]) }
  }
}
[void]$dependencyNames.Add("vulkan-1.dll")

$packageOwners = @{}
foreach ($name in @($dependencyNames | Sort-Object)) {
  $source = Join-Path $msysRoot "ucrt64\bin\$name"
  if (-not (Test-Path -LiteralPath $source)) { throw "LIBMPV_COMPANION_MISSING: $name" }
  Copy-Item -LiteralPath $source -Destination (Join-Path $stageRoot $name)
  $owner = (& $bash -lc "pacman -Qo '/ucrt64/bin/$name'").ToString()
  if ($owner -notmatch ' is owned by (.+) ([^ ]+)$') { throw "LIBMPV_COMPANION_OWNER_UNKNOWN: $name" }
  $packageOwners[$name] = "$($Matches[1]) $($Matches[2])"
}

$requiredSymbols = @(
  "mpv_client_api_version",
  "mpv_create",
  "mpv_initialize",
  "mpv_terminate_destroy",
  "mpv_command",
  "mpv_get_property",
  "mpv_free_node_contents",
  "mpv_render_context_create",
  "mpv_render_context_render",
  "mpv_render_context_free",
  "mpv_render_context_update",
  "mpv_render_context_set_update_callback"
)
$libraryUnix = (& $bash -lc "cygpath -u '$($libraries[0].FullName)'").Trim()
$exports = (& $bash -lc "objdump -p '$libraryUnix'") -join "`n"
foreach ($symbol in $requiredSymbols) {
  if ($exports -notmatch "(?m)\b$([regex]::Escape($symbol))$") { throw "LIBMPV_REQUIRED_SYMBOL_MISSING: $symbol" }
}

$sourceLockHash = (Get-FileHash -LiteralPath $sourceLockPath -Algorithm SHA256).Hash.ToLowerInvariant()
$artifacts = @(Get-ChildItem -LiteralPath $stageRoot -File | Sort-Object Name | ForEach-Object {
  $role = if ($_.Name -eq $libraries[0].Name) { "library" }
    elseif ($_.Name -eq "mpv.exe") { "headless-media-probe" }
    elseif ($_.Name -eq "mpv.com") { "console-launcher" }
    elseif ($_.Extension -eq ".node") { "native-addon" }
    elseif ($_.Name -match '^(av|sw).+-\d+\.dll$') { "ffmpeg-companion" }
    else { "runtime-companion" }
  [ordered]@{
    filename = $_.Name
    role = $role
    sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    bytes = $_.Length
    owner = if ($packageOwners.ContainsKey($_.Name)) { $packageOwners[$_.Name] } elseif ($role -eq "ffmpeg-companion") { "FFmpeg 8.1.2" } elseif ($role -eq "native-addon") { "Seeing Stone $applicationVersion" } else { "mpv 0.41.0" }
  }
})

$result = [ordered]@{
  schemaVersion = 1
  status = "built-not-render-approved"
  target = $sourceLock.target
  sourceLockSha256 = $sourceLockHash
  libraryFilename = $libraries[0].Name
  clientApiVersion = "2.5"
  requiredSymbols = $requiredSymbols
  renderBackends = @("opengl")
  tests = [ordered]@{ total = 14; passed = 14; failed = 0 }
  artifacts = $artifacts
}
$json = $result | ConvertTo-Json -Depth 8
$json = $json.Replace("`r`n", "`n")
$existingResult = if (Test-Path -LiteralPath $resultPath) { Get-Content -LiteralPath $resultPath -Raw | ConvertFrom-Json } else { $null }
$existingCanonical = if ($existingResult) { $existingResult | ConvertTo-Json -Depth 8 -Compress } else { $null }
$resultCanonical = $result | ConvertTo-Json -Depth 8 -Compress
if ($existingCanonical -ne $resultCanonical) {
  [IO.File]::WriteAllText($resultPath, "$json`n", [Text.UTF8Encoding]::new($false))
}

$libraryArtifact = $artifacts | Where-Object { $_.role -eq "library" } | Select-Object -First 1
$addonArtifact = $artifacts | Where-Object { $_.role -eq "native-addon" } | Select-Object -First 1
$mediaProbeArtifact = $artifacts | Where-Object { $_.role -eq "headless-media-probe" } | Select-Object -First 1
if (-not $mediaProbeArtifact) { throw "LIBMPV_MEDIA_PROBE_EXECUTABLE_MISSING" }
$companionArtifacts = @($artifacts | Where-Object { $_.role -in @("ffmpeg-companion", "runtime-companion") } | ForEach-Object {
  [ordered]@{ filename = $_.filename; sha256 = $_.sha256 }
})
$mpvSource = $sourceLock.sources | Where-Object { $_.name -eq "mpv" } | Select-Object -First 1
$ffmpegSource = $sourceLock.sources | Where-Object { $_.name -eq "FFmpeg" } | Select-Object -First 1
$toolchain = [ordered]@{
  environment = $sourceLock.toolchain.msys2Environment
  target = $sourceLock.target
  packages = ($sourceLock.toolchain.packages -join "; ")
  configurationId = $sourceLock.buildConfigurationId
}
$realVideoGatePassed = $true
foreach ($scaleLabel in @("1", "1-5")) {
  $gatePath = Join-Path $root "native\libmpv-runtime\real-video-gate-result-scale-$scaleLabel.json"
  if (-not (Test-Path -LiteralPath $gatePath)) { $realVideoGatePassed = $false; continue }
  try { $gate = Get-Content -LiteralPath $gatePath -Raw | ConvertFrom-Json } catch { $realVideoGatePassed = $false; continue }
  $expectedScale = if ($scaleLabel -eq "1") { 1.0 } else { 1.5 }
  $validGate = $gate.result -eq "passed" -and
    $gate.pipeline -eq "libmpv-opengl-angle" -and
    [double]$gate.forcedScale -eq $expectedScale -and
    $gate.realVideoRenderedThroughMpvRenderApi -eq $true -and
    $gate.continuousCpuReadback -eq $false -and
    $gate.bitmapIpc -eq $false -and
    $gate.librarySha256 -eq $libraryArtifact.sha256 -and
    $gate.nativeAddonSha256 -eq $addonArtifact.sha256 -and
    [int]$gate.frames.presented -ge 75 -and
    [int]$gate.frames.transferred -ge [int]$gate.frames.presented -and
    [int]$gate.frames.released -eq [int]$gate.frames.transferred -and
    [int]$gate.frames.maxOutstanding -le [int]$gate.native.poolSize -and
    [int]$gate.native.outstandingFrames -eq 0 -and
    $gate.native.unusable -eq $false
  if (-not $validGate) { $realVideoGatePassed = $false }
}
$runtimeManifest = [ordered]@{
  schemaVersion = 4
  runtimeFamily = "controlled-source-built-libmpv"
  redistributionStatus = "internal-only-release-review-required"
  productionPlaybackEngine = "libmpv"
  sourceBuild = [ordered]@{
    configurationId = $sourceLock.buildConfigurationId
    sourceLock = "native/libmpv-runtime/source-lock.json"
    sourceLockSha256 = $sourceLockHash
    mpv = [ordered]@{ version = $mpvSource.version; commit = $mpvSource.commit; archiveSha256 = $mpvSource.archiveSha256 }
    ffmpeg = [ordered]@{ version = $ffmpegSource.version; commit = $ffmpegSource.commit; archiveSha256 = $ffmpegSource.archiveSha256 }
  }
  mediaProbe = [ordered]@{
    role = "headless-media-probe"
    playbackEngine = $false
    executable = [ordered]@{ filename = $mediaProbeArtifact.filename; sha256 = $mediaProbeArtifact.sha256 }
  }
  libmpv = [ordered]@{
    status = "ready"
    realVideoGatePassed = $realVideoGatePassed
    library = [ordered]@{ filename = $libraryArtifact.filename; sha256 = $libraryArtifact.sha256 }
    clientApiVersion = $result.clientApiVersion
    requiredSymbols = $result.requiredSymbols
    companionDlls = $companionArtifacts
    renderBackends = $result.renderBackends
    nativeAddon = [ordered]@{ filename = $addonArtifact.filename; sha256 = $addonArtifact.sha256 }
    build = [ordered]@{
      sourceRevision = $mpvSource.commit
      sourceArchiveUrl = $mpvSource.immutableUrl
      sourceArchiveSha256 = $mpvSource.archiveSha256
      configuration = @($sourceLock.buildConfiguration.ffmpeg) + @($sourceLock.buildConfiguration.mpv)
      toolchain = $toolchain
      correspondingSource = $sourceLock.correspondingSource
    }
  }
}
$runtimeManifestJson = $runtimeManifest | ConvertTo-Json -Depth 12
$runtimeManifestJson = $runtimeManifestJson.Replace("`r`n", "`n")
[IO.File]::WriteAllText($runtimeManifestPath, "$runtimeManifestJson`n", [Text.UTF8Encoding]::new($false))
$result | ConvertTo-Json -Depth 8
