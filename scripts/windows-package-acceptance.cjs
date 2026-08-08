"use strict";

const assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const {
  closeSync,
  createReadStream,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  rmSync,
  statSync,
} = require("node:fs");
const { join, relative, resolve } = require("node:path");
const { extractFile, listPackage } = require("@electron/asar");
const {
  FuseState,
  FuseV1Options,
  getCurrentFuseWire,
} = require("@electron/fuses");

const root = resolve(__dirname, "..");
const runtimeRoot = join(root, ".runtime");
const releaseRoot = join(runtimeRoot, "release");
const acceptanceRoot = join(runtimeRoot, "package-acceptance");
const installRoot = join(acceptanceRoot, "install");
const userDataRoot = join(acceptanceRoot, "user-data");
const emptyCwd = join(acceptanceRoot, "empty-cwd");
const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const installer = join(releaseRoot, `Seeing-Stone-Setup-${packageJson.version}-x64.exe`);
const unpackedRoot = join(releaseRoot, "win-unpacked");
const unpackedExecutable = join(unpackedRoot, "Seeing Stone.exe");
const installedExecutable = join(installRoot, "Seeing Stone.exe");
const expectedTitle = "Seeing Stone";

void main().catch((error) => {
  process.stderr.write(`${error?.stack || String(error)}\n`);
  process.stderr.write(`Acceptance files were retained at ${acceptanceRoot} for diagnosis.\n`);
  process.exitCode = 1;
});

async function main() {
  assert.equal(process.platform, "win32", "Windows package acceptance must run on Windows.");
  requireFile(installer);
  requireFile(unpackedExecutable);
  assertNoExistingInstallation();
  assertNoExistingShortcuts();
  safelyResetAcceptanceRoot();
  mkdirSync(userDataRoot, { recursive: true });
  mkdirSync(emptyCwd, { recursive: true });

  const artifact = {
    path: installer,
    bytes: statSync(installer).size,
    sha256: await sha256(installer),
    authenticode: authenticodeStatus(installer),
  };
  assert.equal(readPeMachine(unpackedExecutable), 0x8664, "Packaged application is not x64.");
  assertVersionInfo(unpackedExecutable);
  assertPackagedResources(unpackedRoot);
  await assertHardenedFuses(unpackedExecutable);

  installArtifact();
  requireFile(installedExecutable);
  assertVersionInfo(installedExecutable);
  assertPackagedResources(installRoot);
  await assertHardenedFuses(installedExecutable);
  assertInstalledRegistryLocation();
  assert.equal(listInstalledProcesses().length, 0, "The isolated installed app was already running.");

  const firstIdentity = await launchAndVerifyInstalledApp(true);
  const secondIdentity = await launchAndVerifyInstalledApp(false);
  assert.equal(secondIdentity, firstIdentity, "The packaged device ID changed across restart.");

  runInstalledMpvAcceptance();
  uninstallArtifact();
  await waitFor(() => !existsSync(installedExecutable), 60000, "installed executable removal");
  assert.equal(existsSync(userDataRoot), true, "Uninstall removed the isolated user-data directory.");
  assert.equal(readDeviceId(), firstIdentity, "Uninstall altered the persisted device identity.");
  await waitFor(() => queryInstallations().length === 0, 60000, "uninstall registry entry removal");
  assertNoExistingShortcuts();

  process.stdout.write(`${JSON.stringify({
    result: "passed",
    version: packageJson.version,
    architecture: "x64",
    installer: artifact,
    installedMpv: join(installRoot, "resources", "mpv", "mpv.exe"),
    deviceIdentityStable: true,
    userDataRetainedAfterUninstall: true,
    gracefulClose: "not automated; isolated test processes were stopped after each launch",
  }, null, 2)}\n`);

  safelyResetAcceptanceRoot();
}

