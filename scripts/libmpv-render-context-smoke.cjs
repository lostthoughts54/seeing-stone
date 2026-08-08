const { createHash } = require("node:crypto");
const { readFileSync, writeFileSync } = require("node:fs");
const { dirname, resolve } = require("node:path");

const root = resolve(__dirname, "..");
const runtimeDirectory = resolve(root, ".runtime", "libmpv");
const sourceLock = JSON.parse(readFileSync(resolve(root, "native", "libmpv-runtime", "source-lock.json"), "utf8"));
const runtimeManifest = JSON.parse(readFileSync(resolve(root, "libmpv-runtime.json"), "utf8"));
const electronPackagePath = require.resolve("electron/package.json");
const electronPackage = JSON.parse(readFileSync(electronPackagePath, "utf8"));
const angleDirectory = resolve(dirname(electronPackagePath), "dist");
const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

if (runtimeManifest.libmpv.status !== "ready" || runtimeManifest.libmpv.realVideoGatePassed !== false) {
  throw new Error("LIBMPV_RENDER_CONTEXT_GATE_STATE_INVALID");
}
for (const artifact of [runtimeManifest.libmpv.library, runtimeManifest.libmpv.nativeAddon, ...runtimeManifest.libmpv.companionDlls]) {
  if (sha256(resolve(runtimeDirectory, artifact.filename)) !== artifact.sha256) {
    throw new Error("LIBMPV_RENDER_CONTEXT_ARTIFACT_HASH_MISMATCH");
  }
}

const bridge = require(resolve(runtimeDirectory, runtimeManifest.libmpv.nativeAddon.filename));
const lifecycle = bridge.probeLibMpvRuntime({
  libraryPath: resolve(runtimeDirectory, runtimeManifest.libmpv.library.filename),
  expectedClientApiVersion: runtimeManifest.libmpv.clientApiVersion,
  iterations: 10,
});
const renderContext = bridge.probeLibMpvRenderContext({
  libraryPath: resolve(runtimeDirectory, runtimeManifest.libmpv.library.filename),
  angleDirectory,
  expectedClientApiVersion: runtimeManifest.libmpv.clientApiVersion,
  iterations: 10,
});
if (!renderContext.d3d11Device || !renderContext.shareableBgraTexture ||
    !renderContext.angleTextureSurface || !renderContext.renderContextLifecycle) {
  throw new Error("LIBMPV_RENDER_CONTEXT_GATE_FAILED");
}

const angleSource = sourceLock.referenceSources.find((source) => source.name.startsWith("ANGLE"));
if (!angleSource) throw new Error("LIBMPV_ANGLE_SOURCE_LOCK_MISSING");
const angleArtifacts = ["libEGL.dll", "libGLESv2.dll", "d3dcompiler_47.dll", "dxcompiler.dll", "dxil.dll"]
  .map((filename) => ({ filename, sha256: sha256(resolve(angleDirectory, filename)) }));
const result = {
  schemaVersion: 1,
  status: "passed",
  electronVersion: electronPackage.version,
  chromiumVersion: "150.0.7871.47",
  angleSourceRevision: angleSource.commit,
  angleSourceArchiveUrl: angleSource.immutableUrl,
  angleSourceArchiveSha256: angleSource.archiveSha256,
  angleArtifacts,
  lifecycle,
  renderContext,
  realVideoRendered: false,
};
const output = resolve(root, "native", "libmpv-runtime", "render-context-gate-result.json");
writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify(result)}\n`);
