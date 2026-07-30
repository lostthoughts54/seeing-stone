[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$vswhere = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"

function Fail([string]$message) {
  Write-Error $message
  exit 1
}

if ($env:PROCESSOR_ARCHITECTURE -notin @("AMD64", "x86")) {
  Fail "LIBMPV_TOOLCHAIN_ARCH_UNSUPPORTED: Windows x64 is required."
}

if (-not (Test-Path -LiteralPath $vswhere -PathType Leaf)) {
  Fail "LIBMPV_TOOLCHAIN_VSWHERE_MISSING: Visual Studio Installer detection is unavailable."
}

$installation = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $installation) {
  Fail "LIBMPV_TOOLCHAIN_MSVC_MISSING: Modify Visual Studio 2022 or newer to include Desktop development with C++ and a Windows 11 SDK."
}

$vcvars = Join-Path $installation "VC\Auxiliary\Build\vcvars64.bat"
if (-not (Test-Path -LiteralPath $vcvars -PathType Leaf)) {
  Fail "LIBMPV_TOOLCHAIN_VCVARS_MISSING: The detected MSVC installation has no vcvars64.bat."
}

$nodeGyp = Join-Path $root "node_modules\.bin\node-gyp.cmd"
$napiHeaders = Join-Path $root "node_modules\node-addon-api\napi.h"
if (-not (Test-Path -LiteralPath $nodeGyp -PathType Leaf)) {
  Fail "LIBMPV_TOOLCHAIN_NODE_GYP_MISSING: Restore the locked workspace dependencies."
}
if (-not (Test-Path -LiteralPath $napiHeaders -PathType Leaf)) {
  Fail "LIBMPV_TOOLCHAIN_NAPI_HEADERS_MISSING: Restore node-addon-api from pnpm-lock.yaml."
}

$python = if ($env:PYTHON -and (Test-Path -LiteralPath $env:PYTHON -PathType Leaf)) {
  $env:PYTHON
} else {
  $pythonCommand = Get-Command python.exe -ErrorAction SilentlyContinue
  if ($pythonCommand) { $pythonCommand.Source } else {
    Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe"
  }
}
if (-not (Test-Path -LiteralPath $python -PathType Leaf)) {
  Fail "LIBMPV_TOOLCHAIN_PYTHON_MISSING: Python 3 is required by node-gyp; set the PYTHON environment variable to its absolute path."
}

$installedKits = Get-ItemProperty "HKLM:\SOFTWARE\Microsoft\Windows Kits\Installed Roots" -ErrorAction SilentlyContinue
$kitsRoot = if ($installedKits.KitsRoot10) { $installedKits.KitsRoot10 } else { Join-Path ${env:ProgramFiles(x86)} "Windows Kits\10" }
$sdkRoot = Join-Path $kitsRoot "Include"
$sdkVersions = @(Get-ChildItem -LiteralPath $sdkRoot -Directory -ErrorAction SilentlyContinue | Sort-Object Name -Descending)
$sdk = $sdkVersions | Where-Object {
  (Test-Path -LiteralPath (Join-Path $_.FullName "um\d3d11.h")) -and
  (Test-Path -LiteralPath (Join-Path $_.FullName "shared\dxgi1_2.h"))
} | Select-Object -First 1
if (-not $sdk) {
  Fail "LIBMPV_TOOLCHAIN_WINDOWS_SDK_MISSING: A Windows SDK containing d3d11.h and dxgi1_2.h is required."
}

[pscustomobject]@{
  result = "ready"
  architecture = "x64"
  visualStudioInstallation = $installation
  windowsSdk = $sdk.Name
  node = (& node.exe --version)
  electron = (Get-Content -Raw (Join-Path $root "node_modules\electron\package.json") | ConvertFrom-Json).version
  nodeAddonApi = (Get-Content -Raw (Join-Path $root "node_modules\node-addon-api\package.json") | ConvertFrom-Json).version
  python = (& $python --version)
  pythonExecutable = $python
} | ConvertTo-Json