function assertPackagedResources(applicationRoot) {
  const resources = join(applicationRoot, "resources");
  const asarPath = join(resources, "app.asar");
  const workerPath = join(resources, "app.asar.unpacked", "dist", "main", "services", "persistenceWorker.js");
  const workerTypesPath = join(resources, "app.asar.unpacked", "dist", "main", "services", "persistenceTypes.js");
  const mpvRoot = join(resources, "mpv");
  const libMpvRoot = join(resources, "libmpv");
  const manifestPath = join(mpvRoot, "mpv-runtime.json");

  for (const file of [
    join(applicationRoot, "LICENSE.electron.txt"),
    join(applicationRoot, "LICENSES.chromium.html"),
    join(applicationRoot, "resources.pak"),
    join(applicationRoot, "icudtl.dat"),
    join(applicationRoot, "snapshot_blob.bin"),
    join(applicationRoot, "v8_context_snapshot.bin"),
    asarPath,
    workerPath,
    workerTypesPath,
    join(mpvRoot, "mpv.exe"),
    join(mpvRoot, "mpv.com"),
    join(mpvRoot, "vulkan-1.dll"),
    join(mpvRoot, "input.conf"),
    join(mpvRoot, "NOTICE.md"),
    manifestPath,
  ]) requireFile(file);

  assert.equal(existsSync(join(resources, "app")), false, "A loose application directory was packaged.");
  assert.equal(existsSync(join(resources, "default_app.asar")), false, "Electron's default application was packaged.");

  const asarEntries = listPackage(asarPath).map((entry) => entry.replaceAll("\\", "/"));
  for (const expected of [
    "/dist/main/index.js",
    "/dist/preload/index.js",
    "/dist/renderer/index.html",
    "/dist/main/services/persistence-worker-integrity.json",
    "/package.json",
  ]) assert.equal(asarEntries.includes(expected), true, `${expected} is missing from app.asar.`);
  assert.equal(asarEntries.some((entry) => entry.startsWith("/node_modules/zod/")), true, "The Zod runtime is missing from app.asar.");
  assert.equal(asarEntries.some((entry) => entry.startsWith("/node_modules/ws/")), true, "The SyncPlay WebSocket runtime is missing from app.asar.");
  assert.equal(asarEntries.some((entry) => entry.startsWith("/src/") || entry.startsWith("/tests/") || entry.startsWith("/tests-node/")), false, "Development source or tests were packaged.");
  assert.equal(asarEntries.some((entry) => entry.startsWith("/dist/") && entry.endsWith(".map")), false, "Application source maps were packaged.");
  assert.equal(asarEntries.some((entry) => entry === "/app.js" || entry === "/server.js"), false, "The imported prototype source was packaged loose.");

  const workerIntegrity = JSON.parse(extractFile(
    asarPath,
    join("dist", "main", "services", "persistence-worker-integrity.json"),
  ).toString("utf8"));
  assert.equal(workerIntegrity.schemaVersion, 1);
  assert.equal(workerIntegrity.algorithm, "sha256");
  for (const file of ["persistenceWorker.js", "persistenceTypes.js"]) {
    assert.equal(
      hashFileSync(join(resources, "app.asar.unpacked", "dist", "main", "services", file)),
      workerIntegrity.files[file],
      `Unpacked worker integrity mismatch: ${file}`,
    );
  }

  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  assert.match(manifest.version, /^v0\.41\.0/);
  assert.equal(manifest.commit, "e5486b96d7d06dd148337899bfdc46bf25101663");
  assert.ok(Array.isArray(manifest.licenseFiles) && manifest.licenseFiles.length >= 8, "The verified mpv notice manifest is incomplete.");
  for (const license of manifest.licenseFiles) {
    const licensePath = join(mpvRoot, "licenses", license.path);
    requireFile(licensePath);
    assert.equal(hashFileSync(licensePath), license.sha256, `Packaged license checksum mismatch: ${license.path}`);
  }

  assert.equal(manifest.libmpv?.status, "ready", "The packaged runtime manifest does not declare libmpv ready.");
  assert.equal(manifest.libmpv.realVideoGatePassed, true, "The packaged libmpv runtime has not passed the real-video gate.");
  const libMpvArtifacts = [
    manifest.libmpv.library,
    manifest.libmpv.nativeAddon,
    ...manifest.libmpv.companionDlls,
  ];
  const expectedLibMpvFiles = new Set(libMpvArtifacts.map((artifact) => artifact.filename));
  for (const artifact of libMpvArtifacts) {
    const artifactPath = join(libMpvRoot, artifact.filename);
    requireFile(artifactPath);
    assert.equal(hashFileSync(artifactPath), artifact.sha256, `Packaged libmpv checksum mismatch: ${artifact.filename}`);
  }
  assert.deepEqual(new Set(readdirSync(libMpvRoot)), expectedLibMpvFiles, "The packaged libmpv directory contains missing or unexpected files.");
}

