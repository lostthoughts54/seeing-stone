import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(import.meta.dirname, "..");
const modules = join(root, "node_modules");
const output = join(root, "dependency-licenses.json");
const notices = join(root, "THIRD_PARTY_NOTICES.md");
const componentsManifest = join(root, "legal-components.json");
const generatedModule = join(root, "src", "shared", "generated", "openSourceLicenses.ts");

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
  "OFL-1.1",
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

const COMPONENT_CATEGORIES = new Set(["application", "font", "native", "plugin"]);
const REDISTRIBUTION_STATUSES = new Set([
  "source-only",
  "source-and-binary",
  "internal-only-unverified-provenance",
]);
const SHA256 = /^[a-f0-9]{64}$/;

function requiredText(value, label) {
  const result = normalizeText(value);
  if (!result) throw new LicenseAuditError(`${label} is missing.`);
  return result;
}

function publicHttpsUrl(value, label) {
  const url = requiredText(value, label);
  try {
    if (new URL(url).protocol !== "https:") throw new Error("protocol");
  } catch {
    throw new LicenseAuditError(`${label} must be an HTTPS URL.`);
  }
  return url;
}

function checkedRelativePath(value, label, rootDirectory) {
  const path = requiredText(value, label).replaceAll("\\", "/");
  if (isAbsolute(path) || path.startsWith("../") || path.includes("/../") || path === "..") {
    throw new LicenseAuditError(`${label} must remain inside the repository.`);
  }
  const absolute = resolve(rootDirectory, path);
  const fromRoot = relative(rootDirectory, absolute);
  if (!fromRoot || fromRoot.startsWith(`..${sep}`) || fromRoot === ".." || isAbsolute(fromRoot)) {
    throw new LicenseAuditError(`${label} must remain inside the repository.`);
  }
  return { path, absolute };
}

async function assertFileHash(file, expectedHash, label) {
  const expected = requiredText(expectedHash, `${label} SHA-256`).toLowerCase();
  if (!SHA256.test(expected)) throw new LicenseAuditError(`${label} has an invalid SHA-256 value.`);
  let content;
  try {
    content = await readFile(file);
  } catch (error) {
    throw manifestReadFailure(label, error);
  }
  const actual = createHash("sha256").update(content).digest("hex");
  if (actual !== expected) throw new LicenseAuditError(`${label} failed SHA-256 verification.`);
}

