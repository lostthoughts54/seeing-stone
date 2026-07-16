import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const modules = join(root, "node_modules");
const output = join(root, "dependency-licenses.json");
const notices = join(root, "THIRD_PARTY_NOTICES.md");
const mode = process.argv[2] || "--check";
const rejected = /(UNLICENSED|UNKNOWN|PROPRIETARY|NONCOMMERCIAL|CC-BY-NC|SEE LICENSE)/i;

async function manifests() {
  const entries = await readdir(modules, { withFileTypes: true });
  const paths = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    if (entry.name.startsWith("@")) {
      for (const child of await readdir(join(modules, entry.name), { withFileTypes: true })) {
        if (child.isDirectory()) paths.push(join(modules, entry.name, child.name, "package.json"));
      }
    } else paths.push(join(modules, entry.name, "package.json"));
  }
  return paths;
}

const packages = [];
for (const path of await manifests()) {
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    const license = typeof value.license === "string"
      ? value.license.trim()
      : Array.isArray(value.licenses) ? value.licenses.map((entry) => entry.type || entry).join(" OR ") : "";
    packages.push({ name: value.name, version: value.version, license, repository: value.repository?.url || value.repository || null });
  } catch {}
}
packages.sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`));
const invalid = packages.filter((entry) => !entry.name || !entry.version || !entry.license || rejected.test(entry.license));
if (invalid.length) {
  console.error("License policy rejected dependencies:");
  for (const entry of invalid) console.error(`- ${entry.name || "<unknown>"}@${entry.version || "?"}: ${entry.license || "<missing>"}`);
  process.exitCode = 1;
}

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

if (mode === "--write") {
  await writeFile(output, `${JSON.stringify(inventory, null, 2)}\n`);
  await writeFile(notices, markdown);
} else {
  const expectedInventory = await readFile(output, "utf8").catch(() => "");
  const expectedNotices = await readFile(notices, "utf8").catch(() => "");
  if (expectedInventory !== `${JSON.stringify(inventory, null, 2)}\n` || expectedNotices !== markdown) {
    console.error("License inventory is missing or stale. Run pnpm licenses:write.");
    process.exitCode = 1;
  }
}
