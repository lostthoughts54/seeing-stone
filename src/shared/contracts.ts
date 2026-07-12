export type ItemType = "Movie" | "Series" | "Season" | "Episode" | "BoxSet" | "Video";
export type ImageKind = "Primary" | "Backdrop" | "Thumb";

export interface SafeUserData {
  played: boolean;
  playbackPositionTicks: number;
  playedPercentage: number;
}

export interface MediaItem {
  id: string;
  name: string;
  type: ItemType;
  overview: string;
  productionYear: number | null;
  premiereYear: number | null;
  officialRating: string | null;
  communityRating: number | null;
  runTimeTicks: number;
  genres: string[];
  primaryImageAspectRatio: number | null;
  imageTags: Partial<Record<ImageKind, string>>;
  backdropImageTag: string | null;
  parentThumbItemId: string | null;
  parentThumbImageTag: string | null;
  seriesId: string | null;
  seriesName: string | null;
  seasonId: string | null;
  indexNumber: number | null;
  parentIndexNumber: number | null;
  userData: SafeUserData;
  hasTrailer: boolean;
  playable: boolean;
}

export interface LibrarySummary {
  id: string;
  name: string;
  collectionType: string | null;
}

export interface HomePayload {
  libraries: LibrarySummary[];
  resumeItems: MediaItem[];
  nextUpItems: MediaItem[];
  latestRows: Array<{ library: LibrarySummary; items: MediaItem[] }>;
}

export interface PublicServerInfo {
  address: string;
  id: string;
  name: string;
  version: string;
}

export interface ServerConnection extends PublicServerInfo {
  connectionId: string;
}

export interface DiscoveredServer extends PublicServerInfo {
  endpointAddress: string;
  network: string;
  score: number;
  source: "udp" | "lan-scan" | "localhost";
}

export interface SafeSession {
  authenticated: boolean;
  persistence: "protected" | "memory-only" | "none";
  server: PublicServerInfo | null;
  user: { id: string; name: string } | null;
}

export interface MediaSourceCapabilities {
  itemId: string;
  sources: Array<{
    id: string;
    container: string | null;
    size: number | null;
    supportsDirectPlay: boolean;
    supportsDirectStream: boolean;
    supportsTranscoding: boolean;
  }>;
}

export interface PlaybackStartResult {
  playbackId: string;
  resumePositionTicks: number;
  durationTicks: number;
  source: "server" | "local";
}

export interface PlaybackTrack {
  id: number;
  type: "audio" | "subtitle";
  title: string | null;
  language: string | null;
  selected: boolean;
}

export interface PlaybackState {
  playbackId: string | null;
  itemId: string | null;
  phase: "idle" | "resolving" | "loading" | "playing" | "paused" | "buffering" | "ended" | "stopped" | "error";
  source: "server" | "local" | null;
  positionTicks: number;
  durationTicks: number;
  paused: boolean;
  buffering: boolean;
  seekable: boolean;
  fullscreen: boolean;
  audioTracks: PlaybackTrack[];
  subtitleTracks: PlaybackTrack[];
  error: string | null;
}

export type RpcResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string; retryable: boolean } };

export interface ServerUrlInput { url: string }
export interface LoginInput { connectionId: string; username: string; password: string; remember: boolean }
export interface ItemIdInput { itemId: string }
export interface LibraryItemsInput { type: "Movie" | "Series"; limit: number }
export interface SearchInput { query: string }
export interface EpisodesInput { seriesId: string; seasonId: string }
export interface ArtworkInput { itemId: string; kind: ImageKind; tag?: string; width?: number; height?: number }
export interface PlaybackStartInput { itemId: string; resumeMode: "resume" | "start-over" }
export interface PlaybackIdInput { playbackId: string }
export interface PlaybackPauseInput extends PlaybackIdInput { paused: boolean }
export interface PlaybackSeekInput extends PlaybackIdInput { positionTicks: number }
export interface PlaybackTrackInput extends PlaybackIdInput { trackId: number | null }
export interface PlaybackFullscreenInput extends PlaybackIdInput { fullscreen: boolean }

export interface JellyfinBridge {
  server: {
    discover(): Promise<DiscoveredServer[]>;
    connect(input: ServerUrlInput): Promise<ServerConnection>;
  };
  session: {
    login(input: LoginInput): Promise<SafeSession>;
    restore(): Promise<SafeSession>;
    getState(): Promise<SafeSession>;
    logout(): Promise<SafeSession>;
  };
  home: { get(): Promise<HomePayload> };
  libraries: {
    list(): Promise<LibrarySummary[]>;
    getItems(input: LibraryItemsInput): Promise<MediaItem[]>;
  };
  search: { query(input: SearchInput): Promise<MediaItem[]> };
  items: {
    getDetails(input: ItemIdInput): Promise<MediaItem>;
    openTrailer(input: ItemIdInput): Promise<{ opened: boolean }>;
  };
  shows: {
    getSeasons(input: ItemIdInput): Promise<MediaItem[]>;
    getEpisodes(input: EpisodesInput): Promise<MediaItem[]>;
  };
  artwork: {
    getUrl(input: ArtworkInput): Promise<string>;
  };
  mediaSources: {
    getCapabilities(input: ItemIdInput): Promise<MediaSourceCapabilities>;
  };
  playback: {
    start(input: PlaybackStartInput): Promise<PlaybackStartResult>;
    setPaused(input: PlaybackPauseInput): Promise<PlaybackState>;
    seek(input: PlaybackSeekInput): Promise<PlaybackState>;
    selectAudio(input: PlaybackTrackInput): Promise<PlaybackState>;
    selectSubtitle(input: PlaybackTrackInput): Promise<PlaybackState>;
    setFullscreen(input: PlaybackFullscreenInput): Promise<PlaybackState>;
    stop(input: PlaybackIdInput): Promise<PlaybackState>;
    getState(): Promise<PlaybackState>;
    subscribe(listener: (state: PlaybackState) => void): () => void;
  };
}

export const IPC = {
  serverDiscover: "server:discover",
  serverConnect: "server:connect",
  sessionLogin: "session:login",
  sessionRestore: "session:restore",
  sessionGetState: "session:get-state",
  sessionLogout: "session:logout",
  homeGet: "home:get",
  librariesList: "libraries:list",
  librariesGetItems: "libraries:get-items",
  searchQuery: "search:query",
  itemsGetDetails: "items:get-details",
  itemsOpenTrailer: "items:open-trailer",
  showsGetSeasons: "shows:get-seasons",
  showsGetEpisodes: "shows:get-episodes",
  artworkGetUrl: "artwork:get-url",
  mediaSourcesGetCapabilities: "media-sources:get-capabilities",
  playbackStart: "playback:start",
  playbackSetPaused: "playback:set-paused",
  playbackSeek: "playback:seek",
  playbackSelectAudio: "playback:select-audio",
  playbackSelectSubtitle: "playback:select-subtitle",
  playbackSetFullscreen: "playback:set-fullscreen",
  playbackStop: "playback:stop",
  playbackGetState: "playback:get-state",
  playbackStateChanged: "playback:state-changed",
} as const;
