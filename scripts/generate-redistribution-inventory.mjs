import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const packageRoot = resolve(root, ".runtime/release/win-unpacked");
const manifest = JSON.parse(await readFile(resolve(root, "redistribution-compliance.json"), "utf8"));
const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const nativePattern = /\.(?:dll|exe|node)$/i;

async function walk(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(path));
    else if (entry.isFile() && nativePattern.test(entry.name)) files.push(path);
  }
  return files;
}

const declaredByPath = new Map();
for (const component of manifest.components) {
  for (const artifact of component.artifacts) {
    const normalized = artifact.replaceAll("/", "\\").toLowerCase();
    const list = declaredByPath.get(normalized) ?? [];
    list.push(component.id);
    declaredByPath.set(normalized, list);
  }
}

const artifacts = [];
const failures = [];
for (const path of (await walk(packageRoot)).sort()) {
  const packagePath = relative(packageRoot, path).replaceAll("\\", "/");
  const componentIds = declaredByPath.get(packagePath.replaceAll("/", "\\").toLowerCase());
  if (!componentIds) failures.push(`unaccounted packaged native file: ${packagePath}`);
  const bytes = await readFile(path);
  artifacts.push({
    packagePath,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.length,
    componentIds: componentIds ?? [],
  });
}

for (const [packagePath] of declaredByPath) {
  if (!artifacts.some((artifact) => artifact.packagePath.replaceAll("/", "\\").toLowerCase() === packagePath)) {
    failures.push(`declared native file missing from package: ${packagePath}`);
  }
}
if (failures.length) throw new Error(`REDISTRIBUTION_INVENTORY_FAILED\n- ${failures.join("\n- ")}`);

const output = {
  schemaVersion: 1,
  applicationVersion: packageJson.version,
  packageDirectory: ".runtime/release/win-unpacked",
  generatedFrom: "production package plus redistribution-compliance.json",
  artifacts,
};
await writeFile(resolve(root, "native/redistribution-inventory.json"), `${JSON.stringify(output, null, 2)}\n`, "utf8");
process.stdout.write(`REDISTRIBUTION_INVENTORY_WRITTEN (${artifacts.length} native files)\n`);