async function assertHardenedFuses(executable) {
  const wire = await getCurrentFuseWire(executable);
  const expected = new Map([
    [FuseV1Options.RunAsNode, FuseState.DISABLE],
    [FuseV1Options.EnableCookieEncryption, FuseState.ENABLE],
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable, FuseState.DISABLE],
    [FuseV1Options.EnableNodeCliInspectArguments, FuseState.DISABLE],
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation, FuseState.ENABLE],
    [FuseV1Options.OnlyLoadAppFromAsar, FuseState.ENABLE],
    [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot, FuseState.DISABLE],
    [FuseV1Options.GrantFileProtocolExtraPrivileges, FuseState.DISABLE],
    [FuseV1Options.WasmTrapHandlers, FuseState.ENABLE],
  ]);
  for (const [fuse, state] of expected) assert.equal(wire[fuse], state, `Unexpected Electron fuse state at index ${fuse}.`);
}

function installArtifact() {
  const result = spawnSync(installer, ["/S", "/currentuser", `/D=${installRoot}`], {
    cwd: emptyCwd,
    encoding: "utf8",
    windowsHide: true,
    timeout: 180000,
  });
  assertChildSucceeded(result, "NSIS installation");
}

async function launchAndVerifyInstalledApp(checkSecondInstance) {
  const child = spawn(installedExecutable, [`--user-data-dir=${userDataRoot}`], {
    cwd: emptyCwd,
    env: sanitizedEnvironment(),
    stdio: "ignore",
    windowsHide: false,
  });
  let mainPid = null;
  try {
    const windowState = await waitForWindow(45000);
    mainPid = windowState.pid;
    assert.equal(windowState.title, expectedTitle);
    assert.equal(windowState.responding, true);
    await waitFor(() => existsSync(join(userDataRoot, "device-identity.json")), 15000, "device identity creation");
    await waitFor(() => existsSync(join(userDataRoot, "localfirst.sqlite3")), 15000, "SQLite database creation");
    assertSqliteHeader(join(userDataRoot, "localfirst.sqlite3"));
    await waitForRenderedInterface(windowState.handle, 30000);
    const identity = readDeviceId();

    if (checkSecondInstance) {
      const duplicate = spawn(installedExecutable, [`--user-data-dir=${userDataRoot}`], {
        cwd: emptyCwd,
        env: sanitizedEnvironment(),
        stdio: "ignore",
        windowsHide: true,
      });
      await waitForProcessExit(duplicate, 15000, "second packaged instance");
      assert.equal(listInstalledProcesses().some((process) => process.pid === mainPid && process.handle !== 0), true, "The primary packaged instance exited when a second instance started.");
      // Let Electron's queued second-instance focus event settle before ending
      // this isolated single-instance probe.
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 1000));
      // End the single-instance probe without racing its focus event against
      // the separate graceful-close probe on the next restart.
      stopInstalledProcesses();
      await waitFor(() => listInstalledProcesses().length === 0, 15000, "single-instance probe shutdown");
      return identity;
    }

    stopInstalledProcesses();
    await waitFor(() => listInstalledProcesses().length === 0, 15000, "restart probe shutdown");
    return identity;
  } finally {
    if (listInstalledProcesses().length > 0) stopInstalledProcesses();
    if (child.exitCode === null) child.kill();
  }
}

