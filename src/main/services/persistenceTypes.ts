import type { MediaItem, PlaybackDiagnostics } from "../../shared/contracts";

export const DATABASE_SCHEMA_VERSION = 8;

export type ApplicationPreferenceKey =
  | "player.adapter-mode"
  | "watchparty.buffering-policy"
  | "watchparty.sync-offset"
  | "player.cached-diagnostics"
  | "companion.settings";

export interface ApplicationPreferenceRecord {
  key: ApplicationPreferenceKey;
  valueJson: string;
  updatedAt: number;
}

export interface CatalogIdentityInput {
  serverId: string;
  serverAddress: string;
  serverName: string | null;
  userId: string;
  userName: string | null;
}

export interface MediaItemRecordInput {
  serverId: string;
  userId: string;
  itemId: string;
  itemType: "Movie" | "Episode" | "Video";
  name: string;
  seriesId: string | null;
  seasonId: string | null;
  runTimeTicks: number;
  /** Already-sanitized, path-free metadata. Omitted values preserve an existing cache entry. */
  metadata?: MediaItem | null;
}

export interface MediaItemRecord extends MediaItemRecordInput {
  metadata: MediaItem | null;
  nextUp: MediaItem | null;
  createdAt: number;
  updatedAt: number;
}

export interface MediaSourceRecordInput {
  serverId: string;
  userId: string;
  itemId: string;
  mediaSourceId: string;
  container: string | null;
  expectedSize: number | null;
  /** Sanitized per-source diagnostics. Omitted values preserve an existing cache entry. */
  diagnostics?: PlaybackDiagnostics | null;
}

export interface MediaSourceRecord extends MediaSourceRecordInput {
  diagnostics: PlaybackDiagnostics | null;
  createdAt: number;
  updatedAt: number;
}

export type DownloadOrigin = "manual" | "smart";
export type DownloadJobState = "queued" | "downloading" | "paused" | "completed" | "failed" | "cancelled";

export interface CreateDownloadInput {
  downloadId?: string;
  serverId: string;
  userId: string;
  itemId: string;
  mediaSourceId: string | null;
  origin: DownloadOrigin;
  smartManaged: boolean;
  keepDownloaded: boolean;
  qualityProfile: string | null;
  expectedSize: number | null;
}

export interface TransitionDownloadInput {
  downloadId: string;
  state: DownloadJobState;
  bytesDownloaded?: number;
  errorCode?: string | null;
  errorMessage?: string | null;
}

export interface DownloadJobRecord {
  downloadId: string;
  serverId: string;
  userId: string;
  itemId: string;
  mediaSourceId: string | null;
  origin: DownloadOrigin;
  state: DownloadJobState;
  smartManaged: boolean;
  keepDownloaded: boolean;
  qualityProfile: string | null;
  bytesDownloaded: number;
  expectedSize: number | null;
  retryCount: number;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
}

export type LocalFileState = "staging" | "finalized" | "missing" | "invalid";
export type MediaProbeState = "pending" | "valid" | "invalid";
export type LocalVersionOrigin = "manual" | "smart" | "imported";

export interface RegisterLocalVersionInput {
  localVersionId?: string;
  serverId: string;
  userId: string;
  itemId: string;
  mediaSourceId: string | null;
  downloadId: string | null;
  storageRoot: string;
  localPath: string;
  origin: LocalVersionOrigin;
  smartManaged: boolean;
  keepDownloaded: boolean;
  fileState: LocalFileState;
  probeState: MediaProbeState;
  expectedSize: number | null;
  actualSize: number | null;
  container: string | null;
}

export interface UpdateLocalVersionInput {
  localVersionId: string;
  fileState: LocalFileState;
  probeState: MediaProbeState;
  actualSize: number | null;
}

export interface LocalVersionRecord extends Omit<RegisterLocalVersionInput, "localVersionId"> {
  localVersionId: string;
  pathKey: string;
  createdAt: number;
  updatedAt: number;
}

export interface DownloadBundleRecord {
  job: DownloadJobRecord;
  localVersion: LocalVersionRecord | null;
  itemName: string;
  itemType: "Movie" | "Episode" | "Video";
  item: MediaItemRecord;
  playbackHead: PlaybackHeadRecord | null;
}

export interface SmartSeriesRecordInput {
  serverId: string;
  userId: string;
  seriesId: string;
  seriesName: string;
  episodeLimit: number;
}

