export const DATABASE_SCHEMA_VERSION = 1;

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
}

export interface MediaItemRecord extends MediaItemRecordInput {
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
}

export type PlaybackActionKind = "progress" | "completed" | "start_over" | "replay" | "mark_watched" | "mark_unwatched";
export type ProgressSyncState = "pending" | "succeeded" | "failed" | "superseded";

export interface RecordPlaybackRevisionInput {
  serverId: string;
  userId: string;
  itemId: string;
  actionKind: PlaybackActionKind;
  positionTicks: number;
  watched: boolean;
  occurredAt: number;
}

export interface PlaybackRevisionRecord extends RecordPlaybackRevisionInput {
  localRevision: number;
  completionEvent: boolean;
  syncState: ProgressSyncState;
  attemptCount: number;
  lastError: string | null;
  syncedAt: number | null;
}

export interface PlaybackHeadRecord extends RecordPlaybackRevisionInput {
  latestRevision: number;
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
  | { kind: "upsertCatalogIdentity"; input: CatalogIdentityInput }
  | { kind: "upsertMediaItem"; input: MediaItemRecordInput }
  | { kind: "getMediaItem"; serverId: string; userId: string; itemId: string }
  | { kind: "upsertMediaSource"; input: MediaSourceRecordInput }
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
  | { kind: "setDownloadExpectedSize"; downloadId: string; expectedSize: number }
  | { kind: "registerLocalVersion"; input: RegisterLocalVersionInput & { localVersionId: string; pathKey: string } }
  | { kind: "updateLocalVersion"; input: UpdateLocalVersionInput }
  | { kind: "listLocalVersions"; serverId: string; userId: string; itemId: string }
  | { kind: "recordPlaybackRevision"; input: RecordPlaybackRevisionInput }
  | { kind: "getPlaybackHead"; serverId: string; userId: string; itemId: string }
  | { kind: "listPendingProgress"; limit: number }
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
