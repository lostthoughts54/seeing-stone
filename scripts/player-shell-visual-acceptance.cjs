"use strict";

const { spawnSync } = require("node:child_process");
const { existsSync, mkdtempSync, rmSync } = require("node:fs");
const { mkdir, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");

const CHILD_FLAG = "--seeing-stone-player-shell-child";
const USER_DATA_ENV = "SEEING_STONE_VISUAL_USER_DATA";

if (!process.versions.electron) runParent();
else void runChild().catch((error) => {
  process.stderr.write(`${error?.stack || String(error)}\n`);
  require("electron").app.exit(1);
});

function runParent() {
  const electron = require("electron");
  const userData = mkdtempSync(join(tmpdir(), "seeing-stone-visual-"));
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
  if (result.signal) throw new Error(`Visual acceptance ended with signal ${result.signal}.`);
  process.exitCode = result.status ?? 1;
}

async function runChild() {
  const { app, BrowserWindow } = require("electron");
  if (!process.argv.includes(CHILD_FLAG) || !process.env[USER_DATA_ENV]) throw new Error("Visual acceptance must use its parent wrapper.");
  const rendererEntry = resolve(__dirname, "../dist/renderer/index.html");
  if (!existsSync(rendererEntry)) throw new Error("Build the renderer before visual acceptance.");

  app.commandLine.appendSwitch("disable-gpu");
  app.commandLine.appendSwitch("force-device-scale-factor", "1");
  app.disableHardwareAcceleration();
  app.setPath("userData", process.env[USER_DATA_ENV]);
  app.on("window-all-closed", () => undefined);
  await app.whenReady();

  const outputDirectory = resolve(__dirname, "../artifacts/gate-3-4");
  await mkdir(outputDirectory, { recursive: true });
  const window = new BrowserWindow({
    width: 1680,
    height: 980,
    show: false,
    backgroundColor: "#060711",
    webPreferences: {
      preload: resolve(__dirname, "player-shell-visual-preload.cjs"),
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false,
      webSecurity: true,
      devTools: false,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  const rendererErrors = [];
  window.webContents.on("console-message", (details) => {
    if (details.level === "error") rendererErrors.push(String(details.message).slice(0, 240));
  });

  await window.loadFile(rendererEntry);
  const ready = await window.webContents.executeJavaScript(`(async () => {
    const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
    for (let attempt = 0; attempt < 120; attempt += 1) {
      const button = document.getElementById("featurePlayButton");
      if (button && !button.disabled) { button.click(); break; }
      await delay(25);
    }
    for (let attempt = 0; attempt < 120; attempt += 1) {
      const visible = !document.getElementById("playerView")?.classList.contains("is-hidden");
      const source = document.getElementById("playerSourceBadge")?.textContent;
      if (visible && source === "Direct Play") return true;
      await delay(25);
    }
    return false;
  })()`);
  if (!ready) throw new Error("Player shell did not reach its fixture-backed ready state.");
  await window.webContents.executeJavaScript("document.fonts.ready.then(() => true)");

  const capture = async (filename, width, height, setup = null) => {
    window.setSize(width, height, false);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 240));
    if (setup) await window.webContents.executeJavaScript(setup);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 160));
    const image = await window.webContents.capturePage();
    await writeFile(join(outputDirectory, filename), image.toPNG());
    const panelCollapsed = await window.webContents.executeJavaScript('document.getElementById("playerView").classList.contains("is-panel-collapsed")');
    return { filename, width: image.getSize().width, height: image.getSize().height, panelCollapsed };
  };

  const screenshots = [];
  screenshots.push(await capture("player-wide.png", 1680, 980));
  screenshots.push(await capture("player-constrained.png", 980, 760));
  screenshots.push(await capture("player-constrained-session-drawer.png", 980, 760, `document.getElementById("openSessionPanelButton")?.click(); true`));
  screenshots.push(await capture("player-compact-session-drawer.png", 760, 650));
  window.webContents.setZoomFactor(1.25);
  screenshots.push(await capture("player-text-scale-125.png", 1280, 860, `document.getElementById("playerPlayPauseButton")?.focus(); true`));

  const assertions = await window.webContents.executeJavaScript(`(() => {
    const player = document.getElementById("playerView");
    const viewport = document.getElementById("playerViewport").getBoundingClientRect();
    const controls = document.getElementById("playerControls").getBoundingClientRect();
    const panel = document.getElementById("sessionPanel").getBoundingClientRect();
    const focus = getComputedStyle(document.getElementById("playerPlayPauseButton"));
    const namedControls = [...player.querySelectorAll("button, input, select")].every((element) =>
      element.disabled || Boolean(element.getAttribute("aria-label") || element.getAttribute("title") || element.textContent.trim()));
    const focusable = [...player.querySelectorAll("button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex='-1'])")]
      .filter((element) => element.getClientRects().length > 0);
    let focusedCount = 0;
    for (const element of focusable) {
      element.focus();
      if (document.activeElement === element) focusedCount += 1;
    }
    document.getElementById("playerPlayPauseButton").focus();
    const panelText = document.getElementById("sessionPanelContent").textContent;
    return {
      viewportAboveControls: viewport.bottom <= controls.top,
      viewportNonZero: viewport.width >= 16 && viewport.height >= 16,
      panelDoesNotCoverViewport: panel.width === 0 || viewport.right <= panel.left,
      namedControls,
      focusableCount: focusable.length,
      focusedCount,
      focusOutlineWidth: focus.outlineWidth,
      horizontalOverflow: player.scrollWidth > player.clientWidth,
      interLoaded: document.fonts.check('16px "Inter"'),
      spectralLoaded: document.fonts.check('16px "Spectral"'),
      unavailableRowsHidden: !/(?:Container|Bitrate|Buffer ahead|Request)/.test(panelText),
      sourceLabel: document.getElementById("playerSourceBadge").textContent,
      connectionLabel: document.getElementById("playerConnectionBadge").textContent,
      diagnosticsContainSensitiveText: /(?:access.?token|authorization|api[_-]?key|file:\\/|https?:\\/\\/)/i.test(panelText),
    };
  })()`);

  if (!assertions.viewportAboveControls || !assertions.viewportNonZero) throw new Error("Native viewport geometry overlaps or collapses into controls.");
  if (!assertions.panelDoesNotCoverViewport) throw new Error("The responsive Session Panel covers the native video viewport.");
  if (!assertions.namedControls) throw new Error("A visible player control lacks an accessible name.");
  if (assertions.focusedCount !== assertions.focusableCount) throw new Error("A visible player control cannot receive keyboard focus.");
  if (assertions.focusOutlineWidth === "0px") throw new Error("Focused player controls have no visible outline.");
  if (assertions.horizontalOverflow) throw new Error("Player shell overflows horizontally at 125% text scale.");
  if (!assertions.interLoaded || !assertions.spectralLoaded) throw new Error("Bundled player fonts did not load.");
  if (!assertions.unavailableRowsHidden) throw new Error("Unavailable diagnostics rendered placeholder rows.");
  if (assertions.diagnosticsContainSensitiveText) throw new Error("Session diagnostics exposed sensitive-looking text.");
  if (screenshots[0].panelCollapsed || !screenshots[1].panelCollapsed || screenshots[2].panelCollapsed) {
    throw new Error("Responsive Session Panel collapse and drawer states did not match the acceptance sequence.");
  }
  if (rendererErrors.length > 0) throw new Error(`Renderer logged ${rendererErrors.length} error(s).`);

  const report = {
    schemaVersion: 1,
    harness: "isolated-visual-fixture",
    screenshots,
    assertions,
    rendererErrorCount: rendererErrors.length,
  };
  await writeFile(join(outputDirectory, "player-shell-acceptance.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`Player shell visual acceptance passed (${screenshots.length} screenshots).\n`);
  window.destroy();
  app.exit(0);
}
