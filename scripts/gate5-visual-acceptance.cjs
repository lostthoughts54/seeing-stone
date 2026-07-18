"use strict";

const { createHash } = require("node:crypto");
const { execFileSync, spawnSync } = require("node:child_process");
const { existsSync, mkdtempSync, rmSync } = require("node:fs");
const { mkdir, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");

const CHILD_FLAG = "--seeing-stone-gate5-visual-child";
const USER_DATA_ENV = "SEEING_STONE_GATE5_VISUAL_USER_DATA";

if (!process.versions.electron) runParent();
else void runChild().catch((error) => {
  process.stderr.write(`${safeFailure(error)}\n`);
  require("electron").app.exit(1);
});

function runParent() {
  const electron = require("electron");
  const userData = mkdtempSync(join(tmpdir(), "seeing-stone-gate5-"));
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
  if (result.signal) throw new Error(`Gate 5 visual acceptance ended with signal ${result.signal}.`);
  process.exitCode = result.status ?? 1;
}

async function runChild() {
  const { app, BrowserWindow } = require("electron");
  if (!process.argv.includes(CHILD_FLAG) || !process.env[USER_DATA_ENV]) throw new Error("Gate 5 visual acceptance must use its parent wrapper.");
  const root = resolve(__dirname, "..");
  const rendererEntry = resolve(root, "dist/renderer/index.html");
  if (!existsSync(rendererEntry)) throw new Error("Build the renderer before Gate 5 visual acceptance.");
  // Capture provenance before this harness creates its own untracked evidence.
  const sourceRevision = git(root, ["rev-parse", "HEAD"]);
  const sourceTree = git(root, ["status", "--porcelain"]) ? "working-tree" : "clean";

  app.commandLine.appendSwitch("disable-gpu");
  app.commandLine.appendSwitch("force-device-scale-factor", "1");
  app.disableHardwareAcceleration();
  app.setPath("userData", process.env[USER_DATA_ENV]);
  app.on("window-all-closed", () => undefined);
  await app.whenReady();

  const outputDirectory = resolve(root, "artifacts/gate-5");
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
  const result = await window.webContents.executeJavaScript(`(async () => {
    const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
    for (let attempt = 0; attempt < 120; attempt += 1) {
      const button = document.getElementById("featurePlayButton");
      if (button && !button.disabled) { button.click(); break; }
      await delay(25);
    }
    for (let attempt = 0; attempt < 120; attempt += 1) {
      if (!document.getElementById("playerView")?.classList.contains("is-hidden")) break;
      await delay(25);
    }
    window.seeingStoneVisualAcceptance.joinWatchPartyFixture();
    document.getElementById("sessionWatchpartyTab").click();
    for (let attempt = 0; attempt < 120; attempt += 1) {
      if (document.getElementById("sessionPanelContent")?.textContent.includes("Isolated fixture party")) break;
      await delay(25);
    }
    const panel = document.getElementById("sessionPanelContent");
    const actionLabels = Array.from(panel.querySelectorAll(".session-party-actions button"), (button) => button.textContent.trim());
    const participantValues = Array.from(panel.querySelectorAll(".session-section:nth-of-type(2) .session-row span:last-child"), (element) => element.textContent.trim());
    const explanation = panel.querySelector(".session-empty")?.textContent || "";
    const policy = panel.querySelector('[data-session-action="buffering-policy"]');
    const initialPolicy = policy?.value || null;

    panel.querySelector('[data-session-action="wait-party"]')?.click();
    for (let attempt = 0; attempt < 80; attempt += 1) {
      if (panel.textContent.includes("Paused")) break;
      await delay(20);
    }
    const waitState = panel.textContent.includes("Paused");
    panel.querySelector('[data-session-action="continue-party"]')?.click();
    for (let attempt = 0; attempt < 80; attempt += 1) {
      if (panel.textContent.includes("Playing")) break;
      await delay(20);
    }
    const continueState = panel.textContent.includes("Playing");
    const toast = document.getElementById("toast");
    const refreshedPolicy = panel.querySelector('[data-session-action="buffering-policy"]');
    refreshedPolicy.value = "continue";
    refreshedPolicy.dispatchEvent(new Event("change", { bubbles: true }));
    for (let attempt = 0; attempt < 120; attempt += 1) {
      const current = panel.querySelector('[data-session-action="buffering-policy"]');
      if (current?.value === "continue" && !current.disabled && toast.textContent === "Automatic waiting is off.") break;
      await delay(20);
    }
    const savedPolicy = panel.querySelector('[data-session-action="buffering-policy"]')?.value || null;
    const resetPolicy = panel.querySelector('[data-session-action="buffering-policy"]');
    resetPolicy.value = "wait-for-all";
    resetPolicy.dispatchEvent(new Event("change", { bubbles: true }));
    for (let attempt = 0; attempt < 120; attempt += 1) {
      const current = panel.querySelector('[data-session-action="buffering-policy"]');
      if (current?.value === "wait-for-all" && !current.disabled && toast.textContent === "Buffering policy set to wait for everyone.") break;
      await delay(20);
    }
    const restoredPolicy = panel.querySelector('[data-session-action="buffering-policy"]')?.value || null;
    const resetCompleted = toast.textContent === "Buffering policy set to wait for everyone.";
    toast.textContent = "";
    toast.classList.add("is-hidden");
    toast.style.display = "none";
    toast.setAttribute("aria-hidden", "true");
    const visibleText = document.body.innerText;
    return {
      actionLabels,
      participantValues,
      explanation,
      initialPolicy,
      savedPolicy,
      restoredPolicy,
      resetCompleted,
      waitState,
      continueState,
      hasLatencyRow: /Server latency|Local drift/.test(panel.textContent),
      hasIncident: Boolean(panel.querySelector(".session-buffering-incident")),
      sensitiveText: /(?:[A-Za-z]:[\\/]|\\\\|Bearer\s|X-Emby-Token|X-MediaBrowser-Token|access[_ -]?token|api[_ -]?key|https?:\\/\\/)/i.test(visibleText),
    };
  })()`);

  assert(result.actionLabels.join("|") === "Wait|Continue|Resync|Leave Party", "Watchparty actions are incomplete.");
  assert(result.participantValues.length === 2 && result.participantValues.every((value) => value === "Jellyfin member"), "Unverified participants must show only native Jellyfin membership.");
  assert(result.explanation.includes("unavailable") && result.explanation.includes("Standard Jellyfin SyncPlay remains active"), "Disabled telemetry explanation is missing.");
  assert(result.initialPolicy === "wait-for-all" && result.savedPolicy === "continue" && result.restoredPolicy === "wait-for-all" && result.resetCompleted, "Buffering policy controls did not round-trip.");
  assert(result.waitState && result.continueState, "Wait and Continue did not update the isolated Jellyfin group state.");
  assert(!result.hasLatencyRow && !result.hasIncident, "Unavailable enhanced diagnostics must be suppressed.");
  assert(!result.sensitiveText, "Gate 5 visual fixture exposed sensitive-looking text.");
  assert(rendererErrors.length === 0, "Renderer errors occurred during Gate 5 visual acceptance.");

  const image = await window.webContents.capturePage();
  const png = image.toPNG();
  const screenshotName = "watchparty-disabled-fallback.png";
  await writeFile(join(outputDirectory, screenshotName), png);
  const report = {
    schemaVersion: 1,
    gate: 5,
    fixture: "isolated-watchparty-visual-fixture",
    appVersion: app.getVersion(),
    sourceRevision,
    sourceTree,
    platform: { platform: process.platform, arch: process.arch, electron: process.versions.electron, chrome: process.versions.chrome },
    screenshot: {
      filename: screenshotName,
      width: image.getSize().width,
      height: image.getSize().height,
      sha256: createHash("sha256").update(png).digest("hex"),
    },
    assertions: {
      strictDisabledFallback: true,
      standardSyncPlayActive: true,
      waitContinueGroupActions: true,
      groupResyncVisible: true,
      bufferingPolicyRoundTrip: true,
      unverifiedRowsSuppressed: true,
      sensitiveTextRejected: true,
      rendererErrors: rendererErrors.length,
    },
  };
  await writeFile(join(outputDirectory, "gate5-visual-acceptance.json"), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write("Gate 5 isolated visual acceptance passed (1 screenshot, 0 renderer errors).\n");
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
