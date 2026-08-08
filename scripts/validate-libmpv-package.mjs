import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const sha256Pattern = /^[a-f0-9]{64}$/;
const failures = [];

function reject(message) {
  failures.push(message);
}

async function sha256(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

const manifest = JSON.parse(await readFile(resolve(root, "mpv-runtime.json"), "utf8"));
const config = await readFile(resolve(root, "electron-builder.yml"), "utf8");

if (manifest.libmpv?.status !== "ready" || manifest.libmpv.realVideoGatePassed !== true) {
  reject("runtime manifest does not identify a gate-passed libmpv runtime");
}
if (!config.includes("  - from: .runtime/libmpv\n    to: libmpv")) {
  reject("production build does not package the staged libmpv runtime at resources/libmpv");
}
if (!config.includes('      - "*.dll"') || !config.includes('      - "*.node"')) {
  reject("production build does not restrict libmpv resources to the reviewed native closure");
}

const artifacts = [
  manifest.libmpv?.library,
  manifest.libmpv?.nativeAddon,
  ...(manifest.libmpv?.companionDlls ?? []),
].filter(Boolean);
const declared = new Set();
for (const artifact of artifacts) {
  if (
    typeof artifact.filename !== "string"
    || artifact.filename !== artifact.filename.split(/[\\/]/).at(-1)
    || !sha256Pattern.test(artifact.sha256 ?? "")
  ) {
    reject("runtime manifest contains an uncontrolled native artifact");
    continue;
  }
  if (declared.has(artifact.filename)) reject(`duplicate native artifact: ${artifact.filename}`);
  declared.add(artifact.filename);
  try {
    const actual = await sha256(resolve(root, ".runtime/libmpv", artifact.filename));
    if (actual !== artifact.sha256) reject(`staged artifact hash mismatch: ${artifact.filename}`);
  } catch {
    reject(`staged artifact is missing: ${artifact.filename}`);
  }
}

for (const entry of await readdir(resolve(root, ".runtime/libmpv"), { withFileTypes: true })) {
  if (!entry.isFile()) reject(`linked or nested staged entry is prohibited: ${entry.name}`);
  if (/\.(?:dll|node)$/i.test(entry.name) && !declared.has(entry.name)) {
    reject(`unmanifested native artifact would be packaged: ${entry.name}`);
  }
}

if (failures.length) {
  process.stderr.write("LIBMPV_PRODUCTION_PACKAGE_INVALID\n");
  for (const failure of [...new Set(failures)]) process.stderr.write(`- ${failure}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`LIBMPV_PRODUCTION_PACKAGE_READY (${artifacts.length} native artifacts)\n`);
}