export async function loadLegalComponents(manifestPath = componentsManifest, rootDirectory = root) {
  let value;
  try {
    value = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) throw new LicenseAuditError("The legal component manifest contains malformed JSON.");
    throw manifestReadFailure("legal component manifest", error);
  }
  if (!value || typeof value !== "object" || Array.isArray(value) || value.schemaVersion !== 1 || !Array.isArray(value.components)) {
    throw new LicenseAuditError("The legal component manifest must use schema version 1 with a components array.");
  }

  const components = [];
  const identities = new Set();
  for (const [index, raw] of value.components.entries()) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new LicenseAuditError(`Legal component ${index + 1} must be an object.`);
    }
    const category = requiredText(raw.category, `Legal component ${index + 1} category`);
    if (!COMPONENT_CATEGORIES.has(category)) throw new LicenseAuditError(`Legal component ${index + 1} has an unknown category: ${category}.`);
    const name = requiredText(raw.name, `Legal component ${index + 1} name`);
    const version = requiredText(raw.version, `Legal component ${name} version`);
    const license = requiredText(raw.license, `Legal component ${name} license`);
    const decision = evaluateLicensePolicy(license);
    if (!decision.approved) throw new LicenseAuditError(`Legal component ${name}@${version}: ${license} (${decision.reason}).`);
    const identity = `${category}:${name}@${version}`;
    if (identities.has(identity)) throw new LicenseAuditError(`Duplicate legal component: ${identity}.`);
    identities.add(identity);
    const isBundledTelemetrySource = category === "plugin"
      && name === "Seeing Stone Participant Telemetry"
      && version === "protocol-v1-disabled"
      && license === "GPL-2.0-or-later"
      && raw.redistributionStatus === "source-only";
    const projectUrl = raw.projectUrl === null ? null : publicHttpsUrl(raw.projectUrl, `Legal component ${name} project URL`);
    if (!projectUrl && category !== "application" && !isBundledTelemetrySource) throw new LicenseAuditError(`Legal component ${name} must record a public project URL.`);
    const sourceRevision = raw.sourceRevision === null ? null : requiredText(raw.sourceRevision, `Legal component ${name} source revision`);
    const redistributionStatus = requiredText(raw.redistributionStatus, `Legal component ${name} redistribution status`);
    if (!REDISTRIBUTION_STATUSES.has(redistributionStatus)) {
      throw new LicenseAuditError(`Legal component ${name} has an unknown redistribution status: ${redistributionStatus}.`);
    }
    if (!sourceRevision && category !== "application" && redistributionStatus !== "internal-only-unverified-provenance") {
      throw new LicenseAuditError(`Legal component ${name} must record an immutable source revision.`);
    }

    if (!Array.isArray(raw.artifacts)) throw new LicenseAuditError(`Legal component ${name} artifacts must be an array.`);
    const artifacts = [];
    for (const [artifactIndex, artifact] of raw.artifacts.entries()) {
      if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) {
        throw new LicenseAuditError(`Legal component ${name} artifact ${artifactIndex + 1} must be an object.`);
      }
      const checked = checkedRelativePath(artifact.path, `Legal component ${name} artifact ${artifactIndex + 1}`, rootDirectory);
      const sha256 = requiredText(artifact.sha256, `Legal component ${name} artifact ${artifactIndex + 1} SHA-256`).toLowerCase();
      await assertFileHash(checked.absolute, sha256, `Legal component ${name} artifact ${artifactIndex + 1}`);
      artifacts.push({ path: checked.path, sha256 });
    }
    if (category === "font" && artifacts.length === 0) throw new LicenseAuditError(`Font component ${name} must include at least one verified artifact.`);
    if (isBundledTelemetrySource) {
      const expectedArtifacts = new Set([
        "plugins/SeeingStone.ParticipantTelemetry/README.md",
        "plugins/SeeingStone.ParticipantTelemetry/protocol-v1.schema.json",
      ]);
      if (artifacts.length !== expectedArtifacts.size || artifacts.some((artifact) => !expectedArtifacts.has(artifact.path))) {
        throw new LicenseAuditError("The bundled telemetry source exception must contain only its reviewed README and protocol schema.");
      }
    }

    if (!raw.licenseFile || typeof raw.licenseFile !== "object" || Array.isArray(raw.licenseFile)) {
      throw new LicenseAuditError(`Legal component ${name} must include a verified license file.`);
    }
    const checkedLicense = checkedRelativePath(raw.licenseFile.path, `Legal component ${name} license file`, rootDirectory);
    const licenseSha256 = requiredText(raw.licenseFile.sha256, `Legal component ${name} license file SHA-256`).toLowerCase();
    await assertFileHash(checkedLicense.absolute, licenseSha256, `Legal component ${name} license file`);
    components.push({
      category,
      name,
      version,
      license,
      projectUrl,
      sourceRevision,
      redistributionStatus,
      artifacts,
      licenseFile: { path: checkedLicense.path, sha256: licenseSha256 },
    });
  }
  return components;
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

