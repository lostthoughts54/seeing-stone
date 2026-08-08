"use strict";

const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} = require("node:fs");
const { spawn, spawnSync } = require("node:child_process");
const { basename, join, relative, resolve } = require("node:path");
const packageMetadata = require("../package.json");

const root = resolve(__dirname, "..");
const runtimeRoot = join(root, ".runtime");
const outputDirectoryName =
  process.env.SEEING_STONE_LIBMPV_TEST_OUTPUT || "libmpv-test-release";
assert.match(
  outputDirectoryName,
  /^[A-Za-z0-9._-]+$/,
  "The libmpv test output override must be a single controlled directory name.",
);
const output = join(runtimeRoot, outputDirectoryName);
const unpacked = join(output, "win-unpacked");
const resources = join(unpacked, "resources");
const libmpvDirectory = join(resources, "libmpv");
const manifestPath = join(resources, "libmpv", "runtime-manifest.json");
const packagedExecutable = join(unpacked, "Seeing Stone Libmpv Test.exe");
const installer = join(
  output,
  `Seeing-Stone-Libmpv-Test-Setup-${packageMetadata.version}-x64.exe`,
);
const acceptanceRoot = join(runtimeRoot, "libmpv-test-package-acceptance");
const installRoot = join(acceptanceRoot, "install");
const emptyCwd = join(acceptanceRoot, "empty-cwd");
const userDataRoot = join(acceptanceRoot, "user-data");
const engineDiagnosticsPath = join(userDataRoot, "player-engine-status.json");
const installedExecutable = join(installRoot, "Seeing Stone Libmpv Test.exe");
const installedResources = join(installRoot, "resources");

