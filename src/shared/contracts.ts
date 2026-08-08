export type ItemType = "Movie" | "Series" | "Season" | "Episode" | "BoxSet" | "Video" | "TvChannel" | "Program";
export type ImageKind = "Primary" | "Backdrop" | "Thumb";

export interface SafeUserData {
  played: boolean;
  playbackPositionTicks: number;
  playedPercentage: number;
}
export interface MediaPerson {
  id: string;
  name: string;
  role: string;
  type: string;
  primaryImageTag: string | null;
}

export type BrowseSort = "title-ascending" | "title-descending" | "date-added-descending" | "release-date-descending" | "release-date-ascending" | "rating-descending";
export interface BrowseQuery {
  libraryId?: string;
  type: "Movie" | "Series" | "Episode" | "Mixed";
  genre?: string;
  personId?: string;
  watched?: boolean;
  sort: BrowseSort;
  startIndex: number;
  limit: number;
}
export interface BrowsePage { items: MediaItem[]; totalRecordCount: number; }

export interface PersonMediaResult {
  item: MediaItem;
  appearanceCount?: number;
  source: "direct" | "episode-group";
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
  people?: MediaPerson[];
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
  notice?: string | null;
}

export type PlaybackSourceKind = "matched-local" | "downloaded" | "downloading" | "direct-play" | "direct-stream" | "transcode" | "offline-local";

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
  /** Sanitized embedded renderer profile; never contains device or driver names. */
  videoOutput?: "d3d11" | "opengl-software" | "libmpv-opengl-angle" | null;
  videoOutputHealthy?: boolean | null;
  hardwareDecoding?: boolean | null;
  directRendering?: boolean | null;
  frameQueueDepth?: number | null;
  droppedFrames?: number | null;
  renderFallbackUsed?: boolean;
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

export interface NextItemCountdown {
  nextItemId: string;
  itemType?: "Movie" | "Episode" | "Video";
  title: string;
  seriesName: string | null;
  seasonNumber: number | null;
  episodeNumber: number | null;
  remainingSeconds: number;
  totalSeconds: number;
}

/** @deprecated Use NextItemCountdown. */
export type NextEpisodeCountdown = NextItemCountdown;

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
  /** null means ordinary seek rules; 0 means progressive playback has not confirmed a BOF range. */
  seekableUntilTicks: number | null;
  /** Effective mpv volume on a 0-100 scale. */
  volume: number;
  fullscreen: boolean;
  audioTracks: PlaybackTrack[];
  subtitleTracks: PlaybackTrack[];
  nextEpisodeCountdown?: NextItemCountdown | null;
  error: string | null;
  contentKind?: "on-demand" | "live-tv";
}

export type LiveTvAvailability = "available" | "not-configured" | "forbidden" | "offline";

export interface LiveTvStatus {
  availability: LiveTvAvailability;
  hasGuide: boolean;
  canManageRecordings: boolean;
  message: string | null;
}

export interface LiveTvChannel {
  id: string;
  name: string;
  number: string | null;
  imageTag: string | null;
  isFavorite: boolean;
  currentProgramId: string | null;
}

export interface LiveTvProgram {
  id: string;
  channelId: string;
  name: string;
  overview: string;
  startUtc: string;
  endUtc: string;
  episodeTitle: string | null;
  seasonNumber: number | null;
  episodeNumber: number | null;
  isLive: boolean;
  isSeries: boolean;
  isMovie: boolean;
  isNews: boolean;
  isKids: boolean;
  isSports: boolean;
  timerId: string | null;
  seriesTimerId: string | null;
}

export interface LiveTvGuide {
  status: LiveTvStatus;
  channels: LiveTvChannel[];
  programs: LiveTvProgram[];
  windowStartUtc: string;
  windowEndUtc: string;
}

export interface LiveTvTimer {
  id: string;
  programId: string | null;
  channelId: string | null;
  name: string;
  startUtc: string;
  endUtc: string;
  status: string;
  seriesTimerId: string | null;
}

