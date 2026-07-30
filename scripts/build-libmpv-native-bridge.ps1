[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
& (Join-Path $PSScriptRoot "check-libmpv-native-toolchain.ps1") | Out-Host
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$vswhere = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"
$installation = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
$vcvars = Join-Path $installation "VC\Auxiliary\Build\vcvars64.bat"
$nodeGyp = Join-Path $root "node_modules\.bin\node-gyp.cmd"
$bridge = Join-Path $root "native\libmpv-bridge"
$nodeGypCache = Join-Path $root ".runtime\node-gyp"
$python = if ($env:PYTHON -and (Test-Path -LiteralPath $env:PYTHON -PathType Leaf)) {
  $env:PYTHON
} else {
  $pythonCommand = Get-Command python.exe -ErrorAction SilentlyContinue
  if ($pythonCommand) { $pythonCommand.Source } else {
    Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe"
  }
}

$command = "`"$vcvars`" && set `"PYTHON=$python`" && `"$nodeGyp`" rebuild --directory `"$bridge`" --arch=x64 --devdir=`"$nodeGypCache`""
& $env:ComSpec /d /s /c $command
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
