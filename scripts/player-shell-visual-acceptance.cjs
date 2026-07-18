"use strict";

const { createHash } = require("node:crypto");
const { execFileSync, spawnSync } = require("node:child_process");
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
  app.commandLine.appendSwitch("force-prefers-reduced-motion");
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
      backgroundThrottling: false,
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
    const [currentWidth, currentHeight] = window.getSize();
    if (currentWidth === width && currentHeight === height) {
      window.setSize(Math.max(320, width - 1), Math.max(240, height - 1), false);
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 40));
    }
    window.setSize(width, height, false);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 240));
    if (setup) await window.webContents.executeJavaScript(setup);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 160));
    await window.webContents.executeJavaScript("new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
    const image = await window.webContents.capturePage();
    const png = image.toPNG();
    await writeFile(join(outputDirectory, filename), png);
    const panelCollapsed = await window.webContents.executeJavaScript('document.getElementById("playerView").classList.contains("is-panel-collapsed")');
    const settingsVisible = await window.webContents.executeJavaScript('!document.getElementById("playerSettingsMenu").classList.contains("is-hidden")');
    return {
      filename,
      width: image.getSize().width,
      height: image.getSize().height,
      panelCollapsed,
      settingsVisible,
      sha256: createHash("sha256").update(png).digest("hex"),
    };
  };

  const screenshots = [];
  screenshots.push(await capture("player-wide.png", 1680, 980));
  screenshots.push(await capture("player-intermediate.png", 1200, 800));
  screenshots.push(await capture("player-constrained.png", 980, 760));
  screenshots.push(await capture("player-constrained-session-drawer.png", 980, 760, `document.getElementById("openSessionPanelButton")?.click(); true`));
  screenshots.push(await capture("player-compact-session-drawer.png", 760, 650));
  screenshots.push(await capture("player-compact-settings.png", 760, 650, `(() => {
    const player = document.getElementById("playerView");
    if (!player.classList.contains("is-panel-collapsed")) document.getElementById("toggleSessionPanelButton")?.click();
    if (document.getElementById("playerSettingsMenu")?.classList.contains("is-hidden")) document.getElementById("playerSettingsButton")?.click();
    return true;
  })()`));
  window.webContents.setZoomFactor(1.25);
  screenshots.push(await capture("player-text-scale-125.png", 1280, 860, `(() => {
    const player = document.getElementById("playerView");
    if (!document.getElementById("playerSettingsMenu")?.classList.contains("is-hidden")) document.getElementById("closePlayerSettingsButton")?.click();
    if (!player.classList.contains("is-panel-collapsed")) document.getElementById("toggleSessionPanelButton")?.click();
    document.getElementById("playerPlayPauseButton")?.focus();
    return true;
  })()`));

  window.webContents.setZoomFactor(1);
  window.setSize(1280, 820, false);
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 320));

  const interactionAssertions = await window.webContents.executeJavaScript(`(async () => {
    const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
    const acceptance = window.seeingStoneVisualAcceptance;
    const panel = document.getElementById("sessionPanelContent");
    const advanced = panel.querySelector(".session-details");
    const advancedSummary = advanced?.querySelector("summary");
    if (advanced) advanced.open = true;
    advancedSummary?.focus();
    for (let index = 1; index <= 8; index += 1) {
      await window.jellyfin.playback.seek({ playbackId: acceptance.getPlayback().playbackId, positionTicks: index * 10_000_000 });
    }
    const panelStableDuringTicks = Boolean(advanced?.isConnected && advanced.open && document.activeElement === advancedSummary);

    const center = document.getElementById("playerCenter");
    acceptance.clearViewportInputs();
    center.scrollTop = center.scrollHeight;
    center.dispatchEvent(new Event("scroll"));
    await delay(100);
    const scrolledInputs = acceptance.getViewportInputs();
    const viewportHiddenWhenScrolled = scrolledInputs.at(-1)?.visible === false;
    center.scrollTop = 0;
    center.dispatchEvent(new Event("scroll"));
    await delay(100);
    const restoredInputs = acceptance.getViewportInputs();
    const viewportRestoredAfterScroll = restoredInputs.at(-1)?.visible === true;

    const settingsButton = document.getElementById("playerSettingsButton");
    settingsButton.focus();
    settingsButton.click();
    await delay(20);
    const settingsMenu = document.getElementById("playerSettingsMenu");
    const settingsControls = [
      document.getElementById("playerSettingsRateSelect"),
      document.getElementById("playerSettingsAudioSelect"),
      document.getElementById("playerSettingsSubtitleSelect"),
    ];
    const settingsReachable = settingsControls.every((control) => !control.disabled && control.getClientRects().length > 0);
    settingsControls[0].value = "1.25";
    settingsControls[0].dispatchEvent(new Event("change", { bubbles: true }));
    await delay(30);
    settingsControls[1].value = "2";
    settingsControls[1].dispatchEvent(new Event("change", { bubbles: true }));
    await delay(30);
    settingsControls[2].value = "3";
    settingsControls[2].dispatchEvent(new Event("change", { bubbles: true }));
    await delay(30);
    const settingsPlayback = acceptance.getPlayback();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await delay(20);

    const timeline = document.getElementById("playerTimeline");
    timeline.value = "500";
    timeline.dispatchEvent(new Event("change", { bubbles: true }));
    await delay(30);
    const volume = document.getElementById("playerVolume");
    volume.value = "33";
    volume.dispatchEvent(new Event("input", { bubbles: true }));
    await delay(120);
    const directPlayback = acceptance.getPlayback();
    return {
      panelStableDuringTicks,
      viewportHiddenWhenScrolled,
      viewportRestoredAfterScroll,
      settingsReachable,
      settingsExpanded: settingsButton.getAttribute("aria-expanded"),
      settingsClosedByEscape: settingsMenu.classList.contains("is-hidden"),
      settingsFocusReturned: document.activeElement === settingsButton,
      selectedRate: settingsPlayback.diagnostics.playbackRate,
      selectedAudio: settingsPlayback.audioTracks.find((track) => track.selected)?.id ?? null,
      selectedSubtitle: settingsPlayback.subtitleTracks.find((track) => track.selected)?.id ?? null,
      timelinePositionTicks: directPlayback.positionTicks,
      volume: directPlayback.volume,
      expectedHalfTicks: Math.round(directPlayback.durationTicks / 2),
    };
  })()`);

  const sendKey = async (keyCode) => {
    window.webContents.sendInputEvent({ type: "keyDown", keyCode });
    window.webContents.sendInputEvent({ type: "keyUp", keyCode });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 90));
    return window.webContents.executeJavaScript("window.seeingStoneVisualAcceptance.getPlayback()");
  };
  await window.webContents.executeJavaScript('document.getElementById("playerPlayPauseButton").focus(); true');
  const afterK = await sendKey("K");
  const afterSpace = await sendKey("Space");
  const beforeJ = afterSpace.positionTicks;
  const afterJ = await sendKey("J");
  const afterL = await sendKey("L");
  const afterM = await sendKey("M");
  const afterF = await sendKey("F");
  const keyboardAssertions = {
    kPaused: afterK.paused === true,
    spaceResumed: afterSpace.paused === false,
    jSoughtBackTenSeconds: afterJ.positionTicks === Math.max(0, beforeJ - 10 * 10_000_000),
    lSoughtForwardTenSeconds: afterL.positionTicks === beforeJ,
    mMuted: afterM.volume === 0,
    fEnteredFullscreen: afterF.fullscreen === true,
  };

  const autoHideBase = await window.webContents.executeJavaScript(`(async () => {
    const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
    const player = document.getElementById("playerView");
    const play = document.getElementById("playerPlayPauseButton");
    play.focus();
    player.dispatchEvent(new PointerEvent("pointermove", { bubbles: true }));
    await delay(2800);
    const visibleWithControlFocus = !player.classList.contains("is-controls-idle");
    const center = document.getElementById("playerCenter");
    center.tabIndex = -1;
    center.focus();
    player.dispatchEvent(new PointerEvent("pointermove", { bubbles: true }));
    await delay(2800);
    const hiddenWithoutControlFocus = player.classList.contains("is-controls-idle");
    return { visibleWithControlFocus, hiddenWithoutControlFocus };
  })()`);
  await sendKey("Tab");
  const restoredByKeyboardFocus = await window.webContents.executeJavaScript(`(() => {
    const player = document.getElementById("playerView");
    const controls = document.getElementById("playerControls");
    return !player.classList.contains("is-controls-idle") && controls.contains(document.activeElement);
  })()`);
  const autoHideAssertions = { ...autoHideBase, restoredByKeyboardFocus };

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
      reducedMotionActive: matchMedia("(prefers-reduced-motion: reduce)").matches,
      reducedMotionAnimation: getComputedStyle(document.querySelector(".frame-status-orb")).animationName,
      unavailableRowsHidden: !/(?:Container|Bitrate|Buffer ahead|Request)/.test(panelText),
      sourceLabel: document.getElementById("playerSourceBadge").textContent,
      connectionLabel: document.getElementById("playerConnectionBadge").textContent,
      diagnosticsContainSensitiveText: /(?:access.?token|authorization|bearer|x-emby-token|x-mediabrowser-token|api[_-]?key|[a-z]:\\\\|\\\\\\\\|file:\\/|https?:\\/\\/)/i.test(player.textContent),
    };
  })()`);

  if (!assertions.viewportAboveControls || !assertions.viewportNonZero) throw new Error("Native viewport geometry overlaps or collapses into controls.");
  if (!assertions.panelDoesNotCoverViewport) throw new Error("The responsive Session Panel covers the native video viewport.");
  if (!assertions.namedControls) throw new Error("A visible player control lacks an accessible name.");
  if (assertions.focusedCount !== assertions.focusableCount) throw new Error("A visible player control cannot receive keyboard focus.");
  if (assertions.focusOutlineWidth === "0px") throw new Error("Focused player controls have no visible outline.");
  if (assertions.horizontalOverflow) throw new Error("Player shell overflows horizontally at 125% text scale.");
  if (!assertions.interLoaded || !assertions.spectralLoaded) throw new Error("Bundled player fonts did not load.");
  if (!assertions.reducedMotionActive || assertions.reducedMotionAnimation !== "none") throw new Error("Reduced-motion behavior was not applied.");
  if (!assertions.unavailableRowsHidden) throw new Error("Unavailable diagnostics rendered placeholder rows.");
  if (assertions.diagnosticsContainSensitiveText) throw new Error("Session diagnostics exposed sensitive-looking text.");
  if (
    screenshots[0].panelCollapsed
    || screenshots[1].panelCollapsed
    || !screenshots[2].panelCollapsed
    || screenshots[3].panelCollapsed
    || screenshots[4].panelCollapsed
    || !screenshots[5].panelCollapsed
    || !screenshots[5].settingsVisible
    || !screenshots[6].panelCollapsed
    || screenshots[6].settingsVisible
  ) {
    throw new Error("Responsive Session Panel collapse and drawer states did not match the acceptance sequence.");
  }
  if (!Object.values(keyboardAssertions).every(Boolean)) throw new Error("A trusted keyboard shortcut did not update playback.");
  if (!Object.values(autoHideAssertions).every(Boolean)) throw new Error(`Fullscreen control auto-hide did not preserve keyboard access: ${JSON.stringify(autoHideAssertions)}`);
  if (
    !interactionAssertions.panelStableDuringTicks
    || !interactionAssertions.viewportHiddenWhenScrolled
    || !interactionAssertions.viewportRestoredAfterScroll
    || !interactionAssertions.settingsReachable
    || interactionAssertions.settingsExpanded !== "false"
    || !interactionAssertions.settingsClosedByEscape
    || !interactionAssertions.settingsFocusReturned
    || interactionAssertions.selectedRate !== 1.25
    || interactionAssertions.selectedAudio !== 2
    || interactionAssertions.selectedSubtitle !== 3
    || Math.abs(interactionAssertions.timelinePositionTicks - interactionAssertions.expectedHalfTicks) > 1
    || interactionAssertions.volume !== 33
  ) throw new Error("Player interaction acceptance did not preserve state or reach a required control.");
  if (rendererErrors.length > 0) throw new Error(`Renderer logged ${rendererErrors.length} error(s).`);

  const transitionAssertions = await window.webContents.executeJavaScript(`(async () => {
    const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
    window.seeingStoneVisualAcceptance.transitionToNext();
    for (let attempt = 0; attempt < 80; attempt += 1) {
      if (document.getElementById("playerMeta").textContent.includes("The Hidden Gate")) break;
      await delay(25);
    }
    return {
      playerVisible: !document.getElementById("playerView").classList.contains("is-hidden"),
      topMeta: document.getElementById("playerMeta").textContent,
      metadataTitle: document.getElementById("playerMetadataTitle").textContent,
      playbackId: window.seeingStoneVisualAcceptance.getPlayback().playbackId,
    };
  })()`);
  if (!transitionAssertions.playerVisible || !transitionAssertions.topMeta.includes("The Hidden Gate") || transitionAssertions.metadataTitle !== "The Hidden Gate") {
    throw new Error("An automatic item transition left stale player metadata.");
  }

  const terminalAssertions = await window.webContents.executeJavaScript(`(async () => {
    const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
    window.seeingStoneVisualAcceptance.clearViewportInputs();
    window.seeingStoneVisualAcceptance.terminatePlayer();
    await delay(120);
    const viewportInputs = window.seeingStoneVisualAcceptance.getViewportInputs();
    return {
      playerVisible: !document.getElementById("playerView").classList.contains("is-hidden"),
      phaseLabel: document.getElementById("playerPhaseLabel").textContent,
      viewportHidden: viewportInputs.at(-1)?.visible === false,
      playDisabled: document.getElementById("playerPlayPauseButton").disabled,
      settingsTracksDisabled: document.getElementById("playerSettingsAudioSelect").disabled
        && document.getElementById("playerSettingsSubtitleSelect").disabled,
    };
  })()`);
  if (!terminalAssertions.playerVisible || terminalAssertions.phaseLabel !== "Player disconnected" || !terminalAssertions.viewportHidden || !terminalAssertions.playDisabled || !terminalAssertions.settingsTracksDisabled) {
    throw new Error(`Forced player termination did not leave a safe visible terminal state: ${JSON.stringify(terminalAssertions)}`);
  }
  screenshots.push(await capture("player-disconnected.png", 1280, 820, `window.seeingStoneVisualAcceptance.terminatePlayer(); true`));
  const postCaptureTerminalLabel = await window.webContents.executeJavaScript('document.getElementById("playerPhaseLabel").textContent');
  if (postCaptureTerminalLabel !== "Player disconnected") throw new Error("Terminal-state capture did not preserve the disconnected presentation.");

  const packageManifest = require("../package.json");
  const commit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: resolve(__dirname, ".."),
    encoding: "utf8",
    windowsHide: true,
  }).trim();
  const sourceTreeStatus = execFileSync("git", ["status", "--porcelain", "--untracked-files=all", "--", ".", ":(exclude)artifacts/gate-3-4"], {
    cwd: resolve(__dirname, ".."),
    encoding: "utf8",
    windowsHide: true,
  }).trim();
  const report = {
    schemaVersion: 2,
    harness: "isolated-visual-fixture",
    provenance: {
      commit,
      sourceTree: sourceTreeStatus ? "modified" : "clean",
      appVersion: packageManifest.version,
      platform: process.platform,
      architecture: process.arch,
      electronVersion: process.versions.electron,
      fixture: "isolated-visual-fixture",
    },
    screenshots,
    assertions,
    interactions: interactionAssertions,
    keyboard: keyboardAssertions,
    autoHide: autoHideAssertions,
    itemTransition: transitionAssertions,
    terminalState: terminalAssertions,
    checks: [
      { name: "renderer-build", status: "passed" },
      { name: "player-shell-visual", status: "passed" },
    ],
    rendererErrorCount: rendererErrors.length,
  };
  await writeFile(join(outputDirectory, "player-shell-acceptance.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`Player shell visual acceptance passed (${screenshots.length} screenshots).\n`);
  window.destroy();
  app.exit(0);
}
