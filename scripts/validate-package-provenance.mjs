import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { extname, relative, resolve, sep } from "node:path";
import { runLicenseAudit } from "./license-audit.mjs";

const root = resolve(import.meta.dirname, "..");
const sha256Pattern = /^[a-f0-9]{64}$/;
const nonDistributedAssetPrefixes = [
  "assets/fixtures/live-tv/",
];

function fail(message) {
  throw new Error(`PACKAGE_PROVENANCE_INVALID: ${message}`);
}

function repositoryPath(path) {
  return path.replaceAll("\\", "/");
}

function controlledFilename(value, label) {
  if (typeof value !== "string" || !value || value !== value.split(/[\\/]/).at(-1) || value === "." || value === "..") {
    fail(`${label} must be a filename without directory components.`);
  }
  return value;
}

async function hash(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function filesBelow(directory) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = resolve(directory, entry.name);
    if (entry.isDirectory()) found.push(...await filesBelow(absolute));
    else if (entry.isFile()) found.push(absolute);
    else fail(`linked or special file is not accepted: ${repositoryPath(relative(root, absolute))}`);
  }
  return found;
}

async function main() {
  await runLicenseAudit("--check");

  const legal = JSON.parse(await readFile(resolve(root, "legal-components.json"), "utf8"));
  const coveredAssets = new Set();
  for (const component of legal.components ?? []) {
    for (const artifact of component.artifacts ?? []) coveredAssets.add(repositoryPath(artifact.path));
    if (component.licenseFile?.path) coveredAssets.add(repositoryPath(component.licenseFile.path));
    if (component.category === "native" && component.redistributionStatus === "source-and-binary") {
      const provenance = component.provenance;
      if (!provenance || typeof provenance !== "object") fail(`${component.name} lacks native provenance metadata.`);
      for (const field of ["immutableSourceUrl", "sourceArchive", "sourceArchiveSha512", "correspondingSource", "applicationRelease"]) {
        if (typeof provenance[field] !== "string" || !provenance[field].trim()) fail(`${component.name} provenance is missing ${field}.`);
      }
      for (const field of ["binaryHashes", "buildFlags", "toolchain", "requiredRuntimeDlls", "patches", "buildScripts"]) {
        if (!Array.isArray(provenance[field])) fail(`${component.name} provenance is missing ${field}.`);
      }
      for (const buildScript of provenance.buildScripts) {
        const absolute = resolve(root, buildScript);
        const fromRoot = relative(root, absolute);
        if (!fromRoot || fromRoot === ".." || fromRoot.startsWith(`..${sep}`)) fail(`${component.name} build script escapes the repository.`);
        await readFile(absolute);
      }
    }
  }

  for (const directory of ["assets", "build", "src/renderer/assets"]) {
    for (const absolute of await filesBelow(resolve(root, directory))) {
      const path = repositoryPath(relative(root, absolute));
      if (nonDistributedAssetPrefixes.some((prefix) => path.startsWith(prefix))) continue;
      if (!coveredAssets.has(path)) fail(`distributed asset lacks a legal manifest entry: ${path}`);
    }
  }

  const runtimeManifest = JSON.parse(await readFile(resolve(root, "libmpv-runtime.json"), "utf8"));
  if (runtimeManifest.runtimeFamily !== "controlled-source-built-libmpv") fail("production runtime family is not the controlled source build.");
  if (runtimeManifest.productionPlaybackEngine !== "libmpv") fail("production playback engine is not libmpv.");
  const declaredRuntime = new Map();
  const artifacts = [
    runtimeManifest.libmpv?.library,
    runtimeManifest.libmpv?.nativeAddon,
    ...(runtimeManifest.libmpv?.companionDlls ?? []),
    runtimeManifest.mediaProbe?.executable,
  ].filter(Boolean);
  for (const artifact of artifacts) {
    const filename = controlledFilename(artifact.filename, "runtime artifact");
    if (!sha256Pattern.test(artifact.sha256)) fail(`${filename} has no valid SHA-256.`);
    if (declaredRuntime.has(filename)) fail(`duplicate runtime artifact: ${filename}`);
    declaredRuntime.set(filename, artifact.sha256);
  }
  for (const filename of declaredRuntime.keys()) {
    const expected = declaredRuntime.get(filename);
    if (await hash(resolve(root, ".runtime/libmpv", filename)) !== expected) fail(`runtime artifact hash mismatch: ${filename}`);
  }
  const builder = await readFile(resolve(root, "electron-builder.yml"), "utf8");
  if (builder.includes(".runtime/mpv") || /\bto:\s*mpv\b/.test(builder)) fail("production packaging still references the legacy mpv runtime directory.");
  if (!builder.includes("libmpv/runtime-manifest.json") || !builder.includes('      - "mpv.exe"')) {
    fail("production packaging does not include the controlled runtime manifest and media probe executable.");
  }

  // Native build directories are development-only and excluded by electron-builder.
  // Scan the distribution tree here; a future packaged addon must also be declared
  // in the ready runtime manifest before packaging can pass this check.
  for (const directory of ["dist"]) {
    for (const absolute of await filesBelow(resolve(root, directory)).catch((error) => error?.code === "ENOENT" ? [] : Promise.reject(error))) {
      if ([".dll", ".node"].includes(extname(absolute).toLowerCase())) {
        fail(`native output is not yet represented by a ready runtime manifest: ${repositoryPath(relative(root, absolute))}`);
      }
    }
  }
}

try {
  await main();
  process.stdout.write("Package provenance validation passed.\n");
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "Package provenance validation failed."}\n`);
  process.exitCode = 1;
}
