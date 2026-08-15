"use strict";

const assert = require("node:assert/strict");
const { existsSync, readFileSync, rmSync } = require("node:fs");
const { resolve } = require("node:path");
const { app, BrowserWindow, ipcMain } = require("electron");
app.commandLine.appendSwitch("disable-error-dialogs");

const root = resolve(__dirname, "..");
const resourcesArgument = process.argv.find((argument) => argument.startsWith("--resources="));
const resourcesRoot = resourcesArgument
  ? resolve(resourcesArgument.slice("--resources=".length))
  : null;
const cpuReadback = process.argv.includes("--cpu-readback");
const diagnosticLogPath = resolve(root, "artifacts", cpuReadback
  ? "libmpv-cpu-readback-smoke.ndjson"
  : "libmpv-shared-texture-smoke.ndjson");
if (existsSync(diagnosticLogPath)) rmSync(diagnosticLogPath);
const { LibMpvHost } = require(resolve(root, "dist", "main", "services", "libMpvHost.js"));
const { ElectronLibMpvBridge } = require(resolve(root, "dist", "main", "services", "libMpvElectronBridge.js"));
const manifest = require(resourcesRoot
  ? resolve(resourcesRoot, "libmpv", "runtime-manifest.json")
  : resolve(root, "libmpv-runtime.json"));
const libmpvRoot = resourcesRoot
  ? resolve(resourcesRoot, "libmpv")
  : resolve(root, ".runtime", "libmpv");

let window = null;
let host = null;
let bridge = null;

const delay = (milliseconds) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));

async function waitFor(predicate, timeout, label) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(50);
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

async function shutdown() {
  await host?.destroy().catch(() => undefined);
  host = null;
  bridge = null;
  if (window && !window.isDestroyed()) window.destroy();
  window = null;
}

