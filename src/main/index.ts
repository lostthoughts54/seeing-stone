import { existsSync } from "node:fs";
import { NsisUpdater } from "electron-updater";
import { readFile, writeFile } from "node:fs/promises";
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
import { materializeCachedMediaItem } from "./services/cachedMedia";
import { DeviceIdentityService } from "./services/deviceIdentity";
import { DownloadManager } from "./services/downloadManager";
import { DownloadLocationService } from "./services/downloadLocation";
import { AppError } from "./services/errors";
import { JellyfinApi } from "./services/jellyfinApi";
import { LocalPlaybackResolver } from "./services/localPlaybackResolver";
import { PlaybackSessionService } from "./services/playbackSession";
import { PlaybackReportingService } from "./services/playbackReporting";
import { PlayerPreferencesService } from "./services/playerPreferences";
import { EmbeddedMpvAdapter, LegacyExternalMpvAdapter, LibMpvAdapter, MpvPlayerService } from "./services/mpvPlayer";
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
import { detectLibMpvRuntime, detectMediaProbeRuntime, libMpvManifestPath, libMpvRuntimeDirectory } from "./services/libMpvRuntime";
import { LibMpvHost } from "./services/libMpvHost";
import { ElectronLibMpvBridge } from "./services/libMpvElectronBridge";
import { resolveLibMpvDiagnosticSettings } from "./services/libMpvDiagnostics";
import { PlayerControllerRouter, type PlayerControllerRoute } from "./services/playerControllerRouter";
import { persistPlayerEngineDiagnostics } from "./services/playerEngineDiagnostics";
import { TrailerWindowService } from "./services/trailerWindow";
import { SmartDownloadService } from "./services/smartDownloads";
import { PlaybackMetadataService } from "./services/playbackMetadata";
import { TrickplayService } from "./services/trickplay";
import {
  CleanMachineDiagnosticsService,
  formatCleanMachineDiagnostics,
  probeControlledLibMpvRuntime,
} from "./services/cleanMachineDiagnostics";
import { UnavailablePlayerController } from "./services/unavailablePlayerController";
import { UpdateChecker, updateUnavailableReason } from "./services/updateChecker";
import { getUpdateSessionActivity } from "./services/updateSessionActivity";
import { YouTubeRoomService } from "./services/youtubeRooms";
import { CompanionYouTubeService } from "./services/companionYouTube";
import { YouTubeApiKeyStore } from "./services/youtubeApiKeyStore";
import { PlayerFeaturesService } from "./services/playerFeatures";
import { featureIpc } from "../shared/playerFeatures";
import { IptvProviderStore } from "./services/iptvProviderStore";
import { IptvService } from "./services/iptvService";

registerPrivilegedSchemes();
app.enableSandbox();
const internalLibMpvAcceptanceBuild = app.isPackaged
  && existsSync(join(process.resourcesPath, "libmpv", "INTERNAL_TESTING_ONLY.md"));
const packagedProduction = app.isPackaged && !internalLibMpvAcceptanceBuild;
const applicationId = internalLibMpvAcceptanceBuild
  ? "app.seeingstone.client.libmpv-test"
  : "app.seeingstone.client";
app.setAppUserModelId(applicationId);
// IPTV, Jellyfin and Companion Remote share the application's normal profile.
// The old --iptv-beta argument is only a navigation alias now.

let mainWindow: BrowserWindow | null = null;
let persistence: SqlitePersistenceService | null = null;
let downloadManager: DownloadManager | null = null;
let offlineSynchronization: OfflineSynchronizationService | null = null;
let activeSyncPlay: SyncPlayService | null = null;
let activePlayback: PlayerController | null = null;
let activeVideoHost: EmbeddedVideoHost | null = null;
let activeCompanion: CompanionRemoteManager | null = null;
let activeSmartDownloads: SmartDownloadService | null = null;
let activeYouTubeRooms: YouTubeRoomService | null = null;
let activePlayerFeatures: PlayerFeaturesService | null = null;
let activeIptv: IptvService | null = null;
let persistenceClosing = false;
let shutdownPromise: Promise<void> | null = null;
let shuttingDown = false;
let activeUpdates: UpdateChecker | null = null;
const ownsSingleInstance = app.requestSingleInstanceLock();

if (!ownsSingleInstance) app.quit();

