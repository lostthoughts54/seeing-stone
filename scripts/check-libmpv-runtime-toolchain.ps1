[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"

function Fail([string]$Message) {
  Write-Error $Message
  exit 1
}

$candidates = @($env:MSYS2_ROOT, "C:\msys64", "D:\msys64") | Where-Object { $_ }
$msysRoot = $candidates | Where-Object {
  (Test-Path (Join-Path $_ "usr\bin\bash.exe")) -and
  (Test-Path (Join-Path $_ "usr\bin\pacman.exe"))
} | Select-Object -First 1

if (-not $msysRoot) {
  Fail "LIBMPV_RUNTIME_MSYS2_MISSING: install MSYS2 in C:\msys64 or D:\msys64, or set MSYS2_ROOT to its absolute path. No libmpv artifacts may be downloaded as a substitute."
}

$bash = Join-Path $msysRoot "usr\bin\bash.exe"
$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$msysHome = Join-Path $repositoryRoot ".runtime\msys2-home"
New-Item -ItemType Directory -Force -Path $msysHome | Out-Null
$probe = @'
set -eu
for tool in git cmake ninja python3 curl tar; do
  command -v "$tool" >/dev/null || { echo "missing:$tool"; exit 2; }
done
printf 'msystem=%s\n' "$MSYSTEM"
printf 'bash=%s\n' "$BASH_VERSION"
git --version
cmake --version | head -n 1
ninja --version
python3 --version
'@

$savedErrorActionPreference = $ErrorActionPreference
$savedHome = $env:HOME
$savedChereInvoking = $env:CHERE_INVOKING
$ErrorActionPreference = "Continue"
$env:HOME = $msysHome
$env:CHERE_INVOKING = "1"
try {
  $output = & $bash -lc $probe 2>&1
  $probeExitCode = $LASTEXITCODE
} finally {
  $ErrorActionPreference = $savedErrorActionPreference
  $env:HOME = $savedHome
  $env:CHERE_INVOKING = $savedChereInvoking
}
$outputLines = @($output | ForEach-Object { $_.ToString() })
if ($probeExitCode -ne 0) {
  $details = ($outputLines -join [Environment]::NewLine).Trim()
  Fail "LIBMPV_RUNTIME_TOOLS_MISSING: the controlled MSYS2 environment is incomplete. $details"
}
$toolLines = @($outputLines | Where-Object {
  $_ -match '^(msystem=|bash=|git version |cmake version |[0-9]+\.[0-9]+(?:\.[0-9]+)?$|Python )'
})

[ordered]@{
  status = "ready"
  msys2Root = $msysRoot
  tools = $toolLines
} | ConvertTo-Json -Depth 4
