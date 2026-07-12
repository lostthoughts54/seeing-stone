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
import { PlayerPreferencesService } from "./services/playerPreferences";
import { MpvPlayerService } from "./services/mpvPlayer";
import { resolveMpvRuntime } from "./services/mpvRuntime";
import { SecureSessionStore } from "./services/secureSession";
import { logger } from "./services/logger";
import { SqlitePersistenceService } from "./services/persistence";
import { IPC } from "../shared/contracts";

registerPrivilegedSchemes();
app.enableSandbox();

let mainWindow: BrowserWindow | null = null;
let persistence: SqlitePersistenceService | null = null;
let persistenceClosing = false;
const ownsSingleInstance = app.requestSingleInstanceLock();

if (!ownsSingleInstance) app.quit();

app.on("before-quit", (event) => {
  if (!persistence || persistenceClosing) return;
  event.preventDefault();
  const activePersistence = persistence;
  persistence = null;
  void activePersistence.close().finally(() => {
    persistenceClosing = true;
    app.quit();
  });
});

app.on("second-instance", () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});

if (ownsSingleInstance) app.whenReady().then(async () => {
  persistence = new SqlitePersistenceService(app.getPath("userData"));
  await persistence.open();
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
  const playbackSource = new PlaybackSessionService(api);
  const playbackReporting = new PlaybackReportingService(api, logger);
  const playerPreferences = new PlayerPreferencesService(app.getPath("userData"));

  await rendererSession.protocol.handle("app", serveRendererAsset);
  await rendererSession.protocol.handle("jellyfin-artwork", async (request) => {
    try { return await artwork.handle(request); } catch { return new Response(null, { status: 502 }); }
  });
  mainWindow = createWindow();
  const runtime = await resolveMpvRuntime({
    packaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    moduleDirectory: __dirname,
  });
  const playback = new MpvPlayerService(mainWindow, playbackSource, playbackReporting, playerPreferences, runtime);
  playback.onState((state) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(IPC.playbackStateChanged, state);
  });
  registerIpcHandlers(ipcMain, mainWindow, api, artwork, playback);
  await mainWindow.loadURL(APP_URL);
}).catch((error) => {
  logger.error("Application startup failed.", error);
  app.quit();
});

app.on("window-all-closed", () => app.quit());
