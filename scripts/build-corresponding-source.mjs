import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { access, cp, mkdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const runtimeRoot = resolve(root, ".runtime");
const cacheRoot = resolve(runtimeRoot, "corresponding-source-cache");
const stagingRoot = resolve(runtimeRoot, "corresponding-source-staging");
const artifactsRoot = resolve(root, "artifacts");
const fixedTime = new Date("2000-01-01T00:00:00.000Z");
const allowDownload = process.argv.includes("--download");

const manifest = JSON.parse(await readFile(resolve(root, "redistribution-compliance.json"), "utf8"));
const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const bundleName = `Seeing-Stone-${packageJson.version}-corresponding-source`;
const bundleRoot = resolve(stagingRoot, bundleName);
const archivePath = resolve(artifactsRoot, `${bundleName}.zip`);

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

async function download(url, destination) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`SOURCE_DOWNLOAD_FAILED ${response.status}: ${url}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, bytes);
}

async function verifyArchive(source) {
  const path = resolve(cacheRoot, source.filename);
  try {
    await access(path);
  } catch {
    if (!allowDownload) throw new Error(`SOURCE_ARCHIVE_MISSING: ${source.filename} (rerun with --download)`);
    process.stdout.write(`Downloading ${source.filename}\n`);
    await download(source.url, path);
  }
  const actual = sha256(await readFile(path));
  if (actual !== source.sha256) throw new Error(`SOURCE_ARCHIVE_HASH_MISMATCH: ${source.filename}`);
  return path;
}

async function setFixedTimes(path) {
  const info = await stat(path);
  if (info.isDirectory()) {
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(path);
    for (const entry of entries.sort()) await setFixedTimes(join(path, entry));
  }
  await utimes(path, fixedTime, fixedTime);
}

async function run(command, args) {
  await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { cwd: root, stdio: "inherit", windowsHide: true });
    child.once("error", rejectPromise);
    child.once("exit", (code) => code === 0 ? resolvePromise() : rejectPromise(new Error(`${command} exited ${code}`)));
  });
}

await mkdir(cacheRoot, { recursive: true });
await rm(stagingRoot, { recursive: true, force: true });
await mkdir(resolve(bundleRoot, "source-archives"), { recursive: true });

for (const source of manifest.sourceArchives) {
  const cached = await verifyArchive(source);
  await cp(cached, resolve(bundleRoot, "source-archives", source.filename));
}

for (const relative of manifest.bundleBuildFiles) {
  const source = resolve(root, relative);
  await access(source);
  await cp(source, resolve(bundleRoot, "build-materials", relative), { recursive: true });
}

const readme = `# Seeing Stone ${packageJson.version} corresponding source\n\n`
  + `This archive accompanies the Windows x64 binary release. It contains the pinned source archives, patches, native bridge source, build scripts, configuration, license texts, and binary-to-source manifest used for the bundled native components.\n\n`
  + `The release tag/source archive supplies the complete Seeing Stone application source under GPL-2.0-or-later. The build-materials directory in this archive contains the native runtime portions needed to understand and rebuild the distributed libmpv/FFmpeg stack. No byte-identical build result is asserted.\n\n`
  + `Source archives marked voluntary-source in redistribution-compliance.json are included for completeness; that label does not assert a source-distribution duty for permissively licensed binaries.\n`;
await writeFile(resolve(bundleRoot, "README.md"), readme, "utf8");
await setFixedTimes(bundleRoot);

await mkdir(artifactsRoot, { recursive: true });
await rm(archivePath, { force: true });
await run("tar", ["-a", "-cf", archivePath, "-C", stagingRoot, bundleName]);

const archiveHash = sha256(await readFile(archivePath));
await writeFile(`${archivePath}.sha256.txt`, `${archiveHash}  ${basename(archivePath)}\n`, "utf8");
process.stdout.write(`CORRESPONDING_SOURCE_READY ${archivePath}\nSHA256 ${archiveHash}\n`);
