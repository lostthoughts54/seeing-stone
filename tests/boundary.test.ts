import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { IPC } from "../src/shared/contracts";

describe("renderer and preload security boundary", () => {
  it("builds every Electron target before the documented development launch", async () => {
    const packageJson = JSON.parse(await readFile("package.json", "utf8")) as {
      scripts?: Record<string, string>;
    };
    expect(packageJson.scripts?.start).toBe("pnpm run build && electron .");
  });

  it("exposes only the explicit bridge and no playback-report channel", async () => {
    expect(Object.keys(IPC)).not.toContain("request");
    expect(Object.values(IPC).join(" ")).not.toMatch(/report-start|report-progress|report-stop|sessions\/playing/i);
    const preload = await readFile("src/preload/index.ts", "utf8");
    const renderer = [
      await readFile("src/renderer/app.ts", "utf8"),
      await readFile("src/renderer/playerPresentation.ts", "utf8"),
    ].join("\n");
    expect(preload).not.toMatch(/exposeInMainWorld\([^,]+,\s*ipcRenderer/);
    expect(preload).not.toMatch(/\b(send|sendSync|on)\s*:/);
    expect(preload).toContain("code: result.error.code");
    expect(renderer).toContain('errorCode(error) === "SESSION_EXPIRED"');
    expect(renderer).not.toContain('error.name === "SESSION_EXPIRED"');
  });

  it("contains no renderer networking, token storage, Node, or privileged imports", async () => {
    const renderer = [
      await readFile("src/renderer/app.ts", "utf8"),
      await readFile("src/renderer/playerPresentation.ts", "utf8"),
    ].join("\n");
    expect(renderer).not.toMatch(/\bfetch\s*\(/);
    expect(renderer).not.toMatch(/localStorage|sessionStorage|accessToken|api_key|X-MediaBrowser-Token/);
    expect(renderer).not.toMatch(/from\s+["'](?:node:|electron|.*\/main\/)/);
    expect(renderer).not.toMatch(/window\.open|ipcRenderer|child_process/);
  });

  it("keeps poster and landscape cards uniform without changing other artwork fit behavior", async () => {
    const styles = await readFile("src/renderer/styles.css", "utf8");
    expect(styles).toMatch(/\.media-card\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\);[^}]*justify-content:\s*stretch;/s);
    expect(styles).toMatch(/\.media-card\.poster\s+\.media-art\s*\{[^}]*aspect-ratio:\s*2\s*\/\s*3/s);
    expect(styles).toMatch(/\.media-card\.landscape\s+\.media-art\s*\{[^}]*aspect-ratio:\s*16\s*\/\s*9/s);
    expect(styles).toMatch(/\.media-card\s+\.media-art\s+img\s*\{[^}]*object-fit:\s*cover;[^}]*object-position:\s*center;/s);
    expect(styles).toMatch(/\.episode-thumb\s+img,[\s\S]*?\.detail-poster\s*\{[^}]*object-fit:\s*contain;/);
  });

  it("uses no synchronous privileged operations", async () => {
    const files = [
      "src/main/index.ts",
      "src/main/electronSecurity.ts",
      "src/main/ipc.ts",
      "src/main/services/artwork.ts",
      "src/main/services/deviceIdentity.ts",
      "src/main/services/downloadLocation.ts",
      "src/main/services/secureSession.ts",
      "src/main/services/jellyfinApi.ts",
      "src/main/services/mpvIpc.ts",
      "src/main/services/mpvPlayer.ts",
      "src/main/services/mpvRuntime.ts",
      "src/main/services/offlineSynchronization.ts",
      "src/main/services/playbackCompletion.ts",
      "src/main/services/playbackProxy.ts",
      "src/main/services/playbackReporting.ts",
      "src/main/services/playbackSession.ts",
      "src/main/services/playerPreferences.ts",
      "src/main/services/persistence.ts",
      "src/main/services/persistenceTypes.ts",
      "src/main/services/serverDiscovery.ts",
    ];
    const source = (await Promise.all(files.map((file) => readFile(file, "utf8")))).join("\n");
    expect(source).not.toMatch(/readFileSync|writeFileSync|execSync|spawnSync|sendSync/);
  });

  it("keeps synchronous SQLite isolated in a main-owned worker with no renderer database API", async () => {
    const service = await readFile("src/main/services/persistence.ts", "utf8");
    const types = await readFile("src/main/services/persistenceTypes.ts", "utf8");
    const worker = await readFile("src/main/services/persistenceWorker.ts", "utf8");
    const renderer = await readFile("src/renderer/app.ts", "utf8");
    const preload = await readFile("src/preload/index.ts", "utf8");
    const contracts = await readFile("src/shared/contracts.ts", "utf8");
    expect(service).toContain('private readonly workerPath = join(__dirname, "persistenceWorker.js")');
    expect(service).toContain("new Worker(this.workerPath");
    expect(service).not.toMatch(/DatabaseSync|node:sqlite|readFileSync|writeFileSync/);
    expect(worker).toContain('from "node:sqlite"');
    expect(worker).toContain("new DatabaseSync");
    expect(worker).toContain("PRAGMA journal_mode = WAL");
    expect(worker).toContain("PRAGMA quick_check");
    expect(`${service}\n${types}\n${worker}`).not.toMatch(/accessToken|password|authorization|api[_-]?key/i);
    expect(`${renderer}\n${preload}\n${contracts}`).not.toMatch(/sqlite|localPath|storageRoot|download_jobs|playback_revisions/i);
  });

  it("keeps mpv executable, arguments, capabilities, and paths out of renderer IPC", async () => {
    const contracts = await readFile("src/shared/contracts.ts", "utf8");
    const preload = await readFile("src/preload/index.ts", "utf8");
    const renderer = await readFile("src/renderer/app.ts", "utf8");
    const rendererBoundary = `${contracts}\n${preload}\n${renderer}`;
    expect(rendererBoundary).not.toMatch(/mediaUrl|input-ipc-server|--wid|mpv\.exe|child_process|spawn\s*\(/i);
    expect(rendererBoundary).not.toMatch(/interface\s+Playback\w*Input[^}]*?(?:path|url|args|command|executable)\s*:/is);
    expect(preload).toContain("ipcRenderer.on(IPC.playbackStateChanged, receive)");
    expect(preload).toContain("ipcRenderer.removeListener(IPC.playbackStateChanged, receive)");
  });

  it("exposes only sanitized watch-party summaries and narrow actions", async () => {
    const contracts = await readFile("src/shared/contracts.ts", "utf8");
    const preload = await readFile("src/preload/index.ts", "utf8");
    const watchPartyContracts = contracts.slice(
      contracts.indexOf("export type WatchPartyPlaybackState"),
      contracts.indexOf("export interface JellyfinBridge"),
    );
    expect(watchPartyContracts).not.toMatch(/accessToken|authorization|authenticatedUrl|serverUrl|localPath|filePath|headers|rawMessage|webSocket(?:Url|Endpoint|Headers|Token)|mediaUrl|api[_-]?key/i);
    expect(watchPartyContracts).not.toMatch(/(?:url|path|headers|credential|token)\s*:/i);
    expect(preload).toContain("ipcRenderer.on(IPC.watchPartiesChanged, receive)");
    expect(preload).toContain("ipcRenderer.removeListener(IPC.watchPartiesChanged, receive)");
    expect(preload).not.toMatch(/new WebSocket|\bfetch\s*\(/);
  });

  it("keeps legacy playback while gating a main-controlled Windows video overlay", async () => {
    const player = await readFile("src/main/services/mpvPlayer.ts", "utf8");
    const host = await readFile("src/main/services/embeddedVideoHost.ts", "utf8");
    const main = await readFile("src/main/index.ts", "utf8");
    const input = await readFile("assets/mpv/input.conf", "utf8");
    expect(player).toContain('"--force-window=immediate"');
    expect(player).toContain('"--title=Seeing Stone Player"');
    expect(player).toContain('"--geometry=1280x720"');
    expect(player).toContain("this.mainWindow.minimize()");
    expect(player).toContain("this.mainWindow.restore()");
    expect(player).toContain("this.mainWindow.show()");
    expect(player).not.toContain("this.mainWindow.hide()");
    expect(player).not.toContain("--wid=");
    expect(player).toContain('"--focus-on=never"');
    expect(player).toContain('"--border=no"');
    expect(player).toContain('"--gpu-api=d3d11"');
    expect(player).toContain('"--gpu-context=d3d11"');
    expect(player).toContain('"--gpu-api=opengl"');
    expect(player).toContain('"--gpu-context=win"');
    expect(player).toContain('"--panscan=0"');
    expect(host).not.toContain("new BaseWindow");
    expect(host).toContain("getNativeWindowHandle()");
    expect(host).toContain("readBigUInt64LE(0)");
    expect(host).toContain("GWLP_HWNDPARENT");
    expect(host).toContain("WS_EX_TRANSPARENT");
    expect(main).toContain("requestedPlayerAdapterMode(process.env.SEEING_STONE_PLAYER");
    expect(main).toContain('initialRoute = adapterLaunch.active === "embedded" ? createEmbeddedRoute() : createLegacyRoute()');
    expect(main).toContain("new LibMpvAdapter(");
    expect(input).toContain("Ctrl+r script-message jellyfin-resync");
  });

  it("pins hardened BrowserWindow settings and narrowly scoped trailer networking", async () => {
    const main = [
      await readFile("src/main/index.ts", "utf8"),
      await readFile("src/main/electronSecurity.ts", "utf8"),
    ].join("\n");
    for (const setting of [
      "contextIsolation: true",
      "sandbox: true",
      "nodeIntegration: false",
      "nodeIntegrationInWorker: false",
      "nodeIntegrationInSubFrames: false",
      "webSecurity: true",
      "allowRunningInsecureContent: false",
      "webviewTag: false",
      "navigateOnDragDrop: false",
    ]) expect(main).toContain(setting);
    expect(main).toContain('connect-src \'none\'');
    expect(main).toContain("setPermissionRequestHandler");
    expect(main).toContain("setPermissionCheckHandler");
    expect(main).toContain("onBeforeRequest");
    expect(main).toContain("setWindowOpenHandler");
    expect(main).toContain("requestSingleInstanceLock");
    for (const wiring of [
      "registerPrivilegedSchemes()",
      "const rendererSession = hardenSession(applicationId)",
      'rendererSession.protocol.handle("app"',
      'rendererSession.protocol.handle("jellyfin-artwork"',
    ]) expect(main).toContain(wiring);
    expect(main).toMatch(/registerIpcHandlers\(\s*ipcMain,\s*mainWindow/);
    expect(main).not.toContain('rendererSession.protocol.handle("jellyfin-media"');
    expect(main).toContain('"media-src \'none\'"');
    expect(main).toContain('"frame-src https://www.youtube.com"');
    expect(main).toContain("isAllowedTrailerRequest(details)");
  });

  it("guards reused artwork elements and playback resolution against stale async results", async () => {
    const renderer = await readFile("src/renderer/app.ts", "utf8");
    expect(renderer).toContain("new WeakMap<HTMLImageElement, number>()");
    expect(renderer).toContain("imageRequestIds.get(image) !== requestId");
    expect(renderer).toContain("const requestId = ++state.playbackRequestId");
    expect(renderer).toContain("requestId !== state.playbackRequestId");
    expect(renderer).toContain("playback.stop({ playbackId: resolved.playbackId })");
    expect(renderer).not.toMatch(/videoPlayer\.addEventListener\("ended",\s*\(\)\s*=>\s*\{\s*void closePlayer/);
  });

  it("preserves reauthentication context and scrubs prior-account renderer state", async () => {
    const renderer = await readFile("src/renderer/app.ts", "utf8");
    expect(renderer).toContain('showToast(errorMessage(error, "Jellyfin could not load the home screen."))');

    const bootstrap = renderer.slice(
      renderer.indexOf("async function bootstrap"),
      renderer.indexOf('loginForm.addEventListener("submit"'),
    );
    expect(bootstrap).toContain("serverUrlInput.value = state.session.server.address");
    expect(bootstrap.indexOf("serverUrlInput.value")).toBeLessThan(bootstrap.indexOf("await loadInitialData()"));

    const reset = renderer.slice(
      renderer.indexOf("function resetSignedInState"),
      renderer.indexOf("async function bootstrap"),
    );
    for (const scrub of [
      "clearImage(featureImage)",
      "clearImage(detailBackdrop)",
      "clearImage(detailPoster, detailPosterFallback)",
      "homeRows.replaceChildren()",
      "libraryGrid.replaceChildren()",
      "searchRows.replaceChildren()",
      "episodeList.replaceChildren()",
      "state.playbackState = null",
      "state.soloDiagnostics = null",
      "sessionPanelContent.replaceChildren()",
      'userLabel.textContent = ""',
      'serverLabel.textContent = ""',
      'setRoute("home")',
      "contentScroller.scrollTop = 0",
    ]) expect(reset).toContain(scrub);
    expect(reset).toContain("state.detailsRequestId += 1");
    expect(reset).toContain("state.searchRequestId += 1");
    expect(reset).toContain("state.playbackRequestId += 1");

    const login = renderer.slice(renderer.indexOf('loginForm.addEventListener("submit"'));
    expect(login).toMatch(/resetSignedInState\(\);\s*await loadInitialData\(\);/);
  });
});
