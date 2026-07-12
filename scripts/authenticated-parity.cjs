"use strict";

const { spawnSync } = require("node:child_process");
const { existsSync } = require("node:fs");
const { hostname } = require("node:os");
const { join, resolve } = require("node:path");

const CHILD_FLAG = "--authenticated-parity-child";
const PARENT_ENV = "JELLYFIN_PARITY_PARENT";
const REQUIRED_TESTS = 11;

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
  const { app, ipcMain } = require("electron");
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
    const { JellyfinApi } = require("../dist/main/services/jellyfinApi.js");
    const { PlaybackSessionService } = require("../dist/main/services/playbackSession.js");
    const { SecureSessionStore } = require("../dist/main/services/secureSession.js");

    ipcChannels = Object.values(IPC);
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
    const playback = new PlaybackSessionService(api);

    rendererSession.protocol.handle("app", security.serveRendererAsset);
    rendererSession.protocol.handle("jellyfin-artwork", async (request) => {
      try { return await artwork.handle(request); } catch { return new Response(null, { status: 502 }); }
    });
    rendererSession.protocol.handle("jellyfin-media", async (request) => {
      try { return await playback.handle(request); } catch { return new Response(null, { status: 502 }); }
    });

    mainWindow = security.createWindow({ showWhenReady: false, devTools: false });
    registerIpcHandlers(ipcMain, mainWindow, api, artwork, playback);
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
    await test("narrow playback start returns one opaque source", () => requireScenario(live, "playbackStart"));
    await test("renderer video accepts the resolved source", () => requireScenario(live, "video"));
    await test("authorized media protocol returns stream bytes", async () => {
      if (!live.playback?.mediaUrl || !live.playback?.playbackId) throw coded("NO_PLAYBACK_SESSION");
      const response = await rendererSession.fetch(live.playback.mediaUrl, {
        headers: { Range: "bytes=0-65535" },
        signal: AbortSignal.timeout(60000),
      });
      if (response.status !== 200 && response.status !== 206) throw coded("MEDIA_RANGE_STATUS");
      if (!response.body) throw coded("MEDIA_BODY_MISSING");
      const reader = response.body.getReader();
      const chunk = await reader.read();
      await reader.cancel().catch(() => undefined);
      if (chunk.done || !chunk.value?.byteLength) throw coded("MEDIA_BYTES_MISSING");
    });
  } finally {
    if (mainWindow && playbackToStop?.playbackId && !mainWindow.isDestroyed()) {
      const playbackId = JSON.stringify(playbackToStop.playbackId);
      await mainWindow.webContents.executeJavaScript(
        `window.jellyfin.playback.stop({ playbackId: ${playbackId} }).catch(() => undefined)`,
      ).catch(() => undefined);
    }
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.destroy();
    for (const channel of ipcChannels) ipcMain.removeHandler(channel);
    if (rendererSession) {
      for (const scheme of ["app", "jellyfin-artwork", "jellyfin-media"]) {
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
    const context = { candidates: [], series: [], episodes: [], playback: null };
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
        if (predicate()) return true;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return false;
    };
    const hasForbiddenKey = (value, seen = new WeakSet()) => {
      if (!value || typeof value !== "object") return false;
      if (seen.has(value)) return false;
      seen.add(value);
      for (const [key, entry] of Object.entries(value)) {
        if (/(?:token|path|headers|mediaSources|mediaStreams|transcodingUrl|directStreamUrl)/i.test(key)) return true;
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

    await run("video", async () => {
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
      document.getElementById("detailPlayButton").click();
      const video = document.getElementById("videoPlayer");
      const accepted = await waitFor(() => !document.getElementById("playerView").classList.contains("is-hidden") && video.src.startsWith("jellyfin-media://stream/") && video.readyState >= 1 && !video.error, 60000);
      if (!accepted) throw coded("VIDEO_SOURCE_REJECTED_" + (context.mediaContainer || "UNKNOWN"));
      document.getElementById("closePlayerButton").click();
      const stopped = await waitFor(() => document.getElementById("playerView").classList.contains("is-hidden"));
      if (!stopped) throw coded("PLAYBACK_UI_DID_NOT_CLOSE");
      const stopDeadline = Date.now() + 10000;
      while (Date.now() < stopDeadline) {
        const state = await window.jellyfin.playback.getState();
        if (!state.playbackId) return {};
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw coded("PLAYBACK_STOP_TIMEOUT");
    });

    await run("playbackStart", async () => {
      if (!context.mediaItem || !context.capabilities) throw coded("MEDIA_SOURCE_DEPENDENCY");
      const playback = await window.jellyfin.playback.start({ itemId: context.mediaItem.id, resumeMode: "resume" });
      const sourceIds = context.capabilities.sources.map((source) => source.id);
      if (!playback.playbackId || !playback.mediaUrl.startsWith("jellyfin-media://stream/") || playback.mediaUrl.includes(context.mediaItem.id) || sourceIds.some((id) => playback.mediaUrl.includes(id))) throw coded("PLAYBACK_URL_NOT_OPAQUE");
      context.playback = playback;
      return {};
    });

    return { results, playback: context.playback ? { playbackId: context.playback.playbackId, mediaUrl: context.playback.mediaUrl } : null };
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
