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
    videoCodec?: string | null;
    audioCodec?: string | null;
    audioChannels?: string | null;
    width?: number | null;
    height?: number | null;
    bitrate?: number | null;
    videoRange?: string | null;
    transcodeReason?: string | null;
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
  sourceKind: PlaybackSourceKind;
}

export type PlaybackSourceKind = "matched-local" | "downloaded" | "direct-play" | "direct-stream" | "transcode" | "offline-local";

export interface PlaybackDiagnostics {
  sourceKind: PlaybackSourceKind | null;
  playbackRate: number;
  bufferAheadTicks: number | null;
  container: string | null;
  videoCodec: string | null;
  audioCodec: string | null;
  audioChannels: string | null;
  resolution: string | null;
  bitrate: number | null;
  videoRange: string | null;
  transcodeReason: string | null;
}

export interface PlaybackTrack {
  id: number;
  /** Demuxer stream index when mpv can map it reliably. */
  streamIndex?: number | null;
  type: "audio" | "subtitle";
  title: string | null;
  language: string | null;
  selected: boolean;
  codec?: string | null;
  channels?: number | null;
  isDefault?: boolean;
  isForced?: boolean;
  external?: boolean;
}

export interface PlaybackState {
  playbackId: string | null;
  itemId: string | null;
  phase: "idle" | "resolving" | "loading" | "ready" | "playing" | "paused" | "buffering" | "stalled" | "disconnected" | "ended" | "stopped" | "error";
  source: "server" | "local" | null;
  diagnostics?: PlaybackDiagnostics;
  positionTicks: number;
  durationTicks: number;
  paused: boolean;
  buffering: boolean;
  seekable: boolean;
  /** Effective mpv volume on a 0-100 scale. */
  volume: number;
  fullscreen: boolean;
  audioTracks: PlaybackTrack[];
  subtitleTracks: PlaybackTrack[];
  error: string | null;
}

export type SessionPanelView = "solo" | "watchparty" | "chat";
export type JellyfinConnectionState = "unknown" | "connected" | "offline" | "reconnecting";

export interface JellyfinConnectionDiagnostics {
  state: JellyfinConnectionState;
  serverName: string | null;
  serverVersion: string | null;
  /** Most recent measured authenticated request time to response headers. */
  requestLatencyMs: number | null;
  measuredAt: string | null;
}

export interface SoloSessionDiagnostics {
  playback: PlaybackState;
  connection: JellyfinConnectionDiagnostics;
  item: MediaItem | null;
  nextUp: MediaItem | null;
}

export type OpenSourceLicenseCategory = "application" | "dependency" | "font" | "native" | "plugin";
export type RedistributionStatus = "source-only" | "source-and-binary" | "internal-only-unverified-provenance";

export interface OpenSourceLicenseEntry {
  category: OpenSourceLicenseCategory;
  name: string;
  version: string;
  license: string;
  projectUrl: string | null;
  redistributionStatus: RedistributionStatus;
}