export interface LiveTvSeriesTimer {
  id: string;
  programId: string | null;
  name: string;
  recordNewOnly: boolean;
  recordAnyChannel: boolean;
  recordAnyTime: boolean;
  daysOfWeek: string[];
  prePaddingSeconds: number;
  postPaddingSeconds: number;
  keepUpTo: number | null;
}

export interface LiveTvRecording {
  id: string;
  name: string;
  channelName: string | null;
  startUtc: string | null;
  endUtc: string | null;
  status: string;
  item: MediaItem;
}

export interface LiveTvGuideInput { startUtc: string; endUtc: string }
export interface LiveTvPageInput { startIndex?: number; limit?: number }
export interface LiveTvScheduleOptions {
  recordNewOnly?: boolean;
  recordAnyChannel?: boolean;
  recordAnyTime?: boolean;
  daysOfWeek?: string[];
  prePaddingSeconds?: number;
  postPaddingSeconds?: number;
  keepUpTo?: number | null;
}
export interface LiveTvCreateRecordingInput { programId: string; series: boolean; options?: LiveTvScheduleOptions }
export interface LiveTvUpdateScheduleInput { id: string; series: boolean; options: LiveTvScheduleOptions }
export interface LiveTvCancelScheduleInput { id: string; series: boolean }
export interface LiveTvDeleteRecordingInput { recordingId: string }
export interface LiveTvPlaybackInput { channelId: string }

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
  /** Full sanitized cache entry; never contains a local path or Jellyfin URL. */
  item: MediaItem;
  resumePositionTicks: number;
  localPlaybackAvailable: boolean;
  canWatchWhileDownloading: boolean;
  state: DownloadState;
  bytesDownloaded: number;
  expectedSize: number | null;
  progressPercent: number | null;
  keepDownloaded: boolean;
  smartManaged: boolean;
  error: { code: string; message: string } | null;
  canPause: boolean;
  canResume: boolean;
  canRetry: boolean;
  canCancel: boolean;
  canDelete: boolean;
}

