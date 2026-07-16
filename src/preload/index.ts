import { contextBridge, ipcRenderer } from "electron";
import {
  IPC,
  type ArtworkInput,
  type DiscoveredServer,
  type DownloadIdInput,
  type DownloadKeepInput,
  type DownloadLocationSummary,
  type DownloadStartInput,
  type DownloadSummary,
  type EpisodesInput,
  type HomePayload,
  type ItemIdInput,
  type JellyfinBridge,
  type LibraryItemsInput,
  type LibrarySummary,
  type LoginInput,
  type MediaItem,
  type MediaSourceCapabilities,
  type PlaybackIdInput,
  type PlaybackFullscreenInput,
  type PlaybackPauseInput,
  type PlaybackRateInput,
  type PlaybackSeekInput,
  type PlaybackStartInput,
  type PlaybackStartResult,
  type PlaybackState,
  type PlaybackTrackInput,
  type PlaybackViewportInput,
  type PlaybackVolumeInput,
  type PlaybackAdapterPreference,
  type PlaybackAdapterPreferenceInput,
  type RpcResult,
  type SafeSession,
  type SearchInput,
  type ServerConnection,
  type ServerUrlInput,
  type WatchedStateInput,
  type WatchedStateResult,
  type WatchPartyCreateInput,
  type WatchPartyGroupInput,
  type WatchPartyVisibilityInput,
  type WatchPartyViewState,
} from "../shared/contracts";

async function invoke<T>(channel: string, input?: unknown): Promise<T> {
  const result = await ipcRenderer.invoke(channel, input) as RpcResult<T>;
  if (!result || typeof result !== "object" || typeof result.ok !== "boolean") throw new Error("The application returned an invalid response.");
  if (!result.ok) {
    // Plain data survives Electron's isolated-world promise bridge intact.
    // Error instances are normalized and lose an assigned application code.
    throw Object.freeze({
      code: result.error.code,
      message: result.error.message,
      retryable: result.error.retryable,
    });
  }
  return result.data;
}

