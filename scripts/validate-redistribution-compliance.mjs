import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { access, readdir, readFile } from "node:fs/promises";
import { basename, relative, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const failures = [];
const reject = (message) => failures.push(message);
const shaPattern = /^[a-f0-9]{64}$/;

async function json(path, label = path) {
  try { return JSON.parse(await readFile(resolve(root, path), "utf8")); }
  catch { reject(`${label} is missing or invalid JSON`); return undefined; }
}
async function exists(path) {
  try { await access(resolve(root, path)); return true; } catch { return false; }
}
async function sha256(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}
async function walkNative(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walkNative(path));
    else if (entry.isFile() && /\.(?:dll|exe|node)$/i.test(entry.name)) files.push(path);
  }
  return files;
}
async function walkFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walkFiles(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}
async function archiveEntries(path) {
  return await new Promise((resolvePromise, rejectPromise) => {
    let output = "";
    const child = spawn("tar", ["-tf", path], { cwd: root, windowsHide: true });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.once("error", rejectPromise);
    child.once("exit", (code) => code === 0 ? resolvePromise(new Set(output.split(/\r?\n/).filter(Boolean).map((x) => x.replaceAll("\\", "/")))) : rejectPromise(new Error(`tar exited ${code}`)));
  });
}

const [manifest, inventory, build, runtime, sourceLock, packageJson] = await Promise.all([
  json("redistribution-compliance.json", "compliance manifest"),
  json("native/redistribution-inventory.json", "production native inventory"),
  json("native/libmpv-runtime/build-result.json", "controlled native build inventory"),
  json("libmpv-runtime.json", "runtime manifest"),
  json("native/libmpv-runtime/source-lock.json", "source lock"),
  json("package.json"),
]);

if (manifest?.schemaVersion !== 1) reject("unsupported compliance manifest schema");
if (inventory?.applicationVersion !== packageJson?.version) reject("native inventory application version does not match package.json");
if (manifest?.application?.license !== "GPL-2.0-or-later") reject("Seeing Stone GPL-2.0-or-later declaration is missing");

const components = new Map((manifest?.components ?? []).map((component) => [component.id, component]));
const declaredPaths = new Set();
for (const component of components.values()) {
  for (const field of ["id", "name", "version", "license", "obligation", "source"]) {
    if (field !== "source" && (typeof component[field] !== "string" || !component[field])) reject(`${component.id ?? "component"} lacks ${field}`);
  }
  if (component.obligation === "source-required" && !component.sourceArchive && !component.source) reject(`${component.id} has no corresponding-source location`);
  for (const notice of component.noticeFiles ?? []) {
    if (notice === "LICENSES.chromium.html") {
      if (!await exists("node_modules/electron/dist/LICENSES.chromium.html")) reject("Electron Chromium notices are missing");
    } else if (!await exists(notice)) reject(`${component.id} notice is missing: ${notice}`);
  }
  for (const artifact of component.artifacts ?? []) declaredPaths.add(artifact.toLowerCase());
}

const buildArtifacts = new Map((build?.artifacts ?? []).map((artifact) => [artifact.filename, artifact]));
for (const artifact of build?.artifacts ?? []) {
  if (artifact.filename === "mpv.com") continue;
  const packagePath = `resources/libmpv/${artifact.filename}`.toLowerCase();
  if (!declaredPaths.has(packagePath)) reject(`controlled build artifact has no compliance component: ${artifact.filename}`);
  if (!shaPattern.test(artifact.sha256 ?? "")) reject(`controlled build artifact has invalid hash: ${artifact.filename}`);
  try {
    if (await sha256(resolve(root, ".runtime/libmpv", artifact.filename)) !== artifact.sha256) reject(`staged runtime hash mismatch: ${artifact.filename}`);
  } catch { reject(`staged runtime artifact is missing: ${artifact.filename}`); }
}
if (declaredPaths.has("resources/libmpv/mpv.com")) reject("mpv.com must not be declared as a production artifact");

const mpvSource = sourceLock?.sources?.find((source) => source.name === "mpv");
const ffmpegSource = sourceLock?.sources?.find((source) => source.name === "FFmpeg");
const mpvComponent = components.get("mpv");
const ffmpegComponent = components.get("ffmpeg-controlled");
if (mpvSource?.version !== mpvComponent?.version || mpvSource?.commit !== mpvComponent?.revision || runtime?.sourceBuild?.mpv?.archiveSha256 !== mpvSource?.archiveSha256) reject("mpv source/version does not match the distributed runtime");
if (ffmpegSource?.version !== ffmpegComponent?.version || ffmpegSource?.commit !== ffmpegComponent?.revision || runtime?.sourceBuild?.ffmpeg?.archiveSha256 !== ffmpegSource?.archiveSha256) reject("FFmpeg source/version does not match the distributed runtime");
const ffmpegFlags = sourceLock?.buildConfiguration?.ffmpeg ?? [];
if (ffmpegFlags.some((flag) => /--enable-(?:gpl|nonfree)/i.test(flag))) reject("controlled FFmpeg configuration enables GPL or nonfree code");

