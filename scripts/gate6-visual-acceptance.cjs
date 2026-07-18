"use strict";

const { createHash } = require("node:crypto");
const { execFileSync, spawnSync } = require("node:child_process");
const { existsSync, mkdtempSync, rmSync } = require("node:fs");
const { mkdir, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");

const CHILD_FLAG = "--seeing-stone-gate6-visual-child";
const USER_DATA_ENV = "SEEING_STONE_GATE6_VISUAL_USER_DATA";

if (!process.versions.electron) runParent();
else void runChild().catch((error) => {
  process.stderr.write(`${safeFailure(error)}\n`);
  require("electron").app.exit(1);
});

function runParent() {
  const electron = require("electron");
  const userData = mkdtempSync(join(tmpdir(), "seeing-stone-gate6-"));
  const env = { ...process.env, [USER_DATA_ENV]: userData };
  delete env.ELECTRON_RUN_AS_NODE;
  let result;
  try {
    result = spawnSync(electron, [__filename, CHILD_FLAG], {
      cwd: resolve(__dirname, ".."),
      env,
      stdio: "inherit",
      windowsHide: true,
      timeout: 120_000,
    });
  } finally {
    rmSync(userData, { force: true, recursive: true, maxRetries: 10, retryDelay: 100 });
  }
  if (result.error) throw result.error;
  if (result.signal) throw new Error(`Gate 6 visual acceptance ended with signal ${result.signal}.`);
  process.exitCode = result.status ?? 1;
}

async function runChild() {
  const { app, BrowserWindow } = require("electron");
  if (!process.argv.includes(CHILD_FLAG) || !process.env[USER_DATA_ENV]) throw new Error("Gate 6 visual acceptance must use its parent wrapper.");
  const root = resolve(__dirname, "..");
  const packageVersion = require(join(root, "package.json")).version;
  const rendererEntry = resolve(root, "dist/renderer/index.html");
  if (!existsSync(rendererEntry)) throw new Error("Build the renderer before Gate 6 visual acceptance.");
  const sourceRevision = git(root, ["rev-parse", "HEAD"]);
  const sourceTree = git(root, ["status", "--porcelain"]) ? "working-tree" : "clean";

  app.commandLine.appendSwitch("disable-gpu");
  app.commandLine.appendSwitch("force-device-scale-factor", "1");
  app.disableHardwareAcceleration();
  app.setPath("userData", process.env[USER_DATA_ENV]);
  app.on("window-all-closed", () => undefined);
  await app.whenReady();

  const outputDirectory = resolve(root, "artifacts/gate-6");
  await mkdir(outputDirectory, { recursive: true });
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    show: false,
    backgroundColor: "#060711",
    webPreferences: {
      preload: resolve(__dirname, "player-shell-visual-preload.cjs"),
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false,
      webSecurity: true,
      devTools: false,
      backgroundThrottling: false,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  const rendererErrors = [];
  window.webContents.on("console-message", (details) => {
    if (details.level === "error") rendererErrors.push(String(details.message).slice(0, 240));
  });

  await window.loadFile(rendererEntry);
  await window.webContents.executeJavaScript(`(async () => {
    const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
    for (let attempt = 0; attempt < 120; attempt += 1) {
      const button = document.getElementById("featurePlayButton");
      if (button && !button.disabled) { button.click(); break; }
      await delay(25);
    }
    for (let attempt = 0; attempt < 120; attempt += 1) {
      if (!document.getElementById("playerView")?.classList.contains("is-hidden")) return true;
      await delay(25);
    }
    return false;
  })()`);

  const initialPlaybackId = await window.webContents.executeJavaScript("window.seeingStoneVisualAcceptance.getPlayback().playbackId");
  assert(initialPlaybackId, "The isolated player did not start.");
  const screenshots = [];

  for (const stage of [
    { state: "offline", filename: "offline-local-player.png", expectedLabel: "Offline" },
    { state: "reconnecting", filename: "reconnecting-local-player.png", expectedLabel: "Reconnecting" },
    { state: "connected", filename: "recovered-local-player.png", expectedLabel: "Connected" },
  ]) {
    const result = await window.webContents.executeJavaScript(`(async () => {
      const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
      window.seeingStoneVisualAcceptance.setGate6Connection(${JSON.stringify(stage.state)});
      for (let attempt = 0; attempt < 120; attempt += 1) {
        if (document.getElementById("playerConnectionBadge")?.textContent.trim() === ${JSON.stringify(stage.expectedLabel)}) break;
        await delay(20);
      }
      document.getElementById("sessionSoloTab")?.click();
      const toast = document.getElementById("toast");
      toast.textContent = "";
      toast.classList.add("is-hidden");
      toast.style.display = "none";
      toast.setAttribute("aria-hidden", "true");
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      await delay(75);
      const visibleText = document.body.innerText;
      return {
        playbackId: window.seeingStoneVisualAcceptance.getPlayback().playbackId,
        connectionLabel: document.getElementById("playerConnectionBadge")?.textContent.trim(),
        sourceLabel: document.getElementById("playerSourceBadge")?.textContent.trim(),
        title: document.getElementById("playerMetadataTitle")?.textContent.trim(),
        overview: document.getElementById("playerOverview")?.textContent.trim(),
        panelText: document.getElementById("sessionPanelContent")?.textContent || "",
        sensitiveText: /(?:[A-Za-z]:[\\/]|\\\\|Bearer\s|X-Emby-Token|X-MediaBrowser-Token|access[_ -]?token|api[_ -]?key|https?:\\/\\/)/i.test(visibleText),
      };
    })()`);
    assert(result.playbackId === initialPlaybackId, `${stage.state} refresh interrupted active local playback.`);
    assert(result.connectionLabel === stage.expectedLabel, `${stage.state} connection label is missing.`);
    assert(result.sourceLabel === "Offline Local", `${stage.state} did not preserve the Offline Local source label.`);
    assert(result.title === "The Shattered Vale" && result.overview.includes("visual acceptance fixture"), `${stage.state} lost cached player metadata.`);
    assert(result.panelText.includes(stage.expectedLabel), `${stage.state} is missing from the solo Session Panel.`);
    assert(!result.sensitiveText, `${stage.state} visual fixture exposed sensitive-looking text.`);

    window.webContents.invalidate();
    await window.webContents.capturePage();
    await new Promise((resolve) => setTimeout(resolve, 250));
    const image = await window.webContents.capturePage();
    const png = image.toPNG();
    await writeFile(join(outputDirectory, stage.filename), png);
    screenshots.push({
      state: stage.state,
      filename: stage.filename,
      width: image.getSize().width,
      height: image.getSize().height,
      sha256: createHash("sha256").update(png).digest("hex"),
    });
  }

  assert(rendererErrors.length === 0, "Renderer errors occurred during Gate 6 visual acceptance.");
  const report = {
    schemaVersion: 1,
    gate: 6,
    fixture: "isolated-offline-reconnect-visual-fixture",
    appVersion: packageVersion,
    sourceRevision,
    sourceTree,
    platform: { platform: process.platform, arch: process.arch, electron: process.versions.electron, chrome: process.versions.chrome },
    screenshots,
    assertions: {
      cachedMetadataVisible: true,
      offlineLocalLabel: true,
      offlineStateVisible: true,
      reconnectingStateVisible: true,
      recoveredStateVisible: true,
      activePlaybackUninterrupted: true,
      sensitiveTextRejected: true,
      rendererErrors: rendererErrors.length,
    },
  };
  await writeFile(join(outputDirectory, "gate6-visual-acceptance.json"), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write("Gate 6 isolated visual acceptance passed (3 screenshots, 0 renderer errors).\n");
  window.destroy();
  app.quit();
}

function git(cwd, args) {
  try { return execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true }).trim(); }
  catch { return "unavailable"; }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function safeFailure(error) {
  return String(error?.stack || error?.message || error || "Unknown failure")
    .replace(/https?:\/\/[^\s"')]+/gi, "<url>")
    .replace(/[A-Za-z]:[\\/][^\r\n"')]+/g, "<path>")
    .slice(0, 2000);
}