function runInstalledMpvAcceptance() {
  const result = spawnSync(process.execPath, [
    join(root, "scripts", "mpv-runtime-acceptance.cjs"),
    join(installRoot, "resources", "mpv"),
  ], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    timeout: 120000,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  assertChildSucceeded(result, "installed mpv runtime acceptance");
}

function uninstallArtifact() {
  const uninstaller = readdirSync(installRoot, { withFileTypes: true })
    .find((entry) => entry.isFile() && /^Uninstall.*\.exe$/i.test(entry.name));
  assert.ok(uninstaller, "The installed uninstaller is missing.");
  const result = spawnSync(join(installRoot, uninstaller.name), ["/S", "/currentuser"], {
    cwd: emptyCwd,
    encoding: "utf8",
    windowsHide: true,
    timeout: 120000,
  });
  assertChildSucceeded(result, "NSIS uninstall");
}

function assertNoExistingInstallation() {
  const installations = queryInstallations();
  assert.deepEqual(installations, [], `A Seeing Stone installation already exists: ${JSON.stringify(installations)}`);
}

function queryInstallations() {
  const script = String.raw`
$paths = @(
  'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
  'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
  'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
)
$found = @(
  foreach ($path in $paths) {
    Get-ItemProperty -Path $path -ErrorAction SilentlyContinue |
      Where-Object { $_.DisplayName -like 'Seeing Stone*' } |
      Select-Object DisplayName, InstallLocation, UninstallString
  }
)
ConvertTo-Json -Compress -InputObject @($found)
`;
  const output = runPowerShell(script).trim();
  if (!output) return [];
  const parsed = JSON.parse(output);
  return Array.isArray(parsed) ? parsed : [parsed];
}

function assertInstalledRegistryLocation() {
  const installations = queryInstallations();
  assert.equal(installations.length, 1, "Expected one per-user uninstall registry entry.");
  const expectedUninstaller = join(installRoot, "Uninstall Seeing Stone.exe");
  assert.equal(
    String(installations[0].UninstallString || "").includes(expectedUninstaller),
    true,
    "Installer registered an unexpected uninstall location.",
  );
}

function assertNoExistingShortcuts() {
  const script = String.raw`
$desktop = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Seeing Stone.lnk'
$start = Join-Path ([Environment]::GetFolderPath('Programs')) 'Seeing Stone.lnk'
[pscustomobject]@{ Desktop = Test-Path -LiteralPath $desktop; StartMenu = Test-Path -LiteralPath $start } | ConvertTo-Json -Compress
`;
  const state = JSON.parse(runPowerShell(script));
  assert.equal(state.Desktop, false, "An existing desktop shortcut would be overwritten.");
  assert.equal(state.StartMenu, false, "An existing Start Menu shortcut would be overwritten.");
}

function assertVersionInfo(executable) {
  const script = String.raw`
$version = (Get-Item -LiteralPath $args[0]).VersionInfo
[pscustomobject]@{
  ProductName = $version.ProductName
  FileDescription = $version.FileDescription
  ProductVersion = $version.ProductVersion
  FileVersion = $version.FileVersion
} | ConvertTo-Json -Compress
`;
  const info = JSON.parse(runPowerShell(script, [executable]));
  assert.equal(info.ProductName, expectedTitle);
  assert.equal(info.FileDescription, expectedTitle);
  assert.match(String(info.ProductVersion), new RegExp(`^${escapeRegExp(packageJson.version)}`));
  assert.match(String(info.FileVersion), new RegExp(`^${escapeRegExp(packageJson.version)}`));
}

function authenticodeStatus(path) {
  const script = "(Get-AuthenticodeSignature -LiteralPath $args[0]).Status.ToString()";
  return runPowerShell(script, [path]).trim();
}

async function waitForWindow(timeout) {
  let state = null;
  await waitFor(() => {
    state = listInstalledProcesses().find((process) => process.handle !== 0 && process.title === expectedTitle && process.responding === true) || null;
    return state !== null;
  }, timeout, "visible packaged window");
  return state;
}

function listInstalledProcesses() {
  const script = String.raw`
$target = [IO.Path]::GetFullPath($args[0])
$found = @(
  Get-Process -ErrorAction SilentlyContinue | Where-Object {
    try { [IO.Path]::GetFullPath($_.Path) -eq $target } catch { $false }
  } | ForEach-Object {
    [pscustomobject]@{
      pid = $_.Id
      handle = [int64]$_.MainWindowHandle
      title = $_.MainWindowTitle
      responding = $_.Responding
    }
  }
)
ConvertTo-Json -Compress -InputObject @($found)
`;
  const output = runPowerShell(script, [installedExecutable], 10000).trim();
  if (!output) return [];
  const parsed = JSON.parse(output);
  return Array.isArray(parsed) ? parsed : [parsed];
}

function measureRendererPixels(handle) {
  const capturePath = join(acceptanceRoot, "renderer-capture.png");
  const script = String.raw`
Add-Type -AssemblyName System.Drawing
$definition = 'using System; using System.Runtime.InteropServices; public static class LocalFirstRendererCapture { [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; } [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out RECT rect); [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd); }'
Add-Type -TypeDefinition $definition
$handle = [IntPtr]::new([int64]$args[0])
[void][LocalFirstRendererCapture]::SetForegroundWindow($handle)
Start-Sleep -Milliseconds 250
$rect = New-Object LocalFirstRendererCapture+RECT
if (-not [LocalFirstRendererCapture]::GetWindowRect($handle, [ref]$rect)) { throw 'Could not read packaged window bounds.' }
$width = $rect.Right - $rect.Left
$height = $rect.Bottom - $rect.Top
if ($width -lt 320 -or $height -lt 240) { throw 'Packaged window was unexpectedly small.' }
$bitmap = New-Object System.Drawing.Bitmap($width, $height)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.CopyFromScreen($rect.Left, $rect.Top, 0, 0, $bitmap.Size)
$bitmap.Save($args[1], [System.Drawing.Imaging.ImageFormat]::Png)
$colors = New-Object 'System.Collections.Generic.HashSet[string]'
$nonBlack = 0
$pixels = 0
$stepX = [Math]::Max(1, [Math]::Floor($width / 160))
$stepY = [Math]::Max(1, [Math]::Floor(($height - 48) / 90))
for ($y = 48; $y -lt $height; $y += $stepY) {
  for ($x = 0; $x -lt $width; $x += $stepX) {
    $color = $bitmap.GetPixel($x, $y)
    if (($color.R + $color.G + $color.B) -ge 24) { $nonBlack += 1 }
    [void]$colors.Add("$([int]($color.R / 16)):$([int]($color.G / 16)):$([int]($color.B / 16))")
    $pixels += 1
  }
}
$graphics.Dispose()
$bitmap.Dispose()
[pscustomobject]@{
  nonBlackRatio = if ($pixels -gt 0) { $nonBlack / $pixels } else { 0 }
  uniqueColors = $colors.Count
  width = $width
  height = $height
} | ConvertTo-Json -Compress
`;
  return JSON.parse(runPowerShell(script, [String(handle), capturePath], 30000));
}

async function waitForRenderedInterface(handle, timeout) {
  const deadline = Date.now() + timeout;
  let pixels = null;
  while (Date.now() < deadline) {
    pixels = measureRendererPixels(handle);
    if (pixels.nonBlackRatio >= 0.15 && pixels.uniqueColors >= 32) return pixels;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
  }
  assert.fail(`Packaged renderer did not leave its startup frame: ${JSON.stringify(pixels)}`);
}

function stopInstalledProcesses() {
  const script = String.raw`
$target = [IO.Path]::GetFullPath($args[0])
Get-Process -ErrorAction SilentlyContinue | Where-Object {
  try { [IO.Path]::GetFullPath($_.Path) -eq $target } catch { $false }
} | Stop-Process -Force
`;
  runPowerShell(script, [installedExecutable]);
}

function runPowerShell(script, args = [], timeout = 30000) {
  const wrapper = `$decodedArguments = ConvertFrom-Json -InputObject $env:LF_ACCEPTANCE_ARGUMENTS\n[string[]]$arguments = @($decodedArguments | ForEach-Object { [string]$_ })\n& {\n${script}\n} @arguments`;
  const encodedCommand = Buffer.from(wrapper, "utf16le").toString("base64");
  const result = spawnSync("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-EncodedCommand",
    encodedCommand,
  ], {
    encoding: "utf8",
    env: { ...process.env, LF_ACCEPTANCE_ARGUMENTS: JSON.stringify(args) },
    windowsHide: true,
    timeout,
  });
  assertChildSucceeded(result, "PowerShell acceptance query");
  return result.stdout || "";
}