export interface OfflinePlayableSummary {
  item: MediaItem;
  resumePositionTicks: number;
  sourceKind: "offline-local";
  localPlaybackAvailable: true;
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
export interface TrailerOpenInput { itemId: string; openExternally?: boolean }

export interface TrailerOpenResult {
  opened: boolean;
  mode: "embedded" | "external" | null;
  embedUrl: string | null;
}
export interface LibraryItemsInput { libraryId: string; type: "Movie" | "Series" | "Mixed"; limit: number }
export type BrowseInput = BrowseQuery;
export interface SearchInput { query: string }
export interface EpisodesInput { seriesId: string; seasonId: string }
export interface ArtworkInput { itemId: string; kind: ImageKind; tag?: string; width?: number; height?: number }
export type PlaybackMediaSegmentType = "Intro" | "Recap" | "Outro";
export interface PlaybackMediaSegment {
  type: PlaybackMediaSegmentType;
  startTicks: number;
  endTicks: number;
}
export interface PlaybackMediaSegmentsResult {
  playbackId: string;
  itemId: string;
  segments: PlaybackMediaSegment[];
}
export interface TrickplayManifest {
  manifestId: string;
  playbackId: string;
  itemId: string;
  frameWidth: number;
  frameHeight: number;
  intervalTicks: number;
  columns: number;
  rows: number;
  frameCount: number;
  spriteCount: number;
}
export interface PlaybackStartInput {
  itemId: string;
  resumeMode: "resume" | "start-over";
  /** Require an eligible growing download; never fall through to Jellyfin for this attempt. */
  progressiveOnly?: boolean;
}
export interface PlaybackIdInput { playbackId: string }
export interface TrickplaySpriteInput extends PlaybackIdInput { manifestId: string; spriteIndex: number }
export interface PlaybackPauseInput extends PlaybackIdInput { paused: boolean }
export interface PlaybackSeekInput extends PlaybackIdInput { positionTicks: number }
export interface PlaybackRateInput extends PlaybackIdInput { rate: number }
export interface PlaybackVolumeInput extends PlaybackIdInput { volume: number }
export interface PlaybackTrackInput extends PlaybackIdInput { trackId: number | null }
export interface PlaybackFullscreenInput extends PlaybackIdInput { fullscreen: boolean }
export interface PlaybackViewportInput { x: number; y: number; width: number; height: number; visible: boolean; revision: number; deviceScaleFactor?: number }
export type PlayerAdapterMode = "legacy" | "embedded" | "libmpv";
export type PlayerAdapterFallbackReason =
  | "manifest-invalid"
  | "library-not-configured"
  | "library-missing"
  | "library-hash-mismatch"
  | "companion-missing"
  | "companion-hash-mismatch"
  | "client-abi-incompatible"
  | "required-symbol-missing"
  | "native-addon-unavailable"
  | "graphics-capability-unavailable"
  | "render-gate-not-passed"
  | "controller-integration-unavailable"
  | "initialization-failed"
  | "embedded-initialization-failed";
export interface PlaybackAdapterPreference {
  active: PlayerAdapterMode;
  selected: PlayerAdapterMode;
  launchSelection: PlayerAdapterMode;
  embeddedAvailable: boolean;
  libmpvAvailable: boolean;
  fallbackActive: boolean;
  fallbackFrom: PlayerAdapterMode | null;
  fallbackReason: PlayerAdapterFallbackReason | null;
  restartRequired: boolean;
}
export interface PlaybackAdapterPreferenceInput { mode: PlayerAdapterMode }
export type CleanMachineDiagnosticStatus = "pass" | "warning" | "fail" | "not-run";
export type CleanMachineDiagnosticCheckId =
  | "windows-platform"
  | "x64-architecture"
  | "self-contained-package"
  | "runtime-integrity"
  | "native-runtime-load"
  | "electron-shared-texture"
  | "gpu-compositing"
  | "hardware-video-decode"
  | "engine-selection"
  | "first-frame-presentation";
export interface CleanMachineDiagnosticCheck {
  id: CleanMachineDiagnosticCheckId;
  label: string;
  status: CleanMachineDiagnosticStatus;
  detail: string;
}
export interface CleanMachineDiagnostics {
  schemaVersion: 1;
  generatedAtUtc: string;
  overall: "ready" | "warning" | "blocked";
  applicationVersion: string;
  build: "internal-libmpv-test" | "packaged" | "development";
  platform: "windows" | "other";
  architecture: "x64" | "other";
  electronVersion: string;
  selectedEngine: PlayerAdapterMode;
  activeEngine: PlayerAdapterMode;
  fallbackReason: PlayerAdapterFallbackReason | null;
  checks: CleanMachineDiagnosticCheck[];
}
export interface CleanMachineDiagnosticActionResult {
  completed: boolean;
}
export interface DownloadStartInput { itemId: string }
export interface DownloadIdInput { downloadId: string }
export interface DownloadKeepInput extends DownloadIdInput { keepDownloaded: boolean }
export type SmartDownloadStatus = "ready" | "checking" | "offline" | "attention";
export interface SmartSeriesSummary {
  seriesId: string;
  name: string;
  episodeLimit: number;
  status: SmartDownloadStatus;
  lastSuccessfulCheck: number | null;
  error: { code: string; message: string; occurredAt: number } | null;
}
export interface SmartDownloadsState {
  series: SmartSeriesSummary[];
  notice: string | null;
}
export interface SmartDownloadFollowInput { seriesId: string; episodeLimit: number }
export interface SmartDownloadUnfollowInput { seriesId: string; disposition: "keep" | "remove" }
export interface SmartDownloadUnfollowResult {
  state: SmartDownloadsState;
  warning: string | null;
}
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

export type WatchPartyPreparationPhase =
  | "idle"
  | "waiting-for-participant"
  | "preparing"
  | "ready"
  | "starting"
  | "playing"
  | "error";

export interface WatchPartyPreparationState {
  phase: WatchPartyPreparationPhase;
  minimumParticipants: 2;
  localSyncOffsetMilliseconds: number;
  scheduledStartAtUnixMs: number | null;
}

export interface WatchPartyViewState {
  availability: "signed-out" | "connecting" | "available" | "denied" | "unsupported" | "offline";
  connection: "disconnected" | "connecting" | "connected";
  groups: WatchPartySummary[];
  joinedGroup: JoinedWatchParty | null;
  sharedControls: boolean;
  preparation: WatchPartyPreparationState;
  sync: SyncPlayDiagnostics;
  telemetry: ParticipantTelemetryViewState;
  error: { code: string; message: string } | null;
}

export interface WatchPartyCreateInput { name: string }
export interface WatchPartyGroupInput { groupId: string }
export interface WatchPartyVisibilityInput { visible: boolean }
export interface WatchPartySyncOffsetInput { offsetMilliseconds: number }

export interface JellyfinBridge {
  application: {
    close(): Promise<void>;
  };
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
  browse: { get(input: BrowseInput): Promise<BrowsePage> };
  people: { getResults(input: ItemIdInput): Promise<PersonMediaResult[]> };
  search: { query(input: SearchInput): Promise<MediaItem[]> };
  items: {
    getDetails(input: ItemIdInput): Promise<MediaItem>;
    openTrailer(input: TrailerOpenInput): Promise<TrailerOpenResult>;
    setWatched(input: WatchedStateInput): Promise<WatchedStateResult>;
  };
  shows: {
    getSeasons(input: ItemIdInput): Promise<MediaItem[]>;
    getEpisodes(input: EpisodesInput): Promise<MediaItem[]>;
  };
  artwork: {
    getUrl(input: ArtworkInput): Promise<string>;
  };
  playbackFeatures: {
    getMediaSegments(input: PlaybackIdInput): Promise<PlaybackMediaSegmentsResult>;
    getTrickplayManifest(input: PlaybackIdInput): Promise<TrickplayManifest | null>;
    getTrickplaySpriteUrl(input: TrickplaySpriteInput): Promise<string>;
  };
  mediaSources: {
    getCapabilities(input: ItemIdInput): Promise<MediaSourceCapabilities>;
  };
  liveTv: {
    getStatus(): Promise<LiveTvStatus>;
    getGuide(input: LiveTvGuideInput): Promise<LiveTvGuide>;
    getRecordings(input?: LiveTvPageInput): Promise<LiveTvRecording[]>;
    getTimers(): Promise<LiveTvTimer[]>;
    getSeriesTimers(): Promise<LiveTvSeriesTimer[]>;
    createRecording(input: LiveTvCreateRecordingInput): Promise<void>;
    updateSchedule(input: LiveTvUpdateScheduleInput): Promise<void>;
    cancelSchedule(input: LiveTvCancelScheduleInput): Promise<void>;
    deleteRecording(input: LiveTvDeleteRecordingInput): Promise<void>;
  };
  downloads: {
    list(): Promise<DownloadSummary[]>;
    listOfflinePlayable(): Promise<OfflinePlayableSummary[]>;
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
  smartDownloads: {
    getState(): Promise<SmartDownloadsState>;
    follow(input: SmartDownloadFollowInput): Promise<SmartDownloadsState>;
    setLimit(input: SmartDownloadFollowInput): Promise<SmartDownloadsState>;
    checkNow(): Promise<SmartDownloadsState>;
    unfollow(input: SmartDownloadUnfollowInput): Promise<SmartDownloadUnfollowResult>;
    skip(input: DownloadIdInput): Promise<SmartDownloadsState>;
    subscribe(listener: (state: SmartDownloadsState) => void): () => void;
  };
  playback: {
    start(input: PlaybackStartInput): Promise<PlaybackStartResult>;
    startLive(input: LiveTvPlaybackInput): Promise<PlaybackStartResult>;
    setPaused(input: PlaybackPauseInput): Promise<PlaybackState>;
    seek(input: PlaybackSeekInput): Promise<PlaybackState>;
    setRate(input: PlaybackRateInput): Promise<PlaybackState>;
    setVolume(input: PlaybackVolumeInput): Promise<PlaybackState>;
    selectAudio(input: PlaybackTrackInput): Promise<PlaybackState>;
    selectSubtitle(input: PlaybackTrackInput): Promise<PlaybackState>;
    setFullscreen(input: PlaybackFullscreenInput): Promise<PlaybackState>;
    continueNextEpisode(input: PlaybackIdInput): Promise<PlaybackState>;
    cancelNextEpisode(input: PlaybackIdInput): Promise<PlaybackState>;
    stop(input: PlaybackIdInput): Promise<PlaybackState>;
    getState(): Promise<PlaybackState>;
    setViewport(input: PlaybackViewportInput): Promise<{ embedded: boolean }>;
    getAdapterPreference(): Promise<PlaybackAdapterPreference>;
    setAdapterPreference(input: PlaybackAdapterPreferenceInput): Promise<PlaybackAdapterPreference>;
    subscribe(listener: (state: PlaybackState) => void): () => void;
  };
  sessionPanel: {
    getSolo(): Promise<SoloSessionDiagnostics>;
    subscribeSolo(listener: (snapshot: SoloSessionDiagnostics) => void): () => void;
  };
  licenses: {
    list(): Promise<OpenSourceLicenseInventory>;
  };
  diagnostics: {
    getCleanMachine(): Promise<CleanMachineDiagnostics>;
    copyCleanMachine(): Promise<CleanMachineDiagnosticActionResult>;
    saveCleanMachine(): Promise<CleanMachineDiagnosticActionResult>;
  };
  companion: CompanionSettingsBridge;
  watchParties: {
    getState(): Promise<WatchPartyViewState>;
    list(): Promise<WatchPartyViewState>;
    create(input: WatchPartyCreateInput): Promise<WatchPartyViewState>;
    join(input: WatchPartyGroupInput): Promise<WatchPartyViewState>;
    leave(): Promise<WatchPartyViewState>;
    wait(): Promise<WatchPartyViewState>;
    continue(): Promise<WatchPartyViewState>;
    resync(): Promise<WatchPartyViewState>;
    setLocalSyncOffset(input: WatchPartySyncOffsetInput): Promise<WatchPartyViewState>;
    setBufferingPolicy(input: BufferingPolicyPreferenceInput): Promise<WatchPartyViewState>;
    setVisible(input: WatchPartyVisibilityInput): Promise<WatchPartyViewState>;
    subscribe(listener: (state: WatchPartyViewState) => void): () => void;
  };
}

export const IPC = {
  applicationClose: "application:close",
  serverDiscover: "server:discover",
  serverConnect: "server:connect",
  sessionLogin: "session:login",
  sessionRestore: "session:restore",
  sessionGetState: "session:get-state",
  sessionLogout: "session:logout",
  homeGet: "home:get",
  librariesList: "libraries:list",
  librariesGetItems: "libraries:get-items",
  browseGet: "browse:get",
  peopleGetResults: "people:get-results",
  searchQuery: "search:query",
  itemsGetDetails: "items:get-details",
  itemsOpenTrailer: "items:open-trailer",
  itemsSetWatched: "items:set-watched",
  showsGetSeasons: "shows:get-seasons",
  showsGetEpisodes: "shows:get-episodes",
  artworkGetUrl: "artwork:get-url",
  playbackFeaturesGetMediaSegments: "playback-features:get-media-segments",
  playbackFeaturesGetTrickplayManifest: "playback-features:get-trickplay-manifest",
  playbackFeaturesGetTrickplaySpriteUrl: "playback-features:get-trickplay-sprite-url",
  mediaSourcesGetCapabilities: "media-sources:get-capabilities",
  liveTvGetStatus: "live-tv:get-status",
  liveTvGetGuide: "live-tv:get-guide",
  liveTvGetRecordings: "live-tv:get-recordings",
  liveTvGetTimers: "live-tv:get-timers",
  liveTvGetSeriesTimers: "live-tv:get-series-timers",
  liveTvCreateRecording: "live-tv:create-recording",
  liveTvUpdateSchedule: "live-tv:update-schedule",
  liveTvCancelSchedule: "live-tv:cancel-schedule",
  liveTvDeleteRecording: "live-tv:delete-recording",
  downloadsList: "downloads:list",
  downloadsListOfflinePlayable: "downloads:list-offline-playable",
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
  smartDownloadsGetState: "smart-downloads:get-state",
  smartDownloadsFollow: "smart-downloads:follow",
  smartDownloadsSetLimit: "smart-downloads:set-limit",
  smartDownloadsCheckNow: "smart-downloads:check-now",
  smartDownloadsUnfollow: "smart-downloads:unfollow",
  smartDownloadsSkip: "smart-downloads:skip",
  smartDownloadsChanged: "smart-downloads:changed",
  playbackStart: "playback:start",
  playbackStartLive: "playback:start-live",
  playbackSetPaused: "playback:set-paused",
  playbackSeek: "playback:seek",
  playbackSetRate: "playback:set-rate",
  playbackSetVolume: "playback:set-volume",
  playbackSelectAudio: "playback:select-audio",
  playbackSelectSubtitle: "playback:select-subtitle",
  playbackSetFullscreen: "playback:set-fullscreen",
  playbackContinueNextEpisode: "playback:continue-next-episode",
  playbackCancelNextEpisode: "playback:cancel-next-episode",
  playbackStop: "playback:stop",
    playbackGetState: "playback:get-state",
    playbackSetViewport: "playback:set-viewport",
    playbackGetAdapterPreference: "playback:get-adapter-preference",
    playbackSetAdapterPreference: "playback:set-adapter-preference",
  playbackStateChanged: "playback:state-changed",
  sessionPanelGetSolo: "session-panel:get-solo",
  sessionPanelSoloChanged: "session-panel:solo-changed",
  licensesList: "licenses:list",
  diagnosticsGetCleanMachine: "diagnostics:get-clean-machine",
  diagnosticsCopyCleanMachine: "diagnostics:copy-clean-machine",
  diagnosticsSaveCleanMachine: "diagnostics:save-clean-machine",
  companionGetStatus: "companion:get-status",
  companionSetEnabled: "companion:set-enabled",
  companionSelectNetwork: "companion:select-network",
  companionBeginPairing: "companion:begin-pairing",
  companionCancelPairing: "companion:cancel-pairing",
  companionRenameDevice: "companion:rename-device",
  companionRevokeDevice: "companion:revoke-device",
  companionRegeneratePort: "companion:regenerate-port",
  companionChanged: "companion:changed",
  watchPartiesGetState: "watch-parties:get-state",
  watchPartiesList: "watch-parties:list",
  watchPartiesCreate: "watch-parties:create",
  watchPartiesJoin: "watch-parties:join",
  watchPartiesLeave: "watch-parties:leave",
  watchPartiesWait: "watch-parties:wait",
  watchPartiesContinue: "watch-parties:continue",
  watchPartiesResync: "watch-parties:resync",
  watchPartiesSetLocalSyncOffset: "watch-parties:set-local-sync-offset",
  watchPartiesSetBufferingPolicy: "watch-parties:set-buffering-policy",
  watchPartiesSetVisible: "watch-parties:set-visible",
  watchPartiesChanged: "watch-parties:changed",
} as const;
import type { CompanionSettingsBridge } from "./companionContracts";