const bridge: JellyfinBridge = {
  server: {
    discover: () => invoke<DiscoveredServer[]>(IPC.serverDiscover),
    connect: (input: ServerUrlInput) => invoke<ServerConnection>(IPC.serverConnect, input),
  },
  session: {
    login: (input: LoginInput) => invoke<SafeSession>(IPC.sessionLogin, input),
    restore: () => invoke<SafeSession>(IPC.sessionRestore),
    getState: () => invoke<SafeSession>(IPC.sessionGetState),
    logout: () => invoke<SafeSession>(IPC.sessionLogout),
  },
  home: { get: () => invoke<HomePayload>(IPC.homeGet) },
  libraries: {
    list: () => invoke<LibrarySummary[]>(IPC.librariesList),
    getItems: (input: LibraryItemsInput) => invoke<MediaItem[]>(IPC.librariesGetItems, input),
  },
  search: { query: (input: SearchInput) => invoke<MediaItem[]>(IPC.searchQuery, input) },
  items: {
    getDetails: (input: ItemIdInput) => invoke<MediaItem>(IPC.itemsGetDetails, input),
    openTrailer: (input: ItemIdInput) => invoke<{ opened: boolean }>(IPC.itemsOpenTrailer, input),
    setWatched: (input: WatchedStateInput) => invoke<WatchedStateResult>(IPC.itemsSetWatched, input),
  },
  shows: {
    getSeasons: (input: ItemIdInput) => invoke<MediaItem[]>(IPC.showsGetSeasons, input),
    getEpisodes: (input: EpisodesInput) => invoke<MediaItem[]>(IPC.showsGetEpisodes, input),
  },
  artwork: { getUrl: (input: ArtworkInput) => invoke<string>(IPC.artworkGetUrl, input) },
  mediaSources: {
    getCapabilities: (input: ItemIdInput) => invoke<MediaSourceCapabilities>(IPC.mediaSourcesGetCapabilities, input),
  },
  downloads: {
    list: () => invoke<DownloadSummary[]>(IPC.downloadsList),
    getLocation: () => invoke<DownloadLocationSummary>(IPC.downloadsGetLocation),
    chooseLocation: () => invoke<DownloadLocationSummary | null>(IPC.downloadsChooseLocation),
    useDefaultLocation: () => invoke<DownloadLocationSummary>(IPC.downloadsUseDefaultLocation),
    openLocation: () => invoke<{ opened: boolean }>(IPC.downloadsOpenLocation),
    start: (input: DownloadStartInput) => invoke<DownloadSummary>(IPC.downloadsStart, input),
    pause: (input: DownloadIdInput) => invoke<DownloadSummary>(IPC.downloadsPause, input),
    resume: (input: DownloadIdInput) => invoke<DownloadSummary>(IPC.downloadsResume, input),
    retry: (input: DownloadIdInput) => invoke<DownloadSummary>(IPC.downloadsRetry, input),
    cancel: (input: DownloadIdInput) => invoke<DownloadSummary>(IPC.downloadsCancel, input),
    delete: (input: DownloadIdInput) => invoke<DownloadSummary>(IPC.downloadsDelete, input),
    setKeep: (input: DownloadKeepInput) => invoke<DownloadSummary>(IPC.downloadsSetKeep, input),
    subscribe: (listener: (downloads: DownloadSummary[]) => void) => {
      const receive = (_event: Electron.IpcRendererEvent, downloads: DownloadSummary[]) => listener(downloads);
      ipcRenderer.on(IPC.downloadsChanged, receive);
      return () => ipcRenderer.removeListener(IPC.downloadsChanged, receive);
    },
  },
  playback: {
    start: (input: PlaybackStartInput) => invoke<PlaybackStartResult>(IPC.playbackStart, input),
    setPaused: (input: PlaybackPauseInput) => invoke<PlaybackState>(IPC.playbackSetPaused, input),
    seek: (input: PlaybackSeekInput) => invoke<PlaybackState>(IPC.playbackSeek, input),
    setRate: (input: PlaybackRateInput) => invoke<PlaybackState>(IPC.playbackSetRate, input),
    setVolume: (input: PlaybackVolumeInput) => invoke<PlaybackState>(IPC.playbackSetVolume, input),
    selectAudio: (input: PlaybackTrackInput) => invoke<PlaybackState>(IPC.playbackSelectAudio, input),
    selectSubtitle: (input: PlaybackTrackInput) => invoke<PlaybackState>(IPC.playbackSelectSubtitle, input),
    setFullscreen: (input: PlaybackFullscreenInput) => invoke<PlaybackState>(IPC.playbackSetFullscreen, input),
    stop: (input: PlaybackIdInput) => invoke<PlaybackState>(IPC.playbackStop, input),
    getState: () => invoke<PlaybackState>(IPC.playbackGetState),
    setViewport: (input: PlaybackViewportInput) => invoke<{ embedded: boolean }>(IPC.playbackSetViewport, input),
    getAdapterPreference: () => invoke<PlaybackAdapterPreference>(IPC.playbackGetAdapterPreference),
    setAdapterPreference: (input: PlaybackAdapterPreferenceInput) => invoke<PlaybackAdapterPreference>(IPC.playbackSetAdapterPreference, input),
    subscribe: (listener: (state: PlaybackState) => void) => {
      const receive = (_event: Electron.IpcRendererEvent, state: PlaybackState) => listener(state);
      ipcRenderer.on(IPC.playbackStateChanged, receive);
      return () => ipcRenderer.removeListener(IPC.playbackStateChanged, receive);
    },
  },
  watchParties: {
    getState: () => invoke<WatchPartyViewState>(IPC.watchPartiesGetState),
    list: () => invoke<WatchPartyViewState>(IPC.watchPartiesList),
    create: (input: WatchPartyCreateInput) => invoke<WatchPartyViewState>(IPC.watchPartiesCreate, input),
    join: (input: WatchPartyGroupInput) => invoke<WatchPartyViewState>(IPC.watchPartiesJoin, input),
    leave: () => invoke<WatchPartyViewState>(IPC.watchPartiesLeave),
    resync: () => invoke<PlaybackState>(IPC.watchPartiesResync),
    setVisible: (input: WatchPartyVisibilityInput) => invoke<WatchPartyViewState>(IPC.watchPartiesSetVisible, input),
    subscribe: (listener: (state: WatchPartyViewState) => void) => {
      const receive = (_event: Electron.IpcRendererEvent, state: WatchPartyViewState) => listener(state);
      ipcRenderer.on(IPC.watchPartiesChanged, receive);
      return () => ipcRenderer.removeListener(IPC.watchPartiesChanged, receive);
    },
  },
};

for (const value of Object.values(bridge)) Object.freeze(value);
Object.freeze(bridge);

contextBridge.exposeInMainWorld("jellyfin", bridge);
