"use strict";

const { spawn } = require("node:child_process");
const { mkdir, writeFile } = require("node:fs/promises");
const { join } = require("node:path");
const { app, BrowserWindow, desktopCapturer, screen } = require("electron");
const { EmbeddedVideoHost } = require("../dist/main/services/embeddedVideoHost.js");
const { MpvIpcClient } = require("../dist/main/services/mpvIpc.js");

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function analyzeSurface(image) {
  const bitmap = image.toBitmap();
  const { width, height } = image.getSize();
  const pixelCount = width * height;
  let sampled = 0;
  let nonDark = 0;
  let minimum = 255;
  let maximum = 0;
  for (let pixel = 0; pixel < pixelCount; pixel += 16) {
    const offset = pixel * 4;
    const blue = bitmap[offset];
    const green = bitmap[offset + 1];
    const red = bitmap[offset + 2];
    const brightness = Math.max(red, green, blue);
    minimum = Math.min(minimum, red, green, blue);
    maximum = Math.max(maximum, red, green, blue);
    if (brightness >= 40) nonDark += 1;
    sampled += 1;
  }
  return {
    nonDarkPixelRatio: Number((nonDark / Math.max(1, sampled)).toFixed(4)),
    colorRange: maximum - minimum,
  };
}

function acceptanceMarkerEvidence(image) {
  const bitmap = image.toBitmap();
  const { width, height } = image.getSize();
  const points = [[5, 5], [width - 6, 5], [5, height - 6], [width - 6, height - 6]];
  const samples = points.map(([x, y]) => {
    const offset = ((y * width) + x) * 4;
    const blue = bitmap[offset];
    const green = bitmap[offset + 1];
    const red = bitmap[offset + 2];
    return [red, green, blue];
  });
  return {
    matched: samples.every(([red, green, blue]) => Math.abs(red - 124) <= 12 && Math.abs(green - 58) <= 12 && Math.abs(blue - 237) <= 12),
    samples,
  };
}

function assertHostState(name, host, owner, viewport, expectedVisible, checks) {
  const nativeHost = host.window;
  if (!nativeHost || nativeHost.isDestroyed()) throw new Error(`Native host unavailable during ${name}.`);
  if (nativeHost.getParentWindow() !== owner) throw new Error(`Native host ownership failed during ${name}.`);
  if (nativeHost.isVisible() !== expectedVisible) throw new Error(`Native host visibility failed during ${name}.`);
  if (expectedVisible) {
    const content = owner.getContentBounds();
    const expected = {
      x: Math.round(content.x + viewport.x),
      y: Math.round(content.y + viewport.y),
      width: Math.max(1, Math.round(viewport.width)),
      height: Math.max(1, Math.round(viewport.height)),
    };
    const actual = nativeHost.getBounds();
    for (const key of ["x", "y", "width", "height"]) {
      if (Math.abs(actual[key] - expected[key]) > 2) {
        throw new Error(`Native host bounds failed during ${name} (${key}: expected ${expected[key]}, received ${actual[key]}).`);
      }
    }
  }
  checks.push(name);
}