function sanitizedEnvironment() {
  const environment = { ...process.env };
  for (const name of [
    "ELECTRON_RUN_AS_NODE",
    "ELECTRON_ENABLE_LOGGING",
    "ELECTRON_LOG_FILE",
    "NODE_OPTIONS",
    "NODE_PATH",
  ]) delete environment[name];
  const windows = environment.SystemRoot || environment.WINDIR || "C:\\Windows";
  environment.PATH = [join(windows, "System32"), windows].join(";");
  return environment;
}

function safelyResetAcceptanceRoot() {
  const resolvedRuntime = resolve(runtimeRoot);
  const resolvedAcceptance = resolve(acceptanceRoot);
  const child = relative(resolvedRuntime, resolvedAcceptance);
  assert.equal(child, "package-acceptance", "Refusing to clean outside .runtime/package-acceptance.");
  if (existsSync(resolvedAcceptance)) {
    assert.equal(lstatSync(resolvedAcceptance).isSymbolicLink(), false, "Refusing to clean a linked acceptance directory.");
    rmSync(resolvedAcceptance, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

function readDeviceId() {
  const identity = JSON.parse(readFileSync(join(userDataRoot, "device-identity.json"), "utf8"));
  assert.match(identity.deviceId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  return identity.deviceId;
}

function assertSqliteHeader(databasePath) {
  const bytes = readFileSync(databasePath);
  assert.ok(bytes.length >= 4096, "Packaged SQLite database is unexpectedly small.");
  assert.equal(bytes.subarray(0, 16).toString("binary"), "SQLite format 3\u0000");
}

function readPeMachine(executable) {
  const file = openSync(executable, "r");
  try {
    const header = Buffer.alloc(4096);
    readSync(file, header, 0, header.length, 0);
    assert.equal(header.subarray(0, 2).toString("ascii"), "MZ");
    const peOffset = header.readUInt32LE(0x3c);
    assert.equal(header.subarray(peOffset, peOffset + 4).toString("binary"), "PE\u0000\u0000");
    return header.readUInt16LE(peOffset + 4);
  } finally {
    closeSync(file);
  }
}

function requireFile(path) {
  assert.equal(existsSync(path), true, `Required packaged file is missing: ${path}`);
  assert.equal(statSync(path).isFile(), true, `Required packaged path is not a file: ${path}`);
}

function hashFileSync(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function sha256(path) {
  return new Promise((resolveHash, rejectHash) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("error", rejectHash);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolveHash(hash.digest("hex")));
  });
}

function assertChildSucceeded(result, label) {
  if (result.error) throw result.error;
  assert.equal(result.signal, null, `${label} ended with signal ${result.signal}.`);
  assert.equal(result.status, 0, `${label} failed (${result.status}).\n${result.stdout || ""}\n${result.stderr || ""}`);
}

function waitForProcessExit(child, timeout, label) {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolveExit, rejectExit) => {
    const timer = setTimeout(() => rejectExit(new Error(`Timed out waiting for ${label}.`)), timeout);
    child.once("exit", () => {
      clearTimeout(timer);
      resolveExit();
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      rejectExit(error);
    });
  });
}

async function waitFor(predicate, timeout, label) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