export interface SmartSeriesRecord extends SmartSeriesRecordInput {
  lastSuccessfulCheck: number | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  lastErrorAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export type SmartSeriesCheckResult =
  | { success: true; checkedAt: number }
  | { success: false; errorCode: string; errorMessage: string; errorAt: number };

export interface OfflinePlayableRecord {
  item: MediaItemRecord;
  mediaSource: MediaSourceRecord | null;
  playbackHead: PlaybackHeadRecord | null;
  downloaded: boolean;
  updatedAt: number;
}

export type PlaybackActionKind = "progress" | "completed" | "start_over" | "replay" | "mark_watched" | "mark_unwatched";
export type ProgressSyncState = "pending" | "succeeded" | "failed" | "superseded";

export interface DurablePlaybackReport {
  kind: "start" | "progress" | "stop";
  mediaSourceId: string;
  playMethod: "DirectPlay" | "DirectStream" | "Transcode";
  playSessionId: string;
  paused: boolean;
  canSeek: boolean;
  audioStreamIndex: number | null;
  subtitleStreamIndex: number | null;
  /** Whether this report may outrank an older remote timeline on reconnect. */
  conflictPolicy: "automatic" | "explicit";
}

export interface RecordPlaybackRevisionInput {
  serverId: string;
  userId: string;
  itemId: string;
  actionKind: PlaybackActionKind;
  positionTicks: number;
  watched: boolean;
  occurredAt: number;
  report?: DurablePlaybackReport | null;
}

export interface PlaybackRevisionRecord extends Omit<RecordPlaybackRevisionInput, "report"> {
  report: DurablePlaybackReport | null;
  localRevision: number;
  completionEvent: boolean;
  syncState: ProgressSyncState;
  attemptCount: number;
  lastError: string | null;
  syncedAt: number | null;
}

export interface PlaybackHeadRecord extends Omit<RecordPlaybackRevisionInput, "report"> {
  latestRevision: number;
  /** Effective precedence across all still-pending revisions for this item. */
  conflictPolicy: "automatic" | "explicit";
  lastSucceededRevision: number;
  lastSucceededPositionTicks: number;
  lastSucceededWatched: boolean;
  updatedAt: number;
}

export interface PersistenceHealth {
  schemaVersion: number;
  journalMode: string;
  foreignKeys: boolean;
  quickCheck: "ok";
  workerThreadId: number;
}

export type PersistenceOperation =
  | { kind: "initialize" }
  | { kind: "getApplicationPreference"; key: ApplicationPreferenceKey }
  | { kind: "setApplicationPreference"; key: ApplicationPreferenceKey; valueJson: string; updatedAt: number }
  | { kind: "upsertCatalogIdentity"; input: CatalogIdentityInput }
  | { kind: "upsertMediaItem"; input: MediaItemRecordInput }
  | { kind: "getMediaItem"; serverId: string; userId: string; itemId: string }
  | { kind: "setMediaItemNextUp"; serverId: string; userId: string; itemId: string; nextUp: MediaItem | null }
  | { kind: "upsertMediaSource"; input: MediaSourceRecordInput }
  | { kind: "getMediaSource"; serverId: string; userId: string; itemId: string; mediaSourceId: string }
  | { kind: "createDownload"; input: CreateDownloadInput & { downloadId: string } }
  | {
    kind: "createDownloadBundle";
    download: CreateDownloadInput & { downloadId: string };
    localVersion: RegisterLocalVersionInput & { localVersionId: string; downloadId: string; pathKey: string };
  }
  | { kind: "transitionDownload"; input: TransitionDownloadInput }
  | { kind: "getDownload"; downloadId: string }
  | { kind: "getDownloadBundle"; downloadId: string }
  | { kind: "listDownloadBundles"; serverId: string; userId: string }
  | { kind: "setDownloadKeep"; downloadId: string; keepDownloaded: boolean }
  | { kind: "setDownloadSmartManaged"; downloadId: string; smartManaged: boolean }
  | { kind: "setDownloadExpectedSize"; downloadId: string; expectedSize: number }
  | { kind: "registerLocalVersion"; input: RegisterLocalVersionInput & { localVersionId: string; pathKey: string } }
  | { kind: "updateLocalVersion"; input: UpdateLocalVersionInput }
  | { kind: "listLocalVersions"; serverId: string; userId: string; itemId: string }
  | { kind: "listOfflinePlayableItems"; serverId: string; userId: string }
  | { kind: "upsertSmartSeries"; input: SmartSeriesRecordInput }
  | { kind: "listSmartSeries"; serverId: string; userId: string }
  | { kind: "recordSmartSeriesCheck"; serverId: string; userId: string; seriesId: string; result: SmartSeriesCheckResult }
  | { kind: "addSmartEpisodeSkip"; serverId: string; userId: string; seriesId: string; itemId: string }
  | { kind: "listSmartEpisodeSkips"; serverId: string; userId: string; seriesId: string }
  | { kind: "deleteSmartSeries"; serverId: string; userId: string; seriesId: string }
  | { kind: "unfollowSmartSeriesKeep"; serverId: string; userId: string; seriesId: string }
  | { kind: "recordPlaybackRevision"; input: RecordPlaybackRevisionInput }
  | { kind: "getPlaybackHead"; serverId: string; userId: string; itemId: string }
  | { kind: "listPlaybackHeadsForSeries"; serverId: string; userId: string; seriesId: string }
  | { kind: "listPendingProgress"; limit: number }
  | { kind: "listPendingProgressForIdentity"; serverId: string; userId: string; limit: number }
  | { kind: "markProgressSucceeded"; serverId: string; userId: string; itemId: string; localRevision: number; syncedAt: number }
  | { kind: "markProgressFailed"; serverId: string; userId: string; itemId: string; localRevision: number; error: string }
  | { kind: "markPlaybackSuperseded"; serverId: string; userId: string; itemId: string; localRevision: number }
  | { kind: "health" }
  | { kind: "close" };

export interface PersistenceRequest {
  id: number;
  operation: PersistenceOperation;
}

export type PersistenceResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: { code: string; message: string } };
