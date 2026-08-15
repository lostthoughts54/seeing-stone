import { createHash } from "node:crypto";
import { access, readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const sha256Pattern = /^[a-f0-9]{64}$/;
const failures = [];

function reject(message) {
  failures.push(message);
}

async function json(path, label = path) {
  try {
    return JSON.parse(await readFile(resolve(root, path), "utf8"));
  } catch {
    reject(`${label} is missing or invalid JSON`);
    return undefined;
  }
}

async function sha256(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function exists(path) {
  try {
    await access(resolve(root, path));
    return true;
  } catch {
    return false;
  }
}

function hasPendingValue(value) {
  if (typeof value === "string") return /pending|until the public-release|until the release/i.test(value);
  if (Array.isArray(value)) return value.some(hasPendingValue);
  if (value && typeof value === "object") return Object.values(value).some(hasPendingValue);
  return false;
}

const manifest = await json("libmpv-runtime.json", "runtime manifest");
const packageData = await json("package.json", "application package manifest");
const build = await json("native/libmpv-runtime/build-result.json", "native build inventory");
const legal = await json("legal-components.json", "legal component manifest");
const redistribution = await json("redistribution-compliance.json", "redistribution compliance manifest");
const dependencyProvenance = await json(
  "native/libmpv-runtime/dependency-provenance.json",
  "companion dependency provenance",
);
const releaseAcceptance = await json(
  "native/libmpv-runtime/public-release-acceptance.json",
  "clean-machine public-release acceptance",
);

if (manifest?.libmpv?.status !== "ready" || manifest?.libmpv?.realVideoGatePassed !== true) {
  reject("real libmpv video gate has not been promoted");
}

for (const resultPath of [
  "native/libmpv-runtime/real-video-gate-result-scale-1.json",
  "native/libmpv-runtime/real-video-gate-result-scale-1-5.json",
]) {
  const result = await json(resultPath, resultPath);
  if (result?.result !== "passed" || result?.realVideoRenderedThroughMpvRenderApi !== true) {
    reject(`${resultPath} does not prove render-API video`);
  }
  if (result?.continuousCpuReadback !== false || result?.bitmapIpc !== false) {
    reject(`${resultPath} does not prohibit CPU readback and bitmap IPC`);
  }
  if (result?.frames?.released !== result?.frames?.transferred || result?.frames?.maxOutstanding > result?.native?.poolSize) {
    reject(`${resultPath} has unbounded or unreleased frame ownership`);
  }
}

const runtimeArtifacts = [
  manifest?.libmpv?.library,
  ...(manifest?.libmpv?.companionDlls ?? []),
  manifest?.libmpv?.nativeAddon,
].filter(Boolean);
const runtimeDirectory = resolve(root, ".runtime/libmpv");
const expectedFiles = new Set();
const controlledBuildFiles = new Map(
  (build?.artifacts ?? []).map((artifact) => [artifact.filename, artifact.sha256]),
);
for (const artifact of runtimeArtifacts) {
  if (artifact.filename !== artifact.filename?.split(/[\\/]/).at(-1) || !sha256Pattern.test(artifact.sha256 ?? "")) {
    reject("runtime manifest contains an uncontrolled filename or invalid hash");
    continue;
  }
  expectedFiles.add(artifact.filename);
  try {
    if (await sha256(resolve(runtimeDirectory, artifact.filename)) !== artifact.sha256) {
      reject(`staged runtime hash mismatch: ${artifact.filename}`);
    }
  } catch {
    reject(`staged runtime artifact is missing: ${artifact.filename}`);
  }
}
try {
  for (const entry of await readdir(runtimeDirectory, { withFileTypes: true })) {
    const controlledHash = controlledBuildFiles.get(entry.name);
    if (!entry.isFile() || !controlledHash) {
      reject(`unexpected staged runtime artifact: ${entry.name}`);
    } else if (await sha256(resolve(runtimeDirectory, entry.name)) !== controlledHash) {
      reject(`staged build-inventory hash mismatch: ${entry.name}`);
    }
  }
} catch {
  reject("staged libmpv runtime directory is missing");
}

const buildOwners = new Set((build?.artifacts ?? []).map((artifact) => artifact.owner).filter(Boolean));
const provenanceRecords = dependencyProvenance?.dependencies ?? [];
for (const owner of buildOwners) {
  const record = provenanceRecords.find((candidate) => candidate.owner === owner);
  if (!record) {
    reject(`no release provenance record covers runtime owner: ${owner}`);
    continue;
  }
  for (const field of [
    "upstreamProject",
    "immutableSourceUrl",
    "version",
    "exactCommit",
    "sourceArchive",
    "sourceArchiveSha256",
    "license",
    "redistributionStatus",
    "correspondingSource",
    "applicationRelease",
  ]) {
    if (typeof record[field] !== "string" || !record[field].trim() || hasPendingValue(record[field])) {
      reject(`${owner} provenance is missing finalized ${field}`);
    }
  }
  for (const field of ["binaryHashes", "buildFlags", "toolchainVersions", "requiredRuntimeDlls", "patches", "buildScripts"]) {
    if (!Array.isArray(record[field])) reject(`${owner} provenance is missing ${field}`);
  }
  if (typeof record.sourceArchive === "string") {
    const source = redistribution?.sourceArchives?.find((candidate) => candidate.filename === record.sourceArchive);
    if (!source || source.sha256 !== record.sourceArchiveSha256) {
      reject(`${owner} corresponding source archive is not hash-pinned by redistribution-compliance.json`);
    } else {
      const sourcePath = source.localPath
        ? resolve(root, source.localPath)
        : resolve(root, ".runtime/corresponding-source-cache", source.filename);
      try {
        if (await sha256(sourcePath) !== source.sha256) reject(`${owner} corresponding source archive hash mismatch`);
      } catch {
        reject(`${owner} corresponding source archive is missing locally: ${source.filename}`);
      }
    }
  }
}

for (const component of legal?.components ?? []) {
  if (component.category === "native" && component.redistributionStatus === "source-and-binary" && hasPendingValue(component.provenance)) {
    reject(`${component.name} contains pending public-release provenance`);
  }
}

const builder = await readFile(resolve(root, "electron-builder.yml"), "utf8");
if (!builder.includes(".runtime/libmpv")) reject("electron-builder does not package the controlled libmpv runtime outside ASAR");
if (!builder.includes("seeing_stone_libmpv_bridge.node")) reject("electron-builder does not explicitly package the native addon outside ASAR");

for (const document of ["LIBMPV_EXPERIMENTAL.md", "LIBMPV_MIGRATION_STATUS.md", "THIRD_PARTY_NOTICES.md"]) {
  if (!await exists(document)) reject(`release documentation is missing: ${document}`);
}

const acceptancePassed = releaseAcceptance?.result === "passed";
const acceptanceWaived = releaseAcceptance?.result === "waived";
if (!acceptancePassed && !acceptanceWaived) {
  reject("clean-machine package/install/playback/uninstall acceptance has neither passed nor been explicitly waived");
}
for (const field of ["release", "packagedArtifactSha256", "inventorySha256", "correspondingSourceSha256"]) {
  if (typeof releaseAcceptance?.[field] !== "string" || !releaseAcceptance[field].trim()) {
    reject(`public-release acceptance is missing ${field}`);
  }
}
if (releaseAcceptance?.release !== packageData?.version) reject("public-release acceptance does not match package.json version");
if (acceptancePassed && (typeof releaseAcceptance?.testedAtUtc !== "string" || !releaseAcceptance.testedAtUtc.trim())) {
  reject("passed public-release acceptance is missing testedAtUtc");
}
if (acceptanceWaived) {
  for (const field of ["waiverReason", "authorizedBy", "authorization", "waivedAtUtc"]) {
    if (typeof releaseAcceptance?.[field] !== "string" || !releaseAcceptance[field].trim()) {
      reject(`waived public-release acceptance is missing ${field}`);
    }
  }
}
for (const [field, path] of [
  ["packagedArtifactSha256", `.runtime/release/Seeing-Stone-Setup-${packageData?.version}-x64.exe`],
  ["inventorySha256", "native/redistribution-inventory.json"],
  ["correspondingSourceSha256", `artifacts/Seeing-Stone-${packageData?.version}-corresponding-source.zip`],
]) {
  try {
    if (await sha256(resolve(root, path)) !== releaseAcceptance?.[field]) reject(`public-release acceptance ${field} does not match ${path}`);
  } catch {
    reject(`public-release acceptance artifact is missing: ${path}`);
  }
}

if (failures.length > 0) {
  process.stderr.write("LIBMPV_PUBLIC_RELEASE_NO_GO\n");
  for (const failure of [...new Set(failures)]) process.stderr.write(`- ${failure}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write("LIBMPV_PUBLIC_RELEASE_GO\n");
}
