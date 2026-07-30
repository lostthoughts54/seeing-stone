import { app, type BrowserWindow, type IpcMain, type IpcMainInvokeEvent } from "electron";
import {
  IPC,
  type CleanMachineDiagnosticActionResult,
  type CleanMachineDiagnostics,
  type DownloadLocationSummary,
  type OpenSourceLicenseInventory,
  type RpcResult,
  type SoloSessionDiagnostics,
} from "../shared/contracts";
import {
  artworkSchema,
  downloadIdSchema,
  downloadKeepSchema,
  downloadStartSchema,
  emptySchema,
  episodesSchema,
  itemIdSchema,
  libraryItemsSchema,
  liveTvCancelScheduleSchema,
  liveTvCreateRecordingSchema,
  liveTvDeleteRecordingSchema,
  liveTvGuideSchema,
  liveTvPageSchema,
  liveTvPlaybackSchema,
  liveTvUpdateScheduleSchema,
  loginSchema,
  playbackFullscreenSchema,
  playbackIdSchema,
  playbackPauseSchema,
  playbackRateSchema,
  playbackSeekSchema,
  playbackStartSchema,
  playbackTrackSchema,
  playbackViewportSchema,
  playbackVolumeSchema,
  playbackAdapterPreferenceSchema,
  bufferingPolicyPreferenceSchema,
  searchSchema,
  serverUrlSchema,
  watchedStateSchema,
  watchPartyCreateSchema,
  watchPartyGroupSchema,
  watchPartyVisibilitySchema,
} from "../shared/schemas";
import type { ArtworkService } from "./services/artwork";
import type { DownloadManager } from "./services/downloadManager";
import type { OfflineSynchronizationService } from "./services/offlineSynchronization";
import { AppError, toPublicError } from "./services/errors";
import type { JellyfinApi } from "./services/jellyfinApi";
import type { PlayerController } from "./services/playerController";
import type { VideoViewport } from "./services/embeddedVideoHost";
import type { PlayerPreferencesService } from "./services/playerPreferences";
import type { PlayerAdapterLaunchStatus } from "./services/playerAdapterSelection";
import type { SyncPlayService } from "./services/syncPlay";
import { discoverServers } from "./services/serverDiscovery";

type Handler<T> = (input: unknown) => Promise<T> | T;

export interface DownloadLocationController {
  getSummary(): Promise<DownloadLocationSummary>;
  choose(): Promise<DownloadLocationSummary | null>;
  useDefault(): Promise<DownloadLocationSummary>;
  open(): Promise<{ opened: boolean }>;
}

export interface SoloSessionDiagnosticsProvider {
  getSnapshot(): Promise<SoloSessionDiagnostics>;
}

export interface OpenSourceLicensesProvider {
  list(): OpenSourceLicenseInventory;
}

export interface CleanMachineDiagnosticsProvider {
  getSnapshot(): Promise<CleanMachineDiagnostics>;
  copyReport(): Promise<CleanMachineDiagnosticActionResult>;
  saveReport(): Promise<CleanMachineDiagnosticActionResult>;
}

export interface PlaybackViewportSink {
  updateViewport(viewport: VideoViewport & { deviceScaleFactor?: number }): void;
}

function safeResult<T>(handler: Handler<T>): Handler<RpcResult<T>> {
  return async (input) => {
    try {
      return { ok: true, data: await handler(input) };
    } catch (error) {
      const safe = toPublicError(error);
      return {
        ok: false,
        error: {
          code: safe.code,
          message: safe.message,
          retryable: safe.status === undefined || safe.status >= 500,
        },
      };
    }
  };
}

function assertAuthorizedSender(event: IpcMainInvokeEvent, window: BrowserWindow): void {
  if (window.isDestroyed() || window.webContents.isDestroyed()
    || event.sender !== window.webContents || event.senderFrame !== event.sender.mainFrame) {
    throw new AppError("UNAUTHORIZED_IPC", "This request is not authorized.");
  }
  let url: URL;
  try { url = new URL(event.senderFrame.url); } catch { throw new AppError("UNAUTHORIZED_IPC", "This request is not authorized."); }
  if (url.protocol !== "app:" || url.hostname !== "bundle") throw new AppError("UNAUTHORIZED_IPC", "This request is not authorized.");
}

