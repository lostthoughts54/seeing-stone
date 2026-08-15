import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const readJson = async (path) => JSON.parse(await readFile(resolve(root, path), "utf8"));

const [packageJson, compliance, build, sourceLock] = await Promise.all([
  readJson("package.json"),
  readJson("redistribution-compliance.json"),
  readJson("native/libmpv-runtime/build-result.json"),
  readJson("native/libmpv-runtime/source-lock.json"),
]);

const sourcesByFilename = new Map(compliance.sourceArchives.map((source) => [source.filename, source]));
const componentsByOwner = new Map(compliance.components.map((component) => [component.owner, component]));
const artifactsByOwner = Map.groupBy(build.artifacts, (artifact) => artifact.owner);

const dependencies = [...artifactsByOwner.entries()].map(([owner, artifacts]) => {
  const component = componentsByOwner.get(owner);
  if (!component) throw new Error(`PROVENANCE_COMPONENT_MISSING: ${owner}`);
  const source = sourcesByFilename.get(component.sourceArchive);
  if (!source) throw new Error(`PROVENANCE_SOURCE_ARCHIVE_MISSING: ${owner}`);

  const isMpv = owner === `mpv ${sourceLock.sources.find((entry) => entry.name === "mpv")?.version}`;
  const isFfmpeg = owner === `FFmpeg ${sourceLock.sources.find((entry) => entry.name === "FFmpeg")?.version}`;
  const isApplication = component.id === "seeing-stone";
  const exactCommit = component.revision
    ?? `MSYS2 source package ${component.version}, archive pinned by SHA-256 ${source.sha256}`;
  const buildFlags = isMpv
    ? sourceLock.buildConfiguration.mpv
    : isFfmpeg
      ? sourceLock.buildConfiguration.ffmpeg
      : isApplication
        ? ["NAPI_DISABLE_CPP_EXCEPTIONS", "C++20", "x64", "Release"]
        : [`MSYS2 UCRT64 PKGBUILD and patches included in ${source.filename}`];
  const buildScripts = isApplication
    ? [
        "native/libmpv-bridge/binding.gyp",
        "scripts/check-libmpv-native-toolchain.ps1",
        "scripts/build-libmpv-native-bridge.ps1",
        "scripts/stage-libmpv-runtime.ps1",
      ]
    : sourceLock.buildScripts;

  return {
    owner,
    upstreamProject: component.name,
    immutableSourceUrl: source.url,
    version: component.version,
    exactCommit,
    sourceArchive: source.filename,
    sourceArchiveSha256: source.sha256,
    license: component.license,
    redistributionStatus: component.obligation === "source-required"
      ? "source-and-binary; corresponding source included"
      : "binary notices plus voluntarily included source",
    correspondingSource: `source-archives/${source.filename} inside Seeing-Stone-${packageJson.version}-corresponding-source.zip`,
    applicationRelease: packageJson.version,
    binaryHashes: artifacts.map((artifact) => `${artifact.filename} sha256:${artifact.sha256}`),
    buildFlags,
    toolchainVersions: isApplication
      ? ["Visual Studio Community 18.8.0 MSVC x64", "Windows SDK 10.0.28000.0", "node-gyp 12.4.0", "node-addon-api 8.5.0"]
      : [sourceLock.toolchain.msys2Environment, ...sourceLock.toolchain.packages],
    requiredRuntimeDlls: artifacts.map((artifact) => artifact.filename),
    patches: sourceLock.patches,
    buildScripts,
  };
}).sort((left, right) => left.owner.localeCompare(right.owner));

const output = {
  schemaVersion: 1,
  application: `Seeing Stone ${packageJson.version}`,
  binaryInventory: "native/libmpv-runtime/build-result.json",
  sourceManifest: "redistribution-compliance.json",
  dependencies,
};

await writeFile(
  resolve(root, "native/libmpv-runtime/dependency-provenance.json"),
  `${JSON.stringify(output, null, 2)}\n`,
  "utf8",
);
process.stdout.write(`LIBMPV_DEPENDENCY_PROVENANCE_READY (${dependencies.length} runtime owners)\n`);
