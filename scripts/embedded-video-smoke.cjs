"use strict";

const { spawn } = require("node:child_process");
const { join } = require("node:path");
const { app, BrowserWindow, desktopCapturer, screen } = require("electron");
const { EmbeddedVideoHost } = require("../dist/main/services/embeddedVideoHost.js");
const { MpvIpcClient } = require("../dist/main/services/mpvIpc.js");

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

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
    ];
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
        const pixels = analyze(await captureSurface(owner, viewport));
        if (pixels.nonDarkPixelRatio < 0.15 || pixels.colorRange < 60) {
          throw new Error(`${profile.name} embedded H.264 surface was visually blank.`);
        }
        results.push({ profile: profile.name, evidence, pixels });
      } finally {
        ipc.close();
        if (child && !child.killed) child.kill();
        await delay(250);
      }
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
