"use strict";

const assert = require("node:assert/strict");
const { mkdirSync, mkdtempSync, readFileSync, writeFileSync } = require("node:fs");
const { join, relative, resolve } = require("node:path");
const { app, BrowserWindow, ipcMain, screen } = require("electron");
app.commandLine.appendSwitch("disable-error-dialogs");

const root = resolve(__dirname, "..");
const artifactRoot = resolve(root, "artifacts", "product-polish");
mkdirSync(artifactRoot, { recursive: true });
const runDirectory = mkdtempSync(join(artifactRoot, "native-transport-"));
const profileDirectory = join(runDirectory, "profile");
mkdirSync(profileDirectory, { recursive: true });
app.setPath("userData", profileDirectory);
app.setPath("sessionData", profileDirectory);
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");
const resourcesArgument = process.argv.find((argument) => argument.startsWith("--resources="));
const resourcesRoot = resourcesArgument
  ? resolve(resourcesArgument.slice("--resources=".length))
  : null;
const cpuReadback = process.argv.includes("--cpu-readback");
const stress = process.argv.includes("--stress");
const diagnosticLogPath = resolve(runDirectory, cpuReadback
  ? "libmpv-cpu-readback-smoke.ndjson"
  : "libmpv-shared-texture-smoke.ndjson");
const codeRoot = resourcesRoot ? resolve(resourcesRoot, "app.asar", "dist") : resolve(root, "dist");
const { LibMpvHost } = require(resolve(codeRoot, "main", "services", "libMpvHost.js"));
const { ElectronLibMpvBridge } = require(resolve(codeRoot, "main", "services", "libMpvElectronBridge.js"));
const manifest = require(resourcesRoot
  ? resolve(resourcesRoot, "libmpv", "runtime-manifest.json")
  : resolve(root, "libmpv-runtime.json"));
const libmpvRoot = resourcesRoot
  ? resolve(resourcesRoot, "libmpv")
  : resolve(root, ".runtime", "libmpv");

let window = null;
let host = null;
let bridge = null;
let discoveryRequests = 0;
let testDisplay = null;

