"use strict";

const { spawn } = require("node:child_process");
const { mkdir, writeFile } = require("node:fs/promises");
const { join } = require("node:path");
const { app, BrowserWindow, desktopCapturer, screen } = require("electron");
const { EmbeddedVideoHost } = require("../dist/main/services/embeddedVideoHost.js");

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

app.whenReady().then(async () => {
  const owner = new BrowserWindow({ width: 1200, height: 780, show: true, title: "Seeing Stone Embedded Spike", backgroundColor: "#090711" });
  const host = new EmbeddedVideoHost(owner);
  host.updateViewport({ x: 180, y: 80, width: 900, height: 506, visible: true, revision: 1 });
  const wid = host.getWindowId();
  if (!/^[1-9][0-9]*$/.test(wid)) throw new Error("Invalid HWND conversion.");

  const media = join(process.cwd(), ".runtime", "mpv-acceptance.mkv");
  const executable = join(process.cwd(), ".runtime", "mpv", "mpv.exe");
  const child = spawn(executable, [
    "--no-config", "--terminal=no", "--force-window=immediate", "--keep-open=yes",
    "--osc=no", "--input-default-bindings=no", "--input-vo-keyboard=no", `--wid=${wid}`, "--loop-file=inf", "--", media,
  ], { windowsHide: true, stdio: "ignore" });
  child.once("error", (error) => { throw error; });

  await delay(1200);
  owner.setBounds({ x: owner.getBounds().x + 80, y: owner.getBounds().y + 50, width: 1280, height: 820 });
  host.updateViewport({ x: 196, y: 92, width: 940, height: 529, visible: true, revision: 2 });
  await delay(500);
  const displays = screen.getAllDisplays();
  if (displays.length > 1) {
    const target = displays[1].workArea;
    owner.setBounds({ x: target.x + 40, y: target.y + 40, width: Math.min(1200, target.width - 80), height: Math.min(780, target.height - 80) });
    await delay(500);
  }
  owner.minimize(); await delay(300); owner.restore(); await delay(500);
  host.setFullscreen(true); await delay(500); host.setFullscreen(false); await delay(500);
  host.updateViewport({ x: 196, y: 92, width: 740, height: 416, visible: true, revision: 3 }); await delay(300);
  const acceptanceDirectory = join(process.cwd(), ".runtime", "acceptance");
  await mkdir(acceptanceDirectory, { recursive: true });
  const display = screen.getDisplayMatching(owner.getBounds());
  const sources = await desktopCapturer.getSources({
    types: ["screen"],
    thumbnailSize: { width: Math.round(display.size.width * display.scaleFactor), height: Math.round(display.size.height * display.scaleFactor) },
    fetchWindowIcons: false,
  });
  const capture = sources.find((source) => source.display_id === String(display.id)) ?? sources[0];
  if (!capture || capture.thumbnail.isEmpty()) throw new Error("Could not capture isolated embedded-window evidence.");
  const ownerBounds = owner.getBounds();
  const captureSize = capture.thumbnail.getSize();
  const scaleX = captureSize.width / display.bounds.width;
  const scaleY = captureSize.height / display.bounds.height;
  const crop = {
    x: Math.max(0, Math.round((ownerBounds.x - display.bounds.x) * scaleX)),
    y: Math.max(0, Math.round((ownerBounds.y - display.bounds.y) * scaleY)),
    width: Math.min(captureSize.width, Math.round(ownerBounds.width * scaleX)),
    height: Math.min(captureSize.height, Math.round(ownerBounds.height * scaleY)),
  };
  await writeFile(join(acceptanceDirectory, "gate1-embedded-window.png"), capture.thumbnail.crop(crop).toPNG());
  host.updateViewport({ x: 0, y: 0, width: 0, height: 0, visible: false, revision: 4 }); await delay(300);
  host.updateViewport({ x: 196, y: 92, width: 940, height: 529, visible: true, revision: 5 }); await delay(500);
  child.kill(); await delay(500);
  host.hide(); host.destroy(); owner.destroy();
  const result = { ok: true, displays: displays.length, screenshot: true, forcedTermination: true };
  await writeFile(join(acceptanceDirectory, "gate1-embedded-window.json"), `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(JSON.stringify(result) + "\n");
  app.quit();
}).catch((error) => {
  process.stderr.write(`Embedded window spike failed: ${error instanceof Error ? error.message : "unknown error"}\n`);
  app.exit(1);
});
