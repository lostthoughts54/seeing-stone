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
const manifestPath = join(resources, "mpv", "mpv-runtime.json");
const packagedExecutable = join(unpacked, "Seeing Stone Libmpv Test.exe");
const installer = join(
  output,
  `Seeing-Stone-Libmpv-Test-Setup-${packageMetadata.version}-x64.exe`,
);
const acceptanceRoot = join(runtimeRoot, "libmpv-test-package-acceptance");
const userDataRoot = join(acceptanceRoot, "user-data");
const engineDiagnosticsPath = join(userDataRoot, "player-engine-status.json");

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
}

function runPackagedRuntimeVideoSmoke() {
  const electron = join(root, "node_modules", "electron", "dist", "electron.exe");
  requireFile(electron, "controlled Electron test executable");
  const result = spawnSync(electron, [
    "--disable-error-dialogs",
    join(root, "scripts", "libmpv-integrated-transport-smoke.cjs"),
    `--resources=${resources}`,
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

async function verifyPackagedDefaultAndCapability() {
  resetAcceptanceRoot();
  const child = spawn(packagedExecutable, [`--user-data-dir=${userDataRoot}`], {
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

async function main() {
  requireFile(installer, "internal test installer");
  requireFile(packagedExecutable, "packaged executable");
  requireFile(join(resources, "app.asar"), "packaged application archive");
  requireFile(join(libmpvDirectory, "INTERNAL_TESTING_ONLY.md"), "internal-build marker");
  requireFile(manifestPath, "mpv runtime manifest");

  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  assert.equal(manifest.redistributionStatus, "internal-testing-only");
  assert.equal(manifest.libmpv?.status, "ready");
  assert.equal(manifest.libmpv.realVideoGatePassed, true);

  const artifacts = [
    manifest.libmpv.library,
    manifest.libmpv.nativeAddon,
    ...manifest.libmpv.companionDlls,
  ];
  const expectedFiles = new Set([
    "INTERNAL_TESTING_ONLY.md",
    ...artifacts.map((artifact) => artifact.filename),
  ]);

  for (const artifact of artifacts) {
    const path = join(libmpvDirectory, artifact.filename);
    requireFile(path, `libmpv artifact ${artifact.filename}`);
    assert.equal(
      sha256(path),
      artifact.sha256,
      `Hash mismatch for packaged artifact ${artifact.filename}.`,
    );
  }
  assert.deepEqual(
    new Set(readdirSync(libmpvDirectory)),
    expectedFiles,
    "The packaged libmpv directory contains missing or unexpected files.",
  );

  runPackagedRuntimeVideoSmoke();
  const diagnostics = await verifyPackagedDefaultAndCapability();

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
