"use strict";

const { spawn } = require("node:child_process");
const { join } = require("node:path");
const { app, BrowserWindow, screen } = require("electron");
const { EmbeddedVideoHost } = require("../dist/main/services/embeddedVideoHost.js");

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

app.whenReady().then(async () => {
  const owner = new BrowserWindow({ width: 1200, height: 780, show: true, backgroundColor: "#090711" });
  const host = new EmbeddedVideoHost(owner);
  host.updateViewport({ x: 180, y: 80, width: 900, height: 506, visible: true });
  const wid = host.getWindowId();
  if (!Number.isSafeInteger(wid) || wid <= 0) throw new Error("Invalid HWND conversion.");

  const media = join(process.cwd(), ".runtime", "mpv-completion-movie.mp4");
  const executable = join(process.cwd(), ".runtime", "mpv", "mpv.exe");
  const child = spawn(executable, [
    "--no-config", "--terminal=no", "--force-window=immediate", "--keep-open=yes",
    "--osc=no", "--input-default-bindings=no", "--input-vo-keyboard=no", `--wid=${wid}`, "--loop-file=inf", "--", media,
  ], { windowsHide: true, stdio: "ignore" });
  child.once("error", (error) => { throw error; });

  await delay(1200);
  owner.setBounds({ x: owner.getBounds().x + 80, y: owner.getBounds().y + 50, width: 1280, height: 820 });
  host.updateViewport({ x: 196, y: 92, width: 940, height: 529, visible: true });
  await delay(500);
  const displays = screen.getAllDisplays();
  if (displays.length > 1) {
    const target = displays[1].workArea;
    owner.setBounds({ x: target.x + 40, y: target.y + 40, width: Math.min(1200, target.width - 80), height: Math.min(780, target.height - 80) });
    await delay(500);
  }
  owner.minimize(); await delay(300); owner.restore(); await delay(500);
  host.setFullscreen(true); await delay(500); host.setFullscreen(false); await delay(500);
  host.updateViewport({ x: 196, y: 92, width: 740, height: 416, visible: true }); await delay(300);
  host.updateViewport({ x: 0, y: 0, width: 0, height: 0, visible: false }); await delay(300);
  host.updateViewport({ x: 196, y: 92, width: 940, height: 529, visible: true }); await delay(500);
  child.kill(); await delay(500);
  host.hide(); host.destroy(); owner.destroy();
  process.stdout.write(JSON.stringify({ ok: true, displays: displays.length }) + "\n");
  app.quit();
}).catch((error) => {
  process.stderr.write(`Embedded window spike failed: ${error instanceof Error ? error.message : "unknown error"}\n`);
  app.exit(1);
});
