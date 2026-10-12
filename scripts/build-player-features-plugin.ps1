param([switch]$Test)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$pluginSdk = $env:SEEING_STONE_DOTNET
if (-not $pluginSdk) {
    $portableSdk = Join-Path $projectRoot '.dotnet9-portable/dotnet.exe'
    if (Test-Path -LiteralPath $portableSdk) { $pluginSdk = $portableSdk }
    else { $pluginSdk = 'dotnet' }
}
Push-Location -LiteralPath $projectRoot
try {
    if ($Test) {
        & $pluginSdk run --project 'plugins/SeeingStone.PlayerFeatures.Tests' --property:RestoreIgnoreFailedSources=true
        if ($LASTEXITCODE -ne 0) { throw 'Plugin regression tests failed.' }
    } else {
        & $pluginSdk publish 'plugins/SeeingStone.YouTubeRooms/SeeingStone.YouTubeRooms.csproj' -c Release -o 'artifacts/SeeingStone.YouTubeRooms'
        if ($LASTEXITCODE -ne 0) { throw 'Plugin build failed. Use a .NET 9 SDK or set SEEING_STONE_DOTNET.' }
        $dll = Join-Path $projectRoot 'artifacts/SeeingStone.YouTubeRooms/SeeingStone.YouTubeRooms.dll'
        $sha = [System.Security.Cryptography.SHA256]::Create()
        try { $hash = [System.BitConverter]::ToString($sha.ComputeHash([System.IO.File]::ReadAllBytes($dll))).Replace('-', '').ToLowerInvariant() }
        finally { $sha.Dispose() }
        [System.IO.File]::WriteAllText(($dll + '.sha256.txt'), ($hash + "  SeeingStone.YouTubeRooms.dll`n"))
    }
} finally { Pop-Location }