app.whenReady().then(async () => {
  let owner;
  let host;
  let child;
  const ipc = new MpvIpcClient();
  const lifecycleChecks = [];
  const scaleOnly = process.argv.includes("--scale-only");
  const evidenceSuffix = scaleOnly ? "-scale125" : "";
  try {
  const primary = screen.getPrimaryDisplay().workArea;
  owner = new BrowserWindow({
    x: primary.x + 40,
    y: primary.y + 40,
    width: Math.min(1200, primary.width - 80),
    height: Math.min(780, primary.height - 80),
    show: true,
    title: "Seeing Stone Embedded Spike",
    backgroundColor: "#7c3aed",
  });
  host = new EmbeddedVideoHost(owner);
  host.updateViewport({ x: 180, y: 80, width: 900, height: 506, visible: true, revision: 1 });
  const wid = host.getWindowId();
  if (!/^[1-9][0-9]*$/.test(wid)) throw new Error("Invalid HWND conversion.");

  const media = join(process.cwd(), ".runtime", "mpv-acceptance.mkv");
  const executable = join(process.cwd(), ".runtime", "mpv", "mpv.exe");
  const pipePath = `\\\\.\\pipe\\seeing-stone-embedded-spike-${process.pid}-${Date.now()}`;
  child = spawn(executable, [
    "--no-config", "--terminal=no", "--force-window=immediate", "--keep-open=yes",
    "--gpu-api=opengl",
    "--osc=no", "--input-default-bindings=no", "--input-vo-keyboard=no", `--input-ipc-server=${pipePath}`,
    `--wid=${wid}`, "--loop-file=inf", "--", media,
  ], { windowsHide: true, stdio: "ignore" });
  child.once("error", (error) => { throw error; });

  await ipc.connect(pipePath);
  await delay(1200);
  const playbackEvidence = {
    idleActive: await ipc.command(["get_property", "idle-active"]),
    videoFormat: await ipc.command(["get_property", "video-format"]),
    currentVo: await ipc.command(["get_property", "current-vo"]),
  };
  assertHostState("initial", host, owner, { x: 180, y: 80, width: 900, height: 506 }, true, lifecycleChecks);
  owner.focus();
  await delay(150);
  if (!owner.isFocused()) throw new Error("Video host took focus from the Seeing Stone controls.");
  owner.setBounds({ x: owner.getBounds().x + 80, y: owner.getBounds().y + 50, width: 1280, height: 820 });
  host.updateViewport({ x: 196, y: 92, width: 940, height: 529, visible: true, revision: 2 });
  await delay(500);
  assertHostState("move-and-resize", host, owner, { x: 196, y: 92, width: 940, height: 529 }, true, lifecycleChecks);
  const displays = screen.getAllDisplays();
  if (!scaleOnly && displays.length > 1) {
    const target = displays[1].workArea;
    owner.setBounds({ x: target.x + 40, y: target.y + 40, width: Math.min(1200, target.width - 80), height: Math.min(780, target.height - 80) });
    await delay(500);
    assertHostState("multi-monitor-move", host, owner, { x: 196, y: 92, width: 940, height: 529 }, true, lifecycleChecks);
  }
  owner.minimize(); await delay(300);
  assertHostState("minimized", host, owner, { x: 196, y: 92, width: 940, height: 529 }, false, lifecycleChecks);
  owner.restore(); await delay(500);
  assertHostState("restored", host, owner, { x: 196, y: 92, width: 940, height: 529 }, true, lifecycleChecks);
  host.setFullscreen(true); await delay(500);
  assertHostState("fullscreen-enter", host, owner, { x: 196, y: 92, width: 940, height: 529 }, true, lifecycleChecks);
  host.setFullscreen(false); await delay(500);
  assertHostState("fullscreen-exit", host, owner, { x: 196, y: 92, width: 940, height: 529 }, true, lifecycleChecks);
  host.updateViewport({ x: 196, y: 92, width: 740, height: 416, visible: true, revision: 3 }); await delay(300);
  assertHostState("session-panel-collapse", host, owner, { x: 196, y: 92, width: 740, height: 416 }, true, lifecycleChecks);
  const acceptanceDirectory = join(process.cwd(), ".runtime", "acceptance");
  await mkdir(acceptanceDirectory, { recursive: true });
  const activeDisplay = screen.getDisplayMatching(owner.getBounds());
  if (scaleOnly && Math.abs(activeDisplay.scaleFactor - 1.25) > 0.01) {
    throw new Error(`Forced display scale was not applied (${activeDisplay.scaleFactor}).`);
  }
  let visualEvidence = null;
  if (!scaleOnly) {
  const display = activeDisplay;
  const sources = await desktopCapturer.getSources({
    types: ["screen"],
    thumbnailSize: { width: Math.round(display.size.width * display.scaleFactor), height: Math.round(display.size.height * display.scaleFactor) },
    fetchWindowIcons: false,
  });
  const capture = sources.find((source) => source.display_id === String(display.id));
  if (!capture || capture.thumbnail.isEmpty()) throw new Error("Could not capture isolated embedded-window evidence.");
  const ownerBounds = owner.getContentBounds();
  const captureSize = capture.thumbnail.getSize();
  const scaleX = captureSize.width / display.bounds.width;
  const scaleY = captureSize.height / display.bounds.height;
  const crop = {
    x: Math.max(0, Math.round((ownerBounds.x - display.bounds.x) * scaleX)),
    y: Math.max(0, Math.round((ownerBounds.y - display.bounds.y) * scaleY)),
    width: Math.min(captureSize.width - Math.max(0, Math.round((ownerBounds.x - display.bounds.x) * scaleX)), Math.round(ownerBounds.width * scaleX)),
    height: Math.min(captureSize.height - Math.max(0, Math.round((ownerBounds.y - display.bounds.y) * scaleY)), Math.round(ownerBounds.height * scaleY)),
  };
  const ownerCapture = capture.thumbnail.crop(crop);
  const markerEvidence = acceptanceMarkerEvidence(ownerCapture);
  if (!markerEvidence.matched) throw new Error(`Capture isolation marker was not present (${JSON.stringify(markerEvidence.samples)}).`);
  const surfaceBounds = {
    x: Math.max(0, Math.round(196 * scaleX)),
    y: Math.max(0, Math.round(92 * scaleY)),
    width: Math.min(ownerCapture.getSize().width, Math.round(740 * scaleX)),
    height: Math.min(ownerCapture.getSize().height, Math.round(416 * scaleY)),
  };
  const surfaceCapture = ownerCapture.crop(surfaceBounds);
  visualEvidence = analyzeSurface(surfaceCapture);
  if (visualEvidence.nonDarkPixelRatio < 0.15 || visualEvidence.colorRange < 60) {
    throw new Error(
      `Embedded video surface remained visually blank (vo=${String(playbackEvidence.currentVo)}, video=${String(playbackEvidence.videoFormat)}, idle=${String(playbackEvidence.idleActive)}).`,
    );
  }
  await writeFile(join(acceptanceDirectory, `gate1-embedded-window${evidenceSuffix}.png`), ownerCapture.toPNG());
  await writeFile(join(acceptanceDirectory, `gate1-embedded-surface${evidenceSuffix}.png`), surfaceCapture.toPNG());
  }
  host.updateViewport({ x: 0, y: 0, width: 0, height: 0, visible: false, revision: 4 }); await delay(300);
  assertHostState("route-hidden", host, owner, { x: 0, y: 0, width: 0, height: 0 }, false, lifecycleChecks);
  host.updateViewport({ x: 196, y: 92, width: 940, height: 529, visible: true, revision: 5 }); await delay(500);
  assertHostState("route-restored", host, owner, { x: 196, y: 92, width: 940, height: 529 }, true, lifecycleChecks);
  owner.focus(); await delay(100);
  if (!owner.isFocused()) throw new Error("Video host took focus after route restoration.");
  child.kill(); await delay(500);
  const result = {
    ok: true,
    displays: displays.length,
    scaleFactors: displays.map((display) => display.scaleFactor),
    activeScaleFactor: activeDisplay.scaleFactor,
    ownerFocusRetained: true,
    screenshot: !scaleOnly,
    visualEvidence,
    playbackEvidence,
    lifecycleChecks,
    forcedTermination: true,
  };
  await writeFile(join(acceptanceDirectory, `gate1-embedded-window${evidenceSuffix}.json`), `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(JSON.stringify(result) + "\n");
  app.quit();
  } finally {
    ipc.close();
    if (child && !child.killed) child.kill();
    if (host) { host.hide(); host.destroy(); }
    if (owner && !owner.isDestroyed()) owner.destroy();
  }
}).catch((error) => {
  process.stderr.write(`Embedded window spike failed: ${error instanceof Error ? error.message : "unknown error"}\n`);
  app.exit(1);
});
