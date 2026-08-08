const { createHash } = require("node:crypto");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");

const root = resolve(__dirname, "..");
const runtimeDirectory = resolve(root, ".runtime", "libmpv");
const buildResult = JSON.parse(readFileSync(resolve(root, "native", "libmpv-runtime", "build-result.json"), "utf8"));
const runtimeManifest = JSON.parse(readFileSync(resolve(root, "libmpv-runtime.json"), "utf8"));
const library = buildResult.artifacts.find((artifact) => artifact.role === "library");
const addon = buildResult.artifacts.find((artifact) => artifact.role === "native-addon");
if (!library || !addon) throw new Error("LIBMPV_SMOKE_MANIFEST_INCOMPLETE");
if (runtimeManifest.libmpv.status !== "ready" || runtimeManifest.libmpv.realVideoGatePassed !== false) {
  throw new Error("LIBMPV_SMOKE_GATE_STATE_INVALID");
}
for (const artifact of [runtimeManifest.libmpv.library, runtimeManifest.libmpv.nativeAddon, ...runtimeManifest.libmpv.companionDlls]) {
  const actual = createHash("sha256").update(readFileSync(resolve(runtimeDirectory, artifact.filename))).digest("hex");
  if (actual !== artifact.sha256) throw new Error("LIBMPV_SMOKE_ARTIFACT_HASH_MISMATCH");
}

const bridge = require(resolve(runtimeDirectory, addon.filename));
const result = bridge.probeLibMpvRuntime({
  libraryPath: resolve(runtimeDirectory, library.filename),
  expectedClientApiVersion: buildResult.clientApiVersion,
  iterations: 10,
});

if (result.completedIterations !== 10 || result.secureAbsoluteLoad !== true ||
    result.requiredRenderSymbolsPresent !== true || result.clientApiVersion !== buildResult.clientApiVersion) {
  throw new Error("LIBMPV_LIFECYCLE_SMOKE_FAILED");
}
let rejectedRelativePath = false;
try {
  bridge.probeLibMpvRuntime({ libraryPath: library.filename, expectedClientApiVersion: buildResult.clientApiVersion, iterations: 1 });
} catch (error) {
  rejectedRelativePath = error instanceof Error && error.message.includes("absolute DLL path");
}
if (!rejectedRelativePath) throw new Error("LIBMPV_RELATIVE_LOAD_WAS_NOT_REJECTED");
process.stdout.write(`${JSON.stringify(result)}\n`);
