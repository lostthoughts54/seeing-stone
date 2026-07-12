const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { MediaProbeService } = require("../dist/main/services/mediaProbe.js");

async function main() {
  const runtimeRoot = path.resolve(__dirname, "../.runtime/mpv");
  const executable = path.join(runtimeRoot, "mpv.exe");
  const fixture = path.resolve(__dirname, "../.runtime/mpv-completion-movie.mp4");
  await Promise.all([fs.access(executable), fs.access(fixture)]);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lf-media-probe-"));
  try {
    const valid = path.join(root, "valid.mp4");
    const invalid = path.join(root, "invalid.mp4");
    await fs.copyFile(fixture, valid);
    await fs.writeFile(invalid, "not media");
    const service = new MediaProbeService({ executable, inputConfig: "unused" }, 15000);
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
  console.error(error?.message || error);
  process.exitCode = 1;
});
