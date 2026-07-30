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

  const runtimeManifest = JSON.parse(await readFile(resolve(root, "mpv-runtime.json"), "utf8"));
  if (!Array.isArray(runtimeManifest.runtimeArtifacts)) fail("mpv-runtime.json lacks runtimeArtifacts.");
  const declaredRuntime = new Map();
  for (const artifact of runtimeManifest.runtimeArtifacts) {
    const filename = controlledFilename(artifact.filename, "runtime artifact");
    if (!sha256Pattern.test(artifact.sha256)) fail(`${filename} has no valid SHA-256.`);
    if (declaredRuntime.has(filename)) fail(`duplicate runtime artifact: ${filename}`);
    declaredRuntime.set(filename, artifact.sha256);
  }
  const packagedRuntimeNames = new Set(["mpv.exe", "mpv.com", "vulkan-1.dll"]);
  for (const filename of packagedRuntimeNames) {
    const expected = declaredRuntime.get(filename);
    if (!expected) fail(`packaged runtime file is unmanifested: ${filename}`);
    if (await hash(resolve(root, ".runtime/mpv", filename)) !== expected) fail(`runtime artifact hash mismatch: ${filename}`);
  }
  for (const filename of declaredRuntime.keys()) {
    if (!packagedRuntimeNames.has(filename)) fail(`runtime manifest contains an artifact not selected by packaging: ${filename}`);
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