const builder = await readFile(resolve(root, "electron-builder.yml"), "utf8");
if (!builder.includes("from: .runtime/libmpv") || !builder.includes("to: libmpv")) reject("production builder does not use resources/libmpv");
if (builder.includes("from: .runtime/mpv") || builder.includes("to: mpv\n")) reject("historical resources/mpv is still configured for production");
if (!builder.includes("packElevateHelper: false")) reject("unused, ambiguously licensed elevate.exe helper is not disabled");
if (!builder.includes("native-licenses")) reject("native license files are not configured for the installed legal directory");
if (await exists("resources/mpv")) reject("historical resources/mpv directory exists");

for (const source of manifest?.sourceArchives ?? []) {
  if (!shaPattern.test(source.sha256 ?? "")) { reject(`source archive has invalid hash: ${source.filename}`); continue; }
  const cachePath = source.localPath
    ? resolve(root, source.localPath)
    : resolve(root, ".runtime/corresponding-source-cache", source.filename);
  try { if (await sha256(cachePath) !== source.sha256) reject(`source archive hash mismatch: ${source.filename}`); }
  catch { reject(`source archive is missing: ${source.filename}`); }
}

const packageRoot = resolve(root, ".runtime/release/win-unpacked");
try {
  const packaged = new Map();
  for (const path of await walkNative(packageRoot)) packaged.set(relative(packageRoot, path).replaceAll("\\", "/"), await sha256(path));
  const recorded = new Map((inventory?.artifacts ?? []).map((artifact) => [artifact.packagePath, artifact.sha256]));
  for (const [path, hash] of packaged) {
    if (!recorded.has(path)) reject(`packaged native artifact is absent from inventory: ${path}`);
    else if (recorded.get(path) !== hash) reject(`packaged native artifact hash differs from inventory: ${path}`);
  }
  for (const [path] of recorded) if (!packaged.has(path)) reject(`inventoried native artifact is absent from package: ${path}`);
  if (packaged.has("resources/elevate.exe")) reject("unused elevate.exe remains in the production package");
  for (const [source, installed] of [
    ["LICENSE", "resources/legal/LICENSE"],
    ["THIRD_PARTY_NOTICES.md", "resources/legal/THIRD_PARTY_NOTICES.md"],
    ["redistribution-compliance.json", "resources/legal/redistribution-compliance.json"],
    ["native/redistribution-inventory.json", "resources/legal/redistribution-native-inventory.json"],
  ]) {
    if (await sha256(resolve(root, source)) !== await sha256(resolve(packageRoot, installed))) reject(`packaged legal file differs from source: ${installed}`);
  }
  for (const source of await walkFiles(resolve(root, "native-licenses"))) {
    const suffix = relative(resolve(root, "native-licenses"), source);
    const installed = resolve(packageRoot, "resources/legal/native-licenses", suffix);
    if (await sha256(source) !== await sha256(installed)) reject(`packaged native license differs from source: ${suffix}`);
  }
} catch { reject("production win-unpacked package is missing or unreadable"); }

const bundleName = `Seeing-Stone-${packageJson?.version}-corresponding-source`;
const bundlePath = resolve(root, "artifacts", `${bundleName}.zip`);
try {
  const entries = await archiveEntries(bundlePath);
  for (const source of manifest?.sourceArchives ?? []) {
    if (!entries.has(`${bundleName}/source-archives/${source.filename}`)) reject(`corresponding-source archive lacks ${source.filename}`);
  }
  for (const required of ["README.md", "build-materials/redistribution-compliance.json", "build-materials/native/libmpv-runtime/source-lock.json", "build-materials/native/libmpv-runtime/dependency-provenance.json", "build-materials/native/libmpv-bridge/src/libmpv_runtime_probe.cc"]) {
    if (!entries.has(`${bundleName}/${required}`)) reject(`corresponding-source archive lacks ${required}`);
  }
} catch { reject(`corresponding-source archive is missing or unreadable: ${basename(bundlePath)}`); }

if (failures.length) {
  process.stderr.write("REDISTRIBUTION_COMPLIANCE_FAILED\n");
  for (const failure of [...new Set(failures)]) process.stderr.write(`- ${failure}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`REDISTRIBUTION_COMPLIANCE_PASSED (${inventory.artifacts.length} production native files, ${manifest.sourceArchives.length} source archives)\n`);
}
