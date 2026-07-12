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
  const { app, nativeImage } = require("electron");
  const { MpvIpcClient } = require("../dist/main/services/mpvIpc.js");
  const root = resolve(__dirname, "..");
  const runtime = join(root, ".runtime", "mpv");
  const executable = join(runtime, "mpv.exe");
  const fixture = join(root, ".runtime", "mpv-acceptance.mkv");
  assert.equal(existsSync(executable), true, "Run pnpm setup:mpv first.");
  if (!existsSync(fixture)) createFixture(root, runtime, fixture);

  await app.whenReady();
  const pipe = `\\\\.\\pipe\\localfirst-mpv-visual-${randomUUID()}`;
  const child = spawn(executable, [
    "--no-config",
    "--terminal=no",
    "--force-window=immediate",
    "--keep-open=yes",
    "--hwdec=no",
    "--osc=no",
    "--title=LocalFirst mpv visual acceptance",
    "--geometry=960x540",
    "--window-maximized=yes",
    `--input-ipc-server=${pipe}`,
    "--loop-file=inf",
    "--",
    fixture,
  ], { windowsHide: true, stdio: "ignore" });
  const ipc = new MpvIpcClient();
  try {
    await ipc.connect(pipe, 10000);
    await waitForNumber(ipc, "time-pos");
    assert.equal(await waitForBoolean(ipc, "window-maximized", true), true, "The first native player window did not open maximized.");
    await ipc.command(["set_property", "fullscreen", true]);
    await waitForBoolean(ipc, "fullscreen", true);
    await ipc.command(["set_property", "fullscreen", false]);
    await waitForBoolean(ipc, "fullscreen", false);
    assert.equal(await waitForBoolean(ipc, "window-maximized", true), true, "Fullscreen changed the maximized window state.");
    await ipc.command(["set_property", "window-maximized", false]);
    await waitForBoolean(ipc, "window-maximized", false);

    const initialWindowHandle = await waitForProcessWindow(child.pid);
    const fileLoaded = waitForEvent(ipc, "file-loaded", 10000);
    await ipc.command(["loadfile", fixture, "replace"]);
    await fileLoaded;
    assert.equal(await waitForProcessWindow(child.pid), initialWindowHandle, "mpv replaced its native window during same-window autoplay.");
    await waitForNumber(ipc, "time-pos");
    await delay(1000);

    const capturePath = join(root, ".runtime", "mpv-visual-capture.png");
    const windowHandle = await waitForProcessWindow(child.pid);
    capturePhysicalWindow(windowHandle, capturePath);
    const windowImage = nativeImage.createFromPath(capturePath);
    assert.equal(windowImage.isEmpty(), false, "The native player window was not capturable.");
    const metrics = pixelMetrics(windowImage);
    const videoOutput = {
      currentVo: await ipc.command(["get_property", "current-vo"]).catch(() => null),
      configured: await ipc.command(["get_property", "vo-configured"]).catch(() => null),
      parameters: await ipc.command(["get_property", "video-out-params"]).catch(() => null),
      hwdec: await ipc.command(["get_property", "hwdec-current"]).catch(() => null),
    };
    assert.ok(metrics.nonBlackRatio >= 0.15, `Player capture was black (${JSON.stringify({ metrics, videoOutput })}).`);
    assert.ok(metrics.uniqueColors >= 32, `Player capture had no visible video detail (${JSON.stringify({ metrics, videoOutput })}).`);
    process.stdout.write(`mpv visual acceptance passed (${metrics.nonBlackRatio.toFixed(3)} non-black, ${metrics.uniqueColors} colors).\n`);
  } finally {
    await ipc.command(["quit"]).catch(() => undefined);
    ipc.close();
    if (!child.killed) child.kill();
  }
  app.exit(0);
}

async function waitForProcessWindow(processId) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const result = spawnSync(powershellPath(), [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "$process=Get-Process -Id ([int]$env:JELLYFIN_CAPTURE_PID) -ErrorAction SilentlyContinue; if($process){$process.Refresh(); [Console]::Write($process.MainWindowHandle)}",
    ], {
      env: { ...process.env, JELLYFIN_CAPTURE_PID: String(processId) },
      encoding: "utf8",
      windowsHide: true,
    });
    const handle = Number(String(result.stdout || "").trim());
    if (Number.isSafeInteger(handle) && handle > 0) return handle;
    await delay(50);
  }
  throw new Error("The native mpv window did not appear.");
}

function capturePhysicalWindow(handle, outputPath) {
  const script = [
    "Add-Type -AssemblyName System.Drawing",
    "$definition='using System; using System.Runtime.InteropServices; public static class LocalFirstCapture { [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; } [DllImport(\"user32.dll\")] public static extern bool GetWindowRect(IntPtr hwnd, out RECT rect); }'",
    "Add-Type -TypeDefinition $definition",
    "$rect=New-Object LocalFirstCapture+RECT",
    "$ok=[LocalFirstCapture]::GetWindowRect([IntPtr]::new([int64]$env:JELLYFIN_CAPTURE_HANDLE),[ref]$rect)",
    "if(-not $ok){exit 2}",
    "$width=$rect.Right-$rect.Left; $height=$rect.Bottom-$rect.Top",
    "if($width -le 0 -or $height -le 0){exit 3}",
    "$bitmap=New-Object System.Drawing.Bitmap($width,$height)",
    "$graphics=[System.Drawing.Graphics]::FromImage($bitmap)",
    "$graphics.CopyFromScreen($rect.Left,$rect.Top,0,0,$bitmap.Size)",
    "$bitmap.Save($env:JELLYFIN_CAPTURE_PATH,[System.Drawing.Imaging.ImageFormat]::Png)",
    "$graphics.Dispose(); $bitmap.Dispose()",
  ].join("; ");
  const result = spawnSync(powershellPath(), ["-NoProfile", "-NonInteractive", "-Command", script], {
    env: { ...process.env, JELLYFIN_CAPTURE_HANDLE: String(handle), JELLYFIN_CAPTURE_PATH: outputPath },
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0 || !existsSync(outputPath)) throw new Error(`Physical player capture failed (${result.status ?? "launch"}).`);
}

function powershellPath() {
  return process.env.SystemRoot
    ? join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    : "powershell.exe";
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

async function waitForBoolean(ipc, property, expected) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const value = await ipc.command(["get_property", property]).catch(() => null);
    if (value === expected) return value;
    await delay(50);
  }
  throw new Error(`Timed out waiting for mpv property ${property}=${expected}.`);
}

function waitForEvent(ipc, eventName, timeoutMilliseconds) {
  return new Promise((resolveEvent, rejectEvent) => {
    let unsubscribe = () => undefined;
    const timer = setTimeout(() => {
      unsubscribe();
      rejectEvent(new Error(`Timed out waiting for mpv ${eventName}.`));
    }, timeoutMilliseconds);
    unsubscribe = ipc.onMessage((message) => {
      if (message.event !== eventName) return;
      clearTimeout(timer);
      unsubscribe();
      resolveEvent();
    });
  });
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
