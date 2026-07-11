import { hostname } from "node:os";
import { extname, join, resolve, sep } from "node:path";
import { readFile } from "node:fs/promises";
import {
  app,
  BrowserWindow,
  ipcMain,
  protocol,
  safeStorage,
  session,
  shell,
} from "electron";
import { registerIpcHandlers } from "./ipc";
import { ArtworkService } from "./services/artwork";
import { DeviceIdentityService } from "./services/deviceIdentity";
import { JellyfinApi } from "./services/jellyfinApi";
import { PlaybackSessionService } from "./services/playbackSession";
import { PlaybackReportingService } from "./services/playbackReporting";
import { SecureSessionStore, type SessionProtector } from "./services/secureSession";
import { logger } from "./services/logger";

const PARTITION = "jellyfin-renderer";
const APP_URL = "app://bundle/index.html";

protocol.registerSchemesAsPrivileged([
  { scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true } },
  { scheme: "jellyfin-artwork", privileges: { standard: true, secure: true, supportFetchAPI: true } },
  { scheme: "jellyfin-media", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

app.enableSandbox();

const contentTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
};

function appContentSecurityPolicy(): string {
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data: jellyfin-artwork:",
    "media-src 'self' jellyfin-media:",
    "connect-src 'none'",
    "font-src 'self'",
    "object-src 'none'",
    "frame-src 'none'",
    "worker-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join("; ");
}

async function serveRendererAsset(request: Request): Promise<Response> {
  if (request.method !== "GET") return new Response(null, { status: 405 });
  const url = new URL(request.url);
  if (url.hostname !== "bundle" || url.search || url.hash) return new Response(null, { status: 400 });
  let pathname: string;
  try { pathname = decodeURIComponent(url.pathname); } catch { return new Response(null, { status: 400 }); }
  const relativePath = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const root = resolve(__dirname, "../renderer");
  const target = resolve(root, relativePath);
  if (target !== root && !target.startsWith(`${root}${sep}`)) return new Response(null, { status: 403 });
  try {
    const body = await readFile(target);
    const headers = new Headers({
      "Content-Type": contentTypes[extname(target).toLowerCase()] || "application/octet-stream",
      "Content-Security-Policy": appContentSecurityPolicy(),
      "X-Content-Type-Options": "nosniff",
      "Cross-Origin-Opener-Policy": "same-origin",
    });
    return new Response(body, { status: 200, headers });
  } catch {
    return new Response(null, { status: 404 });
  }
}

function createSafeStorageProtector(): SessionProtector {
  return {
    async isAvailable() {
      try { return await safeStorage.isAsyncEncryptionAvailable(); } catch { return false; }
    },
    encrypt(value) { return safeStorage.encryptStringAsync(value); },
    decrypt(value) { return safeStorage.decryptStringAsync(value); },
  };
}

function hardenSession(): Electron.Session {
  const rendererSession = session.fromPartition(PARTITION);
  rendererSession.setPermissionCheckHandler(() => false);
  rendererSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  rendererSession.on("will-download", (event) => event.preventDefault());
  rendererSession.webRequest.onBeforeRequest(
    { urls: ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*"] },
    (_details, callback) => callback({ cancel: true }),
  );
  return rendererSession;
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 720,
    minHeight: 560,
    backgroundColor: "#090b10",
    show: false,
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      partition: PARTITION,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      navigateOnDragDrop: false,
      spellcheck: false,
      devTools: !app.isPackaged,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => {
    if (url !== APP_URL) event.preventDefault();
  });
  window.webContents.on("will-attach-webview", (event) => event.preventDefault());
  window.once("ready-to-show", () => window.show());
  return window;
}

app.whenReady().then(async () => {
  const rendererSession = hardenSession();
  const identity = await new DeviceIdentityService(
    app.getPath("userData"),
    `Windows Desktop (${hostname()})`,
    app.getName(),
    app.getVersion(),
  ).get();
  const sessionStore = new SecureSessionStore(app.getPath("userData"), createSafeStorageProtector());
  const api = new JellyfinApi(identity, sessionStore, async (url) => { await shell.openExternal(url); });
  const artwork = new ArtworkService(api);
  const playback = new PlaybackSessionService(api);
  // This service is intentionally main-only. Milestone 3 will feed it
  // authoritative mpv events; renderer video events are never accepted.
  const playbackReporting = new PlaybackReportingService(api, logger);
  void playbackReporting;

  await rendererSession.protocol.handle("app", serveRendererAsset);
  await rendererSession.protocol.handle("jellyfin-artwork", async (request) => {
    try { return await artwork.handle(request); } catch { return new Response(null, { status: 502 }); }
  });
  await rendererSession.protocol.handle("jellyfin-media", async (request) => {
    try { return await playback.handle(request); } catch { return new Response(null, { status: 502 }); }
  });

  const window = createWindow();
  registerIpcHandlers(ipcMain, window, api, artwork, playback);
  await window.loadURL(APP_URL);
}).catch((error) => {
  logger.error("Application startup failed.", error);
  app.quit();
});

app.on("window-all-closed", () => app.quit());
