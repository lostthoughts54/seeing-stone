"use strict";

const { spawn } = require("node:child_process");
const { join, resolve } = require("node:path");
const { app, BrowserWindow, desktopCapturer, screen } = require("electron");
const { EmbeddedVideoHost } = require("../dist/main/services/embeddedVideoHost.js");
const { MpvIpcClient } = require("../dist/main/services/mpvIpc.js");

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const fullscreenMode = process.argv.includes("--fullscreen");

async function changeFullscreen(host, owner, fullscreen) {
  const event = fullscreen ? "enter-full-screen" : "leave-full-screen";
  const changed = new Promise((resolve) => owner.once(event, resolve));
  host.setFullscreen(fullscreen);
  await Promise.race([changed, delay(2500)]);
  await delay(350);
  if (owner.isFullScreen() !== fullscreen) throw new Error("Application fullscreen transition did not complete.");
}

async function verifyRendererCinemaFullscreen() {
  const renderer = new BrowserWindow({
    width: 1400,
    height: 850,
    show: false,
    backgroundColor: "#000000",
    webPreferences: {
      preload: resolve(__dirname, "player-shell-visual-preload.cjs"),
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  const rendererErrors = [];
  renderer.webContents.on("console-message", (details) => {
    if (details.level === "error") rendererErrors.push(true);
  });
  try {
    await renderer.loadFile(resolve(__dirname, "../dist/renderer/index.html"));
    const evidence = await renderer.webContents.executeJavaScript(`(async () => {
      const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
      for (let attempt = 0; attempt < 120; attempt += 1) {
        const button = document.getElementById("featurePlayButton");
        if (button && !button.disabled) { button.click(); break; }
        await delay(25);
      }
      for (let attempt = 0; attempt < 120; attempt += 1) {
        if (window.seeingStoneVisualAcceptance?.getPlayback().phase === "playing") break;
        await delay(25);
      }
      const acceptance = window.seeingStoneVisualAcceptance;
      const player = document.getElementById("playerView");
      const center = document.getElementById("playerCenter");
      const viewport = document.getElementById("playerViewport");
      const controls = document.getElementById("playerControls");
      const desktopViewport = viewport.getBoundingClientRect();
      const desktopScroll = center.scrollTop;
      const panelWasVisible = getComputedStyle(document.getElementById("sessionPanel")).display !== "none";
      acceptance.clearViewportInputs();
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "f", bubbles: true }));
      await delay(180);
      const activeViewport = viewport.getBoundingClientRect();
      const activeControls = controls.getBoundingClientRect();
      const activeInput = acceptance.getViewportInputs().at(-1);
      const activeFullscreen = acceptance.getPlayback().fullscreen === true;
      const shellHidden = [".player-rail", ".player-identity-bar", ".session-panel", ".player-metadata"]
        .every((selector) => getComputedStyle(document.querySelector(selector)).display === "none");
      center.tabIndex = -1;
      center.focus();
      player.dispatchEvent(new PointerEvent("pointermove", { bubbles: true }));
      await delay(2800);
      const idleViewport = viewport.getBoundingClientRect();
      const idleControls = controls.getBoundingClientRect();
      const idleInput = acceptance.getViewportInputs().at(-1);
      const idle = player.classList.contains("is-controls-idle");
      player.dispatchEvent(new PointerEvent("pointermove", { bubbles: true }));
      await delay(120);
      const controlsReturned = !player.classList.contains("is-controls-idle") && controls.getBoundingClientRect().height === 56;
      viewport.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
      await delay(120);
      const doubleClickExited = acceptance.getPlayback().fullscreen === false;
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "f", bubbles: true }));
      await delay(120);
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await delay(180);
      const restoredViewport = viewport.getBoundingClientRect();
      return {
        fEntered: activeFullscreen,
        shellHidden,
        activeBand: Math.round(activeControls.height),
        activeViewportMatches: Boolean(activeInput) && Math.abs(activeInput.height - activeViewport.height) < 1,
        activeReportedHeight: activeInput?.height ?? null,
        activeDomHeight: activeViewport.height,
        idle,
        idleBand: Math.round(idleControls.height),
        idleViewportMatches: Boolean(idleInput) && Math.abs(idleInput.height - idleViewport.height) < 1,
        idleReportedHeight: idleInput?.height ?? null,
        idleDomHeight: idleViewport.height,
        controlsReturned,
        doubleClickExited,
        escapeExited: player.dataset.fullscreen === "false",
        layoutRestored: Math.abs(restoredViewport.width - desktopViewport.width) < 1
          && Math.abs(restoredViewport.height - desktopViewport.height) < 1
          && center.scrollTop === desktopScroll
          && (getComputedStyle(document.getElementById("sessionPanel")).display !== "none") === panelWasVisible,
      };
    })()`);
    if (rendererErrors.length > 0 || !evidence.fEntered || !evidence.shellHidden
      || evidence.activeBand !== 56 || !evidence.activeViewportMatches || !evidence.idle
      || evidence.idleBand !== 3 || !evidence.idleViewportMatches || !evidence.controlsReturned
      || !evidence.doubleClickExited || !evidence.escapeExited || !evidence.layoutRestored) {
      throw new Error(`Renderer cinema fullscreen interaction check failed: ${JSON.stringify(evidence)}`);
    }
    return evidence;
  } finally {
    if (!renderer.isDestroyed()) renderer.destroy();
  }
}

function analyze(image) {
  const bitmap = image.toBitmap();
  const { width, height } = image.getSize();
  let sampled = 0;
  let nonDark = 0;
  let minimum = 255;
  let maximum = 0;
  for (let pixel = 0; pixel < width * height; pixel += 16) {
    const offset = pixel * 4;
    const blue = bitmap[offset];
    const green = bitmap[offset + 1];
    const red = bitmap[offset + 2];
    const brightness = Math.max(red, green, blue);
    if (brightness >= 40) nonDark += 1;
    minimum = Math.min(minimum, red, green, blue);
    maximum = Math.max(maximum, red, green, blue);
    sampled += 1;
  }
  return { nonDarkPixelRatio: nonDark / Math.max(1, sampled), colorRange: maximum - minimum };
}

async function captureSurface(owner, viewport) {
  const display = screen.getDisplayMatching(owner.getBounds());
  const sources = await desktopCapturer.getSources({
    types: ["screen"],
    thumbnailSize: {
      width: Math.round(display.size.width * display.scaleFactor),
      height: Math.round(display.size.height * display.scaleFactor),
    },
    fetchWindowIcons: false,
  });
  const source = sources.find((entry) => entry.display_id === String(display.id));
  if (!source || source.thumbnail.isEmpty()) throw new Error("Screen capture was unavailable.");
  const content = owner.getContentBounds();
  const captureSize = source.thumbnail.getSize();
  const scaleX = captureSize.width / display.bounds.width;
  const scaleY = captureSize.height / display.bounds.height;
  const ownerImage = source.thumbnail.crop({
    x: Math.max(0, Math.round((content.x - display.bounds.x) * scaleX)),
    y: Math.max(0, Math.round((content.y - display.bounds.y) * scaleY)),
    width: Math.min(captureSize.width, Math.round(content.width * scaleX)),
    height: Math.min(captureSize.height, Math.round(content.height * scaleY)),
  });
  return ownerImage.crop({
    x: Math.round(viewport.x * scaleX),
    y: Math.round(viewport.y * scaleY),
    width: Math.round(viewport.width * scaleX),
    height: Math.round(viewport.height * scaleY),
  });
}

app.whenReady().then(async () => {
  let owner;
  let host;
  try {
    const workArea = screen.getPrimaryDisplay().workArea;
    owner = new BrowserWindow({
      x: workArea.x + 40,
      y: workArea.y + 40,
      width: Math.min(1120, workArea.width - 80),
      height: Math.min(720, workArea.height - 80),
      show: true,
      backgroundColor: "#7c3aed",
      title: "Seeing Stone H.264 Smoke",
    });
    host = new EmbeddedVideoHost(owner);
    const viewport = { x: 100, y: 72, width: 900, height: 506, visible: true, revision: 1 };
    host.updateViewport(viewport);
    const profiles = [
      {
        name: "d3d11",
        args: ["--vo=gpu-next", "--gpu-api=d3d11", "--gpu-context=d3d11", "--hwdec=auto-safe", "--panscan=0"],
      },
      {
        name: "opengl-software",
        args: ["--vo=gpu", "--gpu-api=opengl", "--gpu-context=win", "--hwdec=no", "--panscan=0"],
      },
    ].filter((profile) => !fullscreenMode || profile.name === "d3d11");
    const results = [];
    for (const profile of profiles) {
      const ipc = new MpvIpcClient();
      let child;
      try {
        const pipe = `\\\\.\\pipe\\seeing-stone-h264-${process.pid}-${Date.now()}-${profile.name}`;
        child = spawn(join(process.cwd(), ".runtime", "mpv", "mpv.exe"), [
          "--no-config", "--terminal=no", "--force-window=immediate", "--keep-open=yes",
          ...profile.args,
          "--osc=no", "--input-default-bindings=no", "--input-vo-keyboard=no",
          `--input-ipc-server=${pipe}`, `--wid=${host.getWindowId()}`, "--loop-file=inf", "--",
          join(process.cwd(), ".runtime", "h264-embedded-smoke.mp4"),
        ], { windowsHide: true, stdio: "ignore" });
        child.once("error", () => undefined);
        await ipc.connect(pipe);
        await delay(1500);
        let activeViewport = viewport;
        let fullscreenEvidence = null;
        if (fullscreenMode) {
          await changeFullscreen(host, owner, true);
          const content = owner.getContentBounds();
          activeViewport = { x: 0, y: 0, width: content.width, height: content.height - 56, visible: true, revision: 2 };
          host.updateViewport(activeViewport);
          await delay(650);
        }
        const tracks = await ipc.command(["get_property", "track-list"]);
        const videoTrack = Array.isArray(tracks) ? tracks.find((track) => track?.type === "video") : null;
        const evidence = {
          codec: videoTrack?.codec || null,
          format: await ipc.command(["get_property", "video-format"]),
          currentVo: await ipc.command(["get_property", "current-vo"]),
          voConfigured: await ipc.command(["get_property", "vo-configured"]),
          hwdec: await ipc.command(["get_property", "hwdec-current"]),
        };
        if (!String(evidence.codec || "").toLowerCase().includes("h264")) throw new Error("Smoke fixture is not H.264.");
        if (evidence.voConfigured !== true || !evidence.currentVo || !evidence.format) {
          throw new Error(`${profile.name} embedded video output was not configured.`);
        }
        owner.focus();
        await delay(150);
        if (!owner.isFocused()) throw new Error("Embedded video stole application focus.");
        const pixels = analyze(await captureSurface(owner, activeViewport));
        if (pixels.nonDarkPixelRatio < 0.15 || pixels.colorRange < 60) {
          throw new Error(`${profile.name} embedded H.264 surface was visually blank.`);
        }
        if (fullscreenMode) {
          const activeBounds = host.window.getBounds();
          const content = owner.getContentBounds();
          const idleViewport = { x: 0, y: 0, width: content.width, height: content.height - 3, visible: true, revision: 3 };
          host.updateViewport(idleViewport);
          await delay(650);
          const idleBounds = host.window.getBounds();
          const idlePixels = analyze(await captureSurface(owner, idleViewport));
          if (idlePixels.nonDarkPixelRatio < 0.15 || idlePixels.colorRange < 60) {
            throw new Error("Idle fullscreen surface was visually blank.");
          }
          await changeFullscreen(host, owner, false);
          host.updateViewport({ ...viewport, revision: 4 });
          await delay(650);
          const restoredBounds = host.window.getBounds();
          const restoredContent = owner.getContentBounds();
          const expectedRestored = {
            x: restoredContent.x + viewport.x,
            y: restoredContent.y + viewport.y,
            width: viewport.width,
            height: viewport.height,
          };
          const expectedActive = { x: content.x, y: content.y, width: content.width, height: content.height - 56 };
          const expectedIdle = { x: content.x, y: content.y, width: content.width, height: content.height - 3 };
          if (Object.keys(expectedActive).some((key) => activeBounds[key] !== expectedActive[key])
            || Object.keys(expectedIdle).some((key) => idleBounds[key] !== expectedIdle[key])
            || Object.keys(expectedRestored).some((key) => restoredBounds[key] !== expectedRestored[key])) {
            throw new Error("Fullscreen control-band or restored native bounds were incorrect.");
          }
          fullscreenEvidence = { activeBand: 56, idleBand: 3, restored: true, idlePixels };
        }
        results.push({ profile: profile.name, evidence, pixels, ...(fullscreenEvidence ? { fullscreen: fullscreenEvidence } : {}) });
      } finally {
        ipc.close();
        if (child && !child.killed) child.kill();
        await delay(250);
      }
    }
    if (fullscreenMode) {
      owner.hide();
      results[0].renderer = await verifyRendererCinemaFullscreen();
    }
    process.stdout.write(`${JSON.stringify({ ok: true, results })}\n`);
    app.quit();
  } finally {
    if (host) host.destroy();
    if (owner && !owner.isDestroyed()) owner.destroy();
  }
}).catch((error) => {
  const message = String(error?.message || "Embedded H.264 smoke failed")
    .replace(/https?:\/\/[^\s"')]+/gi, "<url>")
    .replace(/[A-Za-z]:[\\/][^\r\n"')]+/g, "<path>")
    .slice(0, 400);
  process.stderr.write(`Embedded H.264 smoke failed: ${message}\n`);
  app.exit(1);
});
