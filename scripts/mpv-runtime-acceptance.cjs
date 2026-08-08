"use strict";

const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { createHash } = require("node:crypto");
const { existsSync, readFileSync, writeFileSync } = require("node:fs");
const { join, resolve } = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { MpvIpcClient } = require("../dist/main/services/mpvIpc.js");

const root = resolve(__dirname, "..");
const runtime = process.argv[2] ? resolve(process.argv[2]) : join(root, ".runtime", "mpv");
const executable = join(runtime, "mpv.exe");
const consoleExecutable = join(runtime, "mpv.com");
const fixture = join(root, ".runtime", "mpv-adapter-acceptance.mkv");
const subtitleFixture = join(root, ".runtime", "mpv-adapter-acceptance.srt");

void main().catch((error) => {
  process.stderr.write(`mpv runtime acceptance failed: ${safeFailureMessage(error)}\n`);
  process.exitCode = 1;
});

async function main() {
  assert.equal(existsSync(executable), true, "Run pnpm setup:mpv first.");
  const manifest = JSON.parse(readFileSync(join(root, "mpv-runtime.json"), "utf8"));
  const executableHash = createHash("sha256").update(readFileSync(executable)).digest("hex");
  assert.equal(executableHash, manifest.executableSha256, "Pinned mpv.exe checksum mismatch.");
  if (!existsSync(fixture)) createFixture();
  if (!existsSync(subtitleFixture)) {
    writeFileSync(subtitleFixture, "1\n00:00:00,000 --> 00:00:02,500\nSynthetic subtitle acceptance\n", "utf8");
  }

  const pipe = `\\\\.\\pipe\\localfirst-mpv-acceptance-${randomUUID()}`;
  const child = spawn(executable, [
    "--no-config",
    "--terminal=no",
    "--vo=null",
    "--ao=null",
    "--pause=yes",
    `--sub-file=${subtitleFixture}`,
    `--input-ipc-server=${pipe}`,
    "--",
    fixture,
  ], { windowsHide: true, stdio: "ignore" });
  const ipc = new MpvIpcClient();
  try {
    await ipc.connect(pipe, 10000);
    const version = await ipc.command(["get_property", "mpv-version"]);
    assert.equal(String(version), `mpv ${manifest.version}`);
    const duration = Number(await waitForProperty(ipc, "duration"));
    assert.ok(duration >= 11 && duration <= 13, `Unexpected duration: ${duration}`);

    await ipc.command(["seek", 5, "absolute+exact"]);
    const position = Number(await waitForPropertyValue(ipc, "time-pos", (value) => Math.abs(Number(value) - 5) < 0.25));
    assert.ok(Math.abs(position - 5) < 0.25, `Unexpected seek position: ${position}`);

    await ipc.command(["set_property", "pause", false]);
    await delay(250);
    assert.equal(await ipc.command(["get_property", "pause"]), false);
    const advanced = Number(await waitForProperty(ipc, "time-pos"));
    assert.ok(advanced > position, "Authoritative mpv time did not advance.");

    const trackList = await ipc.command(["get_property", "track-list"]);
    assert.ok(Array.isArray(trackList) && trackList.some((track) => track.type === "video"));
    const audioTrack = trackList.find((track) => track.type === "audio");
    const subtitleTrack = trackList.find((track) => track.type === "sub");
    assert.equal(typeof audioTrack?.id, "number", "Synthetic audio track was not discovered.");
    assert.equal(typeof subtitleTrack?.id, "number", "Synthetic subtitle track was not discovered.");
    await ipc.command(["set_property", "aid", audioTrack.id]);
    await ipc.command(["set_property", "sid", subtitleTrack.id]);
    assert.equal(await ipc.command(["get_property", "aid"]), audioTrack.id);
    assert.equal(await ipc.command(["get_property", "sid"]), subtitleTrack.id);
    await ipc.command(["set_property", "speed", 1.05]);
    assert.equal(await ipc.command(["get_property", "speed"]), 1.05);
    process.stdout.write(`mpv runtime acceptance passed (${version}, duration ${duration.toFixed(2)}s, audio and subtitle tracks verified).\n`);
  } finally {
    await ipc.command(["quit"]).catch(() => undefined);
    ipc.close();
    if (!child.killed) child.kill();
  }
}

function createFixture() {
  const result = spawnSync(consoleExecutable, [
    "--no-config",
    "--ovc=mpeg4",
    "--oac=aac",
    "--audio-file=av://lavfi:sine=frequency=440:duration=12",
    `--o=${fixture}`,
    "av://lavfi:testsrc2=duration=12:size=640x360:rate=24",
  ], { cwd: root, encoding: "utf8", windowsHide: true });
  if (result.status !== 0 || !existsSync(fixture)) throw new Error("Could not generate the local mpv acceptance fixture.");
}

async function waitForProperty(ipc, property) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const value = await ipc.command(["get_property", property]).catch(() => null);
    if (value !== null && value !== undefined) return value;
    await delay(50);
  }
  throw new Error(`Timed out reading mpv property ${property}.`);
}

async function waitForPropertyValue(ipc, property, predicate) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const value = await ipc.command(["get_property", property]).catch(() => null);
    if (value !== null && value !== undefined && predicate(value)) return value;
    await delay(50);
  }
  throw new Error(`Timed out waiting for mpv property ${property}.`);
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function safeFailureMessage(error) {
  return String(error?.message || error || "Unknown failure")
    .replace(/https?:\/\/[^\s"')]+/gi, "<url>")
    .replace(/[A-Za-z]:[\\/][^\r\n"')]+/g, "<path>")
    .slice(0, 500);
}
