"use strict";

const { spawnSync } = require("node:child_process");
const { existsSync, rmSync } = require("node:fs");
const { hostname } = require("node:os");
const { join, resolve } = require("node:path");

const CHILD_FLAG = "--authenticated-parity-child";
const PARENT_ENV = "JELLYFIN_PARITY_PARENT";
const REQUIRED_TESTS = 18;

if (!process.versions.electron) {
  try {
    runNodeParent();
  } catch (error) {
    process.stdout.write(`not ok 1 - authenticated parity harness launch [${safeCode(error)}]\n`);
    process.stdout.write(`1..${REQUIRED_TESTS}\n`);
    process.exitCode = 1;
  }
} else {
  void runElectronChild().catch((error) => {
    process.stdout.write(`not ok 1 - authenticated parity harness setup [${safeCode(error)}]\n`);
    process.stdout.write(`1..${REQUIRED_TESTS}\n`);
    require("electron").app.exit(1);
  });
}

function runNodeParent() {
  const electronExecutable = require("electron");
  const env = { ...process.env, [PARENT_ENV]: "1" };
  delete env.ELECTRON_RUN_AS_NODE;

  const result = spawnSync(electronExecutable, [__filename, CHILD_FLAG], {
    cwd: resolve(__dirname, ".."),
    env,
    stdio: "inherit",
    windowsHide: true,
    timeout: 180000,
  });

  if (result.error) throw coded("ELECTRON_LAUNCH_FAILED");
  if (result.signal) throw coded("ELECTRON_EXITED_UNEXPECTEDLY");
  process.exitCode = result.status ?? 1;
}

