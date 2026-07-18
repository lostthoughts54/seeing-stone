import { readFile } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import {
  app,
  BrowserWindow,
  protocol,
  safeStorage,
  session,
} from "electron";
import type { SessionProtector } from "./services/secureSession";

export const RENDERER_PARTITION = "jellyfin-renderer";
export const APP_URL = "app://bundle/index.html";

export function registerPrivilegedSchemes(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true } },
    { scheme: "jellyfin-artwork", privileges: { standard: true, secure: true } },
  ]);
}

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
  ".ttf": "font/ttf",
};

export function appContentSecurityPolicy(): string {
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data: jellyfin-artwork:",
    "media-src 'none'",
    "connect-src 'none'",
    "font-src 'self'",
    "object-src 'none'",
    "frame-src 'none'",
    "worker-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join("; ");
}

export async function serveRendererAsset(request: Request): Promise<Response> {
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

export function createSafeStorageProtector(): SessionProtector {
  return {
    async isAvailable() {
      try { return await safeStorage.isAsyncEncryptionAvailable(); } catch { return false; }
    },
    encrypt(value) { return safeStorage.encryptStringAsync(value); },
    decrypt(value) { return safeStorage.decryptStringAsync(value); },
  };
}

export function hardenSession(): Electron.Session {
  const rendererSession = session.fromPartition(RENDERER_PARTITION);
  rendererSession.setPermissionCheckHandler(() => false);
  rendererSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  rendererSession.on("will-download", (event) => event.preventDefault());
  rendererSession.webRequest.onBeforeRequest(
    { urls: ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*"] },
    (_details, callback) => callback({ cancel: true }),
  );
  return rendererSession;
}

export function createWindow(options: { showWhenReady?: boolean; devTools?: boolean } = {}): BrowserWindow {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 720,
    minHeight: 560,
    backgroundColor: "#090b10",
    show: false,
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      partition: RENDERER_PARTITION,
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
      devTools: options.devTools ?? !app.isPackaged,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => {
    if (url !== APP_URL) event.preventDefault();
  });
  window.webContents.on("will-attach-webview", (event) => event.preventDefault());
  if (options.showWhenReady !== false) window.once("ready-to-show", () => window.show());
  return window;
}
