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
const EXPECTED_TESTS = 9;

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
    let expireHome = false;
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
      async getHome() {
        if (expireHome) throw new AppError("SESSION_EXPIRED", "Your Jellyfin session has expired.", 401);
        return { libraries: [], resumeItems: [], nextUpItems: [], latestRows: [] };
      },
      async logout() {
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
            container: "mkv",
            size: 4,
            supportsDirectPlay: true,
            supportsDirectStream: true,
            supportsTranscoding: false,
          }],
        };
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

    rendererSession.protocol.handle("app", security.serveRendererAsset);
    rendererSession.protocol.handle("jellyfin-artwork", async (request) => {
      try { return await artwork.handle(request); } catch { return new Response(null, { status: 502 }); }
    });
    rendererSession.protocol.handle("jellyfin-media", async (request) => {
      try { return await playback.handle(request); } catch { return new Response(null, { status: 502 }); }
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

    await test("playback protocol authorizes exactly one opaque active session URL", async () => {
      const firstItem = "first-secret-item";
      const first = await playback.start(firstItem, "resume");
      assert.match(first.mediaUrl, /^jellyfin-media:\/\/stream\/[0-9a-f-]{36}$/);
      assert.equal(first.mediaUrl.includes(firstItem), false);
      assert.equal(first.mediaUrl.includes("runtime-source-id"), false);
      assert.equal(first.resumePositionTicks, 12345);

      const firstResponse = await rendererSession.fetch(first.mediaUrl, {
        cache: "no-store",
        headers: { Range: "bytes=0-3" },
      });
      assert.equal(firstResponse.status, 206);
      assert.equal(firstResponse.headers.get("cache-control"), "no-store");
      assert.equal(firstResponse.headers.get("content-range"), "bytes 0-3/4");
      assert.equal(streamRequests.length, 1);
      assert.equal(streamRequests[0].itemId, firstItem);
      assert.equal(streamRequests[0].mediaSourceId, "runtime-source-id");
      assert.equal(streamRequests[0].range, "bytes=0-3");
      assert.ok(streamRequests[0].signal instanceof AbortSignal);
      assert.equal(streamRequests[0].signal.aborted, false);
      assert.deepEqual([...new Uint8Array(await firstResponse.arrayBuffer())], [1, 2, 3, 4]);

      const second = await playback.start("second-secret-item", "start-over");
      assert.notEqual(second.mediaUrl, first.mediaUrl);
      assert.equal(second.resumePositionTicks, 0);
      assert.equal((await rendererSession.fetch(first.mediaUrl, { cache: "no-store" })).status, 404);
      const secondResponse = await rendererSession.fetch(second.mediaUrl, { cache: "no-store" });
      assert.equal(secondResponse.status, 200);
      await secondResponse.arrayBuffer();

      playback.stop(second.playbackId);
      assert.equal((await rendererSession.fetch(second.mediaUrl, { cache: "no-store" })).status, 404);
    });

    mainWindow = security.createWindow({ showWhenReady: false, devTools: false });
    registerIpcHandlers(ipcMain, mainWindow, api, artwork, playback);
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
        items: ["getDetails", "openTrailer"],
        shows: ["getEpisodes", "getSeasons"],
        artwork: ["getUrl"],
        mediaSources: ["getCapabilities"],
        playback: ["getState", "start", "stop"],
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
      for (const scheme of ["app", "jellyfin-artwork", "jellyfin-media"]) {
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
