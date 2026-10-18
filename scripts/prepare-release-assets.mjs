import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const require = createRequire(import.meta.url);
const yaml = createRequire(require.resolve("electron-builder"))("js-yaml");
const { version } = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
assert.match(version, /^\d+\.\d+\.\d+$/, "This handoff script handles stable releases only.");
const release = resolve(root, ".runtime/release");
const output = resolve(root, `artifacts/release-${version}`);
const installerName = `Seeing-Stone-Setup-${version}-x64.exe`;
const sourceName = `Seeing-Stone-${version}-corresponding-source.zip`;
const digest = (bytes, algorithm = "sha256", encoding = "hex") => createHash(algorithm).update(bytes).digest(encoding);
const installer = await readFile(resolve(release, installerName));
const metadata = yaml.load(await readFile(resolve(release, "latest.yml"), "utf8"));
assert.equal(metadata.version, version);
assert.equal(metadata.path, installerName);
assert.equal(metadata.sha512, digest(installer, "sha512", "base64"));
assert.equal(metadata.files.length, 1);
assert.equal(metadata.files[0].url, installerName);
assert.equal(metadata.files[0].size, installer.length);
assert.equal(metadata.files[0].sha512, metadata.sha512);
const feed = yaml.load(await readFile(resolve(release, "win-unpacked/resources/app-update.yml"), "utf8"));
assert.equal(feed.provider, "github");
assert.equal(feed.owner, "lostthoughts54");
assert.equal(feed.repo, "seeing-stone");
assert.ok(!feed.token && !feed.private);
const source = await readFile(resolve(root, "artifacts", sourceName));
assert.equal((await readFile(resolve(root, "artifacts", `${sourceName}.sha256.txt`), "utf8")).trim(),
  `${digest(source)}  ${sourceName}`);
execFileSync(process.execPath, ["scripts/validate-redistribution-compliance.mjs"], { cwd: root, stdio: "inherit", windowsHide: true });
await mkdir(output, { recursive: true });
for (const name of [installerName, `${installerName}.blockmap`, "latest.yml"]) {
  await cp(resolve(release, name), resolve(output, name));
}
for (const name of [sourceName, `${sourceName}.sha256.txt`]) {
  await cp(resolve(root, "artifacts", name), resolve(output, name));
}
await writeFile(resolve(output, `${installerName}.sha256.txt`), `${digest(installer)}  ${installerName}\n`);
process.stdout.write(`UPLOAD_ASSETS_VERIFIED ${output}\nClean-machine release approval remains a separate gate.\n`);
