import { hostname } from "node:os";
import { join } from "node:path";
import {
  app,
  dialog,
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
import { DownloadLocationService } from "./services/downloadLocation";
import { AppError } from "./services/errors";
import { JellyfinApi } from "./services/jellyfinApi";
import { LocalPlaybackResolver } from "./services/localPlaybackResolver";
import { PlaybackSessionService } from "./services/playbackSession";
import { PlaybackReportingService } from "./services/playbackReporting";
import { PlayerPreferencesService } from "./services/playerPreferences";
import { EmbeddedMpvAdapter, LegacyExternalMpvAdapter } from "./services/mpvPlayer";
import { resolveMpvRuntime } from "./services/mpvRuntime";
import { SecureSessionStore } from "./services/secureSession";
import { logger } from "./services/logger";
import { SqlitePersistenceService } from "./services/persistence";
import { resolveVerifiedPersistenceWorkerPath } from "./services/persistenceWorkerIntegrity";
import { MediaProbeService } from "./services/mediaProbe";
import { OfflineSynchronizationService } from "./services/offlineSynchronization";
import { IPC } from "../shared/contracts";
import { SyncPlayService } from "./services/syncPlay";
import { EmbeddedVideoHost } from "./services/embeddedVideoHost";
import type { PlayerController } from "./services/playerController";
import { SoloSessionDiagnosticsService } from "./services/soloSessionDiagnostics";
import { OpenSourceLicensesService } from "./services/openSourceLicenses";
import { ApplicationPreferencesService } from "./services/applicationPreferences";

registerPrivilegedSchemes();
app.enableSandbox();
app.setAppUserModelId("app.seeingstone.client");

let mainWindow: BrowserWindow | null = null;
let persistence: SqlitePersistenceService | null = null;
let downloadManager: DownloadManager | null = null;
let offlineSynchronization: OfflineSynchronizationService | null = null;
let activeSyncPlay: SyncPlayService | null = null;
let activePlayback: PlayerController | null = null;
let activeVideoHost: EmbeddedVideoHost | null = null;
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
  const playback = activePlayback;
  const videoHost = activeVideoHost;
  persistence = null;
  downloadManager = null;
  offlineSynchronization = null;
  activeSyncPlay = null;
  activePlayback = null;
  activeVideoHost = null;
  const stopDownloads = activeDownloads ? activeDownloads.shutdown().catch(() => undefined) : Promise.resolve();
  const stopSynchronization = activeSynchronization ? activeSynchronization.shutdown().catch(() => undefined) : Promise.resolve();
  const stopSyncPlay = syncPlay ? syncPlay.deactivate().catch(() => undefined) : Promise.resolve();
  const stopPlayback = playback ? playback.clear().catch(() => undefined) : Promise.resolve();
  void Promise.all([stopDownloads, stopSynchronization, stopSyncPlay, stopPlayback]).then(() => activePersistence.close()).finally(() => {
    videoHost?.destroy();
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
  const applicationPreferences = new ApplicationPreferencesService(persistence);
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
  const playerPreferences = new PlayerPreferencesService(app.getPath("userData"), applicationPreferences);

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
  const defaultDownloadStorageRoot = join(app.getPath("videos"), "Seeing Stone Downloads");
  const downloadLocation = new DownloadLocationService(app.getPath("userData"), defaultDownloadStorageRoot);
  const downloadStorageRoot = await downloadLocation.getActiveRoot();
  const downloadStorageRoots = await downloadLocation.getAuthorizedRoots();
  const localPlayback = new LocalPlaybackResolver(api, persistence, mediaProbe, downloadStorageRoots);
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
    { authorizedRoots: downloadStorageRoots },
  );
  downloadManager.onChanged((downloads) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(IPC.downloadsChanged, downloads);
  });
  const storedPlayerPreferences = await playerPreferences.get();
  const requestedMode = process.env.SEEING_STONE_PLAYER === "embedded" || process.env.SEEING_STONE_PLAYER === "legacy"
    ? process.env.SEEING_STONE_PLAYER
    : storedPlayerPreferences.adapterMode ?? "legacy";
  const embeddedRequested = !app.isPackaged && requestedMode === "embedded";
  const videoHost = embeddedRequested ? new EmbeddedVideoHost(mainWindow) : undefined;
  const playback = videoHost
    ? new EmbeddedMpvAdapter(mainWindow, playbackSource, playbackReporting, playerPreferences, runtime, videoHost)
    : new LegacyExternalMpvAdapter(mainWindow, playbackSource, playbackReporting, playerPreferences, runtime);
  const soloSessionDiagnostics = new SoloSessionDiagnosticsService(api, playback, persistence);
  const openSourceLicenses = new OpenSourceLicensesService();
  activePlayback = playback;
  activeVideoHost = videoHost ?? null;
  playback.onState((state) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(IPC.playbackStateChanged, state);
  });
  soloSessionDiagnostics.onState((snapshot) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(IPC.sessionPanelSoloChanged, snapshot);
  });
  activeSyncPlay = new SyncPlayService(api, playback, logger, 5000, applicationPreferences);
  activeSyncPlay.onState((state) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(IPC.watchPartiesChanged, state);
  });
  const downloadLocationController = {
    getSummary: () => downloadLocation.getSummary(),
    choose: async () => {
      const result = await dialog.showOpenDialog(mainWindow!, {
        title: "Choose where Seeing Stone stores downloads",
        buttonLabel: "Use This Location",
        defaultPath: await downloadLocation.getActiveRoot(),
        properties: ["openDirectory", "createDirectory"],
      });
      if (result.canceled || !result.filePaths[0]) return null;
      const summary = await downloadLocation.chooseParent(result.filePaths[0]);
      const root = await downloadLocation.getActiveRoot();
      downloadManager!.setStorageRoot(root);
      localPlayback.addAuthorizedRoot(root);
      return summary;
    },
    useDefault: async () => {
      const summary = await downloadLocation.useDefault();
      const root = await downloadLocation.getActiveRoot();
      downloadManager!.setStorageRoot(root);
      localPlayback.addAuthorizedRoot(root);
      return summary;
    },
    open: async () => {
      const root = await downloadLocation.ensureActiveFolder();
      const error = await shell.openPath(root);
      if (error) throw new AppError("DOWNLOAD_LOCATION_OPEN_FAILED", "Windows could not open the download folder.", 500);
      return { opened: true };
    },
  };
  registerIpcHandlers(
    ipcMain,
    mainWindow,
    api,
    artwork,
    playback,
    downloadManager,
    offlineSynchronization,
    activeSyncPlay,
    downloadLocationController,
    videoHost,
    playerPreferences,
    soloSessionDiagnostics,
    openSourceLicenses,
  );
  await mainWindow.loadURL(APP_URL);
}).catch((error) => {
  logger.error("Application startup failed.", error);
  app.quit();
});

app.on("window-all-closed", () => app.quit());