async function runElectronChild() {
  const { app, ipcMain, nativeImage } = require("electron");
  const packageJson = require("../package.json");
  if (!process.argv.includes(CHILD_FLAG) || process.env[PARENT_ENV] !== "1") throw coded("INVALID_HARNESS_START");
  const productionUserData = findProductionUserData(packageJson);
  if (!productionUserData) throw coded("NO_PROTECTED_SESSION");

  app.commandLine.appendSwitch("disable-gpu");
  app.commandLine.appendSwitch("no-proxy-server");
  app.disableHardwareAcceleration();
  app.enableSandbox();
  app.setName(packageJson.productName || packageJson.name);
  if (typeof app.setVersion === "function") app.setVersion(packageJson.version);
  // Windows protected storage is intentionally bound to the production
  // Electron profile. The visible client must be closed before this harness
  // opens that profile; credentials are never copied into a test directory.
  app.setPath("userData", productionUserData);
  app.on("window-all-closed", () => undefined);

  const security = require("../dist/main/electronSecurity.js");
  security.registerPrivilegedSchemes();

  let mainWindow = null;
  let rendererSession = null;
  let ipcChannels = [];
  let playbackToStop = null;
  let player = null;
  let persistence = null;
  let downloads = null;
  let synchronization = null;
  let forwardPlaybackReports = true;
  const playbackReports = [];
  let testsRun = 0;
  let testsPassed = 0;
  let testsFailed = 0;

  const test = async (name, callback) => {
    testsRun += 1;
    try {
      await callback();
      testsPassed += 1;
      process.stdout.write(`ok ${testsRun} - ${name}\n`);
    } catch (error) {
      testsFailed += 1;
      process.stdout.write(`not ok ${testsRun} - ${name} [${safeCode(error)}]\n`);
    }
  };

  process.stdout.write("TAP version 13\n");

  try {
    await app.whenReady();
    const { IPC } = require("../dist/shared/contracts.js");
    const { registerIpcHandlers } = require("../dist/main/ipc.js");
    const { ArtworkService } = require("../dist/main/services/artwork.js");
    const { DeviceIdentityService } = require("../dist/main/services/deviceIdentity.js");
    const { DownloadManager } = require("../dist/main/services/downloadManager.js");
    const { JellyfinApi } = require("../dist/main/services/jellyfinApi.js");
    const { LocalPlaybackResolver } = require("../dist/main/services/localPlaybackResolver.js");
    const { logger } = require("../dist/main/services/logger.js");
    const { MediaProbeService } = require("../dist/main/services/mediaProbe.js");
    const { MpvPlayerService } = require("../dist/main/services/mpvPlayer.js");
    const { resolveMpvRuntime } = require("../dist/main/services/mpvRuntime.js");
    const { OfflineSynchronizationService } = require("../dist/main/services/offlineSynchronization.js");
    const { PlaybackReportingService } = require("../dist/main/services/playbackReporting.js");
    const { PlaybackSessionService } = require("../dist/main/services/playbackSession.js");
    const { SqlitePersistenceService } = require("../dist/main/services/persistence.js");
    const { SecureSessionStore } = require("../dist/main/services/secureSession.js");

    ipcChannels = Object.values(IPC).filter((channel) => channel !== IPC.playbackStateChanged && channel !== IPC.downloadsChanged);
    rendererSession = security.hardenSession();
    const identity = await new DeviceIdentityService(
      productionUserData,
      `Windows Desktop (${hostname()})`,
      app.getName(),
      app.getVersion(),
    ).get();
    const sessionStore = new SecureSessionStore(productionUserData, security.createSafeStorageProtector());
    const api = new JellyfinApi(identity, sessionStore, async () => { throw coded("EXTERNAL_OPEN_DISABLED"); });
    const artwork = new ArtworkService(api);
    persistence = new SqlitePersistenceService(productionUserData);
    await persistence.open();

    rendererSession.protocol.handle("app", security.serveRendererAsset);
    rendererSession.protocol.handle("jellyfin-artwork", async (request) => {
      try { return await artwork.handle(request); } catch { return new Response(null, { status: 502 }); }
    });
    mainWindow = security.createWindow({ showWhenReady: false, devTools: false });
    const runtime = await resolveMpvRuntime({ packaged: false, resourcesPath: process.resourcesPath, moduleDirectory: resolve(__dirname, "../dist/main") });
    const mediaProbe = new MediaProbeService(runtime);
    const downloadStorageRoot = join(app.getPath("videos"), "LocalFirst Jellyfin Downloads");
    const localPlayback = new LocalPlaybackResolver(api, persistence, mediaProbe, [downloadStorageRoot]);
    const playbackSource = new PlaybackSessionService(api, localPlayback, persistence);
    downloads = new DownloadManager(api, persistence, mediaProbe, downloadStorageRoot, logger);
    downloads.onChanged((state) => {
      if (!mainWindow.isDestroyed()) mainWindow.webContents.send(IPC.downloadsChanged, state);
    });
    synchronization = new OfflineSynchronizationService(api, persistence, logger);
    synchronization.activate();
    const reporting = new PlaybackReportingService(api, synchronization, logger);
    player = new MpvPlayerService(mainWindow, playbackSource, {
      acceptAuthoritativeEvent: async (event) => {
        playbackReports.push({
          kind: event.kind,
          itemId: event.itemId,
          actionKind: event.actionKind,
          positionTicks: event.positionTicks,
          paused: event.paused,
          playMethod: event.playMethod,
        });
        if (forwardPlaybackReports) await reporting.acceptAuthoritativeEvent(event);
      },
    }, {
      get: async () => ({ windowMaximized: true }),
      setWindowMaximized: async () => undefined,
    }, runtime);
    player.onState((state) => {
      if (!mainWindow.isDestroyed()) mainWindow.webContents.send(IPC.playbackStateChanged, state);
    });
    registerIpcHandlers(ipcMain, mainWindow, api, artwork, player, downloads, synchronization);
    await mainWindow.loadURL(security.APP_URL);
    await waitForAuthenticated(mainWindow);

    const live = await runRendererScenarios(mainWindow);
    playbackToStop = live.playback;

    await test("protected session restores through preload IPC", () => requireScenario(live, "session"));
    await test("Home data and Home UI load through main networking", () => requireScenario(live, "home"));
    await test("libraries and movie/show collections load through IPC", () => requireScenario(live, "libraries"));
    await test("search runs through the typed bridge", () => requireScenario(live, "search"));
    await test("details and navigation preserve the renderer flow", () => requireScenario(live, "details"));
    await test("seasons and episodes load through typed IPC", () => requireScenario(live, "episodes"));
    await test("opaque authorized artwork loads in the renderer", () => requireScenario(live, "artwork"));
    await test("media-source capabilities are sanitized", () => requireScenario(live, "mediaSources"));
    await test("UI Play launches main-owned mpv without exposing a source", () => requireScenario(live, "mpvStart"));
    await test("typed mpv pause and seek controls use authoritative state", () => requireScenario(live, "mpvTransport"));
    await test("typed mpv track selection remains allowlisted", () => requireScenario(live, "mpvTracks"));
    await test("main-controlled native mpv fullscreen toggles through typed IPC", () => requireScenario(live, "mpvFullscreen"));
    await test("native mpv output follows a main-controlled window scale change", async () => {
      let before;
      let after;
      try {
        before = await player.getOutputDimensions();
        after = await player.setWindowScale(0.5);
      } catch { throw coded("MPV_OUTPUT_DIMENSIONS_UNAVAILABLE"); }
      if (after.width >= before.width * 0.9 && after.height >= before.height * 0.9) throw coded("MPV_OUTPUT_RESIZE_FAILED");
      if (after.width < 240 || after.height < 135) throw coded("MPV_OUTPUT_RESIZE_INVALID");
    });
    await test("closing mpv restores the prior route and scroll position", async () => {
      if (!live.playback?.playbackId) throw coded("MPV_START_DEPENDENCY");
      const result = await mainWindow.webContents.executeJavaScript(`(async () => {
        await window.jellyfin.playback.stop({ playbackId: ${JSON.stringify(live.playback.playbackId)} });
        const state = await window.jellyfin.playback.getState();
        return {
          stopped: !state.playbackId,
          detailsVisible: !document.getElementById("detailsView").classList.contains("is-hidden"),
          scrollTop: document.getElementById("contentScroller").scrollTop,
        };
      })()`);
      if (!result.stopped) throw coded("MPV_STOP_FAILED");
      if (!result.detailsVisible) throw coded("MPV_ROUTE_NOT_RESTORED");
      if (Math.abs(result.scrollTop - live.priorScroll) > 1) throw coded("MPV_SCROLL_NOT_RESTORED");
      playbackToStop = null;
    });
    await test("a completed exact download plays locally without exposing its path", async () => {
      forwardPlaybackReports = false;
      const context = api.getAuthenticatedContext();
      const bundles = await persistence.listDownloadBundles(context.serverId, context.userId);
      const downloaded = bundles.find((bundle) => bundle.job.state === "completed"
        && bundle.localVersion?.fileState === "finalized"
        && bundle.localVersion.probeState === "valid");
      if (!downloaded) throw coded("NO_VERIFIED_LOCAL_DOWNLOAD");
      const badgeVisible = await mainWindow.webContents.executeJavaScript(`(async () => {
        const input = document.getElementById("searchInput");
        input.value = ${JSON.stringify(downloaded.itemName)};
        input.dispatchEvent(new Event("input", { bubbles: true }));
        for (let attempt = 0; attempt < 120; attempt += 1) {
          const card = document.querySelector('[data-media-item="' + CSS.escape(${JSON.stringify(downloaded.job.itemId)}) + '"]');
          const badge = card?.querySelector(".local-availability-badge");
          if (badge && !badge.classList.contains("is-hidden")) return true;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        return false;
      })()`);
      if (!badgeVisible) throw coded("LOCAL_AVAILABILITY_BADGE_MISSING");
      const result = await mainWindow.webContents.executeJavaScript(`(async () => {
        const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
        const card = document.querySelector('[data-media-item="' + CSS.escape(${JSON.stringify(downloaded.job.itemId)}) + '"]');
        if (!card) throw new Error("LOCAL_CARD_MISSING");
        card.click();
        for (let attempt = 0; attempt < 200; attempt += 1) {
          const ready = !document.getElementById("detailsView").classList.contains("is-hidden")
            && document.getElementById("detailTitle").textContent === ${JSON.stringify(downloaded.itemName)}
            && !document.getElementById("detailPlayButton").disabled;
          if (ready) break;
          await delay(50);
        }
        document.getElementById("detailPlayButton").click();
        for (let attempt = 0; attempt < 1200; attempt += 1) {
          const state = await window.jellyfin.playback.getState();
          if (state.playbackId && ["playing", "paused", "buffering"].includes(state.phase)) return state;
          await delay(50);
        }
        throw new Error("LOCAL_PLAYBACK_TIMEOUT");
      })()`);
      playbackToStop = result;
      if (result.source !== "local") throw coded("LOCAL_SOURCE_NOT_SELECTED");
      if (JSON.stringify(result).includes(downloaded.localVersion.localPath)) throw coded("LOCAL_PATH_EXPOSED");
      const state = player.getState();
      if (state.source !== "local" || state.itemId !== downloaded.job.itemId || state.phase !== "playing") {
        throw coded("LOCAL_PLAYBACK_STATE_INVALID");
      }
      await player.getOutputDimensions().catch(() => { throw coded("LOCAL_MPV_OUTPUT_UNAVAILABLE"); });
      const capturePosition = Math.min(60 * 10000000, Math.floor(state.durationTicks / 4));
      if (capturePosition > 0) await player.seek(result.playbackId, capturePosition);
      await delay(2000);
      const processId = player.process?.pid;
      if (!processId) throw coded("LOCAL_MPV_PROCESS_MISSING");
      const handle = await waitForProcessWindow(processId);
      const capturePath = join(resolve(__dirname, ".."), ".runtime", "local-playback-capture.png");
      rmSync(capturePath, { force: true });
      capturePhysicalWindow(handle, capturePath);
      const image = nativeImage.createFromPath(capturePath);
      const metrics = pixelMetrics(image);
      process.stdout.write(`# local playback capture ${metrics.nonBlackRatio.toFixed(3)} non-black, ${metrics.uniqueColors} colors\n`);
      await mainWindow.webContents.executeJavaScript(`window.jellyfin.playback.stop({ playbackId: ${JSON.stringify(result.playbackId)} })`);
      playbackToStop = null;
      forwardPlaybackReports = true;
      if (metrics.nonBlackRatio < 0.15 || metrics.uniqueColors < 12) throw coded("LOCAL_MPV_VIDEO_BLACK");
    });
    await test("an item without a verified download falls back to Jellyfin streaming", async () => {
      forwardPlaybackReports = false;
      const context = api.getAuthenticatedContext();
      const bundles = await persistence.listDownloadBundles(context.serverId, context.userId);
      const localItemIds = new Set(bundles
        .filter((bundle) => bundle.job.state === "completed"
          && bundle.localVersion?.fileState === "finalized"
          && bundle.localVersion.probeState === "valid")
        .map((bundle) => bundle.job.itemId));
      const home = await api.getHome();
      let candidate = [
        ...home.resumeItems,
        ...home.nextUpItems,
        ...home.latestRows.flatMap((row) => row.items),
      ].find((item) => item.playable && !localItemIds.has(item.id));
      if (!candidate) {
        candidate = (await api.getLibraryItems("Movie", 100)).find((item) => item.playable && !localItemIds.has(item.id));
      }
      if (!candidate) throw coded("NO_SERVER_FALLBACK_ITEM");
      const result = await mainWindow.webContents.executeJavaScript(`window.jellyfin.playback.start({
        itemId: ${JSON.stringify(candidate.id)},
        resumeMode: "start-over"
      })`);
      playbackToStop = result;
      if (result.source !== "server") throw coded("SERVER_FALLBACK_NOT_SELECTED");
      const state = player.getState();
      if (state.source !== "server" || state.itemId !== candidate.id || state.phase !== "playing") {
        throw coded("SERVER_FALLBACK_STATE_INVALID");
      }
      await mainWindow.webContents.executeJavaScript(`window.jellyfin.playback.stop({ playbackId: ${JSON.stringify(result.playbackId)} })`);
      playbackToStop = null;
      forwardPlaybackReports = true;
    });
    await test("authoritative mpv events drive main-only Jellyfin playback reporting", () => {
      if (playbackReports[0]?.kind !== "start") throw coded("MPV_REPORT_START_MISSING");
      if (!playbackReports.some((report) => report.kind === "progress")) throw coded("MPV_REPORT_PROGRESS_MISSING");
      if (playbackReports.at(-1)?.kind !== "stop") throw coded("MPV_REPORT_STOP_MISSING");
      if (playbackReports.some((report) => !Number.isFinite(report.positionTicks) || report.positionTicks < 0)) throw coded("MPV_REPORT_POSITION_INVALID");
      if (!playbackReports.some((report) => report.kind === "start" && report.playMethod === "DirectPlay")) {
        throw coded("LOCAL_DIRECT_PLAY_REPORT_MISSING");
      }
    });
    await test("durable playback progress synchronizes and advances its SQLite head", async () => {
      const report = playbackReports.find((entry) => entry.kind === "stop" && entry.itemId);
      if (!report) throw coded("DURABLE_PROGRESS_REPORT_MISSING");
      const context = api.getAuthenticatedContext();
      let head = null;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        head = await persistence.getPlaybackHead(context.serverId, context.userId, report.itemId);
        if (head?.lastSucceededRevision > 0) break;
        await delay(100);
      }
      if (!head || head.lastSucceededRevision <= 0) throw coded("DURABLE_PROGRESS_NOT_SYNCHRONIZED");
      if (head.lastSucceededRevision > head.latestRevision) throw coded("DURABLE_PROGRESS_REVISION_INVALID");
    });
  } finally {
    if (mainWindow && playbackToStop?.playbackId && !mainWindow.isDestroyed()) {
      const playbackId = JSON.stringify(playbackToStop.playbackId);
      await mainWindow.webContents.executeJavaScript(
        `window.jellyfin.playback.stop({ playbackId: ${playbackId} }).catch(() => undefined)`,
      ).catch(() => undefined);
    }
    await player?.clear().catch(() => undefined);
    await downloads?.shutdown().catch(() => undefined);
    await synchronization?.shutdown().catch(() => undefined);
    await persistence?.close().catch(() => undefined);
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.destroy();
    for (const channel of ipcChannels) ipcMain.removeHandler(channel);
    if (rendererSession) {
      for (const scheme of ["app", "jellyfin-artwork"]) {
        if (rendererSession.protocol.isProtocolHandled(scheme)) rendererSession.protocol.unhandle(scheme);
      }
      await rendererSession.closeAllConnections().catch(() => undefined);
      await rendererSession.clearStorageData().catch(() => undefined);
    }
  }

  if (testsRun !== REQUIRED_TESTS) {
    testsFailed += 1;
    process.stdout.write(`not ok ${testsRun + 1} - complete authenticated test plan [INCOMPLETE_PLAN]\n`);
  }
  process.stdout.write(`1..${REQUIRED_TESTS}\n`);
  process.stdout.write(`# ${testsPassed} passed, ${testsFailed} failed\n`);
  app.exit(testsFailed === 0 ? 0 : 1);
}

