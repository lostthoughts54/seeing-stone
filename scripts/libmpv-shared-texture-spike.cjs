"use strict";

const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { readFileSync, writeFileSync } = require("node:fs");
const { join, resolve } = require("node:path");
const { app, BrowserWindow, ipcMain, sharedTexture } = require("electron");

const root = resolve(__dirname, "..");
const addon = require(join(root, "native", "libmpv-bridge", "build", "Release", "seeing_stone_libmpv_bridge.node"));
const automated = process.argv.includes("--automated");
const realVideo = process.argv.includes("--real-video");
const scaleArgument = process.argv.find((argument) => argument.startsWith("--scale="));
const forcedScale = scaleArgument ? Number(scaleArgument.slice("--scale=".length)) : null;
if (forcedScale !== null) {
  assert.ok(Number.isFinite(forcedScale) && forcedScale >= 0.5 && forcedScale <= 4, "Invalid forced device scale factor.");
  app.commandLine.appendSwitch("force-device-scale-factor", String(forcedScale));
}
const fixturePath = resolve(root, "assets", "fixtures", "libmpv-h264-gate.mp4");
const producer = realVideo
  ? new addon.LibMpvVideoProducer({
      libraryPath: resolve(root, ".runtime", "libmpv", "libmpv-2.dll"),
      angleDirectory: resolve(root, "node_modules", "electron", "dist"),
      sourcePath: fixturePath,
      width: 1280,
      height: 720,
      poolSize: 3,
    })
  : new addon.SyntheticTextureProducer({ width: 1280, height: 720, poolSize: 3 });
const producedFrameCount = () => producer.getStats()[realVideo ? "renderedFrames" : "producedFrames"];
process.stdout.write(`${realVideo ? "Real libmpv video" : "Synthetic"} shared-texture spike starting (automated=${automated}, argv=${JSON.stringify(process.argv)}).\n`);

let window = null;
let receiverReady = false;
let surfaceGeneration = 0;
let pumping = false;
let stopped = false;
let suspended = false;
let presented = 0;
let transferred = 0;
let released = 0;
let maxOutstanding = 0;
let lastPresentedSequence = 0;
let stalePresentationMessages = 0;
let maxPresentationMilliseconds = 0;
let receiverReport = null;
let pumpTimer = null;
let domReady = false;
let listenerReady = false;
let surfaceStartPromise = null;
let received = 0;

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function waitFor(predicate, timeout, label) {
  const deadline = Date.now() + timeout;
  return new Promise((resolveWait, rejectWait) => {
    const poll = () => {
      if (predicate()) return resolveWait();
      if (Date.now() >= deadline) return rejectWait(new Error(`Timed out waiting for ${label}.`));
      setTimeout(poll, 25);
    };
    poll();
  });
}

async function revealExistingViewport() {
  await window.webContents.executeJavaScript(`(() => {
    document.getElementById("loginView")?.classList.add("is-hidden");
    document.getElementById("mainView")?.classList.add("is-hidden");
    document.getElementById("playerView")?.classList.remove("is-hidden");
    document.getElementById("playerFrameStatus")?.classList.add("is-hidden");
    const title = document.getElementById("playerTitle");
    if (title) title.textContent = ${JSON.stringify(realVideo ? "Real libmpv render-API gate" : "Synthetic shared-texture gate")};
    const subtitle = document.getElementById("playerSubtitle");
    if (subtitle) subtitle.textContent = ${JSON.stringify(realVideo ? "libmpv OpenGL → ANGLE/D3D11 → Electron sharedTexture" : "D3D11 → Electron sharedTexture → GPU-backed VideoFrame")};
    return Boolean(document.getElementById("playerViewport"));
  })()`);
}

async function beginSurface() {
  if (surfaceStartPromise) return surfaceStartPromise;
  surfaceStartPromise = beginSurfaceOnce().finally(() => { surfaceStartPromise = null; });
  return surfaceStartPromise;
}

async function beginSurfaceOnce() {
  if (!domReady || !listenerReady) return;
  receiverReady = false;
  surfaceGeneration += 1;
  await revealExistingViewport();
  process.stdout.write(`Sending presenter start for surface generation ${surfaceGeneration}.\n`);
  window.webContents.send("seeing-stone:synthetic-texture-start", {
    surfaceGeneration,
    mechanism: "image-bitmap-renderer",
  });
  await waitFor(() => receiverReady, 5000, "renderer shared-texture receiver");
}

