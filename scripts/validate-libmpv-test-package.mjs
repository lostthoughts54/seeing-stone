import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { runLicenseAudit } from "./license-audit.mjs";

const root = resolve(import.meta.dirname, "..");
const failures = [];
const sha256Pattern = /^[a-f0-9]{64}$/;

function reject(message) {
  failures.push(message);
}

async function sha256(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

const manifest = JSON.parse(await readFile(resolve(root, "mpv-runtime.json"), "utf8"));
const config = await readFile(resolve(root, "electron-builder.libmpv-test.yml"), "utf8");
const documentation = await readFile(resolve(root, "INTERNAL_LIBMPV_TESTING.md"), "utf8");
await runLicenseAudit("--check");

if (manifest.redistributionStatus !== "internal-testing-only") {
  reject("runtime manifest is not explicitly limited to internal testing");
}
if (manifest.libmpv?.status !== "ready" || manifest.libmpv.realVideoGatePassed !== true) {
  reject("manifest does not identify a gate-passed libmpv runtime");
}
if (!config.includes("app.seeingstone.client.libmpv-test")) reject("internal build lacks a separate application identity");
if (!config.includes("Seeing Stone Libmpv Test")) reject("internal build lacks a distinct product name");
if (!config.includes("INTERNAL_TESTING_ONLY.md")) reject("internal build lacks its package marker");
if (!config.includes('      - "*.dll"') || !config.includes('      - "*.node"')) {
  reject("internal build does not restrict native resources to DLL/addon artifacts");
}
if (!/not the public release/i.test(documentation)) reject("internal testing documentation lacks a public-release warning");

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
    reject("manifest contains an uncontrolled native artifact");
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
  process.stderr.write("LIBMPV_INTERNAL_TEST_PACKAGE_INVALID\n");
  for (const failure of [...new Set(failures)]) process.stderr.write(`- ${failure}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`LIBMPV_INTERNAL_TEST_PACKAGE_READY (${artifacts.length} native artifacts)\n`);
}
