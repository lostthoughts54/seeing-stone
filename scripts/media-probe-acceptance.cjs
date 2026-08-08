const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { MediaProbeService } = require("../dist/main/services/mediaProbe.js");

async function main() {
  const runtimeRoot = process.argv[2]
    ? path.resolve(process.argv[2])
    : path.resolve(__dirname, "../.runtime/libmpv");
  const executable = path.join(runtimeRoot, "mpv.exe");
  const manifestPath = process.argv[2]
    ? path.join(runtimeRoot, "runtime-manifest.json")
    : path.resolve(__dirname, "../libmpv-runtime.json");
  const fixture = path.resolve(__dirname, "../.runtime/mpv-completion-movie.mp4");
  await Promise.all([fs.access(executable), fs.access(fixture), fs.access(manifestPath)]);
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  const executableHash = createHash("sha256").update(await fs.readFile(executable)).digest("hex");
  assert.equal(manifest.mediaProbe.role, "headless-media-probe");
  assert.equal(executableHash, manifest.mediaProbe.executable.sha256);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lf-media-probe-"));
  try {
    const valid = path.join(root, "valid.mp4");
    const invalid = path.join(root, "invalid.mp4");
    await fs.copyFile(fixture, valid);
    await fs.writeFile(invalid, "not media");
    const service = new MediaProbeService({ executable }, 15000);
    const result = await service.probe(root, valid);
    assert.equal(result.actualSize, (await fs.stat(valid)).size);
    assert.equal(result.container, "mp4");
    await assert.rejects(service.probe(root, invalid), { code: "MEDIA_PROBE_FAILED" });
    await assert.rejects(service.probe(root, path.join(root, "..", "outside.mp4")), { code: "INVALID_LOCAL_PATH" });
    console.log("Media probe acceptance passed: valid video decoded, invalid media rejected, path escape rejected.");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`Media probe acceptance failed: ${safeFailureMessage(error)}`);
  process.exitCode = 1;
});

function safeFailureMessage(error) {
  return String(error?.message || error || "Unknown failure")
    .replace(/https?:\/\/[^\s"')]+/gi, "<url>")
    .replace(/[A-Za-z]:[\\/][^\r\n"')]+/g, "<path>")
    .slice(0, 500);
}
