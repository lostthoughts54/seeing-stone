"use strict";

const assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const { existsSync } = require("node:fs");
const { join, resolve } = require("node:path");

const CHILD_FLAG = "--mpv-visual-child";
const PARENT_ENV = "JELLYFIN_MPV_VISUAL_PARENT";

if (!process.versions.electron) {
  runParent();
} else {
  void runChild().catch((error) => {
    process.stderr.write(`${error?.stack || String(error)}\n`);
    require("electron").app.exit(1);
  });
}

function runParent() {
  const electron = require("electron");
  const env = { ...process.env, [PARENT_ENV]: "1" };
  delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(electron, [__filename, CHILD_FLAG], {
    cwd: resolve(__dirname, ".."),
    env,
    stdio: "inherit",
    windowsHide: true,
    timeout: 60000,
  });
  if (result.error) throw result.error;
  if (result.signal || result.status !== 0) process.exitCode = result.status || 1;
}

async function runChild() {
  assert.equal(process.argv.includes(CHILD_FLAG) && process.env[PARENT_ENV] === "1", true);
  const { app, BaseWindow, desktopCapturer, screen } = require("electron");
  const { MpvIpcClient } = require("../dist/main/services/mpvIpc.js");
  const root = resolve(__dirname, "..");
  const runtime = join(root, ".runtime", "mpv");
  const executable = join(runtime, "mpv.exe");
  const fixture = join(root, ".runtime", "mpv-acceptance.mkv");
  assert.equal(existsSync(executable), true, "Run pnpm setup:mpv first.");
  if (!existsSync(fixture)) createFixture(root, runtime, fixture);

  await app.whenReady();
  const title = `LocalFirst mpv visual acceptance ${randomUUID()}`;
  const host = new BaseWindow({
    title,
    width: 960,
    height: 640,
    show: false,
    backgroundColor: "#000000",
  });
  host.setMenu(null);
  const pipe = `\\\\.\\pipe\\localfirst-mpv-visual-${randomUUID()}`;
  const child = spawn(executable, [
    "--no-config",
    "--terminal=no",
    "--force-window=yes",
    "--keep-open=yes",
    "--hwdec=no",
    "--osc=no",
    `--input-ipc-server=${pipe}`,
    `--wid=${nativeHandle(host)}`,
    "--loop-file=inf",
    "--",
    fixture,
  ], { windowsHide: true, stdio: "ignore" });
  const ipc = new MpvIpcClient();
  try {
    await ipc.connect(pipe, 10000);
    await waitForNumber(ipc, "time-pos");
    host.show();
    host.focus();
    await delay(1000);

    const bounds = host.getBounds();
    const display = screen.getDisplayMatching(bounds);
    const sources = await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: display.size,
      fetchWindowIcons: false,
    });
    const source = sources.find((entry) => entry.display_id === String(display.id)) || sources[0];
    assert.ok(source, "The desktop containing the native player window was not capturable.");
    const thumbnailSize = source.thumbnail.getSize();
    const scaleX = thumbnailSize.width / display.bounds.width;
    const scaleY = thumbnailSize.height / display.bounds.height;
    const windowImage = source.thumbnail.crop({
      x: Math.max(0, Math.round((bounds.x - display.bounds.x) * scaleX)),
      y: Math.max(0, Math.round((bounds.y - display.bounds.y) * scaleY)),
      width: Math.min(thumbnailSize.width, Math.max(1, Math.round(bounds.width * scaleX))),
      height: Math.min(thumbnailSize.height, Math.max(1, Math.round(bounds.height * scaleY))),
    });
    const metrics = pixelMetrics(windowImage);
    assert.ok(metrics.nonBlackRatio >= 0.15, `Player capture was black (${JSON.stringify(metrics)}).`);
    assert.ok(metrics.uniqueColors >= 32, `Player capture had no visible video detail (${JSON.stringify(metrics)}).`);
    process.stdout.write(`mpv visual acceptance passed (${metrics.nonBlackRatio.toFixed(3)} non-black, ${metrics.uniqueColors} colors).\n`);
  } finally {
    await ipc.command(["quit"]).catch(() => undefined);
    ipc.close();
    if (!child.killed) child.kill();
    if (!host.isDestroyed()) host.destroy();
  }
  app.exit(0);
}

function nativeHandle(window) {
  const value = window.getNativeWindowHandle();
  const handle = value.length >= 8 ? value.readBigUInt64LE() : BigInt(value.readUInt32LE());
  return Number(handle & 0xffffffffn);
}

function pixelMetrics(image) {
  const size = image.getSize();
  assert.ok(size.width > 100 && size.height > 100, "Player capture thumbnail was empty.");
  const x = Math.min(16, Math.floor(size.width / 10));
  const y = Math.min(48, Math.floor(size.height / 10));
  const cropped = image.crop({
    x,
    y,
    width: Math.max(1, size.width - (x * 2)),
    height: Math.max(1, size.height - y - x),
  }).resize({ width: 160, height: 90, quality: "good" });
  const bitmap = cropped.toBitmap();
  const colors = new Set();
  let nonBlack = 0;
  let pixels = 0;
  for (let offset = 0; offset + 3 < bitmap.length; offset += 4) {
    const blue = bitmap[offset];
    const green = bitmap[offset + 1];
    const red = bitmap[offset + 2];
    if (red + green + blue >= 24) nonBlack += 1;
    colors.add(`${red >> 4}:${green >> 4}:${blue >> 4}`);
    pixels += 1;
  }
  return { nonBlackRatio: pixels ? nonBlack / pixels : 0, uniqueColors: colors.size };
}

function createFixture(root, runtime, fixture) {
  const result = spawnSync(join(runtime, "mpv.com"), [
    "--no-config",
    "--no-audio",
    "--ovc=mpeg4",
    `--o=${fixture}`,
    "av://lavfi:testsrc2=duration=12:size=640x360:rate=24",
  ], { cwd: root, encoding: "utf8", windowsHide: true });
  if (result.status !== 0 || !existsSync(fixture)) throw new Error("Could not generate the visual acceptance fixture.");
}

async function waitForNumber(ipc, property) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const value = await ipc.command(["get_property", property]).catch(() => null);
    if (typeof value === "number" && Number.isFinite(value)) return value;
    await delay(50);
  }
  throw new Error(`Timed out reading mpv property ${property}.`);
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
