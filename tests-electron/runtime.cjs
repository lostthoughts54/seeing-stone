"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} = require("node:fs");
const { createServer } = require("node:http");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");

const CHILD_FLAG = "--electron-runtime-child";
const USER_DATA_ENV = "JELLYFIN_ELECTRON_TEST_USER_DATA";
const EXPECTED_TESTS = 20;

if (!process.versions.electron) {
  runNodeParent();
} else {
  void runElectronChild().catch((error) => {
    process.stderr.write(`${error?.stack || String(error)}\n`);
    require("electron").app.exit(1);
  });
}

function runNodeParent() {
  const electronExecutable = require("electron");
  const userDataPath = mkdtempSync(join(tmpdir(), "localfirst-jellyfin-electron-"));
  const env = { ...process.env, [USER_DATA_ENV]: userDataPath };
  delete env.ELECTRON_RUN_AS_NODE;

  let result;
  try {
    result = spawnSync(electronExecutable, [__filename, CHILD_FLAG], {
      cwd: resolve(__dirname, ".."),
      env,
      stdio: "inherit",
      windowsHide: true,
      timeout: 120000,
    });
  } finally {
    rmSync(userDataPath, { force: true, recursive: true, maxRetries: 10, retryDelay: 100 });
  }

  if (result.error) throw result.error;
  if (result.signal) throw new Error(`Electron runtime test ended with signal ${result.signal}.`);
  process.exitCode = result.status ?? 1;
}