function writeResult(result) {
  const report = {
    ...result,
    hiddenWindow: !stress,
    isolatedProfile: true,
    fixture: "assets/fixtures/libmpv-h264-gate.mp4",
    fullscreenTested: stress,
    testDisplay: testDisplay ? { id: testDisplay.id, bounds: testDisplay.bounds } : null,
    artifactDirectory: relative(root, runDirectory).split("\\").join("/"),
  };
  writeFileSync(join(runDirectory, "result.json"), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

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

async function revealFixtureViewport() {
  const available = await window.webContents.executeJavaScript(`(() => {
    document.getElementById("loginView")?.classList.add("is-hidden");
    document.getElementById("mainView")?.classList.add("is-hidden");
    document.getElementById("playerView")?.classList.remove("is-hidden");
    document.getElementById("playerFrameStatus")?.classList.add("is-hidden");
    return Boolean(document.getElementById("playerViewport"));
  })()`);
  assert.ok(available, "The fixture player viewport is unavailable.");
  assert.equal(window.isVisible(), false, "The isolated smoke window must remain hidden.");
}

app.whenReady().then(async () => {
  if (stress) {
    testDisplay = screen.getAllDisplays().find(display => display.id !== screen.getPrimaryDisplay().id);
    assert.ok(testDisplay, "Fullscreen stress tests require a second monitor to avoid covering the active player.");
  }
  const success = (data) => ({ ok: true, data });
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
  ipcMain.handle("server:discover", () => { discoveryRequests += 1; return success([]); });
  ipcMain.handle("playback:set-viewport", () => success(null));
  window = new BrowserWindow({
    ...(testDisplay ? { x: testDisplay.bounds.x + 64, y: testDisplay.bounds.y + 64 } : {}),
    width: 1120,
    height: 780,
    show: false,
    focusable: false,
    backgroundColor: "#020207",
    webPreferences: {
      preload: resolve(codeRoot, "preload", "index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
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
  await window.loadFile(resolve(codeRoot, "renderer", "index.html"));
  await waitFor(() => discoveryRequests >= 1, 3000, "isolated renderer initialization");
  await revealFixtureViewport();
  bridge.updateViewport({ width: 960, height: 540, visible: true, revision: 1, deviceScaleFactor: window.webContents.getZoomFactor() });
  const session = await host.open({ location: resolve(root, "assets", "fixtures", "libmpv-h264-gate.mp4") }, 0);
  if (stress) bridge.producer.command(["set", "loop-file", "inf"]);
  const tracks = await session.query("track-list");
  assert.ok(Array.isArray(tracks) && tracks.some((track) => track?.type === "video"), "Production bridge did not expose a video track.");
  await session.command({ kind: "pause" });
  await waitFor(async () => await session.query("pause") === true, 2000, "production pause command");
  for (const rate of [1.04, 0.94, 1]) {
    await session.command({ kind: "rate", rate });
    await waitFor(async () => Math.abs(Number(await session.query("speed")) - rate) < 0.001, 2000, `playback rate ${rate}`);
  }
  await session.command({ kind: "seek", positionTicks: 2_500_000 });
  await waitFor(async () => Math.abs(Number(await session.query("time-pos")) - 0.25) < 0.1, 2000, "native exact seek");
  await session.command({ kind: "play" });
  if (!cpuReadback) {
    const steadyStateStart = await session.query("seeing-stone-frame-stats");
    await waitFor(async () => {
      const stats = await session.query("seeing-stone-frame-stats");
      return stats.renderedFrames >= steadyStateStart.renderedFrames + 6;
    }, 5000, "shared-texture slot reuse during steady playback");
  }
  const beforeReload = await session.query("seeing-stone-frame-stats");
  const previousDiscoveryRequests = discoveryRequests;
  const reloaded = new Promise((resolveLoaded) => window.webContents.once("did-finish-load", resolveLoaded));
  window.webContents.reload();
  await reloaded;
  await waitFor(() => discoveryRequests > previousDiscoveryRequests, 3000, "isolated renderer reinitialization");
  await revealFixtureViewport();
  await waitFor(async () => {
    const stats = await session.query("seeing-stone-frame-stats");
    return stats.renderedFrames > beforeReload.renderedFrames;
  }, 7500, "frames after production renderer reload");
  window.setSize(1280, 800);
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
  window.setSize(1120, 780);
  await delay(500);
  const presentedImageHashes = new Set();
  if (stress) {
    window.showInactive();
    for (let cycle = 0; cycle < 10; cycle++) {
      const before = await session.query("seeing-stone-frame-stats");
      window.setFullScreen(cycle % 2 === 0);
      window.emit(cycle % 2 === 0 ? "maximize" : "unmaximize");
      await waitFor(async () => (await session.query("seeing-stone-frame-stats")).renderedFrames >= before.renderedFrames + 30,
        5000, `advancing video after window transition ${cycle}`);
      await delay(1500);
      const hash = await window.webContents.executeJavaScript(`(() => {
        const canvases = [...document.querySelectorAll('canvas[id^="libmpvVideoSurface"]')];
        const canvas = canvases.sort((left, right) => Number(right.style.zIndex) - Number(left.style.zIndex))[0];
        if (!canvas) throw new Error('No presented video canvas');
        const data = canvas.toDataURL();
        let hash = 2166136261;
        for (let index = 0; index < data.length; index++) hash = Math.imul(hash ^ data.charCodeAt(index), 16777619);
        return hash >>> 0;
      })()`);
      presentedImageHashes.add(hash);
    }
    assert.ok(presentedImageHashes.size > 1, "Native frame counters advanced but the displayed video image stayed frozen.");
    window.setFullScreen(false);
  }
  if (!stress) assert.equal(window.isVisible(), false, "The isolated smoke window became visible.");
  const frameStats = await session.query("seeing-stone-frame-stats");
  await session.stop();
  const diagnosticEvents = readFileSync(diagnosticLogPath, "utf8")
    .trim().split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
  if (!cpuReadback) {
    const eventNames = diagnosticEvents.map((event) => event.event);
    assert.ok(eventNames.includes("texture-renderer-receipt"), "Shared texture was not received by the renderer.");
    assert.ok(eventNames.includes("texture-video-frame-created"), "Shared texture did not create a VideoFrame.");
    assert.ok(eventNames.includes("texture-video-frame-closed"), "Shared texture VideoFrame was not closed.");
    assert.ok(eventNames.includes("texture-electron-all-references-released"), "Electron's managed texture reference release did not complete.");
    assert.ok(eventNames.includes("texture-slot-reusable"), "No native texture slot reached the definitive reusable state.");
    const tracked = diagnosticEvents.filter(event => event.event === "texture-slot-tracked").length;
    const released = diagnosticEvents.filter(event => event.event === "texture-slot-reusable").length;
    assert.equal(released, tracked, "Imported texture references leaked after playback stopped.");
    assert.ok(!eventNames.includes("texture-lifecycle-violation"), "A shared-texture lifecycle assertion failed.");
  }
  await shutdown();
  writeResult({
    result: "passed",
    presenter: cpuReadback ? "cpu-readback-preload" : "production-preload",
    presenterLayers,
    trackCount: tracks.length,
    playbackRates: [1.04, 0.94, 1],
    exactSeekSeconds: 0.25,
    rendererReload: true,
    resizeTested: true,
    stressCycles: stress ? 10 : 0,
    distinctPresentedImages: presentedImageHashes.size,
    frameStats,
  });
  app.quit();
}).catch(async (error) => {
  process.stderr.write(`${error?.stack || String(error)}\n`);
  writeResult({ result: "failed", code: error?.code ?? null, message: error?.message ?? String(error) });
  await shutdown();
  app.exit(1);
});

setTimeout(async () => {
  process.stderr.write("Integrated libmpv transport smoke timed out.\n");
  writeResult({ result: "failed", code: "SMOKE_TIMEOUT", message: "Integrated libmpv transport smoke timed out." });
  await shutdown();
  app.exit(1);
}, stress ? 90_000 : 30_000).unref();
