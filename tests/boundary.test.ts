import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { IPC } from "../src/shared/contracts";

describe("renderer and preload security boundary", () => {
  it("exposes only the explicit bridge and no playback-report channel", async () => {
    expect(Object.keys(IPC)).not.toContain("request");
    expect(Object.values(IPC).join(" ")).not.toMatch(/report-start|report-progress|report-stop|sessions\/playing/i);
    const preload = await readFile("src/preload/index.ts", "utf8");
    const renderer = await readFile("src/renderer/app.ts", "utf8");
    expect(preload).not.toMatch(/exposeInMainWorld\([^,]+,\s*ipcRenderer/);
    expect(preload).not.toMatch(/\b(send|sendSync|on)\s*:/);
    expect(preload).toContain("code: result.error.code");
    expect(renderer).toContain('errorCode(error) === "SESSION_EXPIRED"');
    expect(renderer).not.toContain('error.name === "SESSION_EXPIRED"');
  });

  it("contains no renderer networking, token storage, Node, or privileged imports", async () => {
    const renderer = await readFile("src/renderer/app.ts", "utf8");
    expect(renderer).not.toMatch(/\bfetch\s*\(/);
    expect(renderer).not.toMatch(/localStorage|sessionStorage|accessToken|api_key|X-MediaBrowser-Token/);
    expect(renderer).not.toMatch(/from\s+["'](?:node:|electron|.*\/main\/)/);
    expect(renderer).not.toMatch(/window\.open|ipcRenderer|child_process/);
  });

  it("uses no synchronous privileged operations", async () => {
    const files = [
      "src/main/index.ts",
      "src/main/electronSecurity.ts",
      "src/main/ipc.ts",
      "src/main/services/artwork.ts",
      "src/main/services/deviceIdentity.ts",
      "src/main/services/secureSession.ts",
      "src/main/services/jellyfinApi.ts",
      "src/main/services/playbackSession.ts",
      "src/main/services/serverDiscovery.ts",
    ];
    const source = (await Promise.all(files.map((file) => readFile(file, "utf8")))).join("\n");
    expect(source).not.toMatch(/readFileSync|writeFileSync|execSync|spawnSync|sendSync/);
  });

  it("pins hardened BrowserWindow settings and renderer network denial", async () => {
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
      "const rendererSession = hardenSession()",
      'rendererSession.protocol.handle("app"',
      'rendererSession.protocol.handle("jellyfin-artwork"',
      'rendererSession.protocol.handle("jellyfin-media"',
      "registerIpcHandlers(ipcMain, mainWindow",
    ]) expect(main).toContain(wiring);
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
      'videoPlayer.removeAttribute("src")',
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
