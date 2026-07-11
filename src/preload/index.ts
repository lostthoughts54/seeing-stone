import { contextBridge, ipcRenderer } from "electron";
import {
  IPC,
  type ArtworkInput,
  type DiscoveredServer,
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
  type PlaybackStartInput,
  type PlaybackStartResult,
  type PlaybackState,
  type PublicServerInfo,
  type RpcResult,
  type SafeSession,
  type SearchInput,
  type ServerUrlInput,
} from "../shared/contracts";

async function invoke<T>(channel: string, input?: unknown): Promise<T> {
  const result = await ipcRenderer.invoke(channel, input) as RpcResult<T>;
  if (!result || typeof result !== "object" || typeof result.ok !== "boolean") throw new Error("The application returned an invalid response.");
  if (!result.ok) {
    const error = new Error(result.error.message);
    error.name = result.error.code;
    throw error;
  }
  return result.data;
}

const bridge: JellyfinBridge = {
  server: {
    discover: () => invoke<DiscoveredServer[]>(IPC.serverDiscover),
    connect: (input: ServerUrlInput) => invoke<PublicServerInfo>(IPC.serverConnect, input),
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
  },
  shows: {
    getSeasons: (input: ItemIdInput) => invoke<MediaItem[]>(IPC.showsGetSeasons, input),
    getEpisodes: (input: EpisodesInput) => invoke<MediaItem[]>(IPC.showsGetEpisodes, input),
  },
  artwork: { getUrl: (input: ArtworkInput) => invoke<string>(IPC.artworkGetUrl, input) },
  mediaSources: {
    getCapabilities: (input: ItemIdInput) => invoke<MediaSourceCapabilities>(IPC.mediaSourcesGetCapabilities, input),
  },
  playback: {
    start: (input: PlaybackStartInput) => invoke<PlaybackStartResult>(IPC.playbackStart, input),
    stop: (input: PlaybackIdInput) => invoke<PlaybackState>(IPC.playbackStop, input),
    getState: () => invoke<PlaybackState>(IPC.playbackGetState),
  },
};

for (const value of Object.values(bridge)) Object.freeze(value);
Object.freeze(bridge);

contextBridge.exposeInMainWorld("jellyfin", bridge);
