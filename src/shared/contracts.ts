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
    externalSubtitles?: ExternalSubtitleTrack[];
  }>;
}

export type ExternalSubtitleFormat = "srt" | "ass" | "ssa" | "vtt";

export interface ExternalSubtitleTrack {
  streamIndex: number;
  format: ExternalSubtitleFormat;
  title: string | null;
  language: string | null;
  isDefault: boolean;
  isForced: boolean;
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

export type DownloadState = "queued" | "downloading" | "paused" | "downloaded" | "failed" | "missing";

export interface DownloadSummary {
  downloadId: string;
  itemId: string;
  name: string;
  itemType: "Movie" | "Episode" | "Video";
  state: DownloadState;
  bytesDownloaded: number;
  expectedSize: number | null;
  progressPercent: number | null;
  keepDownloaded: boolean;
  error: { code: string; message: string } | null;
  canPause: boolean;
  canResume: boolean;
  canRetry: boolean;
  canCancel: boolean;
  canDelete: boolean;
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
export interface DownloadStartInput { itemId: string }
export interface DownloadIdInput { downloadId: string }
export interface DownloadKeepInput extends DownloadIdInput { keepDownloaded: boolean }
export interface WatchedStateInput { itemId: string; watched: boolean }
export interface WatchedStateResult {
  itemId: string;
  watched: boolean;
  synchronization: "synchronized" | "queued";
}

export type WatchPartyPlaybackState = "Idle" | "Waiting" | "Paused" | "Playing";

export interface WatchPartySummary {
  groupId: string;
  name: string;
  playbackState: WatchPartyPlaybackState;
  participants: string[];
  participantCount: number;
  lastUpdatedAt: string;
}

export interface JoinedWatchParty extends WatchPartySummary {
  currentItemId: string | null;
  playlistItemId: string | null;
}

export interface WatchPartyViewState {
  availability: "signed-out" | "connecting" | "available" | "denied" | "unsupported" | "offline";
  connection: "disconnected" | "connecting" | "connected";
  groups: WatchPartySummary[];
  joinedGroup: JoinedWatchParty | null;
  sharedControls: boolean;
  error: { code: string; message: string } | null;
}

export interface WatchPartyCreateInput { name: string }
export interface WatchPartyGroupInput { groupId: string }
export interface WatchPartyVisibilityInput { visible: boolean }

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
    setWatched(input: WatchedStateInput): Promise<WatchedStateResult>;
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
  downloads: {
    list(): Promise<DownloadSummary[]>;
    start(input: DownloadStartInput): Promise<DownloadSummary>;
    pause(input: DownloadIdInput): Promise<DownloadSummary>;
    resume(input: DownloadIdInput): Promise<DownloadSummary>;
    retry(input: DownloadIdInput): Promise<DownloadSummary>;
    cancel(input: DownloadIdInput): Promise<DownloadSummary>;
    delete(input: DownloadIdInput): Promise<DownloadSummary>;
    setKeep(input: DownloadKeepInput): Promise<DownloadSummary>;
    subscribe(listener: (downloads: DownloadSummary[]) => void): () => void;
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
  watchParties: {
    getState(): Promise<WatchPartyViewState>;
    list(): Promise<WatchPartyViewState>;
    create(input: WatchPartyCreateInput): Promise<WatchPartyViewState>;
    join(input: WatchPartyGroupInput): Promise<WatchPartyViewState>;
    leave(): Promise<WatchPartyViewState>;
    resync(): Promise<PlaybackState>;
    setVisible(input: WatchPartyVisibilityInput): Promise<WatchPartyViewState>;
    subscribe(listener: (state: WatchPartyViewState) => void): () => void;
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
  itemsSetWatched: "items:set-watched",
  showsGetSeasons: "shows:get-seasons",
  showsGetEpisodes: "shows:get-episodes",
  artworkGetUrl: "artwork:get-url",
  mediaSourcesGetCapabilities: "media-sources:get-capabilities",
  downloadsList: "downloads:list",
  downloadsStart: "downloads:start",
  downloadsPause: "downloads:pause",
  downloadsResume: "downloads:resume",
  downloadsRetry: "downloads:retry",
  downloadsCancel: "downloads:cancel",
  downloadsDelete: "downloads:delete",
  downloadsSetKeep: "downloads:set-keep",
  downloadsChanged: "downloads:changed",
  playbackStart: "playback:start",
  playbackSetPaused: "playback:set-paused",
  playbackSeek: "playback:seek",
  playbackSelectAudio: "playback:select-audio",
  playbackSelectSubtitle: "playback:select-subtitle",
  playbackSetFullscreen: "playback:set-fullscreen",
  playbackStop: "playback:stop",
  playbackGetState: "playback:get-state",
  playbackStateChanged: "playback:state-changed",
  watchPartiesGetState: "watch-parties:get-state",
  watchPartiesList: "watch-parties:list",
  watchPartiesCreate: "watch-parties:create",
  watchPartiesJoin: "watch-parties:join",
  watchPartiesLeave: "watch-parties:leave",
  watchPartiesResync: "watch-parties:resync",
  watchPartiesSetVisible: "watch-parties:set-visible",
  watchPartiesChanged: "watch-parties:changed",
} as const;
