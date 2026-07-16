import { readdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(import.meta.dirname, "..");
const modules = join(root, "node_modules");
const output = join(root, "dependency-licenses.json");
const notices = join(root, "THIRD_PARTY_NOTICES.md");

// Every automatically approved value is an SPDX license identifier. Keep this
// list deliberately finite: additions require a compatibility and distribution
// review instead of inheriting whatever text a package happens to publish.
export const APPROVED_SPDX_LICENSES = new Set([
  "0BSD",
  "Apache-2.0",
  "BlueOak-1.0.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "CC0-1.0",
  "GPL-2.0-only",
  "GPL-2.0-or-later",
  "GPL-3.0-only",
  "GPL-3.0-or-later",
  "ISC",
  "LGPL-2.0-only",
  "LGPL-2.0-or-later",
  "LGPL-2.1-only",
  "LGPL-2.1-or-later",
  "LGPL-3.0-only",
  "LGPL-3.0-or-later",
  "MIT",
  "MPL-2.0",
  "Python-2.0",
  "Unlicense",
  "WTFPL",
  "Zlib",
]);

// Compound expressions are never inferred from the single-license allowlist.
// Each entry represents an explicit project review of the complete expression.
export const REVIEWED_SPDX_EXPRESSIONS = new Set([
  "(MIT OR CC0-1.0)",
  "(WTFPL OR MIT)",
  "WTFPL OR ISC",
]);

const restrictedLicensePatterns = [
  /\bBUSL(?:-[0-9.]+)?\b/i,
  /\bBUSINESS[\s-]+SOURCE[\s-]+LICENSE\b/i,
  /\bSSPL(?:-[0-9.]+)?\b/i,
  /\bSERVER[\s-]+SIDE[\s-]+PUBLIC[\s-]+LICENSE\b/i,
  /\bPOLYFORM(?:-[A-Z0-9.-]+)?\b/i,
  /\bELASTIC(?:[\s-]+LICENSE)?(?:[\s-]+[0-9.]+)?\b/i,
  /\bCOMMONS[\s-]+CLAUSE\b/i,
  /\bCC-BY-NC(?:-[0-9.]+)?\b/i,
  /\bNON[\s-]?COMMERCIAL\b/i,
  /\bPROPRIETARY\b/i,
  /\bUNKNOWN\b/i,
  /\bUNLICENSED\b/i,
  /\bSEE[\s-]+LICENSE\b/i,
];

export class LicenseAuditError extends Error {
  constructor(message) {
    super(message);
    this.name = "LicenseAuditError";
  }
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
}

function inferPackageLabel(manifestPath) {
  const packageDirectory = basename(dirname(manifestPath));
  const possibleScope = basename(dirname(dirname(manifestPath)));
  return possibleScope.startsWith("@") ? `${possibleScope}/${packageDirectory}` : packageDirectory || "<unknown dependency>";
}

function manifestReadFailure(label, error) {
  const code = typeof error === "object" && error && "code" in error && typeof error.code === "string"
    ? error.code
    : "READ_ERROR";
  return new LicenseAuditError(`Dependency manifest for ${label} is unreadable (${code}).`);
}

function licenseFromManifest(value) {
  if (typeof value.license === "string") return normalizeText(value.license);
  if (value.license && typeof value.license === "object" && !Array.isArray(value.license)) {
    return normalizeText(value.license.type);
  }
  if (!Array.isArray(value.licenses)) return "";
  const licenses = value.licenses.map((entry) => normalizeText(
    typeof entry === "string" ? entry : entry && typeof entry === "object" ? entry.type : "",
  ));
  return licenses.every(Boolean) ? licenses.join(" OR ") : "";
}

export async function loadDependencyManifest(manifestPath, label = inferPackageLabel(manifestPath)) {
  let source;
  try {
    source = await readFile(manifestPath, "utf8");
  } catch (error) {
    throw manifestReadFailure(label, error);
  }

  let value;
  try {
    value = JSON.parse(source);
  } catch {
    throw new LicenseAuditError(`Dependency manifest for ${label} contains malformed JSON.`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new LicenseAuditError(`Dependency manifest for ${label} must contain a JSON object.`);
  }

  const name = normalizeText(value.name);
  const version = normalizeText(value.version);
  const license = licenseFromManifest(value);
  if (!name || !version || !license) {
    const missing = [!name && "name", !version && "version", !license && "license"].filter(Boolean).join(", ");
    throw new LicenseAuditError(`Dependency manifest for ${label} is missing required field(s): ${missing}.`);
  }

  return {
    name,
    version,
    license,
    repository: value.repository?.url || value.repository || null,
  };
}

export function evaluateLicensePolicy(licenseValue) {
  const license = normalizeText(licenseValue);
  if (!license) return { approved: false, reason: "missing license" };
  if (restrictedLicensePatterns.some((pattern) => pattern.test(license))) {
    return { approved: false, reason: "restricted or non-redistributable license" };
  }
  if (APPROVED_SPDX_LICENSES.has(license)) {
    return { approved: true, reason: "approved SPDX license identifier" };
  }
  if (REVIEWED_SPDX_EXPRESSIONS.has(license)) {
    return { approved: true, reason: "explicitly reviewed SPDX compound expression" };
  }
  if (/\b(?:AND|OR|WITH)\b|[()]/.test(license)) {
    return { approved: false, reason: "compound license expression has not been explicitly reviewed" };
  }
  return { approved: false, reason: "license identifier is not on the approved SPDX allowlist" };
}

export function assertLicensePolicy(packages) {
  const rejected = packages
    .map((entry) => ({ entry, decision: evaluateLicensePolicy(entry.license) }))
    .filter(({ decision }) => !decision.approved);
  if (!rejected.length) return;

  const details = rejected
    .map(({ entry, decision }) => `- ${entry.name}@${entry.version}: ${entry.license} (${decision.reason})`)
    .join("\n");
  throw new LicenseAuditError(`License policy rejected dependencies:\n${details}`);
}

async function manifestEntries() {
  let entries;
  try {
    entries = await readdir(modules, { withFileTypes: true });
  } catch (error) {
    throw manifestReadFailure("installed dependencies", error);
  }

  const manifests = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    if (entry.name.startsWith("@")) {
      let children;
      try {
        children = await readdir(join(modules, entry.name), { withFileTypes: true });
      } catch (error) {
        throw manifestReadFailure(entry.name, error);
      }
      for (const child of children) {
        if (child.isDirectory()) {
          manifests.push({ path: join(modules, entry.name, child.name, "package.json"), label: `${entry.name}/${child.name}` });
        }
      }
    } else {
      manifests.push({ path: join(modules, entry.name, "package.json"), label: entry.name });
    }
  }
  return manifests;
}

async function installedPackages() {
  const packages = [];
  for (const manifest of await manifestEntries()) {
    packages.push(await loadDependencyManifest(manifest.path, manifest.label));
  }
  packages.sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`));
  return packages;
}

function renderArtifacts(packages) {
  const inventory = { schemaVersion: 1, generatedFrom: "pnpm-lock.yaml", projectLicense: "GPL-2.0-or-later", packages };
  const markdown = [
    "# Third-party notices",
    "",
    "Seeing Stone is licensed under GPL-2.0-or-later. Dependencies retain their own licenses.",
    "The table below is generated from the frozen installed dependency graph by `pnpm licenses:write`.",
    "",
    "| Package | Version | License |",
    "| --- | --- | --- |",
    ...packages.map((entry) => `| ${entry.name.replaceAll("|", "\\|")} | ${entry.version} | ${entry.license.replaceAll("|", "\\|")} |`),
    "",
    "## Native playback runtime",
    "",
    "See `assets/mpv/NOTICE.md`, `assets/mpv/licenses/`, `mpv-runtime.json`, and `NATIVE_PLAYER_BUILD.md`.",
    "The current Windows binary is not approved for public redistribution.",
    "",
  ].join("\n");
  return { inventory: `${JSON.stringify(inventory, null, 2)}\n`, markdown };
}

export async function runLicenseAudit(mode = "--check") {
  if (mode !== "--check" && mode !== "--write") {
    throw new LicenseAuditError(`Unsupported license-audit mode: ${mode}.`);
  }

  const packages = await installedPackages();
  assertLicensePolicy(packages);
  const artifacts = renderArtifacts(packages);

  if (mode === "--write") {
    await writeFile(output, artifacts.inventory);
    await writeFile(notices, artifacts.markdown);
    return;
  }

  let expectedInventory;
  let expectedNotices;
  try {
    [expectedInventory, expectedNotices] = await Promise.all([
      readFile(output, "utf8"),
      readFile(notices, "utf8"),
    ]);
  } catch {
    throw new LicenseAuditError("License inventory or third-party notices are missing.");
  }
  if (expectedInventory !== artifacts.inventory || expectedNotices !== artifacts.markdown) {
    throw new LicenseAuditError("License inventory is stale. Run pnpm licenses:write.");
  }
}

const invokedAsScript = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedAsScript) {
  try {
    await runLicenseAudit(process.argv[2] || "--check");
  } catch (error) {
    console.error(error instanceof LicenseAuditError ? error.message : "License audit failed unexpectedly.");
    process.exitCode = 1;
  }
}