export interface OpenSourceLicenseInventory {
  schemaVersion: 1;
  projectName: string;
  projectLicense: string;
  entries: OpenSourceLicenseEntry[];
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

export interface DownloadLocationSummary {
  mode: "default" | "custom";
  label: string;
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
export interface PlaybackRateInput extends PlaybackIdInput { rate: number }
export interface PlaybackVolumeInput extends PlaybackIdInput { volume: number }
export interface PlaybackTrackInput extends PlaybackIdInput { trackId: number | null }
export interface PlaybackFullscreenInput extends PlaybackIdInput { fullscreen: boolean }
export interface PlaybackViewportInput { x: number; y: number; width: number; height: number; visible: boolean; revision: number }
export type PlayerAdapterMode = "legacy" | "embedded";
export interface PlaybackAdapterPreference {
  active: PlayerAdapterMode;
  selected: PlayerAdapterMode;
  embeddedAvailable: boolean;
  restartRequired: boolean;
}
export interface PlaybackAdapterPreferenceInput { mode: PlayerAdapterMode }
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

export type ParticipantTelemetryTransportAvailability =
  | "disabled"
  | "absent"
  | "incompatible"
  | "connecting"
  | "available"
  | "offline";

export type BufferingPolicyMode = "wait-for-all" | "continue";

export interface BufferingPolicyPreference {
  mode: BufferingPolicyMode;
  gracePeriodMs: 1500;
}

export interface BufferingPolicyPreferenceInput {
  mode: BufferingPolicyMode;
}

export type BufferingIncidentStatus = "grace" | "waiting" | "suppressed";

export interface BufferingIncident {
  incidentId: string;
  participantId: string;
  participantName: string;
  state: "buffering" | "stalled";
  startedAtUnixMs: number;
  status: BufferingIncidentStatus;
  automaticallyPaused: boolean;
}

export interface ParticipantTelemetryView {
  participantId: string;
  displayName: string;
  state: "playing" | "paused" | "buffering" | "recovering" | "ready" | "stalled" | "disconnected";
  freshness: "current" | "stale" | "disconnected";
  positionTicks: number;
  driftTicks: number | null;
  jellyfinLatencyMs: number | null;
  bufferAheadTicks: number | null;
  sourceKind: PlaybackSourceKind | null;
}

export interface ParticipantTelemetryViewState {
  protocolVersion: 1;
  availability: ParticipantTelemetryTransportAvailability;
  transport: "none" | "websocket" | "http-polling";
  reason: string | null;
  participants: ParticipantTelemetryView[];
  incident: BufferingIncident | null;
  policy: BufferingPolicyPreference;
}

export interface SyncPlayDiagnostics {
  serverLatencyMs: number | null;
  localDriftTicks: number | null;
  authoritativeTimelineReady: boolean;
  measuredAtUnixMs: number | null;
}

export interface WatchPartyViewState {
  availability: "signed-out" | "connecting" | "available" | "denied" | "unsupported" | "offline";
  connection: "disconnected" | "connecting" | "connected";
  groups: WatchPartySummary[];
  joinedGroup: JoinedWatchParty | null;
  sharedControls: boolean;
  sync: SyncPlayDiagnostics;
  telemetry: ParticipantTelemetryViewState;
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
    getLocation(): Promise<DownloadLocationSummary>;
    chooseLocation(): Promise<DownloadLocationSummary | null>;
    useDefaultLocation(): Promise<DownloadLocationSummary>;
    openLocation(): Promise<{ opened: boolean }>;
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
    setRate(input: PlaybackRateInput): Promise<PlaybackState>;
    setVolume(input: PlaybackVolumeInput): Promise<PlaybackState>;
    selectAudio(input: PlaybackTrackInput): Promise<PlaybackState>;
    selectSubtitle(input: PlaybackTrackInput): Promise<PlaybackState>;
    setFullscreen(input: PlaybackFullscreenInput): Promise<PlaybackState>;
    stop(input: PlaybackIdInput): Promise<PlaybackState>;
    getState(): Promise<PlaybackState>;
    setViewport(input: PlaybackViewportInput): Promise<{ embedded: boolean }>;
    getAdapterPreference(): Promise<PlaybackAdapterPreference>;
    setAdapterPreference(input: PlaybackAdapterPreferenceInput): Promise<PlaybackAdapterPreference>;
    subscribe(listener: (state: PlaybackState) => void): () => void;
  };
  sessionPanel: {
    getSolo(): Promise<SoloSessionDiagnostics>;
  };
  licenses: {
    list(): Promise<OpenSourceLicenseInventory>;
  };
  watchParties: {
    getState(): Promise<WatchPartyViewState>;
    list(): Promise<WatchPartyViewState>;
    create(input: WatchPartyCreateInput): Promise<WatchPartyViewState>;
    join(input: WatchPartyGroupInput): Promise<WatchPartyViewState>;
    leave(): Promise<WatchPartyViewState>;
    wait(): Promise<WatchPartyViewState>;
    continue(): Promise<WatchPartyViewState>;
    resync(): Promise<WatchPartyViewState>;
    setBufferingPolicy(input: BufferingPolicyPreferenceInput): Promise<WatchPartyViewState>;
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
  downloadsGetLocation: "downloads:get-location",
  downloadsChooseLocation: "downloads:choose-location",
  downloadsUseDefaultLocation: "downloads:use-default-location",
  downloadsOpenLocation: "downloads:open-location",
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
  playbackSetRate: "playback:set-rate",
  playbackSetVolume: "playback:set-volume",
  playbackSelectAudio: "playback:select-audio",
  playbackSelectSubtitle: "playback:select-subtitle",
  playbackSetFullscreen: "playback:set-fullscreen",
  playbackStop: "playback:stop",
    playbackGetState: "playback:get-state",
    playbackSetViewport: "playback:set-viewport",
    playbackGetAdapterPreference: "playback:get-adapter-preference",
    playbackSetAdapterPreference: "playback:set-adapter-preference",
  playbackStateChanged: "playback:state-changed",
  sessionPanelGetSolo: "session-panel:get-solo",
  licensesList: "licenses:list",
  watchPartiesGetState: "watch-parties:get-state",
  watchPartiesList: "watch-parties:list",
  watchPartiesCreate: "watch-parties:create",
  watchPartiesJoin: "watch-parties:join",
  watchPartiesLeave: "watch-parties:leave",
  watchPartiesWait: "watch-parties:wait",
  watchPartiesContinue: "watch-parties:continue",
  watchPartiesResync: "watch-parties:resync",
  watchPartiesSetBufferingPolicy: "watch-parties:set-buffering-policy",
  watchPartiesSetVisible: "watch-parties:set-visible",
  watchPartiesChanged: "watch-parties:changed",
} as const;
