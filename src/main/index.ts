import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import {
  app,
  clipboard,
  dialog,
  type BrowserWindow,
  ipcMain,
  sharedTexture,
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
import { EmbeddedMpvAdapter, LegacyExternalMpvAdapter, LibMpvAdapter } from "./services/mpvPlayer";
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
import { PlaybackQueueStore } from "./services/playbackQueue";
import { DefaultPlaybackContinuationResolver } from "./services/playbackContinuationResolver";
import { PlaybackCommandService } from "./services/playbackCommandService";
import { CompanionCredentialStore } from "./services/companionCredentialStore";
import { CompanionStateService } from "./services/companionState";
import { CompanionRemoteManager } from "./services/companionRemoteManager";
import { CompanionArtworkService } from "./services/companionArtwork";
import { LiveTvContextService } from "./services/liveTvContext";
import { requestedPlayerAdapterMode, resolvePlayerAdapterLaunch } from "./services/playerAdapterSelection";
import { detectLibMpvRuntime, libMpvManifestPath, libMpvRuntimeDirectory } from "./services/libMpvRuntime";
import { LibMpvHost } from "./services/libMpvHost";
import { ElectronLibMpvBridge } from "./services/libMpvElectronBridge";
import { PlayerControllerRouter, type PlayerControllerRoute } from "./services/playerControllerRouter";
import { persistPlayerEngineDiagnostics } from "./services/playerEngineDiagnostics";
import {
  CleanMachineDiagnosticsService,
  formatCleanMachineDiagnostics,
  probeControlledLibMpvRuntime,
} from "./services/cleanMachineDiagnostics";

registerPrivilegedSchemes();
app.enableSandbox();
const internalLibMpvAcceptanceBuild = app.isPackaged
  && existsSync(join(process.resourcesPath, "libmpv", "INTERNAL_TESTING_ONLY.md"));
app.setAppUserModelId(
  internalLibMpvAcceptanceBuild
    ? "app.seeingstone.client.libmpv-test"
    : "app.seeingstone.client",
);

let mainWindow: BrowserWindow | null = null;
let persistence: SqlitePersistenceService | null = null;
let downloadManager: DownloadManager | null = null;
let offlineSynchronization: OfflineSynchronizationService | null = null;
let activeSyncPlay: SyncPlayService | null = null;
let activePlayback: PlayerController | null = null;
let activeVideoHost: EmbeddedVideoHost | null = null;
let activeCompanion: CompanionRemoteManager | null = null;
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
  const companion = activeCompanion;
  persistence = null;
  downloadManager = null;
  offlineSynchronization = null;
  activeSyncPlay = null;
  activePlayback = null;
  activeVideoHost = null;
  activeCompanion = null;
  const stopDownloads = activeDownloads ? activeDownloads.shutdown().catch(() => undefined) : Promise.resolve();
  const stopSynchronization = activeSynchronization ? activeSynchronization.shutdown().catch(() => undefined) : Promise.resolve();
  const stopSyncPlay = syncPlay ? syncPlay.deactivate().catch(() => undefined) : Promise.resolve();
  const stopPlayback = playback ? playback.clear().catch(() => undefined) : Promise.resolve();
  const stopCompanion = companion ? companion.shutdown().catch(() => undefined) : Promise.resolve();
  void Promise.all([stopDownloads, stopSynchronization, stopSyncPlay, stopPlayback, stopCompanion]).then(() => activePersistence.close()).finally(() => {
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
  const sessionProtector = createSafeStorageProtector();
  const sessionStore = new SecureSessionStore(app.getPath("userData"), sessionProtector);
  const api = new JellyfinApi(identity, sessionStore, async (url) => { await shell.openExternal(url); });
  const artwork = new ArtworkService(api);
  const playerPreferences = new PlayerPreferencesService(
    app.getPath("userData"),
    applicationPreferences,
    internalLibMpvAcceptanceBuild ? "libmpv" : app.isPackaged ? "legacy" : "embedded",
  );

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
  const playbackQueue = new PlaybackQueueStore();
  const playbackContinuation = new DefaultPlaybackContinuationResolver(playbackQueue, api);
  const playbackSource = new PlaybackSessionService(api, localPlayback, persistence, playbackContinuation);
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
  const requestedMode = requestedPlayerAdapterMode(process.env.SEEING_STONE_PLAYER, storedPlayerPreferences.adapterMode);
  const libmpvCapability = await detectLibMpvRuntime({
    manifestPath: libMpvManifestPath({
      packaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      moduleDirectory: __dirname,
    }),
    runtimeDirectory: libMpvRuntimeDirectory({
      packaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      moduleDirectory: __dirname,
    }),
  });
  const adapterLaunch = resolvePlayerAdapterLaunch(requestedMode, libmpvCapability);
  const createLegacyRoute = (): PlayerControllerRoute => {
    activeVideoHost = null;
    return {
      mode: "legacy",
      controller: new LegacyExternalMpvAdapter(mainWindow!, playbackSource, playbackReporting, playerPreferences, runtime),
    };
  };
  const createEmbeddedRoute = (): PlayerControllerRoute => {
    const host = new EmbeddedVideoHost(mainWindow!);
    activeVideoHost = host;
    return {
      mode: "embedded",
      controller: new EmbeddedMpvAdapter(mainWindow!, playbackSource, playbackReporting, playerPreferences, runtime, host),
      updateViewport: (viewport) => host.updateViewport(viewport),
      dispose: () => {
        host.destroy();
        if (activeVideoHost === host) activeVideoHost = null;
      },
    };
  };
  let initialRoute: PlayerControllerRoute;
  if (adapterLaunch.active === "libmpv" && libmpvCapability.available && libmpvCapability.artifacts) {
    try {
      const bridge = new ElectronLibMpvBridge(
        mainWindow,
        ipcMain,
        libmpvCapability.artifacts.libraryPath,
        libmpvCapability.artifacts.nativeAddonPath,
        libmpvCapability.clientApiVersion!,
      );
      const host = new LibMpvHost(libmpvCapability, bridge);
      initialRoute = {
        mode: "libmpv",
        controller: new LibMpvAdapter(mainWindow, playbackSource, playbackReporting, playerPreferences, runtime, host),
        updateViewport: (viewport) => bridge.updateViewport({
          width: viewport.width,
          height: viewport.height,
          visible: viewport.visible,
          revision: viewport.revision,
          deviceScaleFactor: viewport.deviceScaleFactor ?? 1,
        }),
        dispose: () => host.destroy(),
      };
    } catch {
      adapterLaunch.active = "embedded";
      adapterLaunch.libmpvAvailable = false;
      adapterLaunch.fallbackActive = true;
      adapterLaunch.fallbackFrom = "libmpv";
      adapterLaunch.fallbackReason = "initialization-failed";
      initialRoute = createEmbeddedRoute();
    }
  } else {
    initialRoute = adapterLaunch.active === "embedded" ? createEmbeddedRoute() : createLegacyRoute();
  }
  const recordPlayerEngineStatus = (): void => {
    void persistPlayerEngineDiagnostics(
      app.getPath("userData"),
      app.getVersion(),
      internalLibMpvAcceptanceBuild,
      adapterLaunch,
    ).catch((error) => logger.warn("Could not persist sanitized player engine status.", error));
  };
  const playback = new PlayerControllerRouter(
    initialRoute,
    adapterLaunch,
    createEmbeddedRoute,
    createLegacyRoute,
    recordPlayerEngineStatus,
  );
  recordPlayerEngineStatus();
  const soloSessionDiagnostics = new SoloSessionDiagnosticsService(api, playback, persistence);
  const playbackCommands = new PlaybackCommandService(playback, api, playbackQueue);
  const liveTvContext = new LiveTvContextService(api);
  playbackCommands.setLiveTvContext(liveTvContext);
  const openSourceLicenses = new OpenSourceLicensesService();
  const cleanMachineDiagnosticsService = new CleanMachineDiagnosticsService({
    applicationVersion: app.getVersion(),
    packaged: app.isPackaged,
    internalLibMpvTestBuild: internalLibMpvAcceptanceBuild,
    platform: process.platform,
    architecture: process.arch,
    electronVersion: process.versions.electron ?? "unknown",
    runtime: libmpvCapability,
    adapterStatus: adapterLaunch,
    sharedTextureAvailable: Boolean(sharedTexture),
    getGpuFeatureStatus: () => app.getGPUFeatureStatus() as unknown as Record<string, string>,
    probeNativeRuntime: () => probeControlledLibMpvRuntime(libmpvCapability),
    getPlaybackState: () => playback.getState(),
  });
  const cleanMachineDiagnostics = {
    getSnapshot: () => cleanMachineDiagnosticsService.getSnapshot(),
    copyReport: async () => {
      const report = formatCleanMachineDiagnostics(await cleanMachineDiagnosticsService.getSnapshot());
      clipboard.writeText(report);
      return { completed: true };
    },
    saveReport: async () => {
      const snapshot = await cleanMachineDiagnosticsService.getSnapshot();
      const result = await dialog.showSaveDialog(mainWindow!, {
        title: "Save Seeing Stone diagnostics",
        buttonLabel: "Save Report",
        defaultPath: `seeing-stone-diagnostics-${snapshot.generatedAtUtc.slice(0, 10)}.txt`,
        filters: [{ name: "Text report", extensions: ["txt"] }],
      });
      if (result.canceled || !result.filePath) return { completed: false };
      await writeFile(result.filePath, formatCleanMachineDiagnostics(snapshot), {
        encoding: "utf8",
        mode: 0o600,
      });
      return { completed: true };
    },
  };
  activePlayback = playback;
  playback.onState((state) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(IPC.playbackStateChanged, state);
  });
  soloSessionDiagnostics.onState((snapshot) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(IPC.sessionPanelSoloChanged, snapshot);
  });
  activeSyncPlay = new SyncPlayService(api, playback, logger, 5000, applicationPreferences);
  playbackCommands.setSyncPlay(activeSyncPlay);
  const companionState = new CompanionStateService(
    playback,
    playbackQueue,
    soloSessionDiagnostics,
    api,
    () => activeSyncPlay?.isJoined() ?? false,
    liveTvContext,
  );
  const companionCredentials = new CompanionCredentialStore(app.getPath("userData"), sessionProtector);
  const companionArtwork = new CompanionArtworkService(api, companionState);
  activeCompanion = new CompanionRemoteManager(
    applicationPreferences,
    companionCredentials,
    companionState,
    playbackCommands,
    playbackQueue,
    companionArtwork,
    () => {
      const context = api.getAuthenticatedContext();
      return { serverId: context.serverId, userId: context.userId };
    },
    join(__dirname, "../companion"),
  );
  activeCompanion.subscribe((state) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(IPC.companionChanged, state);
  });
  activeSyncPlay.onState((state) => {
    companionState.notifyWatchPartyChange();
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
    playback,
    playerPreferences,
    adapterLaunch,
    soloSessionDiagnostics,
    openSourceLicenses,
    cleanMachineDiagnostics,
    activeCompanion,
    playbackCommands,
  );
  await mainWindow.loadURL(APP_URL);
  // Packaged Windows builds can occasionally miss ready-to-show while the
  // sandboxed renderer is warming up. Loading has completed at this point, so
  // make the primary window visible as a reliable fallback.
  if (!mainWindow.isDestroyed() && !mainWindow.isVisible()) mainWindow.show();
}).catch((error) => {
  logger.error("Application startup failed.", error);
  app.quit();
});

app.on("window-all-closed", () => app.quit());
