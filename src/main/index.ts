import { hostname } from "node:os";
import {
  app,
  type BrowserWindow,
  ipcMain,
  shell,
} from "electron";
import {
  APP_URL,
  createSafeStorageProtector,
  createWindow,
  hardenSession,
  registerPrivilegedSchemes,
  serveRendererAsset,
} from "./electronSecurity";
import { registerIpcHandlers } from "./ipc";
import { ArtworkService } from "./services/artwork";
import { DeviceIdentityService } from "./services/deviceIdentity";
import { JellyfinApi } from "./services/jellyfinApi";
import { PlaybackSessionService } from "./services/playbackSession";
import { PlaybackReportingService } from "./services/playbackReporting";
import { SecureSessionStore } from "./services/secureSession";
import { logger } from "./services/logger";

registerPrivilegedSchemes();
app.enableSandbox();

let mainWindow: BrowserWindow | null = null;
const ownsSingleInstance = app.requestSingleInstanceLock();

if (!ownsSingleInstance) app.quit();

app.on("second-instance", () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});

if (ownsSingleInstance) app.whenReady().then(async () => {
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

  mainWindow = createWindow();
  registerIpcHandlers(ipcMain, mainWindow, api, artwork, playback);
  await mainWindow.loadURL(APP_URL);
}).catch((error) => {
  logger.error("Application startup failed.", error);
  app.quit();
});

app.on("window-all-closed", () => app.quit());