export function registerIpcHandlers(
  ipcMain: IpcMain,
  window: BrowserWindow,
  api: JellyfinApi,
  artwork: ArtworkService,
  playback: PlayerController,
  downloads: DownloadManager,
  synchronization: Pick<OfflineSynchronizationService, "activate" | "deactivate" | "setWatched">,
  syncPlay?: SyncPlayService,
  downloadLocation?: DownloadLocationController,
  videoHost?: PlaybackViewportSink,
  playerPreferences?: PlayerPreferencesService,
  playerAdapterStatus?: PlayerAdapterLaunchStatus,
  soloSessionDiagnostics?: SoloSessionDiagnosticsProvider,
  openSourceLicenses?: OpenSourceLicensesProvider,
  cleanMachineDiagnostics?: CleanMachineDiagnosticsProvider,
): void {
  const register = <T>(channel: string, handler: Handler<T>): void => {
    ipcMain.handle(channel, async (event, input) => {
      try {
        assertAuthorizedSender(event, window);
      } catch (error) {
        const safe = toPublicError(error);
        return { ok: false, error: { code: safe.code, message: safe.message, retryable: false } } satisfies RpcResult<never>;
      }
      return safeResult(handler)(input);
    });
  };

  register(IPC.applicationClose, (input) => {
    emptySchema.strict().parse(input ?? {});
    window.close();
  });
  register(IPC.serverDiscover, () => discoverServers());
  register(IPC.serverConnect, (input) => api.connect(serverUrlSchema.strict().parse(input).url));
  register(IPC.sessionLogin, async (input) => {
    const value = loginSchema.strict().parse(input);
    await syncPlay?.deactivate();
    artwork.clear();
    await playback.clear();
    await downloads.deactivate();
    synchronization.deactivate();
    const session = await api.login(value.connectionId, value.username, value.password, value.remember);
    await downloads.activate();
    synchronization.activate();
    await syncPlay?.activate();
    return session;
  });
  register(IPC.sessionRestore, async () => {
    await syncPlay?.deactivate();
    await downloads.deactivate();
    synchronization.deactivate();
    const session = await api.restore();
    artwork.clear();
    await playback.clear();
    if (session.authenticated) {
      await downloads.activate();
      synchronization.activate();
      await syncPlay?.activate();
    }
    return session;
  });
  register(IPC.sessionGetState, () => api.getSafeSession());
  register(IPC.sessionLogout, async () => {
    await syncPlay?.deactivate();
    artwork.clear();
    await playback.clear();
    await downloads.deactivate();
    synchronization.deactivate();
    return api.logout();
  });
  register(IPC.homeGet, () => api.getHome());
  register(IPC.librariesList, () => api.getLibraries());
  register(IPC.librariesGetItems, (input) => {
    const value = libraryItemsSchema.strict().parse(input);
    return api.getLibraryItems(value.libraryId, value.type, value.limit);
  });
  register(IPC.searchQuery, (input) => api.search(searchSchema.strict().parse(input).query));
  register(IPC.itemsGetDetails, (input) => api.getDetails(itemIdSchema.strict().parse(input).itemId));
  register(IPC.itemsOpenTrailer, async (input) => ({ opened: await api.openTrailer(itemIdSchema.strict().parse(input).itemId) }));
  register(IPC.itemsSetWatched, (input) => {
    const value = watchedStateSchema.strict().parse(input);
    return synchronization.setWatched(value.itemId, value.watched);
  });
  register(IPC.showsGetSeasons, (input) => api.getSeasons(itemIdSchema.strict().parse(input).itemId));
  register(IPC.showsGetEpisodes, (input) => {
    const value = episodesSchema.strict().parse(input);
    return api.getEpisodes(value.seriesId, value.seasonId);
  });
  register(IPC.artworkGetUrl, (input) => artwork.getUrl(artworkSchema.strict().parse(input)));
  register(IPC.mediaSourcesGetCapabilities, (input) => api.getMediaSourceCapabilities(itemIdSchema.strict().parse(input).itemId));
  register(IPC.liveTvGetStatus, (input) => {
    emptySchema.strict().parse(input ?? {});
    return api.getLiveTvStatus();
  });
  register(IPC.liveTvGetGuide, (input) => {
    const value = liveTvGuideSchema.parse(input);
    return api.getLiveTvGuide(value.startUtc, value.endUtc);
  });
  register(IPC.liveTvGetRecordings, (input) => {
    const value = liveTvPageSchema.parse(input ?? {});
    return api.getLiveTvRecordings(value.startIndex, value.limit);
  });
  register(IPC.liveTvGetTimers, (input) => {
    emptySchema.strict().parse(input ?? {});
    return api.getLiveTvTimers();
  });
  register(IPC.liveTvGetSeriesTimers, (input) => {
    emptySchema.strict().parse(input ?? {});
    return api.getLiveTvSeriesTimers();
  });
  register(IPC.liveTvCreateRecording, async (input) => {
    const value = liveTvCreateRecordingSchema.parse(input);
    await api.createLiveTvRecording(value.programId, value.series, value.options);
  });
  register(IPC.liveTvUpdateSchedule, async (input) => {
    const value = liveTvUpdateScheduleSchema.parse(input);
    await api.updateLiveTvSchedule(value.id, value.series, value.options);
  });
  register(IPC.liveTvCancelSchedule, async (input) => {
    const value = liveTvCancelScheduleSchema.parse(input);
    await api.cancelLiveTvSchedule(value.id, value.series);
  });
  register(IPC.liveTvDeleteRecording, async (input) => {
    await api.deleteLiveTvRecording(liveTvDeleteRecordingSchema.parse(input).recordingId);
  });
  register(IPC.downloadsList, (input) => {
    emptySchema.strict().parse(input ?? {});
    return downloads.list();
  });
  register(IPC.downloadsListOfflinePlayable, (input) => {
    emptySchema.strict().parse(input ?? {});
    return downloads.listOfflinePlayable();
  });
  register(IPC.downloadsGetLocation, (input) => {
    emptySchema.strict().parse(input ?? {});
    if (!downloadLocation) throw new AppError("DOWNLOAD_LOCATION_UNAVAILABLE", "Download location settings are unavailable.", 503);
    return downloadLocation.getSummary();
  });
  register(IPC.downloadsChooseLocation, (input) => {
    emptySchema.strict().parse(input ?? {});
    if (!downloadLocation) throw new AppError("DOWNLOAD_LOCATION_UNAVAILABLE", "Download location settings are unavailable.", 503);
    return downloadLocation.choose();
  });
  register(IPC.downloadsUseDefaultLocation, (input) => {
    emptySchema.strict().parse(input ?? {});
    if (!downloadLocation) throw new AppError("DOWNLOAD_LOCATION_UNAVAILABLE", "Download location settings are unavailable.", 503);
    return downloadLocation.useDefault();
  });
  register(IPC.downloadsOpenLocation, (input) => {
    emptySchema.strict().parse(input ?? {});
    if (!downloadLocation) throw new AppError("DOWNLOAD_LOCATION_UNAVAILABLE", "Download location settings are unavailable.", 503);
    return downloadLocation.open();
  });
  register(IPC.downloadsStart, (input) => downloads.start(downloadStartSchema.strict().parse(input).itemId));
  register(IPC.downloadsPause, (input) => downloads.pause(downloadIdSchema.strict().parse(input).downloadId));
  register(IPC.downloadsResume, (input) => downloads.resume(downloadIdSchema.strict().parse(input).downloadId));
  register(IPC.downloadsRetry, (input) => downloads.retry(downloadIdSchema.strict().parse(input).downloadId));
  register(IPC.downloadsCancel, (input) => downloads.cancel(downloadIdSchema.strict().parse(input).downloadId));
  register(IPC.downloadsDelete, (input) => downloads.delete(downloadIdSchema.strict().parse(input).downloadId));
  register(IPC.downloadsSetKeep, (input) => {
    const value = downloadKeepSchema.strict().parse(input);
    return downloads.setKeep(value.downloadId, value.keepDownloaded);
  });
  register(IPC.playbackStart, (input) => {
    const value = playbackStartSchema.strict().parse(input);
    if (syncPlay?.isJoined()) return syncPlay.selectItem(value.itemId, value.resumeMode);
    return playback.loadItem(value.itemId, value.resumeMode, { origin: "local-user" });
  });
  register(IPC.playbackStartLive, (input) => {
    const value = liveTvPlaybackSchema.parse(input);
    if (syncPlay?.isJoined()) throw new AppError("LIVE_TV_WATCH_PARTY_UNAVAILABLE", "Live TV cannot be started in a watch party.", 409);
    return playback.loadItem(value.channelId, "start-over", { origin: "local-user" });
  });
  register(IPC.playbackSetPaused, (input) => {
    const value = playbackPauseSchema.strict().parse(input);
    if (syncPlay?.isJoined()) return syncPlay.requestPaused(value.paused);
    return playback.setPaused(value.playbackId, value.paused, { origin: "local-user" });
  });
  register(IPC.playbackSeek, (input) => {
    const value = playbackSeekSchema.strict().parse(input);
    if (playback.getState().contentKind === "live-tv") {
      throw new AppError("LIVE_TV_SEEK_UNAVAILABLE", "Use Go Live to return to the current live edge.", 422);
    }
    if (syncPlay?.isJoined()) return syncPlay.requestSeek(value.positionTicks);
    return playback.seek(value.playbackId, value.positionTicks, { origin: "local-user" });
  });
  register(IPC.playbackSetRate, (input) => {
    const value = playbackRateSchema.strict().parse(input);
    return playback.setRate(value.playbackId, value.rate, { origin: "local-user" });
  });
  register(IPC.playbackSetVolume, (input) => {
    const value = playbackVolumeSchema.strict().parse(input);
    return playback.setVolume(value.playbackId, value.volume, { origin: "local-user" });
  });
  register(IPC.playbackSelectAudio, (input) => {
    const value = playbackTrackSchema.strict().parse(input);
    return playback.selectAudio(value.playbackId, value.trackId);
  });
  register(IPC.playbackSelectSubtitle, (input) => {
    const value = playbackTrackSchema.strict().parse(input);
    return playback.selectSubtitle(value.playbackId, value.trackId);
  });
  register(IPC.playbackSetFullscreen, (input) => {
    const value = playbackFullscreenSchema.strict().parse(input);
    return playback.setFullscreen(value.playbackId, value.fullscreen, { origin: "local-user" });
  });
  register(IPC.playbackContinueNextEpisode, (input) => {
    const value = playbackIdSchema.strict().parse(input);
    return playback.continueNextEpisode(value.playbackId, { origin: "local-user" });
  });
  register(IPC.playbackCancelNextEpisode, (input) => {
    const value = playbackIdSchema.strict().parse(input);
    return playback.cancelNextEpisode(value.playbackId, { origin: "local-user" });
  });
  register(IPC.playbackStop, (input) => {
    const value = playbackIdSchema.strict().parse(input);
    if (syncPlay?.isJoined()) return syncPlay.requestStop();
    return playback.stop(value.playbackId, "stopped", { origin: "local-user" });
  });
  register(IPC.playbackGetState, () => playback.getState());
  register(IPC.playbackSetViewport, (input) => {
    const viewport = playbackViewportSchema.strict().parse(input);
    videoHost?.updateViewport(viewport);
    return { embedded: Boolean(videoHost) };
  });
  const adapterPreference = async () => {
    if (!playerPreferences) throw new AppError("PLAYER_PREFERENCES_UNAVAILABLE", "Player preferences are unavailable.", 503);
    const selected = (await playerPreferences.get()).adapterMode ?? "legacy";
    const active = playerAdapterStatus?.active ?? (videoHost ? "embedded" : "legacy");
    const launchSelection = playerAdapterStatus?.launchSelection ?? active;
    return {
      active,
      selected,
      launchSelection,
      embeddedAvailable: playerAdapterStatus?.embeddedAvailable ?? true,
      libmpvAvailable: playerAdapterStatus?.libmpvAvailable ?? false,
      fallbackActive: playerAdapterStatus?.fallbackActive ?? false,
      fallbackFrom: playerAdapterStatus?.fallbackFrom ?? null,
      fallbackReason: playerAdapterStatus?.fallbackReason ?? null,
      restartRequired: selected !== launchSelection,
    } as const;
  };
  register(IPC.playbackGetAdapterPreference, adapterPreference);
  register(IPC.playbackSetAdapterPreference, async (input) => {
    if (!playerPreferences) throw new AppError("PLAYER_PREFERENCES_UNAVAILABLE", "Player preferences are unavailable.", 503);
    const { mode } = playbackAdapterPreferenceSchema.strict().parse(input);
    await playerPreferences.setAdapterMode(mode);
    return adapterPreference();
  });
  register(IPC.sessionPanelGetSolo, (input) => {
    emptySchema.strict().parse(input ?? {});
    if (!soloSessionDiagnostics) throw new AppError("SESSION_DIAGNOSTICS_UNAVAILABLE", "Session diagnostics are unavailable.", 503);
    return soloSessionDiagnostics.getSnapshot();
  });
  register(IPC.licensesList, (input) => {
    emptySchema.strict().parse(input ?? {});
    if (!openSourceLicenses) throw new AppError("LICENSES_UNAVAILABLE", "Open source license information is unavailable.", 503);
    return openSourceLicenses.list();
  });
  register(IPC.diagnosticsGetCleanMachine, (input) => {
    emptySchema.strict().parse(input ?? {});
    if (!cleanMachineDiagnostics) throw new AppError("DIAGNOSTICS_UNAVAILABLE", "Clean-machine diagnostics are unavailable.", 503);
    return cleanMachineDiagnostics.getSnapshot();
  });
  register(IPC.diagnosticsCopyCleanMachine, (input) => {
    emptySchema.strict().parse(input ?? {});
    if (!cleanMachineDiagnostics) throw new AppError("DIAGNOSTICS_UNAVAILABLE", "Clean-machine diagnostics are unavailable.", 503);
    return cleanMachineDiagnostics.copyReport();
  });
  register(IPC.diagnosticsSaveCleanMachine, (input) => {
    emptySchema.strict().parse(input ?? {});
    if (!cleanMachineDiagnostics) throw new AppError("DIAGNOSTICS_UNAVAILABLE", "Clean-machine diagnostics are unavailable.", 503);
    return cleanMachineDiagnostics.saveReport();
  });
  const requireSyncPlay = (): SyncPlayService => {
    if (!syncPlay) throw new AppError("SYNCPLAY_UNAVAILABLE", "Watch parties are unavailable in this build.", 503);
    return syncPlay;
  };
  register(IPC.watchPartiesGetState, (input) => {
    emptySchema.strict().parse(input ?? {});
    return requireSyncPlay().getState();
  });
  register(IPC.watchPartiesList, (input) => {
    emptySchema.strict().parse(input ?? {});
    return requireSyncPlay().list();
  });
  register(IPC.watchPartiesCreate, (input) => requireSyncPlay().create(watchPartyCreateSchema.strict().parse(input).name));
  register(IPC.watchPartiesJoin, (input) => requireSyncPlay().join(watchPartyGroupSchema.strict().parse(input).groupId));
  register(IPC.watchPartiesLeave, (input) => {
    emptySchema.strict().parse(input ?? {});
    return requireSyncPlay().leave();
  });
  register(IPC.watchPartiesWait, (input) => {
    emptySchema.strict().parse(input ?? {});
    return requireSyncPlay().waitForAll();
  });
  register(IPC.watchPartiesContinue, (input) => {
    emptySchema.strict().parse(input ?? {});
    return requireSyncPlay().continueAfterBuffering();
  });
  register(IPC.watchPartiesResync, (input) => {
    emptySchema.strict().parse(input ?? {});
    return requireSyncPlay().resyncGroup();
  });
  register(IPC.watchPartiesSetBufferingPolicy, (input) => requireSyncPlay().setBufferingPolicy(
    bufferingPolicyPreferenceSchema.strict().parse(input).mode,
  ));
  register(IPC.watchPartiesSetVisible, (input) => requireSyncPlay().setViewVisible(watchPartyVisibilitySchema.strict().parse(input).visible));
}