function findProductionUserData(packageJson) {
  const names = [...new Set([packageJson.productName, packageJson.name].filter(Boolean))];
  const bases = [process.env.APPDATA, process.env.LOCALAPPDATA].filter(Boolean);
  for (const base of bases) {
    for (const name of names) {
      const candidate = join(base, name);
      if (existsSync(join(candidate, "session.safe"))) return candidate;
    }
  }
  return null;
}

async function waitForAuthenticated(window) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const authenticated = await window.webContents.executeJavaScript(
      `window.jellyfin?.session?.getState().then((session) => session.authenticated).catch(() => false)`,
    ).catch(() => false);
    if (authenticated) return;
    await delay(100);
  }
  throw coded("SESSION_RESTORE_TIMEOUT");
}

async function runRendererScenarios(window) {
  return window.webContents.executeJavaScript(`(async () => {
    const results = {};
    const context = { candidates: [], series: [], episodes: [], playback: null, priorScroll: 0 };
    const safeCode = (error) => {
      const code = error && typeof error === "object" && typeof error.code === "string" ? error.code : "SCENARIO_FAILED";
      return /^[A-Z0-9_]{1,64}$/.test(code) ? code : "SCENARIO_FAILED";
    };
    const coded = (code) => Object.assign(new Error(code), { code });
    const run = async (name, callback) => {
      try { results[name] = { ok: true, ...(await callback()) }; }
      catch (error) { results[name] = { ok: false, code: safeCode(error) }; }
    };
    const waitFor = async (predicate, timeout = 20000) => {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        if (await predicate()) return true;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return false;
    };
    const hasForbiddenKey = (value, seen = new WeakSet()) => {
      if (!value || typeof value !== "object") return false;
      if (seen.has(value)) return false;
      seen.add(value);
      for (const [key, entry] of Object.entries(value)) {
        if (/(?:token|path|headers|mediaSources|mediaStreams|mediaUrl|transcodingUrl|directStreamUrl)/i.test(key)) return true;
        if (hasForbiddenKey(entry, seen)) return true;
      }
      return false;
    };
    const addCandidates = (items) => {
      for (const item of items || []) {
        if (item?.id && !context.candidates.some((entry) => entry.id === item.id)) context.candidates.push(item);
      }
    };

    await run("session", async () => {
      const session = await window.jellyfin.session.getState();
      if (!session.authenticated || session.persistence !== "protected" || !session.server || !session.user) throw coded("SESSION_NOT_PROTECTED");
      return {};
    });

    await run("home", async () => {
      const home = await window.jellyfin.home.get();
      if (!Array.isArray(home.libraries) || !Array.isArray(home.resumeItems) || !Array.isArray(home.nextUpItems) || !Array.isArray(home.latestRows)) throw coded("HOME_SHAPE_INVALID");
      if (hasForbiddenKey(home)) throw coded("HOME_PRIVILEGED_FIELD");
      addCandidates(home.resumeItems);
      addCandidates(home.nextUpItems);
      for (const row of home.latestRows) addCandidates(row.items);
      const uiReady = await waitFor(() => !document.getElementById("mainView").classList.contains("is-hidden") && document.getElementById("homeRows").childElementCount > 0);
      if (!uiReady || !document.getElementById("loginView").classList.contains("is-hidden")) throw coded("HOME_UI_NOT_READY");
      return {};
    });

    await run("libraries", async () => {
      const [libraries, movies, series] = await Promise.all([
        window.jellyfin.libraries.list(),
        window.jellyfin.libraries.getItems({ type: "Movie", limit: 60 }),
        window.jellyfin.libraries.getItems({ type: "Series", limit: 60 }),
      ]);
      if (!Array.isArray(libraries) || libraries.length === 0 || !Array.isArray(movies) || !Array.isArray(series)) throw coded("LIBRARY_DATA_MISSING");
      if (hasForbiddenKey(libraries) || hasForbiddenKey(movies) || hasForbiddenKey(series)) throw coded("LIBRARY_PRIVILEGED_FIELD");
      context.series = series;
      addCandidates(movies);
      addCandidates(series);
      document.getElementById("navMoviesButton").click();
      const uiReady = await waitFor(() => !document.getElementById("libraryView").classList.contains("is-hidden") && document.getElementById("libraryGrid").childElementCount > 0);
      if (!uiReady) throw coded("LIBRARY_UI_NOT_READY");
      return {};
    });

    await run("search", async () => {
      const seed = context.candidates[0];
      const query = seed?.name || "a";
      const items = await window.jellyfin.search.query({ query });
      if (!Array.isArray(items) || (seed && items.length === 0)) throw coded("SEARCH_DATA_MISSING");
      if (hasForbiddenKey(items)) throw coded("SEARCH_PRIVILEGED_FIELD");
      addCandidates(items);
      const input = document.getElementById("searchInput");
      input.value = query;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      const uiReady = await waitFor(() => !document.getElementById("searchView").classList.contains("is-hidden") && document.getElementById("searchRows").childElementCount > 0);
      if (!uiReady) throw coded("SEARCH_UI_NOT_READY");
      return {};
    });

    await run("details", async () => {
      const seed = context.candidates.find((item) => item.playable) || context.candidates[0];
      if (!seed) throw coded("DETAIL_ITEM_MISSING");
      const detail = await window.jellyfin.items.getDetails({ itemId: seed.id });
      if (!detail || detail.id !== seed.id || hasForbiddenKey(detail)) throw coded("DETAIL_DATA_INVALID");
      const card = document.querySelector("#searchRows .media-card, #libraryGrid .media-card, #homeRows .media-card");
      if (!card) throw coded("DETAIL_CARD_MISSING");
      card.click();
      const uiReady = await waitFor(() => !document.getElementById("detailsView").classList.contains("is-hidden") && document.getElementById("detailTitle").textContent.trim().length > 0);
      if (!uiReady) throw coded("DETAIL_UI_NOT_READY");
      return {};
    });

    await run("episodes", async () => {
      const series = context.series[0] || context.candidates.find((item) => item.type === "Series");
      if (!series) throw coded("SERIES_ITEM_MISSING");
      const seasons = await window.jellyfin.shows.getSeasons({ itemId: series.id });
      if (!Array.isArray(seasons) || seasons.length === 0 || hasForbiddenKey(seasons)) throw coded("SEASONS_MISSING");
      const episodes = await window.jellyfin.shows.getEpisodes({ seriesId: series.id, seasonId: seasons[0].id });
      if (!Array.isArray(episodes) || episodes.length === 0 || hasForbiddenKey(episodes)) throw coded("EPISODES_MISSING");
      context.episodes = episodes;
      addCandidates(episodes);
      return {};
    });

    await run("artwork", async () => {
      const item = context.candidates.find((entry) => entry.backdropImageTag || entry.imageTags?.Primary || entry.imageTags?.Thumb);
      if (!item) throw coded("ARTWORK_ITEM_MISSING");
      const kind = item.backdropImageTag ? "Backdrop" : item.imageTags?.Primary ? "Primary" : "Thumb";
      const tag = kind === "Backdrop" ? item.backdropImageTag : item.imageTags?.[kind];
      const url = await window.jellyfin.artwork.getUrl({ itemId: item.id, kind, tag: tag || undefined, width: 640 });
      if (!url.startsWith("jellyfin-artwork://asset/") || url.includes(item.id) || (tag && url.includes(tag))) throw coded("ARTWORK_URL_NOT_OPAQUE");
      const loaded = await new Promise((resolve) => {
        const image = new Image();
        const timer = setTimeout(() => { image.remove(); resolve(false); }, 20000);
        image.onload = () => { clearTimeout(timer); const valid = image.naturalWidth > 0; image.remove(); resolve(valid); };
        image.onerror = () => { clearTimeout(timer); image.remove(); resolve(false); };
        image.style.display = "none";
        document.body.append(image);
        image.src = url;
      });
      if (!loaded) throw coded("ARTWORK_RENDER_FAILED");
      return {};
    });

    await run("mediaSources", async () => {
      const browserContainers = new Set(["mp4", "m4v", "mov", "webm", "ogg", "ogv"]);
      let fallback = null;
      let browserFallback = null;
      let mkvTranscode = null;
      const orderedItems = [
        ...context.candidates.filter((entry) => entry.type === "Movie"),
        ...context.candidates.filter((entry) => entry.type !== "Movie"),
        ...context.episodes,
      ];
      for (const item of orderedItems.filter((entry) => entry.playable).slice(0, 40)) {
        let capabilities;
        try {
          capabilities = await window.jellyfin.mediaSources.getCapabilities({ itemId: item.id });
        } catch { /* Try another playable item without exposing its identity. */ }
        if (!capabilities?.sources?.length) continue;
        if (hasForbiddenKey(capabilities)) throw coded("MEDIA_SOURCE_PRIVILEGED_FIELD");
        const selectedSource = capabilities.sources.find((source) => source.supportsDirectStream || source.supportsDirectPlay) || capabilities.sources[0];
        const container = String(selectedSource.container || "unknown").replace(/[^a-z0-9]/gi, "").toLowerCase().slice(0, 16) || "unknown";
        const candidate = { item, capabilities, container };
        if (!fallback) fallback = candidate;
        if (container === "mkv" && selectedSource.supportsTranscoding) {
          mkvTranscode = candidate;
          break;
        }
        if (browserContainers.has(container) && !browserFallback) browserFallback = candidate;
      }
      const selected = mkvTranscode || browserFallback || fallback;
      if (!selected) throw coded("MEDIA_SOURCE_MISSING");
      context.mediaItem = selected.item;
      context.capabilities = selected.capabilities;
      context.mediaContainer = selected.container.toUpperCase();
      return {};
    });

    await run("mpvStart", async () => {
      if (!context.mediaItem) throw coded("MEDIA_SOURCE_DEPENDENCY");
      const input = document.getElementById("searchInput");
      input.value = context.mediaItem.name;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      const searchReady = await waitFor(() => !document.getElementById("searchView").classList.contains("is-hidden") && document.querySelectorAll("#searchRows .media-card").length > 0);
      if (!searchReady) throw coded("PLAYBACK_SEARCH_NOT_READY");
      const expectedTitle = context.mediaItem.type === "Episode" && context.mediaItem.seriesName
        ? context.mediaItem.seriesName
        : context.mediaItem.name;
      const card = [...document.querySelectorAll("#searchRows .media-card")].find((candidate) => {
        const title = candidate.querySelector(".media-copy strong")?.textContent || "";
        const subtitle = candidate.querySelector(".media-copy small")?.textContent || "";
        return title === expectedTitle && (context.mediaItem.type !== "Episode" || subtitle.includes(context.mediaItem.name));
      });
      if (!card) throw coded("PLAYBACK_CARD_MISSING");
      card.click();
      const detailsReady = await waitFor(() => !document.getElementById("detailsView").classList.contains("is-hidden") && document.getElementById("detailTitle").textContent === context.mediaItem.name && !document.getElementById("detailPlayButton").disabled);
      if (!detailsReady) throw coded("PLAYBACK_DETAILS_NOT_READY");
      const scroller = document.getElementById("contentScroller");
      scroller.scrollTop = Math.min(120, Math.max(0, scroller.scrollHeight - scroller.clientHeight));
      context.priorScroll = scroller.scrollTop;
      document.getElementById("detailPlayButton").click();
      let playback = null;
      const accepted = await waitFor(async () => {
        playback = await window.jellyfin.playback.getState();
        return Boolean(playback.playbackId && ["playing", "paused", "buffering"].includes(playback.phase) && playback.durationTicks > 0);
      }, 60000);
      if (!accepted || !playback || hasForbiddenKey(playback) || JSON.stringify(playback).includes("jellyfin-media://")) throw coded("MPV_SOURCE_NOT_ACCEPTED_" + (context.mediaContainer || "UNKNOWN"));
      context.playback = { playbackId: playback.playbackId };
      return {};
    });

    await run("mpvTransport", async () => {
      if (!context.playback) throw coded("MPV_START_DEPENDENCY");
      const playbackId = context.playback.playbackId;
      try { await window.jellyfin.playback.setPaused({ playbackId, paused: true }); }
      catch { throw coded("MPV_PAUSE_COMMAND_FAILED"); }
      const paused = await waitFor(async () => (await window.jellyfin.playback.getState()).paused === true);
      if (!paused) throw coded("MPV_PAUSE_FAILED");
      let beforeSeek;
      try { beforeSeek = await window.jellyfin.playback.getState(); }
      catch { throw coded("MPV_STATE_BEFORE_SEEK_FAILED"); }
      const target = Math.min(5 * 10000000, Math.max(0, beforeSeek.durationTicks - (2 * 10000000)));
      try { await window.jellyfin.playback.seek({ playbackId, positionTicks: target }); }
      catch { throw coded("MPV_SEEK_COMMAND_FAILED"); }
      const sought = await waitFor(async () => Math.abs((await window.jellyfin.playback.getState()).positionTicks - target) < 2 * 10000000);
      if (!sought) throw coded("MPV_SEEK_FAILED");
      try { await window.jellyfin.playback.setPaused({ playbackId, paused: false }); }
      catch { throw coded("MPV_RESUME_COMMAND_FAILED"); }
      return {};
    });

    await run("mpvTracks", async () => {
      if (!context.playback) throw coded("MPV_START_DEPENDENCY");
      const playbackId = context.playback.playbackId;
      const state = await window.jellyfin.playback.getState();
      const audio = state.audioTracks.find((track) => track.selected) || state.audioTracks[0] || null;
      const subtitle = state.subtitleTracks.find((track) => track.selected) || state.subtitleTracks[0] || null;
      await window.jellyfin.playback.selectAudio({ playbackId, trackId: audio?.id || null });
      await window.jellyfin.playback.selectSubtitle({ playbackId, trackId: subtitle?.id || null });
      return {};
    });

    await run("mpvFullscreen", async () => {
      if (!context.playback) throw coded("MPV_START_DEPENDENCY");
      const playbackId = context.playback.playbackId;
      const entered = await window.jellyfin.playback.setFullscreen({ playbackId, fullscreen: true });
      if (!entered.fullscreen) throw coded("MPV_FULLSCREEN_ENTER_FAILED");
      const left = await window.jellyfin.playback.setFullscreen({ playbackId, fullscreen: false });
      if (left.fullscreen) throw coded("MPV_FULLSCREEN_EXIT_FAILED");
      return {};
    });

    return { results, playback: context.playback ? { playbackId: context.playback.playbackId } : null, priorScroll: context.priorScroll };
  })()`, true);
}