app.whenReady().then(async () => {
  const success = (value) => ({ ok: true, value });
  ipcMain.handle("playback:get-adapter-preference", () => success({
    selected: "libmpv",
    launchSelection: "libmpv",
    active: "libmpv",
    embeddedAvailable: true,
    libmpvAvailable: true,
    fallbackActive: false,
    fallbackFrom: null,
    fallbackReason: null,
    restartRequired: false,
  }));
  ipcMain.handle("session:restore", () => success({
    authenticated: false,
    persistence: "none",
    server: null,
    user: null,
  }));
  ipcMain.handle("server:discover", () => success([]));
  ipcMain.handle("playback:set-viewport", () => success(null));
  window = new BrowserWindow({
    width: 1120,
    height: 780,
    show: false,
    backgroundColor: "#020207",
    webPreferences: {
      preload: resolve(root, "dist", "preload", "index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  bridge = new ElectronLibMpvBridge(
    window,
    ipcMain,
    resolve(libmpvRoot, manifest.libmpv.library.filename),
    resolve(libmpvRoot, manifest.libmpv.nativeAddon.filename),
    manifest.libmpv.clientApiVersion,
    {
      enabled: true,
      decoderMode: "current",
      requestedDecoderMode: "current",
      hwdec: "auto-safe",
      presentationMode: cpuReadback ? "cpu-readback" : "shared-texture",
      logFilePath: diagnosticLogPath,
      unsupportedReason: null,
    },
  );
  host = new LibMpvHost({ available: true, reason: null, clientApiVersion: manifest.libmpv.clientApiVersion, renderApi: "opengl-angle" }, bridge);
  await host.initialize();
  await window.loadFile(resolve(root, "dist", "renderer", "index.html"));
  await window.webContents.executeJavaScript(`(() => {
    document.getElementById("loginView")?.classList.add("is-hidden");
    document.getElementById("mainView")?.classList.add("is-hidden");
    document.getElementById("playerView")?.classList.remove("is-hidden");
    return Boolean(document.getElementById("playerViewport"));
  })()`);
  window.show();
  bridge.updateViewport({ width: 960, height: 540, visible: true, revision: 1, deviceScaleFactor: window.webContents.getZoomFactor() });
  const session = await host.open({ location: resolve(root, "assets", "fixtures", "libmpv-h264-gate.mp4") }, 0);
  const tracks = await session.query("track-list");
  assert.ok(Array.isArray(tracks) && tracks.some((track) => track?.type === "video"), "Production bridge did not expose a video track.");
  await session.command({ kind: "pause" });
  await waitFor(async () => await session.query("pause") === true, 2000, "production pause command");
  for (const rate of [1.04, 0.94, 1]) {
    await session.command({ kind: "rate", rate });
    await waitFor(async () => Math.abs(Number(await session.query("speed")) - rate) < 0.001, 2000, `playback rate ${rate}`);
  }
  await session.command({ kind: "seek", positionTicks: 2_500_000 });
  await session.command({ kind: "play" });
  if (!cpuReadback) {
    const steadyStateStart = await session.query("seeing-stone-frame-stats");
    await waitFor(async () => {
      const stats = await session.query("seeing-stone-frame-stats");
      return stats.renderedFrames >= steadyStateStart.renderedFrames + 6;
    }, 5000, "shared-texture slot reuse during steady playback");
  }
  const beforeReload = await session.query("seeing-stone-frame-stats");
  window.webContents.reload();
  await waitFor(async () => {
    const stats = await session.query("seeing-stone-frame-stats");
    return stats.renderedFrames > beforeReload.renderedFrames;
  }, 7500, "frames after production renderer reload");
  window.setFullScreen(true);
  let presenterLayers = [];
  if (cpuReadback) {
    await waitFor(async () => {
      const stats = await session.query("seeing-stone-frame-stats");
      presenterLayers = await window.webContents.executeJavaScript(`[
        document.getElementById("libmpvVideoSurface")?.style.zIndex,
        document.getElementById("libmpvVideoSurfaceBack")?.style.zIndex,
      ].filter(Boolean).map(Number)`);
      return stats.readbackFrames > 0 && presenterLayers.length === 1 && presenterLayers[0] === 1;
    }, 5000, "CPU readback presenter layer and native readback frames");
  } else {
    await waitFor(async () => {
      presenterLayers = await window.webContents.executeJavaScript(`[
        document.getElementById("libmpvVideoSurface")?.style.zIndex,
        document.getElementById("libmpvVideoSurfaceBack")?.style.zIndex,
      ].filter(Boolean).map(Number)`);
      return presenterLayers.length === 2 && presenterLayers.every((layer) => layer === 1 || layer === 2);
    }, 3000, "both bounded production presenter layers");
  }
  window.setFullScreen(false);
  await delay(500);
  await session.stop();
  const diagnosticEvents = readFileSync(diagnosticLogPath, "utf8")
    .trim().split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
  if (!cpuReadback) {
    const eventNames = diagnosticEvents.map((event) => event.event);
    assert.ok(eventNames.includes("texture-renderer-receipt"), "Shared texture was not received by the renderer.");
    assert.ok(eventNames.includes("texture-video-frame-created"), "Shared texture did not create a VideoFrame.");
    assert.ok(eventNames.includes("texture-video-frame-closed"), "Shared texture VideoFrame was not closed.");
    assert.ok(eventNames.includes("texture-renderer-gpu-release-complete"), "Renderer GPU release callback did not complete.");
    assert.ok(eventNames.includes("texture-slot-reusable"), "No native texture slot reached the definitive reusable state.");
    assert.ok(diagnosticEvents.some((event) => event.event === "texture-renderer-gpu-release-complete"
      && event.details?.reason === "canvas-overwritten"), "A canvas overwrite did not produce a GPU completion callback.");
    assert.ok(!eventNames.includes("texture-lifecycle-violation"), "A shared-texture lifecycle assertion failed.");
  }
  await shutdown();
  process.stdout.write(`${JSON.stringify({
    result: "passed",
    presenter: cpuReadback ? "cpu-readback-preload" : "production-preload",
    presenterLayers,
    trackCount: tracks.length,
    playbackRates: [1.04, 0.94, 1],
  })}\n`);
  app.quit();
}).catch(async (error) => {
  process.stderr.write(`${error?.stack || String(error)}\n`);
  await shutdown();
  app.exit(1);
});

setTimeout(async () => {
  process.stderr.write("Integrated libmpv transport smoke timed out.\n");
  await shutdown();
  app.exit(1);
}, 30_000).unref();