function schedulePump() {
  if (stopped || pumpTimer) return;
  pumpTimer = setTimeout(() => {
    pumpTimer = null;
    void pumpOneFrame();
  }, 16);
}

async function pumpOneFrame() {
  if (stopped || pumping || suspended || !receiverReady || !window || window.isDestroyed()) {
    schedulePump();
    return;
  }
  const frame = producer.nextFrame();
  if (!frame) {
    schedulePump();
    return;
  }
  pumping = true;
  let imported = null;
  try {
    imported = sharedTexture.importSharedTexture({
      textureInfo: {
        pixelFormat: "bgra",
        codedSize: { width: frame.width, height: frame.height },
        visibleRect: { x: 0, y: 0, width: frame.width, height: frame.height },
        timestamp: frame.timestampMicroseconds,
        handle: { ntHandle: frame.ntHandle },
      },
      allReferencesReleased: () => {
        if (producer.releaseFrame(frame.slot, frame.sequence)) released += 1;
      },
    });
    await sharedTexture.sendSharedTexture({
      frame: window.webContents.mainFrame,
      importedSharedTexture: imported,
    }, { sequence: frame.sequence, surfaceGeneration });
    transferred += 1;
  } catch (error) {
    process.stderr.write(`Shared-texture frame ${frame.sequence} failed: ${error?.message || String(error)}\n`);
  } finally {
    imported?.release();
    pumping = false;
    maxOutstanding = Math.max(maxOutstanding, producer.getStats().outstandingFrames);
    schedulePump();
  }
}

async function assertViewportFit(label) {
  const geometry = await window.webContents.executeJavaScript(`(() => {
    const viewport = document.getElementById("playerViewport").getBoundingClientRect();
    const video = document.getElementById("libmpvSyntheticTextureSurface").getBoundingClientRect();
    return { viewport: { width: viewport.width, height: viewport.height }, video: { width: video.width, height: video.height }, dpi: window.devicePixelRatio };
  })()`);
  assert.ok(geometry.viewport.width >= 16 && geometry.viewport.height >= 16, `${label}: viewport is unusably small.`);
  assert.ok(Math.abs(geometry.viewport.width - geometry.video.width) <= 1, `${label}: video width does not match viewport.`);
  assert.ok(Math.abs(geometry.viewport.height - geometry.video.height) <= 1, `${label}: video height does not match viewport.`);
  return geometry;
}