function requireScenario(live, name) {
  const result = live?.results?.[name];
  if (!result?.ok) throw coded(result?.code || "SCENARIO_NOT_RUN");
}

function coded(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function safeCode(error) {
  const code = error && typeof error === "object" && typeof error.code === "string" ? error.code : "ASSERTION_FAILED";
  return /^[A-Z0-9_]{1,64}$/.test(code) ? code : "ASSERTION_FAILED";
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function waitForProcessWindow(processId) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const result = spawnSync(powershellPath(), [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "$process=Get-Process -Id ([int]$env:JELLYFIN_CAPTURE_PID) -ErrorAction SilentlyContinue; if($process){$process.Refresh(); [Console]::Write($process.MainWindowHandle)}",
    ], {
      env: { ...process.env, JELLYFIN_CAPTURE_PID: String(processId) },
      encoding: "utf8",
      windowsHide: true,
    });
    const handle = Number(String(result.stdout || "").trim());
    if (Number.isSafeInteger(handle) && handle > 0) return handle;
    await delay(50);
  }
  throw coded("LOCAL_MPV_WINDOW_MISSING");
}

function capturePhysicalWindow(handle, outputPath) {
  const script = [
    "Add-Type -AssemblyName System.Drawing",
    "$definition='using System; using System.Runtime.InteropServices; public static class LocalFirstCapture { [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; } [DllImport(\"user32.dll\")] public static extern bool GetWindowRect(IntPtr hwnd, out RECT rect); }'",
    "Add-Type -TypeDefinition $definition",
    "$rect=New-Object LocalFirstCapture+RECT",
    "$ok=[LocalFirstCapture]::GetWindowRect([IntPtr]::new([int64]$env:JELLYFIN_CAPTURE_HANDLE),[ref]$rect)",
    "if(-not $ok){exit 2}",
    "$width=$rect.Right-$rect.Left; $height=$rect.Bottom-$rect.Top",
    "if($width -le 0 -or $height -le 0){exit 3}",
    "$bitmap=New-Object System.Drawing.Bitmap($width,$height)",
    "$graphics=[System.Drawing.Graphics]::FromImage($bitmap)",
    "$graphics.CopyFromScreen($rect.Left,$rect.Top,0,0,$bitmap.Size)",
    "$bitmap.Save($env:JELLYFIN_CAPTURE_PATH,[System.Drawing.Imaging.ImageFormat]::Png)",
    "$graphics.Dispose(); $bitmap.Dispose()",
  ].join("; ");
  const result = spawnSync(powershellPath(), ["-NoProfile", "-NonInteractive", "-Command", script], {
    env: { ...process.env, JELLYFIN_CAPTURE_HANDLE: String(handle), JELLYFIN_CAPTURE_PATH: outputPath },
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0 || !existsSync(outputPath)) throw coded("LOCAL_MPV_CAPTURE_FAILED");
}

function powershellPath() {
  return process.env.SystemRoot
    ? join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    : "powershell.exe";
}

function pixelMetrics(image) {
  const size = image.getSize();
  if (image.isEmpty() || size.width <= 100 || size.height <= 100) throw coded("LOCAL_MPV_CAPTURE_EMPTY");
  const x = Math.min(16, Math.floor(size.width / 10));
  const y = Math.min(48, Math.floor(size.height / 10));
  const bitmap = image.crop({
    x,
    y,
    width: Math.max(1, size.width - (x * 2)),
    height: Math.max(1, size.height - y - x),
  }).resize({ width: 160, height: 90, quality: "good" }).toBitmap();
  const colors = new Set();
  let nonBlack = 0;
  let pixels = 0;
  for (let offset = 0; offset + 3 < bitmap.length; offset += 4) {
    const blue = bitmap[offset];
    const green = bitmap[offset + 1];
    const red = bitmap[offset + 2];
    if (red + green + blue >= 24) nonBlack += 1;
    colors.add(`${red >> 4}:${green >> 4}:${blue >> 4}`);
    pixels += 1;
  }
  return { nonBlackRatio: pixels ? nonBlack / pixels : 0, uniqueColors: colors.size };
}