async function runElectronChild() {
  const { app, BrowserWindow, ipcMain } = require("electron");
  const userDataPath = process.env[USER_DATA_ENV];
  if (!process.argv.includes(CHILD_FLAG) || !userDataPath) {
    throw new Error("Electron runtime test must be launched through its Node parent wrapper.");
  }

  app.commandLine.appendSwitch("disable-gpu");
  app.commandLine.appendSwitch("no-proxy-server");
  app.disableHardwareAcceleration();
  app.enableSandbox();
  app.setName("LocalFirst Jellyfin Runtime Acceptance");
  app.setPath("userData", userDataPath);
  // Registering this listener prevents Electron's default Windows behavior
  // from exiting before the harness can print its plan and chosen exit code.
  app.on("window-all-closed", () => undefined);

  const security = require("../dist/main/electronSecurity.js");
  security.registerPrivilegedSchemes();

  let failures = 0;
  let passed = 0;
  let testNumber = 0;
  let mainWindow = null;
  let foreignWindow = null;
  let rendererSession = null;
  let localServer = null;
  let ipcChannels = [];

  const test = async (name, callback) => {
    testNumber += 1;
    try {
      await callback();
      passed += 1;
      process.stdout.write(`ok ${testNumber} - ${name}\n`);
    } catch (error) {
      failures += 1;
      process.stdout.write(`not ok ${testNumber} - ${name}\n`);
      process.stdout.write(`${indent(error?.stack || String(error))}\n`);
    }
  };

  process.stdout.write("TAP version 13\n");

  try {
    await app.whenReady();

    const { IPC } = require("../dist/shared/contracts.js");
    const { registerIpcHandlers } = require("../dist/main/ipc.js");
    const { AppError } = require("../dist/main/services/errors.js");
    const { ArtworkService } = require("../dist/main/services/artwork.js");
    const { PlaybackSessionService } = require("../dist/main/services/playbackSession.js");
    const { SecureSessionStore } = require("../dist/main/services/secureSession.js");

    ipcChannels = Object.values(IPC);
    rendererSession = security.hardenSession();

    let artworkFetchCount = 0;
    let connectionCount = 0;
    let downloadStartCount = 0;
    let chooseDownloadLocationCount = 0;
    let openDownloadLocationCount = 0;
    let defaultDownloadLocationCount = 0;
    const downloadStartItems = [];
    const watchedActions = [];
    let expireHome = false;
    let homeUnavailable = false;
    let homeGetCount = 0;
    let logoutCount = 0;
    let seriesDetailsDelayMs = 0;
    const detailRequests = [];
    const seasonRequests = [];
    const episodeRequests = [];
    const streamRequests = [];
    const safeSession = {
      authenticated: true,
      persistence: "none",
      server: {
        address: "https://runtime-server.invalid",
        id: "runtime-server-id",
        name: "Runtime server",
        version: "10.11.11",
      },
      user: { id: "runtime-user-id", name: "Runtime user" },
    };
    const runtimeItem = {
      id: "runtime-movie-id",
      name: "Runtime movie",
      type: "Movie",
      overview: "Runtime watched-state test item.",
      productionYear: 2026,
      premiereYear: 2026,
      officialRating: null,
      communityRating: null,
      runTimeTicks: 600000000,
      genres: [],
      primaryImageAspectRatio: null,
      imageTags: {},
      backdropImageTag: null,
      parentThumbItemId: null,
      parentThumbImageTag: null,
      seriesId: null,
      seriesName: null,
      seasonId: null,
      indexNumber: null,
      parentIndexNumber: null,
      userData: { played: false, playbackPositionTicks: 0, playedPercentage: 0 },
      hasTrailer: false,
      playable: true,
    };
    const runtimeSeries = {
      ...runtimeItem,
      id: "runtime-series-id",
      name: "Runtime series",
      type: "Series",
      overview: "Runtime parent series.",
      playable: false,
      userData: { played: false, playbackPositionTicks: 0, playedPercentage: 0 },
    };
    const runtimeSeasonOne = {
      ...runtimeItem,
      id: "runtime-season-one-id",
      name: "Season 1",
      type: "Season",
      seriesId: runtimeSeries.id,
      seriesName: runtimeSeries.name,
      indexNumber: 1,
      playable: false,
      userData: { played: false, playbackPositionTicks: 0, playedPercentage: 0 },
    };
    const runtimeSeasonTwo = {
      ...runtimeSeasonOne,
      id: "runtime-season-two-id",
      name: "Season 2",
      indexNumber: 2,
    };
    const runtimeEpisode = {
      ...runtimeItem,
      id: "runtime-episode-id",
      name: "Runtime episode",
      type: "Episode",
      overview: "Runtime episode to parent-series navigation test.",
      seriesId: runtimeSeries.id,
      seriesName: runtimeSeries.name,
      seasonId: runtimeSeasonTwo.id,
      indexNumber: 3,
      parentIndexNumber: 2,
      userData: { played: false, playbackPositionTicks: 0, playedPercentage: 0 },
    };
    const runtimeEpisodeTwo = {
      ...runtimeEpisode,
      id: "runtime-episode-two-id",
      name: "Runtime episode two",
      indexNumber: 4,
    };
    const runtimeWatchedMovie = {
      ...runtimeItem,
      id: "runtime-alpha-movie-id",
      name: "Alpha movie",
      productionYear: 1999,
      premiereYear: 1999,
      communityRating: 9.1,
      userData: { played: true, playbackPositionTicks: 0, playedPercentage: 100 },
    };
    const runtimeOtherMovie = {
      ...runtimeItem,
      id: "runtime-zulu-movie-id",
      name: "Zulu movie",
      productionYear: 2010,
      premiereYear: 2010,
      communityRating: 6.5,
    };
    const api = {
      async connect(url) {
        connectionCount += 1;
        return {
          address: url,
          id: "runtime-server-id",
          name: "Runtime server",
          version: "10.11.11",
          connectionId: "24a625db-2973-49a1-bdb6-aae91ff9872c",
        };
      },
      async restore() { return safeSession; },
      getSafeSession() { return safeSession; },
      async getLibraries() { return []; },
      async getLibraryItems(type) {
        return type === "Movie" ? [runtimeItem, runtimeWatchedMovie, runtimeOtherMovie] : [runtimeSeries];
      },
      async search() { return [runtimeOtherMovie]; },
      async getHome() {
        homeGetCount += 1;
        if (expireHome) throw new AppError("SESSION_EXPIRED", "Your Jellyfin session has expired.", 401);
        if (homeUnavailable) throw new AppError("SERVER_UNAVAILABLE", "Jellyfin is unavailable.", 503);
        return {
          libraries: [],
          resumeItems: [],
          nextUpItems: [],
          latestRows: [{
            library: { id: "runtime-library", name: "Runtime library", collectionType: "movies" },
            items: [runtimeItem, runtimeEpisode],
          }],
        };
      },
      async logout() {
        logoutCount += 1;
        return { authenticated: false, persistence: "none", server: null, user: null };
      },
      async fetchArtwork() {
        artworkFetchCount += 1;
        return new Response(Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]), {
          status: 200,
          headers: { "Content-Type": "image/png", "Content-Length": "8" },
        });
      },
      async getDetails(itemId) {
        detailRequests.push(itemId);
        if (itemId === runtimeItem.id) return runtimeItem;
        if (itemId === runtimeEpisode.id) return runtimeEpisode;
        if (itemId === runtimeSeries.id) {
          if (seriesDetailsDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, seriesDetailsDelayMs));
          return runtimeSeries;
        }
        return {
          id: itemId,
          name: "Runtime item",
          userData: { played: false, playbackPositionTicks: 12345, playedPercentage: 1 },
        };
      },
      async getMediaSourceCapabilities(itemId) {
        return {
          itemId,
          sources: [{
            id: "runtime-source-id",
            container: "mp4",
            size: 4,
            supportsDirectPlay: true,
            supportsDirectStream: true,
            supportsTranscoding: false,
          }],
        };
      },
      async getSeasons(seriesId) {
        seasonRequests.push(seriesId);
        return seriesId === runtimeSeries.id ? [runtimeSeasonOne, runtimeSeasonTwo] : [];
      },
      async getEpisodes(seriesId, seasonId) {
        episodeRequests.push({ seriesId, seasonId });
        return seriesId === runtimeSeries.id && seasonId === runtimeSeasonTwo.id ? [runtimeEpisode, runtimeEpisodeTwo] : [];
      },
      async fetchStaticStream(itemId, mediaSourceId, range, signal) {
        streamRequests.push({ itemId, mediaSourceId, range, signal });
        return new Response(Uint8Array.from([1, 2, 3, 4]), {
          status: range ? 206 : 200,
          headers: {
            "Content-Type": "video/x-matroska",
            "Content-Length": "4",
            "Accept-Ranges": "bytes",
            ...(range ? { "Content-Range": "bytes 0-3/4" } : {}),
          },
        });
      },
    };
    const artwork = new ArtworkService(api);
    const playback = new PlaybackSessionService(api);
    const downloadedItem = {
      downloadId: "runtime-download-id",
      itemId: "runtime-offline-episode-id",
      name: "Runtime offline episode",
      itemType: "Episode",
      state: "downloaded",
      bytesDownloaded: 4,
      expectedSize: 4,
      progressPercent: 100,
      keepDownloaded: true,
      error: null,
      canPause: false,
      canResume: false,
      canRetry: false,
      canCancel: false,
      canDelete: true,
    };
    const downloadedMovie = {
      ...downloadedItem,
      downloadId: "runtime-downloaded-movie-id",
      itemId: runtimeItem.id,
      name: runtimeItem.name,
      itemType: "Movie",
    };
    const downloads = {
      async activate() {},
      async deactivate() {},
      async list() { return [downloadedItem, downloadedMovie]; },
      async start(itemId) {
        downloadStartCount += 1;
        downloadStartItems.push(itemId);
        const source = itemId === runtimeEpisodeTwo.id ? runtimeEpisodeTwo : runtimeEpisode;
        return {
          ...downloadedItem,
          downloadId: `queued-${downloadStartCount}`,
          itemId,
          name: source.name,
          state: "queued",
          bytesDownloaded: 0,
          expectedSize: null,
          progressPercent: null,
          keepDownloaded: false,
          canCancel: true,
          canDelete: false,
        };
      },
      async pause() { throw new Error("not used"); },
      async resume() { throw new Error("not used"); },
      async retry() { throw new Error("not used"); },
      async cancel() { throw new Error("not used"); },
      async delete() { throw new Error("not used"); },
      async setKeep() { throw new Error("not used"); },
    };
    let downloadLocationSummary = { mode: "default", label: "Windows Videos folder" };
    const downloadLocation = {
      async getSummary() { return structuredClone(downloadLocationSummary); },
      async choose() {
        chooseDownloadLocationCount += 1;
        downloadLocationSummary = { mode: "custom", label: "Custom folder on D:" };
        return structuredClone(downloadLocationSummary);
      },
      async useDefault() {
        defaultDownloadLocationCount += 1;
        downloadLocationSummary = { mode: "default", label: "Windows Videos folder" };
        return structuredClone(downloadLocationSummary);
      },
      async open() {
        openDownloadLocationCount += 1;
        return { opened: true };
      },
    };
    const synchronization = {
      activate() {},
      deactivate() {},
      async setWatched(itemId, watched) {
        watchedActions.push({ itemId, watched });
        runtimeItem.userData = { played: watched, playbackPositionTicks: 0, playedPercentage: watched ? 100 : 0 };
        return { itemId, watched, synchronization: "synchronized" };
      },
    };

    rendererSession.protocol.handle("app", security.serveRendererAsset);
    rendererSession.protocol.handle("jellyfin-artwork", async (request) => {
      try { return await artwork.handle(request); } catch { return new Response(null, { status: 502 }); }
    });
    await test("registered app protocol serves strict production security headers", async () => {
      assert.equal(rendererSession.protocol.isProtocolHandled("app"), true);
      const response = await rendererSession.fetch(security.APP_URL, { cache: "no-store" });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("content-security-policy"), security.appContentSecurityPolicy());
      assert.equal(response.headers.get("x-content-type-options"), "nosniff");
      assert.equal(response.headers.get("cross-origin-opener-policy"), "same-origin");
      const csp = response.headers.get("content-security-policy");
      assert.match(csp, /connect-src 'none'/);
      assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/);

      const queryResponse = await rendererSession.fetch(`${security.APP_URL}?unexpected=1`);
      assert.equal(queryResponse.status, 400);
      const postResponse = await rendererSession.fetch(security.APP_URL, { method: "POST" });
      assert.equal(postResponse.status, 405);
    });

    await test("Windows safeStorage persists only protected bytes and restores and clears them", async () => {
      assert.equal(process.platform, "win32", "This acceptance gate requires its target Windows runtime.");
      const protector = security.createSafeStorageProtector();
      assert.equal(await protector.isAvailable(), true, "Windows async safeStorage must be available.");

      const storePath = join(userDataPath, "secure-session-case");
      const token = "runtime-token-0fb715a9-bf0f-4dcf-b64c-e1bb1e828e12";
      const stored = {
        serverUrl: "https://protected-runtime-server.invalid",
        serverId: "protected-server-id",
        serverName: "Protected runtime server",
        serverVersion: "10.11.11",
        userId: "protected-runtime-user-id",
        userName: "Protected runtime user 34d779e8",
        accessToken: token,
      };
      const firstStore = new SecureSessionStore(storePath, protector);
      assert.equal(await firstStore.save(stored, true), "protected");

      const ciphertextPath = join(storePath, "session.safe");
      const ciphertext = readFileSync(ciphertextPath);
      assert.ok(ciphertext.length > 0);
      assert.equal(ciphertext.includes(Buffer.from(token, "utf8")), false);
      assert.equal(ciphertext.includes(Buffer.from(stored.userName, "utf8")), false);
      assert.equal(ciphertext.includes(Buffer.from(stored.serverUrl, "utf8")), false);

      const restoredStore = new SecureSessionStore(storePath, protector);
      assert.deepEqual(await restoredStore.restore(), stored);
      assert.equal(restoredStore.getPersistence(), "protected");
      await restoredStore.clear();
      assert.equal(existsSync(ciphertextPath), false);
      assert.equal(restoredStore.getMemory(), null);
      assert.equal(restoredStore.getPersistence(), "none");
    });

    await test("artwork protocol uses opaque no-store references revoked on clear", async () => {
      const itemId = "secret-item-id-that-must-not-appear";
      const url = artwork.getUrl({ itemId, kind: "Primary", tag: "image-tag", width: 320 });
      assert.match(url, /^jellyfin-artwork:\/\/asset\/[0-9a-f-]{36}$/);
      assert.equal(url.includes(itemId), false);

      const response = await rendererSession.fetch(url, { cache: "no-store" });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("content-type"), "image/png");
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal(response.headers.get("x-content-type-options"), "nosniff");
      assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [137, 80, 78, 71, 13, 10, 26, 10]);
      assert.equal(artworkFetchCount, 1);

      artwork.clear();
      const revoked = await rendererSession.fetch(url, { cache: "no-store" });
      assert.equal(revoked.status, 404);
      assert.equal(artworkFetchCount, 1);
    });

    await test("renderer has no media protocol while playback resolution stays main-only", async () => {
      assert.equal(rendererSession.protocol.isProtocolHandled("jellyfin-media"), false);
      const firstItem = "first-secret-item";
      const first = await playback.start(firstItem, "resume");
      assert.match(first.mediaUrl, /^jellyfin-media:\/\/stream\/[0-9a-f-]{36}$/);
      assert.equal(first.mediaUrl.includes(firstItem), false);
      assert.equal(first.mediaUrl.includes("runtime-source-id"), false);
      assert.equal(first.resumePositionTicks, 12345);

      await assert.rejects(rendererSession.fetch(first.mediaUrl, { cache: "no-store" }));
      assert.equal(streamRequests.length, 0);

      const second = await playback.start("second-secret-item", "start-over");
      assert.notEqual(second.mediaUrl, first.mediaUrl);
      assert.equal(second.resumePositionTicks, 0);
      await assert.rejects(rendererSession.fetch(first.mediaUrl, { cache: "no-store" }));
      await assert.rejects(rendererSession.fetch(second.mediaUrl, { cache: "no-store" }));

      playback.stop(second.playbackId);
      await assert.rejects(rendererSession.fetch(second.mediaUrl, { cache: "no-store" }));
    });

    mainWindow = security.createWindow({ showWhenReady: false, devTools: false });
    const playerController = {
      loadItem: (itemId, resumeMode) => playback.start(itemId, resumeMode),
      getState: () => playback.getState(),
      stop: (playbackId) => playback.stop(playbackId),
      clear: () => playback.clear(),
      setPaused: async () => { throw new Error("not used"); },
      seek: async () => { throw new Error("not used"); },
      setPlaybackRate: async () => { throw new Error("not used"); },
      setVolume: async () => { throw new Error("not used"); },
      selectAudio: async () => { throw new Error("not used"); },
      selectSubtitle: async () => { throw new Error("not used"); },
      setFullscreen: async () => { throw new Error("not used"); },
    };
    let watchPartyState = {
      availability: "available",
      connection: "connected",
      groups: [{
        groupId: "11111111111141118111111111111111",
        name: "Runtime movie night",
        playbackState: "Paused",
        participants: ["Runtime Viewer"],
        participantCount: 1,
        lastUpdatedAt: "2026-07-13T20:00:00.000Z",
      }],
      joinedGroup: null,
      sharedControls: true,
      error: null,
    };
    let watchPartyResyncCount = 0;
    const syncPlay = {
      async activate() { return watchPartyState; },
      async deactivate() {},
      isJoined() { return watchPartyState.joinedGroup !== null; },
      getState() { return structuredClone(watchPartyState); },
      async list() { return structuredClone(watchPartyState); },
      async create(name) {
        const group = { ...watchPartyState.groups[0], name };
        watchPartyState = { ...watchPartyState, groups: [group], joinedGroup: { ...group, currentItemId: null, playlistItemId: null } };
        return structuredClone(watchPartyState);
      },
      async join(groupId) {
        const group = watchPartyState.groups.find((entry) => entry.groupId === groupId);
        watchPartyState = { ...watchPartyState, joinedGroup: { ...group, currentItemId: null, playlistItemId: null } };
        return structuredClone(watchPartyState);
      },
      async leave() {
        watchPartyState = { ...watchPartyState, joinedGroup: null };
        return structuredClone(watchPartyState);
      },
      async resyncLocal() {
        watchPartyResyncCount += 1;
        return playback.getState();
      },
      async setViewVisible() { return structuredClone(watchPartyState); },
    };
    registerIpcHandlers(ipcMain, mainWindow, api, artwork, playerController, downloads, synchronization, syncPlay, downloadLocation);
    let rendererExit = null;
    let failedLoad = null;
    mainWindow.webContents.once("render-process-gone", (_event, details) => { rendererExit = details; });
    mainWindow.webContents.once("did-fail-load", (_event, code, description, url, isMainFrame) => {
      failedLoad = { code, description, url, isMainFrame };
    });
    try {
      await mainWindow.loadURL(security.APP_URL);
    } catch (error) {
      throw new Error(`${error?.message || String(error)}; rendererExit=${JSON.stringify(rendererExit)}; failedLoad=${JSON.stringify(failedLoad)}`);
    }

    await test("effective hidden BrowserWindow and exact frozen preload bridge enforce isolation", async () => {
      assert.equal(mainWindow.isVisible(), false);
      assert.equal(mainWindow.webContents.session, rendererSession);
      assert.equal(mainWindow.webContents.isDevToolsOpened(), false);

      const rendererPid = mainWindow.webContents.getOSProcessId();
      const rendererMetric = app.getAppMetrics().find((metric) => metric.pid === rendererPid);
      assert.equal(rendererMetric?.sandboxed, true, "Renderer process must be OS-sandboxed.");

      const getLastWebPreferences = mainWindow.webContents.getLastWebPreferences;
      if (typeof getLastWebPreferences === "function") {
        const preferences = getLastWebPreferences.call(mainWindow.webContents);
        assert.deepEqual(
          {
            contextIsolation: preferences.contextIsolation,
            sandbox: preferences.sandbox,
            nodeIntegration: preferences.nodeIntegration,
            nodeIntegrationInSubFrames: preferences.nodeIntegrationInSubFrames,
            webSecurity: preferences.webSecurity,
            allowRunningInsecureContent: preferences.allowRunningInsecureContent,
            webviewTag: preferences.webviewTag,
          },
          {
            contextIsolation: true,
            sandbox: true,
            nodeIntegration: false,
            nodeIntegrationInSubFrames: false,
            webSecurity: true,
            allowRunningInsecureContent: false,
            webviewTag: false,
          },
        );
      }

      const createWindowSource = Function.prototype.toString.call(security.createWindow);
      for (const explicitPreference of [
        "nodeIntegrationInWorker",
        "navigateOnDragDrop",
        "spellcheck",
      ]) {
        assert.match(
          createWindowSource,
          new RegExp(`${explicitPreference}\\s*:\\s*false`),
          `${explicitPreference} must remain explicitly disabled in the built window factory.`,
        );
      }

      mainWindow.webContents.openDevTools({ mode: "detach", activate: false });
      await delay(50);
      assert.equal(mainWindow.webContents.isDevToolsOpened(), false);

      const bridge = await mainWindow.webContents.executeJavaScript(`(() => {
        const ownKeys = (value) => Reflect.ownKeys(value)
          .map((key) => typeof key === "symbol" ? \`symbol:\${String(key.description)}\` : key)
          .sort();
        const nestedKeys = {};
        const nestedFrozen = {};
        for (const key of ownKeys(window.jellyfin)) {
          nestedKeys[key] = ownKeys(window.jellyfin[key]);
          nestedFrozen[key] = Object.isFrozen(window.jellyfin[key]);
        }
        window.jellyfin.unexpected = true;
        window.jellyfin.server.unexpected = true;
        const webview = document.createElement("webview");
        return {
          topKeys: ownKeys(window.jellyfin),
          nestedKeys,
          topFrozen: Object.isFrozen(window.jellyfin),
          nestedFrozen,
          unexpectedTop: "unexpected" in window.jellyfin,
          unexpectedServer: "unexpected" in window.jellyfin.server,
          nodeGlobals: {
            require: typeof globalThis.require,
            process: typeof globalThis.process,
            module: typeof globalThis.module,
            Buffer: typeof globalThis.Buffer,
            ipcRenderer: typeof globalThis.ipcRenderer,
            electron: typeof globalThis.electron,
          },
          genericInvoke: "invoke" in window.jellyfin,
          webviewLoadUrl: typeof webview.loadURL,
        };
      })()`);

      const expectedNestedKeys = {
        server: ["connect", "discover"],
        session: ["getState", "login", "logout", "restore"],
        home: ["get"],
        libraries: ["getItems", "list"],
        search: ["query"],
        items: ["getDetails", "openTrailer", "setWatched"],
        shows: ["getEpisodes", "getSeasons"],
        artwork: ["getUrl"],
        mediaSources: ["getCapabilities"],
        downloads: ["cancel", "chooseLocation", "delete", "getLocation", "list", "openLocation", "pause", "resume", "retry", "setKeep", "start", "subscribe", "useDefaultLocation"],
        playback: ["getAdapterPreference", "getState", "seek", "selectAudio", "selectSubtitle", "setAdapterPreference", "setFullscreen", "setPaused", "setRate", "setViewport", "setVolume", "start", "stop", "subscribe"],
        watchParties: ["create", "getState", "join", "leave", "list", "resync", "setVisible", "subscribe"],
      };
      assert.deepEqual(bridge.topKeys, Object.keys(expectedNestedKeys).sort());
      assert.deepEqual(bridge.nestedKeys, expectedNestedKeys);
      assert.equal(bridge.topFrozen, true);
      assert.ok(Object.values(bridge.nestedFrozen).every(Boolean));
      assert.equal(bridge.unexpectedTop, false);
      assert.equal(bridge.unexpectedServer, false);
      assert.deepEqual(bridge.nodeGlobals, {
        require: "undefined",
        process: "undefined",
        module: "undefined",
        Buffer: "undefined",
        ipcRenderer: "undefined",
        electron: "undefined",
      });
      assert.equal(bridge.genericInvoke, false);
      assert.equal(bridge.webviewLoadUrl, "undefined");
    });

    await test("download settings use narrow native actions without exposing a path", async () => {
      const result = await mainWindow.webContents.executeJavaScript(`(async () => {
        const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
        document.getElementById("downloadsButton").click();
        for (let attempt = 0; attempt < 100; attempt += 1) {
          if (document.getElementById("downloadLocationLabel").textContent === "Windows Videos folder") break;
          await delay(20);
        }
        document.getElementById("chooseDownloadLocationButton").click();
        for (let attempt = 0; attempt < 100; attempt += 1) {
          if (document.getElementById("downloadLocationLabel").textContent === "Custom folder on D:") break;
          await delay(20);
        }
        const custom = {
          label: document.getElementById("downloadLocationLabel").textContent,
          defaultVisible: !document.getElementById("defaultDownloadLocationButton").classList.contains("is-hidden"),
          panelText: document.getElementById("downloadsPanel").textContent,
        };
        document.getElementById("openDownloadLocationButton").click();
        document.getElementById("defaultDownloadLocationButton").click();
        for (let attempt = 0; attempt < 100; attempt += 1) {
          if (document.getElementById("downloadLocationLabel").textContent === "Windows Videos folder") break;
          await delay(20);
        }
        return {
          custom,
          resetLabel: document.getElementById("downloadLocationLabel").textContent,
          defaultHidden: document.getElementById("defaultDownloadLocationButton").classList.contains("is-hidden"),
        };
      })()`);
      assert.equal(result.custom.label, "Custom folder on D:");
      assert.equal(result.custom.defaultVisible, true);
      assert.doesNotMatch(result.custom.panelText, /D:\\\\|Sensitive|localPath|storageRoot/);
      assert.equal(result.resetLabel, "Windows Videos folder");
      assert.equal(result.defaultHidden, true);
      assert.equal(chooseDownloadLocationCount, 1);
      assert.equal(openDownloadLocationCount, 1);
      assert.equal(defaultDownloadLocationCount, 1);
    });

    await test("watch-party UI lists, joins, leaves, and creates through the narrow bridge", async () => {
      const result = await mainWindow.webContents.executeJavaScript(`(async () => {
        const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
        const waitFor = async (predicate) => {
          for (let attempt = 0; attempt < 150; attempt += 1) {
            if (predicate()) return;
            await delay(20);
          }
          throw new Error("Timed out waiting for watch-party UI state.");
        };

        document.getElementById("navWatchPartiesButton").click();
        await waitFor(() => document.querySelector(".watch-party-card h2")?.textContent === "Runtime movie night");
        const listed = {
          title: document.querySelector("#watchPartiesView h1")?.textContent,
          copy: document.querySelector("#watchPartiesView .page-heading > p:last-of-type")?.textContent,
          group: document.querySelector(".watch-party-card h2")?.textContent,
          status: document.getElementById("watchPartyStatus").textContent,
        };

        document.querySelector(".watch-party-card button").click();
        await waitFor(() => !document.getElementById("joinedWatchParty").classList.contains("is-hidden"));
        const joined = {
          name: document.querySelector("#joinedWatchParty strong")?.textContent,
          participants: document.querySelectorAll("#joinedWatchParty p")[1]?.textContent,
          shared: document.querySelector("#joinedWatchParty .shared-control-note")?.textContent,
        };

        document.querySelector('[data-watch-party-action="resync"]').click();
        await waitFor(() => document.getElementById("toast").textContent === "This computer was resynced to the party.");
        const resyncToast = document.getElementById("toast").textContent;

        document.querySelector('[data-watch-party-action="leave"]').click();
        await waitFor(() => document.getElementById("joinedWatchParty").classList.contains("is-hidden"));
        const independentToast = document.getElementById("toast").textContent;

        const nameInput = document.getElementById("watchPartyNameInput");
        nameInput.value = "Runtime created party";
        document.getElementById("createWatchPartyButton").click();
        await waitFor(() => document.querySelector("#joinedWatchParty strong")?.textContent === "Runtime created party");
        const createdName = document.querySelector("#joinedWatchParty strong")?.textContent;

        document.querySelector('[data-watch-party-action="leave"]').click();
        await waitFor(() => document.getElementById("joinedWatchParty").classList.contains("is-hidden"));
        document.getElementById("navHomeButton").click();
        return { listed, joined, resyncToast, independentToast, createdName };
      })()`);

      assert.deepEqual(result.listed, {
        title: "Active Watch Parties",
        copy: "Everyone in a party shares playback controls. Each computer still chooses its own local download or Jellyfin stream.",
        group: "Runtime movie night",
        status: "Parties are visible only to signed-in users on this Jellyfin server.",
      });
      assert.equal(result.resyncToast, "This computer was resynced to the party.");
      assert.equal(watchPartyResyncCount, 1);
      assert.deepEqual(result.joined, {
        name: "Runtime movie night",
        participants: "Watching with: Runtime Viewer",
        shared: "Shared controls: anyone can choose an item, play, pause, or seek.",
      });
      assert.equal(result.independentToast, "Left the party. Playback controls are independent again.");
      assert.equal(result.createdName, "Runtime created party");
    });

    await test("joined watch party visibly identifies this computer's local or Jellyfin delivery", async () => {
      await mainWindow.webContents.executeJavaScript(`(async () => {
        const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
        document.getElementById("navWatchPartiesButton").click();
        for (let attempt = 0; attempt < 100; attempt += 1) {
          if (document.querySelector(".watch-party-card button")) break;
          await delay(20);
        }
        document.querySelector(".watch-party-card button")?.click();
        for (let attempt = 0; attempt < 100; attempt += 1) {
          if (!document.getElementById("joinedWatchParty").classList.contains("is-hidden")) break;
          await delay(20);
        }
      })()`);

      const baseState = {
        playbackId: "77777777-7777-4777-8777-777777777777",
        itemId: runtimeItem.id,
        phase: "playing",
        positionTicks: 10_000_000,
        durationTicks: runtimeItem.runTimeTicks,
        paused: false,
        buffering: false,
        seekable: true,
        fullscreen: false,
        audioTracks: [],
        subtitleTracks: [],
        error: null,
      };
      mainWindow.webContents.send(IPC.playbackStateChanged, { ...baseState, source: "local" });
      const local = await mainWindow.webContents.executeJavaScript(`(async () => {
        const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
        for (let attempt = 0; attempt < 100; attempt += 1) {
          const text = document.querySelector(".watch-party-delivery-note")?.textContent;
          if (text === "This computer: Local download") return text;
          await delay(20);
        }
        return document.querySelector(".watch-party-delivery-note")?.textContent;
      })()`);
      assert.equal(local, "This computer: Local download");

      mainWindow.webContents.send(IPC.playbackStateChanged, { ...baseState, source: "server" });
      const server = await mainWindow.webContents.executeJavaScript(`(async () => {
        const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
        for (let attempt = 0; attempt < 100; attempt += 1) {
          const text = document.querySelector(".watch-party-delivery-note")?.textContent;
          if (text === "This computer: Jellyfin stream") return text;
          await delay(20);
        }
        return document.querySelector(".watch-party-delivery-note")?.textContent;
      })()`);
      assert.equal(server, "This computer: Jellyfin stream");

      await mainWindow.webContents.executeJavaScript(`document.querySelector('[data-watch-party-action="leave"]')?.click()`);
    });

    await test("movie details toggle explicit watched state through only the narrow item action", async () => {
      const result = await mainWindow.webContents.executeJavaScript(`(async () => {
        const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
        for (let attempt = 0; attempt < 100; attempt += 1) {
          if (document.querySelector('[data-media-item="runtime-movie-id"]')) break;
          await delay(20);
        }
        document.querySelector('[data-media-item="runtime-movie-id"]')?.click();
        for (let attempt = 0; attempt < 100; attempt += 1) {
          if (document.getElementById("detailTitle").textContent === "Runtime movie") break;
          await delay(20);
        }
        const button = document.getElementById("detailWatchedButton");
        const initial = button.textContent.trim();
        button.click();
        for (let attempt = 0; attempt < 100; attempt += 1) {
          if (button.textContent.includes("Mark Unwatched") && !button.disabled) break;
          await delay(20);
        }
        const afterWatched = button.textContent.trim();
        button.click();
        for (let attempt = 0; attempt < 100; attempt += 1) {
          if (button.textContent.includes("Mark Watched") && !button.disabled) break;
          await delay(20);
        }
        const afterUnwatched = button.textContent.trim();
        document.getElementById("detailsBackButton").click();
        return {
          initial,
          afterWatched,
          afterUnwatched,
          hidden: button.classList.contains("is-hidden"),
        };
      })()`);
      assert.equal(result.initial, "Mark Watched");
      assert.equal(result.afterWatched, "Mark Unwatched");
      assert.equal(result.afterUnwatched, "Mark Watched");
      assert.equal(result.hidden, false);
      assert.deepEqual(watchedActions, [
        { itemId: runtimeItem.id, watched: true },
        { itemId: runtimeItem.id, watched: false },
      ]);
    });

    await test("episode details open the parent series at the episode season", async () => {
      const result = await mainWindow.webContents.executeJavaScript(`(async () => {
        const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
        for (let attempt = 0; attempt < 100; attempt += 1) {
          if (document.querySelector('[data-media-item="runtime-episode-id"]')) break;
          await delay(20);
        }
        document.querySelector('[data-media-item="runtime-episode-id"]')?.click();
        for (let attempt = 0; attempt < 100; attempt += 1) {
          if (document.getElementById("detailTitle").textContent === "Runtime episode") break;
          await delay(20);
        }
        const seriesButton = document.getElementById("detailSeriesButton");
        const buttonVisible = !seriesButton.classList.contains("is-hidden") && !seriesButton.disabled;
        const buttonLabel = seriesButton.textContent.trim();
        seriesButton.click();
        for (let attempt = 0; attempt < 150; attempt += 1) {
          const titleReady = document.getElementById("detailTitle").textContent === "Runtime series";
          const episodesReady = !document.getElementById("episodeSection").classList.contains("is-hidden");
          const seasonReady = document.getElementById("seasonSelect").value === "runtime-season-two-id";
          if (titleReady && episodesReady && seasonReady) break;
          await delay(20);
        }
        const value = {
          buttonVisible,
          buttonLabel,
          title: document.getElementById("detailTitle").textContent,
          episodeSectionVisible: !document.getElementById("episodeSection").classList.contains("is-hidden"),
          seasonId: document.getElementById("seasonSelect").value,
          optionBackground: getComputedStyle(document.getElementById("seasonSelect").options[1]).backgroundColor,
          optionColor: getComputedStyle(document.getElementById("seasonSelect").options[1]).color,
          seriesButtonHidden: document.getElementById("detailSeriesButton").classList.contains("is-hidden"),
        };
        document.getElementById("detailsBackButton").click();
        return value;
      })()`);

      assert.equal(result.buttonVisible, true);
      assert.equal(result.buttonLabel, "View Series");
      assert.equal(result.title, runtimeSeries.name);
      assert.equal(result.episodeSectionVisible, true);
      assert.equal(result.seasonId, runtimeSeasonTwo.id);
      assert.equal(result.optionBackground, "rgb(27, 27, 31)");
      assert.equal(result.optionColor, "rgb(247, 247, 248)");
      assert.equal(result.seriesButtonHidden, true);
      assert.deepEqual(detailRequests.slice(-2), [runtimeEpisode.id, runtimeSeries.id]);
      assert.equal(seasonRequests.at(-1), runtimeSeries.id);
      assert.deepEqual(episodeRequests.at(-1), { seriesId: runtimeSeries.id, seasonId: runtimeSeasonTwo.id });

      seriesDetailsDelayMs = 150;
      const cancelled = await mainWindow.webContents.executeJavaScript(`(async () => {
        const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
        document.querySelector('[data-media-item="runtime-episode-id"]')?.click();
        for (let attempt = 0; attempt < 100; attempt += 1) {
          if (document.getElementById("detailTitle").textContent === "Runtime episode"
            && !document.getElementById("detailSeriesButton").disabled) break;
          await delay(20);
        }
        document.getElementById("detailSeriesButton").click();
        document.getElementById("detailsBackButton").click();
        await delay(250);
        return {
          homeVisible: !document.getElementById("homeView").classList.contains("is-hidden"),
          detailsHidden: document.getElementById("detailsView").classList.contains("is-hidden"),
        };
      })()`);
      seriesDetailsDelayMs = 0;
      assert.equal(cancelled.homeVisible, true);
      assert.equal(cancelled.detailsHidden, true);
    });

    await test("season view selects and queues multiple episode downloads", async () => {
      const startsBefore = downloadStartCount;
      const result = await mainWindow.webContents.executeJavaScript(`(async () => {
        const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
        document.querySelector('[data-media-item="runtime-episode-id"]')?.click();
        for (let attempt = 0; attempt < 100; attempt += 1) {
          if (document.getElementById("detailTitle").textContent === "Runtime episode") break;
          await delay(20);
        }
        document.getElementById("detailSeriesButton").click();
        for (let attempt = 0; attempt < 150; attempt += 1) {
          if (document.getElementById("detailTitle").textContent === "Runtime series"
            && document.getElementById("seasonSelect").value === "runtime-season-two-id"
            && document.querySelectorAll(".episode-row").length === 2
            && !document.getElementById("selectSeasonEpisodes").disabled) break;
          await delay(20);
        }
        const selectAll = document.getElementById("selectSeasonEpisodes");
        selectAll.checked = true;
        selectAll.dispatchEvent(new Event("change", { bubbles: true }));
        const batch = document.getElementById("downloadSelectedEpisodes");
        const selectedLabel = batch.textContent.trim();
        batch.click();
        for (let attempt = 0; attempt < 150; attempt += 1) {
          if (!document.getElementById("downloadsPanel").classList.contains("is-hidden")
            && batch.textContent.trim() === "Download selected") break;
          await delay(20);
        }
        const value = {
          episodeRows: document.querySelectorAll(".episode-row").length,
          episodeSelectors: document.querySelectorAll("[data-episode-select]").length,
          selectedLabel,
          panelVisible: !document.getElementById("downloadsPanel").classList.contains("is-hidden"),
          batchDisabled: batch.disabled,
        };
        document.getElementById("closeDownloadsButton").click();
        document.getElementById("detailsBackButton").click();
        return value;
      })()`);

      assert.equal(result.episodeRows, 2);
      assert.equal(result.episodeSelectors, 2);
      assert.equal(result.selectedLabel, "Download selected (2)");
      assert.equal(result.panelVisible, true);
      assert.equal(result.batchDisabled, true);
      assert.equal(downloadStartCount, startsBefore + 2);
      assert.deepEqual(downloadStartItems.slice(-2), [runtimeEpisode.id, runtimeEpisodeTwo.id]);
    });

    await test("library filtering and sorting operate on the loaded Jellyfin library", async () => {
      const result = await mainWindow.webContents.executeJavaScript(`(async () => {
        const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
        const titles = () => [...document.querySelectorAll("#libraryGrid .media-card strong")]
          .map((entry) => entry.textContent.trim());
        document.getElementById("navMoviesButton").click();
        for (let attempt = 0; attempt < 100; attempt += 1) {
          if (document.querySelectorAll("#libraryGrid .media-card").length === 3) break;
          await delay(20);
        }
        const filter = document.getElementById("libraryFilter");
        const sort = document.getElementById("librarySort");
        sort.value = "title-descending";
        sort.dispatchEvent(new Event("change", { bubbles: true }));
        const descending = titles();
        filter.value = "unwatched";
        filter.dispatchEvent(new Event("change", { bubbles: true }));
        const unwatched = titles();
        filter.value = "watched";
        filter.dispatchEvent(new Event("change", { bubbles: true }));
        const watched = titles();
        filter.value = "downloaded";
        filter.dispatchEvent(new Event("change", { bubbles: true }));
        const downloaded = titles();
        filter.value = "all";
        filter.dispatchEvent(new Event("change", { bubbles: true }));
        return { descending, unwatched, watched, downloaded };
      })()`);

      assert.deepEqual(result.descending, ["Zulu movie", "Runtime movie", "Alpha movie"]);
      assert.deepEqual(result.unwatched, ["Zulu movie", "Runtime movie"]);
      assert.deepEqual(result.watched, ["Alpha movie"]);
      assert.deepEqual(result.downloaded, ["Runtime movie"]);
    });

    await test("Home, library, and search cards expose narrow quick Play without replacing details navigation", async () => {
      const result = await mainWindow.webContents.executeJavaScript(`(async () => {
        const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
        const card = document.querySelector('#libraryGrid [data-media-item="runtime-zulu-movie-id"]');
        const libraryQuickPlay = document.querySelector('#libraryGrid [data-quick-play-item="runtime-zulu-movie-id"]');
        const homeQuickPlay = document.querySelector('#homeRows [data-quick-play-item="runtime-movie-id"]');
        const search = document.getElementById("searchInput");
        search.value = "Zulu";
        search.dispatchEvent(new Event("input", { bubbles: true }));
        for (let attempt = 0; attempt < 100; attempt += 1) {
          if (document.querySelector('#searchRows [data-quick-play-item="runtime-zulu-movie-id"]')) break;
          await delay(20);
        }
        const searchQuickPlay = document.querySelector('#searchRows [data-quick-play-item="runtime-zulu-movie-id"]');
        searchQuickPlay?.click();
        let livePlayback = null;
        for (let attempt = 0; attempt < 100; attempt += 1) {
          livePlayback = await window.jellyfin.playback.getState();
          if (livePlayback.itemId === "runtime-zulu-movie-id") break;
          await delay(20);
        }
        return {
          detailsCardPresent: Boolean(card),
          homeQuickPlayPresent: Boolean(homeQuickPlay),
          libraryQuickPlayPresent: Boolean(libraryQuickPlay),
          searchQuickPlayPresent: Boolean(searchQuickPlay),
          quickPlayLabel: searchQuickPlay?.getAttribute("aria-label"),
          playerTitle: document.getElementById("playerTitle").textContent,
          playbackItemId: livePlayback?.itemId ?? null,
        };
      })()`);

      assert.equal(result.detailsCardPresent, true);
      assert.equal(result.homeQuickPlayPresent, true);
      assert.equal(result.libraryQuickPlayPresent, true);
      assert.equal(result.searchQuickPlayPresent, true);
      assert.equal(result.quickPlayLabel, "Play Zulu movie");
      assert.equal(result.playerTitle, "Zulu movie");
      assert.equal(result.playbackItemId, runtimeOtherMovie.id);
      const playbackState = playback.getState();
      assert.equal(playbackState.itemId, runtimeOtherMovie.id);
      playback.stop(playbackState.playbackId);
    });

    await test("downloaded media exposes Play and invokes only the narrow playback action", async () => {
      const result = await mainWindow.webContents.executeJavaScript(`(async () => {
        const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
        for (let attempt = 0; attempt < 100; attempt += 1) {
          if (document.querySelector(".download-card")) break;
          await delay(20);
        }
        document.getElementById("downloadsButton").click();
        const card = [...document.querySelectorAll(".download-card")]
          .find((entry) => entry.querySelector("strong")?.textContent === "Runtime offline episode");
        const buttons = [...(card?.querySelectorAll("button") ?? [])];
        const play = buttons.find((button) => button.textContent === "Play");
        play?.click();
        let livePlayback = null;
        for (let attempt = 0; attempt < 100; attempt += 1) {
          livePlayback = await window.jellyfin.playback.getState();
          if (livePlayback.itemId === "runtime-offline-episode-id") break;
          await delay(20);
        }
        return {
          foundCard: Boolean(card),
          buttonLabels: buttons.map((button) => button.textContent),
          playerTitle: document.getElementById("playerTitle").textContent,
          playerMeta: document.getElementById("playerMeta").textContent,
          sourceBadge: document.getElementById("playerSourceBadge").textContent,
          playbackItemId: livePlayback?.itemId ?? null,
        };
      })()`);
      assert.equal(result.foundCard, true);
      assert.deepEqual(result.buttonLabels, ["Play", "Delete copy"]);
      assert.equal(result.playerTitle, downloadedItem.name);
      assert.equal(result.playerMeta, "Episode - Downloaded");
      assert.equal(result.sourceBadge, "Jellyfin");
      assert.equal(result.playbackItemId, downloadedItem.itemId);
      const playbackState = playback.getState();
      assert.equal(playbackState.itemId, downloadedItem.itemId);
      assert.equal(playbackState.source, "server");
      playback.stop(playbackState.playbackId);
    });

    await test("rendered media cards use fixed cover geometry", async () => {
      const result = await mainWindow.webContents.executeJavaScript(`(() => {
        const posterRail = document.createElement("div");
        const card = document.createElement("button");
        const art = document.createElement("span");
        const poster = document.createElement("img");
        const landscapeRail = document.createElement("div");
        const landscapeCard = document.createElement("button");
        const landscapeArt = document.createElement("span");
        const landscapeImage = document.createElement("img");
        const episode = document.createElement("span");
        const episodeImage = document.createElement("img");
        posterRail.className = "media-rail poster";
        card.className = "media-card poster";
        art.className = "media-art";
        landscapeRail.className = "media-rail landscape";
        landscapeCard.className = "media-card landscape";
        landscapeArt.className = "media-art";
        episode.className = "episode-thumb";
        art.append(poster);
        landscapeArt.append(landscapeImage);
        landscapeCard.append(landscapeArt);
        landscapeRail.append(landscapeCard);
        episode.append(episodeImage);
        card.append(art);
        posterRail.append(card);
        document.body.append(posterRail, landscapeRail, episode);
        const posterRectangle = art.getBoundingClientRect();
        const landscapeRectangle = landscapeArt.getBoundingClientRect();
        const value = {
          posterTrack: getComputedStyle(posterRail).gridAutoColumns,
          posterCardWidth: card.getBoundingClientRect().width,
          posterWidth: posterRectangle.width,
          posterHeight: posterRectangle.height,
          posterFit: getComputedStyle(poster).objectFit,
          posterPosition: getComputedStyle(poster).objectPosition,
          landscapeTrack: getComputedStyle(landscapeRail).gridAutoColumns,
          landscapeCardWidth: landscapeCard.getBoundingClientRect().width,
          landscapeWidth: landscapeRectangle.width,
          landscapeHeight: landscapeRectangle.height,
          landscapeFit: getComputedStyle(landscapeImage).objectFit,
          landscapePosition: getComputedStyle(landscapeImage).objectPosition,
          episodeFit: getComputedStyle(episodeImage).objectFit,
        };
        posterRail.remove();
        landscapeRail.remove();
        episode.remove();
        return value;
      })()`);
      assert.equal(result.posterTrack, "174px");
      assert.ok(Math.abs(result.posterCardWidth - 174) < 1);
      assert.ok(Math.abs(result.posterWidth - 174) < 1, JSON.stringify(result));
      assert.ok(Math.abs(result.posterHeight - 261) < 1);
      assert.equal(result.posterFit, "cover");
      assert.equal(result.posterPosition, "50% 50%");
      assert.equal(result.landscapeTrack, "310px");
      assert.ok(Math.abs(result.landscapeCardWidth - 310) < 1);
      assert.ok(Math.abs(result.landscapeWidth - 310) < 1, JSON.stringify(result));
      assert.ok(Math.abs(result.landscapeHeight - 174.375) < 1);
      assert.equal(result.landscapeFit, "cover");
      assert.equal(result.landscapePosition, "50% 50%");
      assert.equal(result.episodeFit, "contain");
    });

    await test("server-unavailable Home exposes a retry that restores the protected session", async () => {
      const homeCallsBefore = homeGetCount;
      homeUnavailable = true;
      const failed = await mainWindow.webContents.executeJavaScript(`(async () => {
        const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
        document.getElementById("closeDownloadsButton").click();
        document.getElementById("refreshButton").click();
        for (let attempt = 0; attempt < 150; attempt += 1) {
          if (document.querySelector("[data-retry-connection]")) break;
          await delay(20);
        }
        const retry = document.querySelector("[data-retry-connection]");
        const offlineCard = document.querySelector('[aria-label="Play offline: Runtime offline episode"]');
        return {
          retryVisible: Boolean(retry) && !retry.disabled,
          retryLabel: retry?.textContent.trim(),
          heading: document.querySelector(".connection-failure h2")?.textContent,
          loginHidden: document.getElementById("loginView").classList.contains("is-hidden"),
          mainVisible: !document.getElementById("mainView").classList.contains("is-hidden"),
          homeVisible: !document.getElementById("homeView").classList.contains("is-hidden"),
          offlineCardVisible: Boolean(offlineCard),
          offlineRowTitle: [...document.querySelectorAll("#homeRows .row-heading h2")]
            .map((heading) => heading.textContent.trim()).find((title) => title === "Downloaded Media"),
          downloadsPanelHidden: document.getElementById("downloadsPanel").classList.contains("is-hidden"),
        };
      })()`);

      assert.equal(failed.retryVisible, true);
      assert.equal(failed.retryLabel, "Retry Connection");
      assert.equal(failed.heading, "Could not reach Jellyfin");
      assert.equal(failed.loginHidden, true);
      assert.equal(failed.mainVisible, true);
      assert.equal(failed.homeVisible, true);
      assert.equal(failed.offlineCardVisible, true);
      assert.equal(failed.offlineRowTitle, "Downloaded Media");
      assert.equal(failed.downloadsPanelHidden, true);
      assert.equal(logoutCount, 0);

      homeUnavailable = false;
      const recovered = await mainWindow.webContents.executeJavaScript(`(async () => {
        const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
        document.querySelector("[data-retry-connection]")?.click();
        for (let attempt = 0; attempt < 150; attempt += 1) {
          if (document.querySelector('#homeRows [data-media-item="runtime-movie-id"]')
            && !document.querySelector("[data-retry-connection]")
            && document.getElementById("featureTitle").textContent === "Runtime movie") break;
          await delay(20);
        }
        return {
          homeCardRestored: Boolean(document.querySelector('#homeRows [data-media-item="runtime-movie-id"]')),
          failureRemoved: !document.querySelector("[data-retry-connection]"),
          featureTitle: document.getElementById("featureTitle").textContent,
        };
      })()`);

      assert.equal(recovered.homeCardRestored, true);
      assert.equal(recovered.failureRemoved, true);
      assert.equal(recovered.featureTitle, runtimeItem.name);
      assert.equal(homeGetCount, homeCallsBefore + 2);
      assert.equal(logoutCount, 0);
    });

    await test("renderer preserves safe reauthentication context and scrubs expired-account UI", async () => {
      expireHome = true;
      const result = await mainWindow.webContents.executeJavaScript(`(async () => {
        const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
        for (let attempt = 0; attempt < 100; attempt += 1) {
          if (!document.getElementById("mainView").classList.contains("is-hidden")) break;
          await delay(20);
        }

        const privatePixel = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==";
        for (const id of ["featureImage", "detailBackdrop", "detailPoster"]) {
          const image = document.getElementById(id);
          image.src = privatePixel;
          image.classList.remove("is-hidden");
        }
        document.getElementById("homeRows").innerHTML = "<p>prior home</p>";
        document.getElementById("libraryGrid").innerHTML = "<p>prior library</p>";
        document.getElementById("searchRows").innerHTML = "<p>prior search</p>";
        document.getElementById("episodeList").innerHTML = "<li>prior episode</li>";
        document.getElementById("detailTitle").textContent = "Prior account title";

        const serverBeforeExpiry = document.getElementById("serverUrlInput").value;
        document.getElementById("refreshButton").click();
        for (let attempt = 0; attempt < 200; attempt += 1) {
          if (!document.getElementById("loginView").classList.contains("is-hidden")) break;
          await delay(20);
        }

        return {
          serverBeforeExpiry,
          loginVisible: !document.getElementById("loginView").classList.contains("is-hidden"),
          mainHidden: document.getElementById("mainView").classList.contains("is-hidden"),
          loginMessage: document.getElementById("loginMessage").textContent,
          featureHasSource: document.getElementById("featureImage").hasAttribute("src"),
          backdropHasSource: document.getElementById("detailBackdrop").hasAttribute("src"),
          posterHasSource: document.getElementById("detailPoster").hasAttribute("src"),
          homeChildren: document.getElementById("homeRows").childElementCount,
          libraryChildren: document.getElementById("libraryGrid").childElementCount,
          searchChildren: document.getElementById("searchRows").childElementCount,
          episodeChildren: document.getElementById("episodeList").childElementCount,
          detailTitle: document.getElementById("detailTitle").textContent,
          userLabel: document.getElementById("userLabel").textContent,
          serverLabel: document.getElementById("serverLabel").textContent,
          homeVisible: !document.getElementById("homeView").classList.contains("is-hidden"),
          detailsHidden: document.getElementById("detailsView").classList.contains("is-hidden"),
        };
      })()`);
      expireHome = false;

      assert.equal(result.serverBeforeExpiry, safeSession.server.address);
      assert.equal(result.loginVisible, true);
      assert.equal(result.mainHidden, true);
      assert.equal(result.loginMessage, "Your Jellyfin session expired. Sign in again.");
      assert.equal(result.featureHasSource, false);
      assert.equal(result.backdropHasSource, false);
      assert.equal(result.posterHasSource, false);
      assert.equal(result.homeChildren, 0);
      assert.equal(result.libraryChildren, 0);
      assert.equal(result.searchChildren, 0);
      assert.equal(result.episodeChildren, 0);
      assert.equal(result.detailTitle, "");
      assert.equal(result.userLabel, "");
      assert.equal(result.serverLabel, "");
      assert.equal(result.homeVisible, true);
      assert.equal(result.detailsHidden, true);
    });

    await test("renderer HTTP, popup, and permission requests are denied", async () => {
      let receivedRequests = 0;
      localServer = createServer((_request, response) => {
        receivedRequests += 1;
        response.writeHead(204);
        response.end();
      });
      await listen(localServer);
      const address = localServer.address();
      assert.ok(address && typeof address === "object");
      const blockedUrl = `http://127.0.0.1:${address.port}/must-not-arrive`;

      const sessionFetch = await rendererSession.fetch(blockedUrl).then(
        () => "allowed",
        () => "blocked",
      );
      assert.equal(sessionFetch, "blocked");

      const rendererFetch = await mainWindow.webContents.executeJavaScript(`fetch(${JSON.stringify(blockedUrl)}).then(
        () => "allowed",
        () => "blocked",
      )`);
      assert.equal(rendererFetch, "blocked");
      await delay(50);
      assert.equal(receivedRequests, 0);

      const windowsBefore = BrowserWindow.getAllWindows().length;
      const popupResult = await mainWindow.webContents.executeJavaScript(`(() => {
        const opened = window.open("app://bundle/index.html", "runtime-popup");
        return opened === null ? "denied" : "returned-window";
      })()`);
      await delay(50);
      assert.equal(popupResult, "denied");
      assert.equal(BrowserWindow.getAllWindows().length, windowsBefore);

      const permissions = await mainWindow.webContents.executeJavaScript(`Promise.all([
        navigator.permissions.query({ name: "geolocation" }).then((status) => status.state),
        Promise.race([
          navigator.mediaDevices.getUserMedia({ audio: true }).then(
            () => "allowed",
            (error) => error.name,
          ),
          new Promise((resolve) => setTimeout(() => resolve("timeout"), 3000)),
        ]),
      ])`);
      assert.equal(permissions[0], "denied");
      assert.equal(permissions[1], "NotAllowedError");

      await closeServer(localServer);
      localServer = null;
    });

    await test("real IPC accepts the authorized main frame and rejects extra fields", async () => {
      const connected = await mainWindow.webContents.executeJavaScript(`window.jellyfin.server.connect({
        url: "https://ipc-runtime.invalid"
      })`);
      assert.deepEqual(connected, {
        address: "https://ipc-runtime.invalid",
        id: "runtime-server-id",
        name: "Runtime server",
        version: "10.11.11",
        connectionId: "24a625db-2973-49a1-bdb6-aae91ff9872c",
      });
      assert.equal(connectionCount, 1);

      const rejected = await mainWindow.webContents.executeJavaScript(`window.jellyfin.server.connect({
        url: "https://ipc-runtime.invalid",
        headers: { Authorization: "must-not-cross" }
      }).then(
        () => ({ accepted: true }),
        (error) => ({ accepted: false, code: error.code, message: error.message, retryable: error.retryable }),
      )`);
      assert.equal(rejected.accepted, false);
      assert.equal(rejected.code, "INVALID_INPUT");
      assert.equal(rejected.retryable, false);
      assert.equal(connectionCount, 1);
      assert.doesNotMatch(rejected.message, /Authorization|must-not-cross/);

      const startsBeforeRejectedDownload = downloadStartCount;
      const rejectedDownload = await mainWindow.webContents.executeJavaScript(`window.jellyfin.downloads.start({
        itemId: "movie-1",
        mediaSourceId: "private-source",
        url: "https://ipc-runtime.invalid/video?api_key=must-not-cross",
        path: "D:\\\\Sensitive\\\\movie.mkv"
      }).then(
        () => ({ accepted: true }),
        (error) => ({ accepted: false, code: error.code, message: error.message, retryable: error.retryable }),
      )`);
      assert.equal(rejectedDownload.accepted, false);
      assert.equal(rejectedDownload.code, "INVALID_INPUT");
      assert.equal(rejectedDownload.retryable, false);
      assert.equal(downloadStartCount, startsBeforeRejectedDownload);
      assert.doesNotMatch(rejectedDownload.message, /private-source|ipc-runtime|Sensitive|must-not-cross/);
    });

    await test("real IPC rejects a foreign window even at the trusted app origin", async () => {
      foreignWindow = security.createWindow({ showWhenReady: false, devTools: false });
      await foreignWindow.loadURL(security.APP_URL);
      const result = await foreignWindow.webContents.executeJavaScript(`window.jellyfin.session.getState().then(
        () => ({ accepted: true }),
        (error) => ({ accepted: false, code: error.code, message: error.message, retryable: error.retryable }),
      )`);
      assert.equal(result.accepted, false);
      assert.equal(result.code, "UNAUTHORIZED_IPC");
      assert.equal(result.retryable, false);
      assert.equal(result.message, "This request is not authorized.");
    });
  } catch (error) {
    failures += 1;
    process.stdout.write(`# runtime harness setup failed\n`);
    process.stdout.write(`#${indent(error?.stack || String(error))}\n`);
  } finally {
    if (localServer) await closeServer(localServer).catch(() => undefined);
    if (foreignWindow && !foreignWindow.isDestroyed()) foreignWindow.destroy();
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

  if (testNumber !== EXPECTED_TESTS) {
    failures += 1;
    process.stdout.write(`# incomplete: ran ${testNumber} of ${EXPECTED_TESTS} required tests\n`);
  }
  process.stdout.write(`1..${EXPECTED_TESTS}\n`);
  process.stdout.write(`# ${passed} passed, ${failures} failed\n`);
  app.exit(failures === 0 ? 0 : 1);
}

function listen(server) {
  return new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolvePromise();
    });
  });
}

function closeServer(server) {
  return new Promise((resolvePromise, reject) => {
    server.close((error) => error ? reject(error) : resolvePromise());
  });
}

function delay(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function indent(value) {
  return String(value).split(/\r?\n/).map((line) => `  ${line}`).join("\n");
}
