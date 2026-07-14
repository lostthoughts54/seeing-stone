import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from "electron";
import {
  IPC,
  type RpcResult,
} from "../shared/contracts";
import {
  artworkSchema,
  downloadIdSchema,
  downloadKeepSchema,
  downloadStartSchema,
  episodesSchema,
  itemIdSchema,
  libraryItemsSchema,
  loginSchema,
  playbackFullscreenSchema,
  playbackIdSchema,
  playbackPauseSchema,
  playbackSeekSchema,
  playbackStartSchema,
  playbackTrackSchema,
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
import type { SyncPlayService } from "./services/syncPlay";
import { discoverServers } from "./services/serverDiscovery";

type Handler<T> = (input: unknown) => Promise<T> | T;

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
    return api.getLibraryItems(value.type, value.limit);
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
  register(IPC.downloadsList, () => downloads.list());
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
  register(IPC.playbackSetPaused, (input) => {
    const value = playbackPauseSchema.strict().parse(input);
    if (syncPlay?.isJoined()) return syncPlay.requestPaused(value.paused);
    return playback.setPaused(value.playbackId, value.paused, { origin: "local-user" });
  });
  register(IPC.playbackSeek, (input) => {
    const value = playbackSeekSchema.strict().parse(input);
    if (syncPlay?.isJoined()) return syncPlay.requestSeek(value.positionTicks);
    return playback.seek(value.playbackId, value.positionTicks, { origin: "local-user" });
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
  register(IPC.playbackStop, (input) => {
    const value = playbackIdSchema.strict().parse(input);
    if (syncPlay?.isJoined()) return syncPlay.requestStop();
    return playback.stop(value.playbackId, "stopped", { origin: "local-user" });
  });
  register(IPC.playbackGetState, () => playback.getState());
  const requireSyncPlay = (): SyncPlayService => {
    if (!syncPlay) throw new AppError("SYNCPLAY_UNAVAILABLE", "Watch parties are unavailable in this build.", 503);
    return syncPlay;
  };
  register(IPC.watchPartiesGetState, () => requireSyncPlay().getState());
  register(IPC.watchPartiesList, () => requireSyncPlay().list());
  register(IPC.watchPartiesCreate, (input) => requireSyncPlay().create(watchPartyCreateSchema.strict().parse(input).name));
  register(IPC.watchPartiesJoin, (input) => requireSyncPlay().join(watchPartyGroupSchema.strict().parse(input).groupId));
  register(IPC.watchPartiesLeave, () => requireSyncPlay().leave());
  register(IPC.watchPartiesResync, () => requireSyncPlay().resyncLocal());
  register(IPC.watchPartiesSetVisible, (input) => requireSyncPlay().setViewVisible(watchPartyVisibilitySchema.strict().parse(input).visible));
}