function shutdownApplication(): Promise<void> {
  if (shutdownPromise) return shutdownPromise;
  shuttingDown = true;
  const activePersistence = persistence;
  const activeDownloads = downloadManager;
  const activeSynchronization = offlineSynchronization;
  const syncPlay = activeSyncPlay;
  const playback = activePlayback;
  const videoHost = activeVideoHost;
  const companion = activeCompanion;
  const smartDownloads = activeSmartDownloads;
  const youtubeRooms = activeYouTubeRooms;
  const playerFeatures = activePlayerFeatures;
  persistence = null;
  downloadManager = null;
  offlineSynchronization = null;
  activeSyncPlay = null;
  activePlayback = null;
  activeVideoHost = null;
  activeCompanion = null;
  activeSmartDownloads = null;
  activeYouTubeRooms = null;
  activePlayerFeatures = null;
  const stopYouTube = (youtubeRooms?.getState().room ? youtubeRooms.leave().catch(() => undefined) : Promise.resolve()).finally(() => youtubeRooms?.deactivate());
  const stopFeatures = (playerFeatures?.isJoined() ? playerFeatures.command({ operation: "leave" }).catch(() => undefined) : Promise.resolve()).finally(() => playerFeatures?.deactivate());
  const stopDownloads = (smartDownloads ? smartDownloads.shutdown().catch(() => undefined) : Promise.resolve())
    .then(() => activeDownloads ? activeDownloads.shutdown().catch(() => undefined) : undefined);
  const stopSyncPlay = syncPlay ? syncPlay.deactivate().catch(() => undefined) : Promise.resolve();
  const stopPlayback = Promise.all([stopSyncPlay, stopFeatures]).then(() => playback?.clear().catch(() => undefined));
  const stopSynchronization = stopPlayback.then(() => activeSynchronization?.shutdown().catch(() => undefined));
  const stopCompanion = companion ? companion.shutdown().catch(() => undefined) : Promise.resolve();
  const stopIptv = activeIptv?.shutdown().catch(() => undefined);
  shutdownPromise = Promise.all([stopDownloads, stopSynchronization, stopYouTube, stopCompanion, stopIptv]).then(() => activePersistence?.close()).finally(() => {
    videoHost?.destroy();
    persistenceClosing = true;
  });
  return shutdownPromise;
}

app.on("before-quit", (event) => {
  if (persistenceClosing) return;
  event.preventDefault();
  void shutdownApplication().catch(() => logger.warn("Application cleanup failed.")).finally(() => app.quit());
});
app.on("will-quit", () => activeUpdates?.dispose());

app.on("second-instance", () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});