function requireFile(path, description) {
  assert.equal(existsSync(path) && statSync(path).isFile(), true, `Missing ${description}: ${path}`);
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function sanitizedEnvironment() {
  const environment = { ...process.env };
  for (const name of [
    "ELECTRON_RUN_AS_NODE",
    "ELECTRON_ENABLE_LOGGING",
    "ELECTRON_LOG_FILE",
    "NODE_OPTIONS",
    "NODE_PATH",
    "SEEING_STONE_PLAYER",
  ]) delete environment[name];
  return environment;
}

function resetAcceptanceRoot() {
  assert.equal(
    relative(runtimeRoot, acceptanceRoot),
    "libmpv-test-package-acceptance",
    "Refusing to clean outside the controlled acceptance directory.",
  );
  rmSync(acceptanceRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  mkdirSync(userDataRoot, { recursive: true });
  mkdirSync(emptyCwd, { recursive: true });
}

function runPackagedRuntimeVideoSmoke(resourcesRoot) {
  const electron = join(root, "node_modules", "electron", "dist", "electron.exe");
  requireFile(electron, "controlled Electron test executable");
  const result = spawnSync(electron, [
    "--disable-error-dialogs",
    join(root, "scripts", "libmpv-integrated-transport-smoke.cjs"),
    `--resources=${resourcesRoot}`,
  ], {
    cwd: root,
    encoding: "utf8",
    env: sanitizedEnvironment(),
    windowsHide: true,
    timeout: 60000,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  assert.equal(result.signal, null, `Packaged runtime smoke ended with signal ${result.signal}.`);
  assert.equal(result.status, 0, `Packaged runtime smoke failed with exit ${result.status}.`);
}

async function waitForFile(path, timeoutMilliseconds) {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error(`Timed out waiting for ${path}.`);
}

async function waitForMissing(path, timeoutMilliseconds) {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    if (!existsSync(path)) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error(`Timed out waiting for removal of ${path}.`);
}

async function verifyInstalledDefaultAndCapability() {
  const child = spawn(installedExecutable, [`--user-data-dir=${userDataRoot}`], {
    cwd: acceptanceRoot,
    env: sanitizedEnvironment(),
    stdio: "ignore",
    windowsHide: true,
  });
  try {
    await waitForFile(engineDiagnosticsPath, 45000);
    const diagnostics = JSON.parse(readFileSync(engineDiagnosticsPath, "utf8"));
    assert.equal(diagnostics.schemaVersion, 1);
    assert.equal(diagnostics.internalLibMpvTestBuild, true);
    assert.equal(diagnostics.launchSelection, "libmpv");
    assert.equal(diagnostics.active, "libmpv");
    assert.equal(diagnostics.libmpvAvailable, true);
    assert.equal(diagnostics.fallbackActive, false);
    assert.equal(diagnostics.fallbackReason, null);
    return diagnostics;
  } finally {
    if (child.exitCode === null) child.kill();
  }
}

function assertRuntimeLayout(resourcesRoot, manifest, artifacts, expectedFiles) {
  const runtimeLibMpvDirectory = join(resourcesRoot, "libmpv");
  requireFile(join(resourcesRoot, "app.asar"), "packaged application archive");
  requireFile(join(runtimeLibMpvDirectory, "INTERNAL_TESTING_ONLY.md"), "internal-build marker");
  requireFile(join(resourcesRoot, "libmpv", "runtime-manifest.json"), "controlled runtime manifest");
  requireFile(join(resourcesRoot, "mpv", "mpv.exe"), "legacy fallback player");
  for (const artifact of artifacts) {
    const path = join(runtimeLibMpvDirectory, artifact.filename);
    requireFile(path, `libmpv artifact ${artifact.filename}`);
    assert.equal(sha256(path), artifact.sha256, `Hash mismatch for packaged artifact ${artifact.filename}.`);
  }
  assert.deepEqual(
    new Set(readdirSync(runtimeLibMpvDirectory)),
    expectedFiles,
    "The packaged libmpv directory contains missing or unexpected files.",
  );
}

function installArtifact() {
  const result = spawnSync(installer, ["/S", "/currentuser", `/D=${installRoot}`], {
    cwd: emptyCwd,
    encoding: "utf8",
    windowsHide: true,
    timeout: 180000,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  assert.equal(result.signal, null, `NSIS installation ended with signal ${result.signal}.`);
  assert.equal(result.status, 0, `NSIS installation failed with exit ${result.status}.`);
}

function runInstalledFallbackAcceptance() {
  let lastResult = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const result = spawnSync(process.execPath, [
      join(root, "scripts", "mpv-runtime-acceptance.cjs"),
      join(installedResources, "mpv"),
    ], {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
      timeout: 120000,
    });
    lastResult = result;
    if (!result.error && result.signal === null && result.status === 0) {
      if (result.stdout) process.stdout.write(result.stdout);
      return;
    }
    if (attempt === 1) process.stdout.write("Retrying the installed fallback smoke after a transient mpv command failure.\n");
  }
  if (lastResult.stdout) process.stdout.write(lastResult.stdout);
  if (lastResult.stderr) process.stderr.write(lastResult.stderr);
  if (lastResult.error) throw lastResult.error;
  assert.equal(lastResult.signal, null, `Installed fallback smoke ended with signal ${lastResult.signal}.`);
  assert.equal(lastResult.status, 0, `Installed fallback smoke failed with exit ${lastResult.status}.`);
}

function uninstallArtifact() {
  const entry = readdirSync(installRoot, { withFileTypes: true })
    .find((candidate) => candidate.isFile() && /^Uninstall.*\.exe$/i.test(candidate.name));
  assert.ok(entry, "The installed uninstaller is missing.");
  const result = spawnSync(join(installRoot, entry.name), ["/S", "/currentuser"], {
    cwd: emptyCwd,
    encoding: "utf8",
    windowsHide: true,
    timeout: 120000,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `NSIS uninstall failed with exit ${result.status}.`);
}

async function main() {
  resetAcceptanceRoot();
  requireFile(installer, "internal test installer");
  requireFile(packagedExecutable, "packaged executable");
  requireFile(manifestPath, "mpv runtime manifest");

  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  assert.equal(manifest.redistributionStatus, "internal-only-release-review-required");
  assert.equal(manifest.libmpv?.status, "ready");
  assert.equal(manifest.libmpv.realVideoGatePassed, true);

  const artifacts = [
    manifest.libmpv.library,
    manifest.libmpv.nativeAddon,
    ...manifest.libmpv.companionDlls,
    manifest.mediaProbe.executable,
  ];
  const expectedFiles = new Set([
    "INTERNAL_TESTING_ONLY.md",
    "runtime-manifest.json",
    ...artifacts.map((artifact) => artifact.filename),
  ]);

  assertRuntimeLayout(resources, manifest, artifacts, expectedFiles);
  runPackagedRuntimeVideoSmoke(resources);
  installArtifact();
  requireFile(installedExecutable, "installed application executable");
  assertRuntimeLayout(installedResources, manifest, artifacts, expectedFiles);
  runPackagedRuntimeVideoSmoke(installedResources);
  const diagnostics = await verifyInstalledDefaultAndCapability();
  runInstalledFallbackAcceptance();
  uninstallArtifact();
  await waitForMissing(installedExecutable, 60000);

  const installerSha256 = sha256(installer);
  const acceptanceResult = {
    result: "passed",
    installer,
    installerBytes: statSync(installer).size,
    installerSha256,
    libmpvArtifactCount: artifacts.length,
    redistributionStatus: manifest.redistributionStatus,
    packagedDefault: diagnostics.active,
    fallbackActive: diagnostics.fallbackActive,
    installedPackageTested: true,
    bundledPlayers: ["libmpv", "legacy-mpv-fallback"],
  };
  writeFileSync(
    `${installer}.sha256.txt`,
    `${installerSha256}  ${basename(installer)}\n`,
    "utf8",
  );
  writeFileSync(
    join(output, "libmpv-test-acceptance.json"),
    `${JSON.stringify(acceptanceResult, null, 2)}\n`,
    "utf8",
  );
  process.stdout.write(`${JSON.stringify(acceptanceResult, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error?.stack || String(error)}\n`);
  process.exitCode = 1;
});