async function runAutomatedAcceptance() {
  await waitFor(() => presented >= 45, 10000, "initial advancing frames");
  const initial = await assertViewportFit("initial");
  let controllerSurface = null;
  if (realVideo) {
    const tracks = producer.getProperty("track-list");
    assert.ok(Array.isArray(tracks) && tracks.some((track) => track?.type === "video"), "libmpv did not expose a video track.");
    producer.command(["set", "pause", "yes"]);
    await waitFor(() => producer.getProperty("pause") === true, 2000, "native pause command");
    producer.command(["seek", "0.25", "absolute+exact"]);
    producer.command(["set", "pause", "no"]);
    await waitFor(() => producer.getProperty("pause") === false, 2000, "native play command");
    controllerSurface = {
      trackCount: tracks.length,
      durationSeconds: producer.getProperty("duration"),
      seekable: producer.getProperty("seekable"),
    };
  }

  window.setSize(1040, 760);
  await delay(750);
  const resized = await assertViewportFit("resized");

  window.setFullScreen(true);
  await delay(1000);
  const fullscreen = await assertViewportFit("fullscreen");
  window.setFullScreen(false);
  await delay(750);

  window.minimize();
  await waitFor(() => suspended, 2000, "native production suspension after minimize");
  const beforeMinimize = producedFrameCount();
  await delay(750);
  const duringMinimize = producedFrameCount();
  assert.equal(duringMinimize, beforeMinimize, "Frame production continued while minimized.");
  window.restore();
  await delay(750);
  await waitFor(() => producedFrameCount() > duringMinimize, 3000, "frames after restore");

  const beforeReload = presented;
  receiverReady = false;
  window.webContents.reload();
  await waitFor(() => receiverReady, 7500, "receiver after renderer reload");
  await waitFor(() => presented >= beforeReload + 30, 7500, "advancing frames after renderer reload");
  const reloaded = await assertViewportFit("renderer reload");

  await shutdown();
  const stats = producer.getStats();
  assert.equal(stats.outstandingFrames, 0, "Electron retained texture references at shutdown.");
  assert.equal(stats.unusable, false, "The native producer became unusable.");
  assert.ok(presented >= 75, "Too few frames were presented.");
  assert.ok(lastPresentedSequence >= presented, "Frame sequence did not advance.");
  assert.ok(maxOutstanding <= stats.poolSize, "Texture references exceeded the bounded pool.");
  assert.ok(maxPresentationMilliseconds < 1000, "Presentation latency exceeded the bounded one-second transfer timeout.");
  assert.equal(stalePresentationMessages, 0, "Stale presentation callbacks were accepted.");
  if (forcedScale !== null) assert.ok(Math.abs(reloaded.dpi - forcedScale) <= 0.05, "Forced DPI scale was not applied.");
  producer.destroy();
  const quarantined = realVideo ? addon.quarantinedVideoStateCount() : addon.quarantinedStateCount();
  assert.equal(quarantined, 0, "A texture pool was quarantined during deterministic shutdown.");

  const result = {
    result: "passed",
    pipeline: realVideo ? "libmpv-opengl-angle" : "synthetic-d3d11",
    forcedScale,
    mechanism: receiverReport.mechanism,
    capabilities: receiverReport.capabilities,
    frames: { transferred, presented, released, lastSequence: lastPresentedSequence, maxOutstanding, maxPresentationMilliseconds },
    geometry: { initial, resized, fullscreen, reloaded },
    native: stats,
    continuousCpuReadback: false,
    bitmapIpc: false,
    ...(realVideo ? {
      fixtureSha256: createHash("sha256").update(readFileSync(fixturePath)).digest("hex"),
      librarySha256: createHash("sha256").update(readFileSync(resolve(root, ".runtime", "libmpv", "libmpv-2.dll"))).digest("hex"),
      nativeAddonSha256: createHash("sha256").update(readFileSync(resolve(root, "native", "libmpv-bridge", "build", "Release", "seeing_stone_libmpv_bridge.node"))).digest("hex"),
      realVideoRenderedThroughMpvRenderApi: true,
      hwdec: "no-conservative-gate",
      controllerSurface,
    } : {}),
  };
  if (realVideo) {
    const scaleLabel = String(forcedScale ?? "system").replace(".", "-");
    writeFileSync(resolve(root, "native", "libmpv-runtime", `real-video-gate-result-scale-${scaleLabel}.json`),
      `${JSON.stringify(result, null, 2)}\n`, "utf8");
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  app.quit();
}

async function shutdown() {
  if (stopped) return;
  stopped = true;
  if (pumpTimer) clearTimeout(pumpTimer);
  pumpTimer = null;
  if (window && !window.isDestroyed()) window.webContents.send("seeing-stone:synthetic-texture-stop");
  await waitFor(() => producer.getStats().outstandingFrames === 0, 5000, "Electron texture release acknowledgements");
}

ipcMain.on("seeing-stone:synthetic-texture-ready", (event, report) => {
  if (!window || event.sender !== window.webContents || report?.surfaceGeneration !== surfaceGeneration) return;
  receiverReport = report;
  receiverReady = true;
  schedulePump();
});

ipcMain.on("seeing-stone:synthetic-texture-bootstrap", (event, report) => {
  if (!window || event.sender !== window.webContents) return;
  process.stdout.write(`Preload bootstrap: ${JSON.stringify(report)}\n`);
  if (!report?.sharedTextureAvailable) {
    process.stderr.write("Electron sharedTexture is unavailable in the configured preload context.\n");
  }
});

ipcMain.on("seeing-stone:synthetic-texture-listener-ready", (event) => {
  if (!window || event.sender !== window.webContents) return;
  listenerReady = true;
  process.stdout.write("Preload receiver listener ready.\n");
  void beginSurface().catch((error) => process.stderr.write(`Surface initialization failed: ${error?.stack || String(error)}\n`));
});

ipcMain.on("seeing-stone:synthetic-texture-start-received", (event, report) => {
  if (!window || event.sender !== window.webContents) return;
  process.stdout.write(`Preload received presenter start: ${JSON.stringify(report)}\n`);
});

ipcMain.on("seeing-stone:synthetic-texture-presented", (event, report) => {
  if (!window || event.sender !== window.webContents) return;
  if (report?.surfaceGeneration !== surfaceGeneration) {
    stalePresentationMessages += 1;
    return;
  }
  if (!Number.isSafeInteger(report.sequence) || report.sequence <= lastPresentedSequence) return;
  lastPresentedSequence = report.sequence;
  presented += 1;
  maxPresentationMilliseconds = Math.max(maxPresentationMilliseconds, Number(report.presentationMilliseconds) || 0);
});

ipcMain.on("seeing-stone:synthetic-texture-received", (event, report) => {
  if (!window || event.sender !== window.webContents || report?.surfaceGeneration !== surfaceGeneration) return;
  received += 1;
  if (received === 1) process.stdout.write(`Renderer received first shared texture: ${JSON.stringify(report)}\n`);
});

ipcMain.on("seeing-stone:synthetic-texture-error", (event, report) => {
  if (window && event.sender === window.webContents) process.stderr.write(`${JSON.stringify(report)}\n`);
});

app.on("before-quit", (event) => {
  if (!stopped) {
    event.preventDefault();
    void shutdown().finally(() => {
      producer.destroy();
      app.quit();
    });
  }
});

const hardTimeout = setTimeout(() => {
  process.stderr.write(`${realVideo ? "Real-video" : "Synthetic"} spike hard timeout: ${JSON.stringify({ receiverReady, surfaceGeneration, presented, released, producer: producer.getStats() })}\n`);
  void shutdown().finally(() => {
    producer.destroy();
    app.exit(1);
  });
}, automated ? 45000 : 300000);

app.whenReady().then(async () => {
  process.stdout.write("Electron app ready.\n");
  window = new BrowserWindow({
    width: 1280,
    height: 820,
    title: "Seeing Stone shared-texture gate",
    show: false,
    backgroundColor: "#020407",
    webPreferences: {
      preload: join(__dirname, "libmpv-shared-texture-preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  window.on("minimize", () => { suspended = true; producer.setSuspended?.(true); });
  window.on("restore", () => { producer.setSuspended?.(false); suspended = false; schedulePump(); });
  window.on("closed", () => { window = null; });
  window.webContents.on("did-finish-load", () => {
    process.stdout.write("Renderer finished loading.\n");
    domReady = true;
    void beginSurface().catch((error) => process.stderr.write(`Surface initialization failed: ${error?.stack || String(error)}\n`));
  });
  window.webContents.on("did-start-loading", () => {
    domReady = false;
    listenerReady = false;
    receiverReady = false;
  });
  window.webContents.on("preload-error", (_event, _path, error) => {
    process.stderr.write(`Preload error: ${error?.stack || String(error)}\n`);
  });
  window.webContents.on("did-fail-load", (_event, code, description) => {
    process.stderr.write(`Renderer load failed (${code}): ${description}\n`);
  });
  window.webContents.on("render-process-gone", (_event, details) => {
    process.stderr.write(`Renderer process gone: ${JSON.stringify(details)}\n`);
  });
  window.webContents.on("console-message", (_event, details) => {
    if (details.level === "error") process.stderr.write(`Renderer console: ${details.message}\n`);
  });
  await window.loadFile(join(root, "dist", "renderer", "index.html"));
  process.stdout.write("Renderer file loaded; showing acceptance window.\n");
  window.show();
  if (automated) await runAutomatedAcceptance();
}).then(() => {
  if (!automated) return;
  clearTimeout(hardTimeout);
}).catch((error) => {
  clearTimeout(hardTimeout);
  process.stderr.write(`${realVideo ? "Real-video" : "Synthetic"} shared-texture acceptance failed: ${error?.stack || String(error)}\n`);
  void shutdown().catch((shutdownError) => {
    process.stderr.write(`Synthetic shutdown failed: ${shutdownError?.stack || String(shutdownError)}\n`);
  }).finally(() => {
    producer.destroy();
    app.exit(1);
  });
});