function renderArtifacts(packages, components) {
  const inventory = {
    schemaVersion: 2,
    generatedFrom: {
      dependencies: "installed node_modules graph frozen by pnpm-lock.yaml",
      components: "legal-components.json",
    },
    projectLicense: "GPL-2.0-or-later",
    components,
    packages,
  };
  const publicEntries = [
    ...components.map((entry) => ({
      category: entry.category,
      name: entry.name,
      version: entry.version,
      license: entry.license,
      projectUrl: entry.projectUrl,
      redistributionStatus: entry.redistributionStatus,
    })),
    ...packages.map((entry) => ({
      category: "dependency",
      name: entry.name,
      version: entry.version,
      license: entry.license,
      projectUrl: typeof entry.repository === "string" && /^https:\/\//i.test(entry.repository.replace(/^git\+/, ""))
        ? entry.repository.replace(/^git\+/, "").replace(/\.git$/, "")
        : null,
      redistributionStatus: "source-and-binary",
    })),
  ].sort((a, b) => `${a.category}:${a.name}@${a.version}`.localeCompare(`${b.category}:${b.name}@${b.version}`));
  const publicInventory = {
    schemaVersion: 1,
    projectName: "Seeing Stone",
    projectLicense: "GPL-2.0-or-later",
    entries: publicEntries,
  };
  const markdown = [
    "# Third-party notices",
    "",
    "Seeing Stone is licensed under GPL-2.0-or-later. Dependencies retain their own licenses.",
    "These tables are generated from pinned component provenance and the frozen installed dependency graph by `pnpm licenses:write`.",
    "",
    "## Application, fonts, and native components",
    "",
    "| Category | Component | Version/revision | License | Redistribution status |",
    "| --- | --- | --- | --- | --- |",
    ...components.map((entry) => `| ${entry.category} | ${entry.name.replaceAll("|", "\\|")} | ${entry.version.replaceAll("|", "\\|")} | ${entry.license.replaceAll("|", "\\|")} | ${entry.redistributionStatus} |`),
    "",
    "Available source revisions, artifact hashes, and every license-file hash are recorded in `dependency-licenses.json`.",
    "The current native runtime remains internal-only because upstream did not record a complete linked-dependency source bill of materials.",
    "",
    "## JavaScript dependencies",
    "",
    "| Package | Version | License |",
    "| --- | --- | --- |",
    ...packages.map((entry) => `| ${entry.name.replaceAll("|", "\\|")} | ${entry.version} | ${entry.license.replaceAll("|", "\\|")} |`),
    "",
    "## Native playback runtime details",
    "",
    "See `assets/mpv/NOTICE.md`, `assets/mpv/licenses/`, `mpv-runtime.json`, and `NATIVE_PLAYER_BUILD.md`.",
    "The current Windows binary is not approved for public redistribution.",
    "",
  ].join("\n");
  const generated = [
    "// Generated by scripts/license-audit.mjs. Do not edit by hand.",
    'import type { OpenSourceLicenseInventory } from "../contracts";',
    "",
    `export const OPEN_SOURCE_LICENSES = ${JSON.stringify(publicInventory, null, 2)} satisfies OpenSourceLicenseInventory;`,
    "",
  ].join("\n");
  return { inventory: `${JSON.stringify(inventory, null, 2)}\n`, markdown, generated };
}

export async function runLicenseAudit(mode = "--check") {
  if (mode !== "--check" && mode !== "--write") {
    throw new LicenseAuditError(`Unsupported license-audit mode: ${mode}.`);
  }

  const [packages, components] = await Promise.all([installedPackages(), loadLegalComponents()]);
  assertLicensePolicy(packages);
  const projectManifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const applicationComponent = components.find((entry) => entry.category === "application");
  if (!applicationComponent || applicationComponent.version !== projectManifest.version || applicationComponent.license !== projectManifest.license) {
    throw new LicenseAuditError("The application legal component must match package.json version and license.");
  }
  const artifacts = renderArtifacts(packages, components);

  if (mode === "--write") {
    await writeFile(output, artifacts.inventory);
    await writeFile(notices, artifacts.markdown);
    await writeFile(generatedModule, artifacts.generated);
    return;
  }

  let expectedInventory;
  let expectedNotices;
  let expectedGenerated;
  try {
    [expectedInventory, expectedNotices, expectedGenerated] = await Promise.all([
      readFile(output, "utf8"),
      readFile(notices, "utf8"),
      readFile(generatedModule, "utf8"),
    ]);
  } catch {
    throw new LicenseAuditError("License inventory, third-party notices, or generated in-app inventory are missing.");
  }
  if (expectedInventory !== artifacts.inventory || expectedNotices !== artifacts.markdown || expectedGenerated !== artifacts.generated) {
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