if (ownsSingleInstance) app.whenReady().then(async () => {
  const libMpvDiagnostics = resolveLibMpvDiagnosticSettings(process.env, app.getPath("logs"));
  if (libMpvDiagnostics.enabled) {
    logger.info("Opt-in libmpv playback diagnostics enabled.", {
      requestedDecoderMode: libMpvDiagnostics.requestedDecoderMode,
      activeDecoderMode: libMpvDiagnostics.decoderMode,
      configuredHwdec: libMpvDiagnostics.hwdec,
      presentationMode: libMpvDiagnostics.presentationMode,
    });
  }
  if (libMpvDiagnostics.unsupportedReason) {
    logger.warn("Requested libmpv diagnostic mode is unavailable.", {
      requestedDecoderMode: libMpvDiagnostics.requestedDecoderMode,
      presentationMode: libMpvDiagnostics.presentationMode,
      reason: libMpvDiagnostics.unsupportedReason,
    });
  }
  const persistenceWorkerPath = app.isPackaged
    ? await resolveVerifiedPersistenceWorkerPath(process.resourcesPath, __dirname)
    : undefined;
  persistence = new SqlitePersistenceService(app.getPath("userData"), persistenceWorkerPath);
  await persistence.open();
  const applicationPreferences = new ApplicationPreferencesService(persistence);
  const rendererSession = hardenSession(applicationId);
  const identity = await new DeviceIdentityService(
    app.getPath("userData"),
    `Windows Desktop (${hostname()})`,
    app.getName(),
    app.getVersion(),
  ).get();
  const sessionProtector = createSafeStorageProtector();
  activeIptv = new IptvService(new IptvProviderStore(persistence, sessionProtector), persistence);
  const sessionStore = new SecureSessionStore(app.getPath("userData"), sessionProtector);
  const api = new JellyfinApi(identity, sessionStore, async (url) => { await shell.openExternal(url); });
  const artwork = new ArtworkService(api);
  const playerPreferences = new PlayerPreferencesService(
    app.getPath("userData"),
    applicationPreferences,
    app.isPackaged ? "libmpv" : "embedded",
    packagedProduction ? "libmpv" : undefined,
  );

  await rendererSession.protocol.handle("app", serveRendererAsset);
  await rendererSession.protocol.handle("jellyfin-artwork", async (request) => {
    try { return await artwork.handle(request); } catch { return new Response(null, { status: 502 }); }
  });
  mainWindow = createWindow();
  const trailerWindow = new TrailerWindowService();
  const runtimeLocation = {
    packaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    moduleDirectory: __dirname,
  };
  const manifestPath = libMpvManifestPath(runtimeLocation);
  const runtimeDirectory = libMpvRuntimeDirectory(runtimeLocation);
  const libmpvCapability = await detectLibMpvRuntime({ manifestPath, runtimeDirectory });
  const mediaProbeRuntime = await detectMediaProbeRuntime({ manifestPath, runtimeDirectory });
  const legacyRuntime = packagedProduction ? null : await resolveMpvRuntime(runtimeLocation);
  const mediaProbe = new MediaProbeService(mediaProbeRuntime);
  const defaultDownloadStorageRoot = join(app.getPath("videos"), "Seeing Stone Downloads");
  const downloadLocation = new DownloadLocationService(app.getPath("userData"), defaultDownloadStorageRoot);
  const downloadStorageRoot = await downloadLocation.getActiveRoot();
  const downloadStorageRoots = await downloadLocation.getAuthorizedRoots();
  downloadManager = new DownloadManager(
    api,
    persistence,
    mediaProbe,
    downloadStorageRoot,
    logger,
    { authorizedRoots: downloadStorageRoots },
  );
  const localPlayback = new LocalPlaybackResolver(api, persistence, mediaProbe, downloadStorageRoots);
  const playbackQueue = new PlaybackQueueStore();
  const playbackContinuation = new DefaultPlaybackContinuationResolver(playbackQueue, api);
  const playbackSource = new PlaybackSessionService(api, localPlayback, persistence, playbackContinuation, downloadManager, activeIptv);
  offlineSynchronization = new OfflineSynchronizationService(api, persistence, logger);
  offlineSynchronization.activate();
  const playbackReporting = new PlaybackReportingService(api, offlineSynchronization, logger);
  const configureProgressiveFallback = <T extends MpvPlayerService>(controller: T): T => {
    controller.setProgressiveFallbackDecider(async (reason) => {
      const connection = api.getConnectionDiagnostics().state;
      const offline = connection === "offline" || connection === "reconnecting";
      const detail = reason === "probe-failed"
        ? "The completed download failed media validation."
        : "This video cannot be opened progressively.";
      if (offline) {
        await dialog.showMessageBox(mainWindow!, {
          type: "info",
          title: "Wait for download",
          message: detail,
          detail: "Jellyfin is offline, so server streaming is unavailable.",
          buttons: ["Wait for download"],
          defaultId: 0,
          cancelId: 0,
          noLink: true,
        });
        return "wait";
      }
      const result = await dialog.showMessageBox(mainWindow!, {
        type: "question",
        title: "Progressive playback unavailable",
        message: detail,
        detail: "Stream from Jellyfin now, or wait for the download to finish.",
        buttons: ["Stream from Jellyfin", "Wait for download"],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      });
      return result.response === 0 ? "stream" : "wait";
    });
    return controller;
  };
  downloadManager.onChanged((downloads) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(IPC.downloadsChanged, downloads);
  });
  const storedPlayerPreferences = await playerPreferences.get();
  const requestedMode = requestedPlayerAdapterMode(
    process.env.SEEING_STONE_PLAYER,
    storedPlayerPreferences.adapterMode,
    packagedProduction,
  );
  const adapterLaunch = resolvePlayerAdapterLaunch(requestedMode, libmpvCapability, !packagedProduction);
  const createLegacyRoute = (): PlayerControllerRoute => {
    if (!legacyRuntime) throw new AppError("PLAYER_RUNTIME_UNAVAILABLE", "The legacy development player is unavailable.", 503);
    activeVideoHost = null;
    return {
      mode: "legacy",
      controller: configureProgressiveFallback(new LegacyExternalMpvAdapter(mainWindow!, playbackSource, playbackReporting, playerPreferences, legacyRuntime)),
    };
  };
  const createEmbeddedRoute = (): PlayerControllerRoute => {
    if (!legacyRuntime) throw new AppError("PLAYER_RUNTIME_UNAVAILABLE", "The embedded development player is unavailable.", 503);
    const host = new EmbeddedVideoHost(mainWindow!);
    activeVideoHost = host;
    return {
      mode: "embedded",
      controller: configureProgressiveFallback(new EmbeddedMpvAdapter(mainWindow!, playbackSource, playbackReporting, playerPreferences, legacyRuntime, host)),
      updateViewport: (viewport) => host.updateViewport(viewport),
      dispose: () => {
        host.destroy();
        if (activeVideoHost === host) activeVideoHost = null;
      },
    };
  };
  const createUnavailableRoute = (): PlayerControllerRoute => ({
    mode: "libmpv",
    controller: new UnavailablePlayerController(),
  });
  let initialRoute: PlayerControllerRoute;
  if (adapterLaunch.active === "libmpv" && libmpvCapability.available && libmpvCapability.artifacts) {
    try {
      const bridge = new ElectronLibMpvBridge(
        mainWindow,
        ipcMain,
        libmpvCapability.artifacts.libraryPath,
        libmpvCapability.artifacts.nativeAddonPath,
        libmpvCapability.clientApiVersion!,
        libMpvDiagnostics,
      );
      const host = new LibMpvHost(libmpvCapability, bridge);
      initialRoute = {
        mode: "libmpv",
        controller: configureProgressiveFallback(new LibMpvAdapter(mainWindow, playbackSource, playbackReporting, playerPreferences, host)),
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
      adapterLaunch.libmpvAvailable = false;
      adapterLaunch.fallbackReason = "initialization-failed";
      if (packagedProduction) {
        adapterLaunch.active = "libmpv";
        adapterLaunch.fallbackActive = false;
        adapterLaunch.fallbackFrom = null;
        initialRoute = createUnavailableRoute();
      } else {
        adapterLaunch.active = "embedded";
        adapterLaunch.fallbackActive = true;
        adapterLaunch.fallbackFrom = "libmpv";
        initialRoute = createEmbeddedRoute();
      }
    }
  } else {
    initialRoute = adapterLaunch.active === "libmpv"
      ? createUnavailableRoute()
      : adapterLaunch.active === "embedded" ? createEmbeddedRoute() : createLegacyRoute();
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
    !packagedProduction,
  );
  recordPlayerEngineStatus();
  const soloSessionDiagnostics = new SoloSessionDiagnosticsService(api, playback, persistence);
  const playbackCatalog = persistence;
  const playbackCommands = new PlaybackCommandService(playback, api, playbackQueue, async (itemId) => {
    const identity = api.getAuthenticatedContext();
    const [item, head] = await Promise.all([
      playbackCatalog.getMediaItem(identity.serverId, identity.userId, itemId),
      playbackCatalog.getPlaybackHead(identity.serverId, identity.userId, itemId),
    ]);
    const current = api.getAuthenticatedContext();
    if (current.serverId !== identity.serverId || current.userId !== identity.userId) return null;
    return item ? materializeCachedMediaItem(item, head) : null;
  });
  const playbackMetadata = new PlaybackMetadataService(api);
  const trickplay = new TrickplayService(api, (playbackId) => playbackSource.getActiveResourceContext(playbackId));
  playbackMetadata.setPlaybackState(playback.getState());
  trickplay.setPlaybackState(playback.getState());
  await rendererSession.protocol.handle("jellyfin-trickplay", async (request) => {
    try { return await trickplay.handle(request); } catch { return new Response(null, { status: 502 }); }
  });
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
  let installed = false;
  try {
    installed = (await readFile(join(process.resourcesPath, "seeing-stone-install-type"), "utf8")).trim() === "nsis"
      && existsSync(join(dirname(process.execPath), "Uninstall Seeing Stone.exe"));
  } catch { /* Unpacked and portable builds have no installer-owned marker. */ }
  const unavailableReason = updateUnavailableReason({
    packaged: app.isPackaged, platform: process.platform, arch: process.arch, internal: internalLibMpvAcceptanceBuild,
    installed, feed: existsSync(join(process.resourcesPath, "app-update.yml")),
  });
  const updateController = new UpdateChecker({
    appName: app.isPackaged ? app.getName() : "Seeing Stone", currentVersion: app.getVersion(), unavailableReason,
    updater: unavailableReason ? null : new NsisUpdater(), logger,
    activity: () => getUpdateSessionActivity(playback.getState(), activeSyncPlay?.getState(), activeYouTubeRooms?.getState(), activePlayerFeatures?.getState()),
    confirmRestart: async () => {
      if (!mainWindow || mainWindow.isDestroyed() || shuttingDown) return false;
      const result = await dialog.showMessageBox(mainWindow, {
        type: "warning", title: "Restart & Update", message: "End this session and install the update?",
        detail: "Restarting Seeing Stone will stop playback and leave your active watch party. Cancel keeps your session and downloaded update available.",
        buttons: ["Cancel", "Restart & Update"], defaultId: 0, cancelId: 0, noLink: true,
      });
      return result.response === 1 && !shuttingDown;
    },
    shutdown: shutdownApplication,
  });
  activeUpdates = updateController;
  updateController.onState((status) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(IPC.updatesChanged, status);
  });
  activePlayback = playback;
  activeSmartDownloads = new SmartDownloadService(
    api,
    persistence,
    downloadManager,
    (itemId) => playback.getState().itemId === itemId,
    logger,
  );
  activeSmartDownloads.onChanged((state) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(IPC.smartDownloadsChanged, state);
  });
  let previousPlaybackItemId = playback.getState().itemId;
  playback.onState((state) => {
    updateController.activityChanged();
    playbackMetadata.setPlaybackState(state);
    trickplay.setPlaybackState(state);
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(IPC.playbackStateChanged, state);
    if (previousPlaybackItemId && previousPlaybackItemId !== state.itemId) activeSmartDownloads?.notifyPlaybackStopped();
    previousPlaybackItemId = state.itemId;
  });
  playback.onEvent((event) => {
    if (event.action === "completed" && event.state.itemId) void activeSmartDownloads?.notifyWatchedItem(event.state.itemId);
  });
  soloSessionDiagnostics.onState((snapshot) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(IPC.sessionPanelSoloChanged, snapshot);
  });
  activeSyncPlay = new SyncPlayService(api, playback, logger, 5000, applicationPreferences);
  activeYouTubeRooms = new YouTubeRoomService(api);
  activePlayerFeatures = new PlayerFeaturesService(api, playback, downloadManager, () => Boolean(activeSyncPlay?.isJoined() || activeYouTubeRooms?.getState().room));
  playbackCommands.setPlayerFeatures(activePlayerFeatures);
  activePlayerFeatures.onState((state) => {
    updateController.activityChanged();
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(featureIpc.changed, state);
  });
  playbackCommands.setSyncPlay(activeSyncPlay);
  const companionState = new CompanionStateService(
    playback,
    playbackQueue,
    soloSessionDiagnostics,
    api,
    () => Boolean(activeSyncPlay?.isJoined() || activePlayerFeatures?.isJoined()),
    liveTvContext,
    () => activeSyncPlay?.getState() ?? null,
    playbackMetadata,
  );
  const companionCredentials = new CompanionCredentialStore(app.getPath("userData"), sessionProtector);
  const companionArtwork = new CompanionArtworkService(api, companionState);
  const youtubeApiKeyStore = new YouTubeApiKeyStore(app.getPath("userData"), sessionProtector);
  await youtubeApiKeyStore.load();
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
    new CompanionYouTubeService(activeYouTubeRooms, () => youtubeApiKeyStore.getKey(), fetch, youtubeApiKeyStore),
  );
  activeCompanion.subscribe((state) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(IPC.companionChanged, state);
  });
  activeSyncPlay.onState((state) => {
    updateController.activityChanged();
    companionState.notifyWatchPartyChange();
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(IPC.watchPartiesChanged, state);
  });
  activeYouTubeRooms.onState((state) => {
    updateController.activityChanged();
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(IPC.youtubeRoomsChanged, state);
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
    trailerWindow,
    activeSmartDownloads,
    playbackMetadata,
    trickplay,
    !packagedProduction,
    updateController,
    activeYouTubeRooms,
    activePlayerFeatures,
    activeIptv,
    () => shuttingDown,
  );
  await mainWindow.loadURL(APP_URL);
  if (process.argv.includes("--open-iptv") || process.argv.includes("--iptv-beta")) {
    await mainWindow.webContents.executeJavaScript("document.getElementById('loginIptvButton')?.click()");
  }
  // Packaged Windows builds can occasionally miss ready-to-show while the
  // sandboxed renderer is warming up. Loading has completed at this point, so
  // make the primary window visible as a reliable fallback.
  if (!mainWindow.isDestroyed() && !mainWindow.isVisible()) mainWindow.show();
  // Update discovery starts after the renderer has loaded and never affects startup.
  updateController.start();
}).catch((error) => {
  logger.error("Application startup failed.", error);
  app.quit();
});

app.on("window-all-closed", () => app.quit());
