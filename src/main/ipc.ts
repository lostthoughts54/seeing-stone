import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from "electron";
import {
  IPC,
  type RpcResult,
} from "../shared/contracts";
import {
  artworkSchema,
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
} from "../shared/schemas";
import type { ArtworkService } from "./services/artwork";
import { AppError, toPublicError } from "./services/errors";
import type { JellyfinApi } from "./services/jellyfinApi";
import type { MpvPlayerService } from "./services/mpvPlayer";
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
  playback: MpvPlayerService,
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
    artwork.clear();
    await playback.clear();
    return api.login(value.connectionId, value.username, value.password, value.remember);
  });
  register(IPC.sessionRestore, async () => {
    const session = await api.restore();
    artwork.clear();
    await playback.clear();
    return session;
  });
  register(IPC.sessionGetState, () => api.getSafeSession());
  register(IPC.sessionLogout, async () => {
    artwork.clear();
    await playback.clear();
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
  register(IPC.showsGetSeasons, (input) => api.getSeasons(itemIdSchema.strict().parse(input).itemId));
  register(IPC.showsGetEpisodes, (input) => {
    const value = episodesSchema.strict().parse(input);
    return api.getEpisodes(value.seriesId, value.seasonId);
  });
  register(IPC.artworkGetUrl, (input) => artwork.getUrl(artworkSchema.strict().parse(input)));
  register(IPC.mediaSourcesGetCapabilities, (input) => api.getMediaSourceCapabilities(itemIdSchema.strict().parse(input).itemId));
  register(IPC.playbackStart, (input) => {
    const value = playbackStartSchema.strict().parse(input);
    return playback.start(value.itemId, value.resumeMode);
  });
  register(IPC.playbackSetPaused, (input) => {
    const value = playbackPauseSchema.strict().parse(input);
    return playback.setPaused(value.playbackId, value.paused);
  });
  register(IPC.playbackSeek, (input) => {
    const value = playbackSeekSchema.strict().parse(input);
    return playback.seek(value.playbackId, value.positionTicks);
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
    return playback.setFullscreen(value.playbackId, value.fullscreen);
  });
  register(IPC.playbackStop, (input) => playback.stop(playbackIdSchema.strict().parse(input).playbackId));
  register(IPC.playbackGetState, () => playback.getState());
}
