import { hostname } from "node:os";
import { join } from "node:path";
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
import { DownloadManager } from "./services/downloadManager";
import { JellyfinApi } from "./services/jellyfinApi";
import { LocalPlaybackResolver } from "./services/localPlaybackResolver";
import { PlaybackSessionService } from "./services/playbackSession";
import { PlaybackReportingService } from "./services/playbackReporting";
import { PlayerPreferencesService } from "./services/playerPreferences";
import { MpvPlayerService } from "./services/mpvPlayer";
import { resolveMpvRuntime } from "./services/mpvRuntime";
import { SecureSessionStore } from "./services/secureSession";
import { logger } from "./services/logger";
import { SqlitePersistenceService } from "./services/persistence";
import { resolveVerifiedPersistenceWorkerPath } from "./services/persistenceWorkerIntegrity";
import { MediaProbeService } from "./services/mediaProbe";
import { OfflineSynchronizationService } from "./services/offlineSynchronization";
import { IPC } from "../shared/contracts";
import { SyncPlayService } from "./services/syncPlay";

registerPrivilegedSchemes();
app.enableSandbox();
app.setAppUserModelId("com.localfirst.jellyfin");

let mainWindow: BrowserWindow | null = null;
let persistence: SqlitePersistenceService | null = null;
let downloadManager: DownloadManager | null = null;
let offlineSynchronization: OfflineSynchronizationService | null = null;
let activeSyncPlay: SyncPlayService | null = null;
let persistenceClosing = false;
const ownsSingleInstance = app.requestSingleInstanceLock();

if (!ownsSingleInstance) app.quit();

app.on("before-quit", (event) => {
  if (!persistence || persistenceClosing) return;
  event.preventDefault();
  const activePersistence = persistence;
  const activeDownloads = downloadManager;
  const activeSynchronization = offlineSynchronization;
  const syncPlay = activeSyncPlay;
  persistence = null;
  downloadManager = null;
  offlineSynchronization = null;
  activeSyncPlay = null;
  const stopDownloads = activeDownloads ? activeDownloads.shutdown().catch(() => undefined) : Promise.resolve();
  const stopSynchronization = activeSynchronization ? activeSynchronization.shutdown().catch(() => undefined) : Promise.resolve();
  const stopSyncPlay = syncPlay ? syncPlay.deactivate().catch(() => undefined) : Promise.resolve();
  void Promise.all([stopDownloads, stopSynchronization, stopSyncPlay]).then(() => activePersistence.close()).finally(() => {
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
  const persistenceWorkerPath = app.isPackaged
    ? await resolveVerifiedPersistenceWorkerPath(process.resourcesPath, __dirname)
    : undefined;
  persistence = new SqlitePersistenceService(app.getPath("userData"), persistenceWorkerPath);
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
  const mediaProbe = new MediaProbeService(runtime);
  const downloadStorageRoot = join(app.getPath("videos"), "LocalFirst Jellyfin Downloads");
  const localPlayback = new LocalPlaybackResolver(api, persistence, mediaProbe, [downloadStorageRoot]);
  const playbackSource = new PlaybackSessionService(api, localPlayback, persistence);
  offlineSynchronization = new OfflineSynchronizationService(api, persistence, logger);
  offlineSynchronization.activate();
  const playbackReporting = new PlaybackReportingService(api, offlineSynchronization, logger);
  downloadManager = new DownloadManager(
    api,
    persistence,
    mediaProbe,
    downloadStorageRoot,
    logger,
  );
  downloadManager.onChanged((downloads) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(IPC.downloadsChanged, downloads);
  });
  const playback = new MpvPlayerService(mainWindow, playbackSource, playbackReporting, playerPreferences, runtime);
  playback.onState((state) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(IPC.playbackStateChanged, state);
  });
  activeSyncPlay = new SyncPlayService(api, playback, logger);
  activeSyncPlay.onState((state) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(IPC.watchPartiesChanged, state);
  });
  registerIpcHandlers(ipcMain, mainWindow, api, artwork, playback, downloadManager, offlineSynchronization, activeSyncPlay);
  await mainWindow.loadURL(APP_URL);
}).catch((error) => {
  logger.error("Application startup failed.", error);
  app.quit();
});

app.on("window-all-closed", () => app.quit());
