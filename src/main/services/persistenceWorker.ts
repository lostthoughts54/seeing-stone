import { parentPort, threadId, workerData } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import {
  DATABASE_SCHEMA_VERSION,
  type ApplicationPreferenceRecord,
  type DownloadBundleRecord,
  type DownloadJobRecord,
  type DownloadJobState,
  type LocalVersionRecord,
  type MediaItemRecord,
  type PersistenceHealth,
  type PersistenceOperation,
  type PersistenceRequest,
  type PersistenceResponse,
  type PlaybackHeadRecord,
  type PlaybackRevisionRecord,
} from "./persistenceTypes";

const port = parentPort;
if (!port) throw new Error("Persistence worker requires a parent port.");

class PersistenceWorkerError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

const databasePath = String((workerData as { databasePath?: unknown }).databasePath ?? "");
let database: DatabaseSync | null = null;
let health: PersistenceHealth | null = null;

const MIGRATION_1 = `
CREATE TABLE servers (
  server_id TEXT PRIMARY KEY,
  address TEXT NOT NULL,
  name TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE profiles (
  server_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  user_name TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (server_id, user_id),
  FOREIGN KEY (server_id) REFERENCES servers(server_id) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;

CREATE TABLE media_items (
  server_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  item_type TEXT NOT NULL CHECK (item_type IN ('Movie', 'Episode', 'Video')),
  name TEXT NOT NULL,
  series_id TEXT,
  season_id TEXT,
  runtime_ticks INTEGER NOT NULL CHECK (runtime_ticks >= 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (server_id, user_id, item_id),
  FOREIGN KEY (server_id, user_id) REFERENCES profiles(server_id, user_id) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;

CREATE TABLE media_sources (
  server_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  media_source_id TEXT NOT NULL,
  container TEXT,
  expected_size INTEGER CHECK (expected_size IS NULL OR expected_size >= 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (server_id, user_id, item_id, media_source_id),
  FOREIGN KEY (server_id, user_id, item_id) REFERENCES media_items(server_id, user_id, item_id) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;

CREATE TABLE download_jobs (
  download_id TEXT PRIMARY KEY,
  server_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  media_source_id TEXT,
  origin TEXT NOT NULL CHECK (origin IN ('manual', 'smart')),
  state TEXT NOT NULL CHECK (state IN ('queued', 'downloading', 'paused', 'completed', 'failed', 'cancelled')),
  smart_managed INTEGER NOT NULL CHECK (smart_managed IN (0, 1)),
  keep_downloaded INTEGER NOT NULL CHECK (keep_downloaded IN (0, 1)),
  quality_profile TEXT,
  bytes_downloaded INTEGER NOT NULL CHECK (bytes_downloaded >= 0),
  expected_size INTEGER CHECK (expected_size IS NULL OR expected_size >= 0),
  retry_count INTEGER NOT NULL CHECK (retry_count >= 0),
  error_code TEXT,
  error_message TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER,
  FOREIGN KEY (server_id, user_id, item_id) REFERENCES media_items(server_id, user_id, item_id) ON DELETE CASCADE,
  FOREIGN KEY (server_id, user_id, item_id, media_source_id)
    REFERENCES media_sources(server_id, user_id, item_id, media_source_id)
) STRICT;

CREATE INDEX download_jobs_item_idx ON download_jobs(server_id, user_id, item_id, updated_at DESC);
CREATE INDEX download_jobs_queue_idx ON download_jobs(state, updated_at) WHERE state IN ('queued', 'downloading', 'paused', 'failed');
CREATE UNIQUE INDEX download_jobs_active_identity_idx ON download_jobs(
  server_id, user_id, item_id, COALESCE(media_source_id, ''), COALESCE(quality_profile, '')
) WHERE state IN ('queued', 'downloading', 'paused', 'failed');

CREATE TABLE local_versions (
  local_version_id TEXT PRIMARY KEY,
  server_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  media_source_id TEXT,
  download_id TEXT,
  storage_root TEXT NOT NULL,
  local_path TEXT NOT NULL,
  path_key TEXT NOT NULL UNIQUE,
  origin TEXT NOT NULL CHECK (origin IN ('manual', 'smart', 'imported')),
  smart_managed INTEGER NOT NULL CHECK (smart_managed IN (0, 1)),
  keep_downloaded INTEGER NOT NULL CHECK (keep_downloaded IN (0, 1)),
  file_state TEXT NOT NULL CHECK (file_state IN ('staging', 'finalized', 'missing', 'invalid')),
  probe_state TEXT NOT NULL CHECK (probe_state IN ('pending', 'valid', 'invalid')),
  expected_size INTEGER CHECK (expected_size IS NULL OR expected_size >= 0),
  actual_size INTEGER CHECK (actual_size IS NULL OR actual_size >= 0),
  container TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (server_id, user_id, item_id) REFERENCES media_items(server_id, user_id, item_id) ON DELETE CASCADE,
  FOREIGN KEY (server_id, user_id, item_id, media_source_id)
    REFERENCES media_sources(server_id, user_id, item_id, media_source_id),
  FOREIGN KEY (download_id) REFERENCES download_jobs(download_id),
  CHECK (file_state <> 'finalized' OR (probe_state = 'valid' AND actual_size IS NOT NULL)),
  CHECK (file_state <> 'finalized' OR expected_size IS NULL OR expected_size = actual_size)
) STRICT;

CREATE INDEX local_versions_item_idx ON local_versions(server_id, user_id, item_id, file_state, probe_state);

CREATE TABLE playback_heads (
  server_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  latest_revision INTEGER NOT NULL CHECK (latest_revision >= 1),
  action_kind TEXT NOT NULL CHECK (action_kind IN ('progress', 'completed', 'start_over', 'replay', 'mark_watched', 'mark_unwatched')),
  position_ticks INTEGER NOT NULL CHECK (position_ticks >= 0),
  watched INTEGER NOT NULL CHECK (watched IN (0, 1)),
  occurred_at INTEGER NOT NULL,
  last_succeeded_revision INTEGER NOT NULL CHECK (last_succeeded_revision >= 0),
  last_succeeded_position_ticks INTEGER NOT NULL CHECK (last_succeeded_position_ticks >= 0),
  last_succeeded_watched INTEGER NOT NULL CHECK (last_succeeded_watched IN (0, 1)),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (server_id, user_id, item_id),
  FOREIGN KEY (server_id, user_id, item_id) REFERENCES media_items(server_id, user_id, item_id) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;

CREATE TABLE playback_revisions (
  revision_id INTEGER PRIMARY KEY,
  server_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  local_revision INTEGER NOT NULL CHECK (local_revision >= 1),
  action_kind TEXT NOT NULL CHECK (action_kind IN ('progress', 'completed', 'start_over', 'replay', 'mark_watched', 'mark_unwatched')),
  position_ticks INTEGER NOT NULL CHECK (position_ticks >= 0),
  watched INTEGER NOT NULL CHECK (watched IN (0, 1)),
  completion_event INTEGER NOT NULL CHECK (completion_event IN (0, 1)),
  occurred_at INTEGER NOT NULL,
  sync_state TEXT NOT NULL CHECK (sync_state IN ('pending', 'succeeded', 'failed', 'superseded')),
  attempt_count INTEGER NOT NULL CHECK (attempt_count >= 0),
  last_error TEXT,
  synced_at INTEGER,
  UNIQUE (server_id, user_id, item_id, local_revision),
  FOREIGN KEY (server_id, user_id, item_id) REFERENCES media_items(server_id, user_id, item_id) ON DELETE CASCADE
) STRICT;

CREATE INDEX playback_revisions_pending_idx
  ON playback_revisions(sync_state, server_id, user_id, item_id, local_revision)
  WHERE sync_state IN ('pending', 'failed');
`;

const MIGRATION_2 = `
ALTER TABLE playback_revisions ADD COLUMN report_kind TEXT
  CHECK (report_kind IS NULL OR report_kind IN ('start', 'progress', 'stop'));
ALTER TABLE playback_revisions ADD COLUMN report_media_source_id TEXT;
ALTER TABLE playback_revisions ADD COLUMN report_play_method TEXT
  CHECK (report_play_method IS NULL OR report_play_method IN ('DirectPlay', 'DirectStream', 'Transcode'));
ALTER TABLE playback_revisions ADD COLUMN report_play_session_id TEXT;
ALTER TABLE playback_revisions ADD COLUMN report_paused INTEGER
  CHECK (report_paused IS NULL OR report_paused IN (0, 1));
ALTER TABLE playback_revisions ADD COLUMN report_can_seek INTEGER
  CHECK (report_can_seek IS NULL OR report_can_seek IN (0, 1));
ALTER TABLE playback_revisions ADD COLUMN report_audio_stream_index INTEGER
  CHECK (report_audio_stream_index IS NULL OR report_audio_stream_index >= 0);
ALTER TABLE playback_revisions ADD COLUMN report_subtitle_stream_index INTEGER
  CHECK (report_subtitle_stream_index IS NULL OR report_subtitle_stream_index >= 0);
`;

const MIGRATION_3 = `
ALTER TABLE playback_revisions ADD COLUMN report_conflict_policy TEXT
  CHECK (report_conflict_policy IS NULL OR report_conflict_policy IN ('automatic', 'explicit'));
`;

const MIGRATION_4 = `
CREATE TABLE application_preferences (
  preference_key TEXT PRIMARY KEY
    CHECK (preference_key IN ('player.adapter-mode', 'watchparty.buffering-policy', 'player.cached-diagnostics')),
  value_json TEXT NOT NULL CHECK (length(value_json) BETWEEN 1 AND 16384),
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0)
) STRICT, WITHOUT ROWID;
`;

const DOWNLOAD_TRANSITIONS: Record<DownloadJobState, ReadonlySet<DownloadJobState>> = {
  queued: new Set(["downloading", "paused", "failed", "cancelled"]),
  downloading: new Set(["paused", "completed", "failed", "cancelled"]),
  paused: new Set(["queued", "downloading", "failed", "cancelled"]),
  completed: new Set(),
  failed: new Set(["queued", "cancelled"]),
  cancelled: new Set(),
};

function db(): DatabaseSync {
  if (!database) throw new PersistenceWorkerError("PERSISTENCE_UNAVAILABLE", "Local data storage is unavailable.");
  return database;
}

function transaction<T>(operation: () => T): T {
  db().exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    db().exec("COMMIT");
    return result;
  } catch (error) {
    try { db().exec("ROLLBACK"); } catch { /* Preserve the original error. */ }
    throw error;
  }
}

function initialize(): PersistenceHealth {
  if (health) return health;
  try {
    database = new DatabaseSync(databasePath, {
      allowExtension: false,
      defensive: true,
      enableForeignKeyConstraints: true,
      timeout: 5000,
    });
    db().exec("PRAGMA trusted_schema = OFF; PRAGMA synchronous = NORMAL; PRAGMA temp_store = MEMORY;");
    db().prepare("PRAGMA journal_mode = WAL").get();
    const version = Number((db().prepare("PRAGMA user_version").get() as Record<string, unknown>).user_version ?? 0);
    if (version > DATABASE_SCHEMA_VERSION) {
      throw new PersistenceWorkerError("PERSISTENCE_SCHEMA_NEWER", "Local data was created by a newer application version.");
    }
    if (version < 1) {
      transaction(() => {
        db().exec(MIGRATION_1);
        db().exec("PRAGMA user_version = 1");
      });
    }
    if (version < 2) {
      transaction(() => {
        db().exec(MIGRATION_2);
        db().exec("PRAGMA user_version = 2");
      });
    }
    if (version < 3) {
      transaction(() => {
        db().exec(MIGRATION_3);
        db().exec("PRAGMA user_version = 3");
      });
    }
    if (version < 4) {
      transaction(() => {
        db().exec(MIGRATION_4);
        db().exec("PRAGMA user_version = 4");
      });
    }
    const now = Date.now();
    db().prepare(`
      UPDATE download_jobs
      SET state = 'paused', error_code = 'INTERRUPTED', error_message = 'Download paused after application restart.', updated_at = ?
      WHERE state = 'downloading'
    `).run(now);
    const quickCheck = String((db().prepare("PRAGMA quick_check").get() as Record<string, unknown>).quick_check ?? "");
    const foreignKeyProblems = db().prepare("PRAGMA foreign_key_check").all();
    if (quickCheck !== "ok" || foreignKeyProblems.length) {
      throw new PersistenceWorkerError("PERSISTENCE_CORRUPT", "Local data failed its integrity check.");
    }
    const journalMode = String((db().prepare("PRAGMA journal_mode").get() as Record<string, unknown>).journal_mode ?? "");
    const foreignKeys = Number((db().prepare("PRAGMA foreign_keys").get() as Record<string, unknown>).foreign_keys ?? 0) === 1;
    health = { schemaVersion: DATABASE_SCHEMA_VERSION, journalMode, foreignKeys, quickCheck: "ok", workerThreadId: threadId };
    return health;
  } catch (error) {
    try { database?.close(); } catch { /* Preserve the original error. */ }
    database = null;
    if (error instanceof PersistenceWorkerError) throw error;
    throw new PersistenceWorkerError("PERSISTENCE_CORRUPT", "Local data could not be opened safely.");
  }
}

function getApplicationPreference(
  key: Extract<PersistenceOperation, { kind: "getApplicationPreference" }>["key"],
): ApplicationPreferenceRecord | null {
  const row = db().prepare(`
    SELECT preference_key, value_json, updated_at
    FROM application_preferences WHERE preference_key = ?
  `).get(key) as Record<string, unknown> | undefined;
  return row ? { key, valueJson: String(row.value_json), updatedAt: Number(row.updated_at) } : null;
}

function setApplicationPreference(
  key: Extract<PersistenceOperation, { kind: "setApplicationPreference" }>["key"],
  valueJson: string,
  updatedAt: number,
): ApplicationPreferenceRecord {
  db().prepare(`
    INSERT INTO application_preferences(preference_key, value_json, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(preference_key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
  `).run(key, valueJson, updatedAt);
  return { key, valueJson, updatedAt };
}

function upsertCatalogIdentity(input: Extract<PersistenceOperation, { kind: "upsertCatalogIdentity" }>["input"]): null {
  const now = Date.now();
  transaction(() => {
    db().prepare(`
      INSERT INTO servers(server_id, address, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(server_id) DO UPDATE SET address = excluded.address, name = excluded.name, updated_at = excluded.updated_at
    `).run(input.serverId, input.serverAddress, input.serverName, now, now);
    db().prepare(`
      INSERT INTO profiles(server_id, user_id, user_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(server_id, user_id) DO UPDATE SET user_name = excluded.user_name, updated_at = excluded.updated_at
    `).run(input.serverId, input.userId, input.userName, now, now);
  });
  return null;
}

function upsertMediaItem(input: Extract<PersistenceOperation, { kind: "upsertMediaItem" }>["input"]): null {
  const now = Date.now();
  db().prepare(`
    INSERT INTO media_items(server_id, user_id, item_id, item_type, name, series_id, season_id, runtime_ticks, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(server_id, user_id, item_id) DO UPDATE SET
      item_type = excluded.item_type, name = excluded.name, series_id = excluded.series_id,
      season_id = excluded.season_id, runtime_ticks = excluded.runtime_ticks, updated_at = excluded.updated_at
  `).run(input.serverId, input.userId, input.itemId, input.itemType, input.name, input.seriesId, input.seasonId, input.runTimeTicks, now, now);
  return null;
}

function getMediaItem(serverId: string, userId: string, itemId: string): MediaItemRecord | null {
  const row = db().prepare(`
    SELECT * FROM media_items WHERE server_id = ? AND user_id = ? AND item_id = ?
  `).get(serverId, userId, itemId) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    serverId: String(row.server_id),
    userId: String(row.user_id),
    itemId: String(row.item_id),
    itemType: row.item_type as MediaItemRecord["itemType"],
    name: String(row.name),
    seriesId: row.series_id === null ? null : String(row.series_id),
    seasonId: row.season_id === null ? null : String(row.season_id),
    runTimeTicks: Number(row.runtime_ticks),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function upsertMediaSource(input: Extract<PersistenceOperation, { kind: "upsertMediaSource" }>["input"]): null {
  const now = Date.now();
  db().prepare(`
    INSERT INTO media_sources(server_id, user_id, item_id, media_source_id, container, expected_size, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(server_id, user_id, item_id, media_source_id) DO UPDATE SET
      container = excluded.container, expected_size = excluded.expected_size, updated_at = excluded.updated_at
  `).run(input.serverId, input.userId, input.itemId, input.mediaSourceId, input.container, input.expectedSize, now, now);
  return null;
}

function downloadRow(row: Record<string, unknown> | undefined): DownloadJobRecord | null {
  if (!row) return null;
  return {
    downloadId: String(row.download_id),
    serverId: String(row.server_id),
    userId: String(row.user_id),
    itemId: String(row.item_id),
    mediaSourceId: row.media_source_id === null ? null : String(row.media_source_id),
    origin: row.origin as DownloadJobRecord["origin"],
    state: row.state as DownloadJobRecord["state"],
    smartManaged: row.smart_managed === 1,
    keepDownloaded: row.keep_downloaded === 1,
    qualityProfile: row.quality_profile === null ? null : String(row.quality_profile),
    bytesDownloaded: Number(row.bytes_downloaded),
    expectedSize: row.expected_size === null ? null : Number(row.expected_size),
    retryCount: Number(row.retry_count),
    errorCode: row.error_code === null ? null : String(row.error_code),
    errorMessage: row.error_message === null ? null : String(row.error_message),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    completedAt: row.completed_at === null ? null : Number(row.completed_at),
  };
}

function getDownload(downloadId: string): DownloadJobRecord | null {
  return downloadRow(db().prepare("SELECT * FROM download_jobs WHERE download_id = ?").get(downloadId) as Record<string, unknown> | undefined);
}

function getLocalVersionByDownload(downloadId: string): LocalVersionRecord | null {
  const row = db().prepare("SELECT * FROM local_versions WHERE download_id = ?").get(downloadId) as Record<string, unknown> | undefined;
  return row ? localVersionRow(row) : null;
}

function getDownloadBundle(downloadId: string): DownloadBundleRecord | null {
  const job = getDownload(downloadId);
  if (!job) return null;
  const item = db().prepare(`
    SELECT name, item_type FROM media_items WHERE server_id = ? AND user_id = ? AND item_id = ?
  `).get(job.serverId, job.userId, job.itemId) as Record<string, unknown> | undefined;
  if (!item) throw new PersistenceWorkerError("MEDIA_ITEM_NOT_FOUND", "The download media item no longer exists.");
  return {
    job,
    localVersion: getLocalVersionByDownload(downloadId),
    itemName: String(item.name),
    itemType: item.item_type as DownloadBundleRecord["itemType"],
  };
}

function listDownloadBundles(serverId: string, userId: string): DownloadBundleRecord[] {
  const rows = db().prepare(`
    SELECT download_id FROM download_jobs
    WHERE server_id = ? AND user_id = ?
    ORDER BY created_at DESC, download_id DESC
  `).all(serverId, userId) as Array<{ download_id: string }>;
  return rows.map((row) => getDownloadBundle(String(row.download_id))).filter((value): value is DownloadBundleRecord => value !== null);
}

function createDownload(input: Extract<PersistenceOperation, { kind: "createDownload" }>["input"]): DownloadJobRecord {
  const now = Date.now();
  db().prepare(`
    INSERT INTO download_jobs(
      download_id, server_id, user_id, item_id, media_source_id, origin, state, smart_managed, keep_downloaded,
      quality_profile, bytes_downloaded, expected_size, retry_count, error_code, error_message, created_at, updated_at, completed_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, 0, ?, 0, NULL, NULL, ?, ?, NULL)
  `).run(
    input.downloadId, input.serverId, input.userId, input.itemId, input.mediaSourceId, input.origin,
    input.smartManaged ? 1 : 0, input.keepDownloaded ? 1 : 0, input.qualityProfile, input.expectedSize, now, now,
  );
  return getDownload(input.downloadId)!;
}

function transitionDownload(input: Extract<PersistenceOperation, { kind: "transitionDownload" }>["input"]): DownloadJobRecord {
  const current = getDownload(input.downloadId);
  if (!current) throw new PersistenceWorkerError("DOWNLOAD_NOT_FOUND", "The download no longer exists.");
  if (input.state !== current.state && !DOWNLOAD_TRANSITIONS[current.state].has(input.state)) {
    throw new PersistenceWorkerError("INVALID_DOWNLOAD_TRANSITION", "That download state transition is not allowed.");
  }
  const bytes = input.bytesDownloaded ?? current.bytesDownloaded;
  const recoveringQueuedTransfer = current.state === "queued" && input.state === "downloading";
  if (bytes < current.bytesDownloaded && !recoveringQueuedTransfer) {
    throw new PersistenceWorkerError("INVALID_DOWNLOAD_PROGRESS", "Download progress cannot move backward.");
  }
  if (current.expectedSize !== null && bytes > current.expectedSize) throw new PersistenceWorkerError("INVALID_DOWNLOAD_PROGRESS", "Download progress exceeds the expected size.");
  if (input.state === "completed" && current.expectedSize !== null && bytes !== current.expectedSize) {
    throw new PersistenceWorkerError("DOWNLOAD_SIZE_MISMATCH", "The download cannot complete because its size does not match.");
  }
  const now = Date.now();
  const retryCount = current.state === "failed" && input.state === "queued" ? current.retryCount + 1 : current.retryCount;
  const errorCode = input.state === "failed" || input.state === "paused" ? (input.errorCode ?? current.errorCode) : null;
  const errorMessage = input.state === "failed" || input.state === "paused" ? (input.errorMessage ?? current.errorMessage) : null;
  db().prepare(`
    UPDATE download_jobs
    SET state = ?, bytes_downloaded = ?, retry_count = ?, error_code = ?, error_message = ?, updated_at = ?, completed_at = ?
    WHERE download_id = ?
  `).run(input.state, bytes, retryCount, errorCode, errorMessage, now, input.state === "completed" ? now : current.completedAt, input.downloadId);
  return getDownload(input.downloadId)!;
}

function localVersionRow(row: Record<string, unknown>): LocalVersionRecord {
  return {
    localVersionId: String(row.local_version_id),
    serverId: String(row.server_id),
    userId: String(row.user_id),
    itemId: String(row.item_id),
    mediaSourceId: row.media_source_id === null ? null : String(row.media_source_id),
    downloadId: row.download_id === null ? null : String(row.download_id),
    storageRoot: String(row.storage_root),
    localPath: String(row.local_path),
    pathKey: String(row.path_key),
    origin: row.origin as LocalVersionRecord["origin"],
    smartManaged: row.smart_managed === 1,
    keepDownloaded: row.keep_downloaded === 1,
    fileState: row.file_state as LocalVersionRecord["fileState"],
    probeState: row.probe_state as LocalVersionRecord["probeState"],
    expectedSize: row.expected_size === null ? null : Number(row.expected_size),
    actualSize: row.actual_size === null ? null : Number(row.actual_size),
    container: row.container === null ? null : String(row.container),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function getLocalVersion(localVersionId: string): LocalVersionRecord | null {
  const row = db().prepare("SELECT * FROM local_versions WHERE local_version_id = ?").get(localVersionId) as Record<string, unknown> | undefined;
  return row ? localVersionRow(row) : null;
}

function assertFinalizedVersion(probeState: string, actualSize: number | null, expectedSize: number | null): void {
  if (probeState !== "valid" || actualSize === null || (expectedSize !== null && expectedSize !== actualSize)) {
    throw new PersistenceWorkerError("LOCAL_VERSION_NOT_VERIFIED", "A local version cannot be finalized until size and media probing succeed.");
  }
}

function registerLocalVersion(input: Extract<PersistenceOperation, { kind: "registerLocalVersion" }>["input"]): LocalVersionRecord {
  if (input.fileState === "finalized") assertFinalizedVersion(input.probeState, input.actualSize, input.expectedSize);
  const now = Date.now();
  db().prepare(`
    INSERT INTO local_versions(
      local_version_id, server_id, user_id, item_id, media_source_id, download_id, storage_root, local_path, path_key,
      origin, smart_managed, keep_downloaded, file_state, probe_state, expected_size, actual_size, container, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.localVersionId, input.serverId, input.userId, input.itemId, input.mediaSourceId, input.downloadId,
    input.storageRoot, input.localPath, input.pathKey, input.origin, input.smartManaged ? 1 : 0, input.keepDownloaded ? 1 : 0,
    input.fileState, input.probeState, input.expectedSize, input.actualSize, input.container, now, now,
  );
  return getLocalVersion(input.localVersionId)!;
}

function createDownloadBundle(operation: Extract<PersistenceOperation, { kind: "createDownloadBundle" }>): DownloadBundleRecord {
  return transaction(() => {
    createDownload(operation.download);
    registerLocalVersion(operation.localVersion);
    return getDownloadBundle(operation.download.downloadId)!;
  });
}

function setDownloadKeep(downloadId: string, keepDownloaded: boolean): DownloadBundleRecord {
  return transaction(() => {
    const current = getDownloadBundle(downloadId);
    if (!current) throw new PersistenceWorkerError("DOWNLOAD_NOT_FOUND", "The download no longer exists.");
    const keep = keepDownloaded ? 1 : 0;
    const now = Date.now();
    db().prepare("UPDATE download_jobs SET keep_downloaded = ?, updated_at = ? WHERE download_id = ?")
      .run(keep, now, downloadId);
    db().prepare("UPDATE local_versions SET keep_downloaded = ?, updated_at = ? WHERE download_id = ?")
      .run(keep, now, downloadId);
    return getDownloadBundle(downloadId)!;
  });
}

function setDownloadExpectedSize(downloadId: string, expectedSize: number): DownloadBundleRecord {
  return transaction(() => {
    const current = getDownloadBundle(downloadId);
    if (!current) throw new PersistenceWorkerError("DOWNLOAD_NOT_FOUND", "The download no longer exists.");
    if (current.job.bytesDownloaded > expectedSize) {
      throw new PersistenceWorkerError("INVALID_DOWNLOAD_PROGRESS", "The expected size is smaller than downloaded progress.");
    }
    const now = Date.now();
    db().prepare("UPDATE download_jobs SET expected_size = ?, updated_at = ? WHERE download_id = ?")
      .run(expectedSize, now, downloadId);
    db().prepare("UPDATE local_versions SET expected_size = ?, updated_at = ? WHERE download_id = ?")
      .run(expectedSize, now, downloadId);
    return getDownloadBundle(downloadId)!;
  });
}

function updateLocalVersion(input: Extract<PersistenceOperation, { kind: "updateLocalVersion" }>["input"]): LocalVersionRecord {
  const current = getLocalVersion(input.localVersionId);
  if (!current) throw new PersistenceWorkerError("LOCAL_VERSION_NOT_FOUND", "The local version no longer exists.");
  if (input.fileState === "finalized") assertFinalizedVersion(input.probeState, input.actualSize, current.expectedSize);
  db().prepare(`
    UPDATE local_versions SET file_state = ?, probe_state = ?, actual_size = ?, updated_at = ? WHERE local_version_id = ?
  `).run(input.fileState, input.probeState, input.actualSize, Date.now(), input.localVersionId);
  return getLocalVersion(input.localVersionId)!;
}

function listLocalVersions(serverId: string, userId: string, itemId: string): LocalVersionRecord[] {
  return (db().prepare(`
    SELECT * FROM local_versions WHERE server_id = ? AND user_id = ? AND item_id = ? ORDER BY created_at, local_version_id
  `).all(serverId, userId, itemId) as Record<string, unknown>[]).map(localVersionRow);
}

function playbackRevisionRow(row: Record<string, unknown>): PlaybackRevisionRecord {
  const reportKind = row.report_kind === null || row.report_kind === undefined
    ? null
    : row.report_kind as NonNullable<PlaybackRevisionRecord["report"]>["kind"];
  return {
    serverId: String(row.server_id),
    userId: String(row.user_id),
    itemId: String(row.item_id),
    localRevision: Number(row.local_revision),
    actionKind: row.action_kind as PlaybackRevisionRecord["actionKind"],
    positionTicks: Number(row.position_ticks),
    watched: row.watched === 1,
    report: reportKind === null ? null : {
      kind: reportKind,
      mediaSourceId: String(row.report_media_source_id),
      playMethod: row.report_play_method as NonNullable<PlaybackRevisionRecord["report"]>["playMethod"],
      playSessionId: String(row.report_play_session_id),
      paused: row.report_paused === 1,
      canSeek: row.report_can_seek === 1,
      audioStreamIndex: row.report_audio_stream_index === null ? null : Number(row.report_audio_stream_index),
      subtitleStreamIndex: row.report_subtitle_stream_index === null ? null : Number(row.report_subtitle_stream_index),
      conflictPolicy: row.report_conflict_policy === "explicit" ? "explicit" : "automatic",
    },
    completionEvent: row.completion_event === 1,
    occurredAt: Number(row.occurred_at),
    syncState: row.sync_state as PlaybackRevisionRecord["syncState"],
    attemptCount: Number(row.attempt_count),
    lastError: row.last_error === null ? null : String(row.last_error),
    syncedAt: row.synced_at === null ? null : Number(row.synced_at),
  };
}

function playbackHeadRow(row: Record<string, unknown> | undefined): PlaybackHeadRecord | null {
  if (!row) return null;
  return {
    serverId: String(row.server_id),
    userId: String(row.user_id),
    itemId: String(row.item_id),
    latestRevision: Number(row.latest_revision),
    conflictPolicy: row.effective_conflict_policy === "explicit" ? "explicit" : "automatic",
    actionKind: row.action_kind as PlaybackHeadRecord["actionKind"],
    positionTicks: Number(row.position_ticks),
    watched: row.watched === 1,
    occurredAt: Number(row.occurred_at),
    lastSucceededRevision: Number(row.last_succeeded_revision),
    lastSucceededPositionTicks: Number(row.last_succeeded_position_ticks),
    lastSucceededWatched: row.last_succeeded_watched === 1,
    updatedAt: Number(row.updated_at),
  };
}

function getPlaybackHead(serverId: string, userId: string, itemId: string): PlaybackHeadRecord | null {
  return playbackHeadRow(db().prepare(`
    SELECT playback_heads.*,
      CASE WHEN EXISTS (
        SELECT 1 FROM playback_revisions
        WHERE playback_revisions.server_id = playback_heads.server_id
          AND playback_revisions.user_id = playback_heads.user_id
          AND playback_revisions.item_id = playback_heads.item_id
          AND playback_revisions.local_revision > playback_heads.last_succeeded_revision
          AND playback_revisions.sync_state IN ('pending', 'failed')
          AND (
            playback_revisions.report_conflict_policy = 'explicit'
            OR (
              playback_revisions.report_conflict_policy IS NULL
              AND playback_revisions.action_kind <> 'progress'
            )
          )
      ) THEN 'explicit' ELSE 'automatic' END AS effective_conflict_policy
    FROM playback_heads
    WHERE playback_heads.server_id = ? AND playback_heads.user_id = ? AND playback_heads.item_id = ?
  `).get(serverId, userId, itemId) as Record<string, unknown> | undefined);
}

function recordPlaybackRevision(input: Extract<PersistenceOperation, { kind: "recordPlaybackRevision" }>["input"]): PlaybackRevisionRecord {
  return transaction(() => {
    const head = getPlaybackHead(input.serverId, input.userId, input.itemId);
    const revision = (head?.latestRevision ?? 0) + 1;
    const completionEvent = input.actionKind === "completed";
    db().prepare(`
      INSERT INTO playback_revisions(
        server_id, user_id, item_id, local_revision, action_kind, position_ticks, watched, completion_event,
        occurred_at, sync_state, attempt_count, last_error, synced_at,
        report_kind, report_media_source_id, report_play_method, report_play_session_id,
        report_paused, report_can_seek, report_audio_stream_index, report_subtitle_stream_index,
        report_conflict_policy
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.serverId, input.userId, input.itemId, revision, input.actionKind, input.positionTicks,
      input.watched ? 1 : 0, completionEvent ? 1 : 0, input.occurredAt,
      input.report?.kind ?? null,
      input.report?.mediaSourceId ?? null,
      input.report?.playMethod ?? null,
      input.report?.playSessionId ?? null,
      input.report ? (input.report.paused ? 1 : 0) : null,
      input.report ? (input.report.canSeek ? 1 : 0) : null,
      input.report?.audioStreamIndex ?? null,
      input.report?.subtitleStreamIndex ?? null,
      input.report?.conflictPolicy ?? null,
    );
    db().prepare(`
      INSERT INTO playback_heads(
        server_id, user_id, item_id, latest_revision, action_kind, position_ticks, watched, occurred_at,
        last_succeeded_revision, last_succeeded_position_ticks, last_succeeded_watched, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, ?)
      ON CONFLICT(server_id, user_id, item_id) DO UPDATE SET
        latest_revision = excluded.latest_revision, action_kind = excluded.action_kind,
        position_ticks = excluded.position_ticks, watched = excluded.watched,
        occurred_at = excluded.occurred_at, updated_at = excluded.updated_at
    `).run(
      input.serverId, input.userId, input.itemId, revision, input.actionKind, input.positionTicks,
      input.watched ? 1 : 0, input.occurredAt, Date.now(),
    );
    const row = db().prepare(`
      SELECT * FROM playback_revisions WHERE server_id = ? AND user_id = ? AND item_id = ? AND local_revision = ?
    `).get(input.serverId, input.userId, input.itemId, revision) as Record<string, unknown>;
    return playbackRevisionRow(row);
  });
}

function listPendingProgressForIdentity(serverId: string, userId: string, limit: number): PlaybackRevisionRecord[] {
  return (db().prepare(`
      SELECT * FROM playback_revisions
      WHERE server_id = ? AND user_id = ? AND sync_state IN ('pending', 'failed')
      ORDER BY occurred_at, item_id, local_revision
      LIMIT ?
    `).all(serverId, userId, limit) as Record<string, unknown>[]).map(playbackRevisionRow);
}

function listPendingProgress(limit: number): PlaybackRevisionRecord[] {
  return (db().prepare(`
      SELECT * FROM playback_revisions
      WHERE sync_state IN ('pending', 'failed')
      ORDER BY occurred_at, server_id, user_id, item_id, local_revision
      LIMIT ?
    `).all(limit) as Record<string, unknown>[]).map(playbackRevisionRow);
}

function markProgressSucceeded(serverId: string, userId: string, itemId: string, localRevision: number, syncedAt: number): null {
  transaction(() => {
    const revision = db().prepare(`
      SELECT * FROM playback_revisions WHERE server_id = ? AND user_id = ? AND item_id = ? AND local_revision = ?
    `).get(serverId, userId, itemId, localRevision) as Record<string, unknown> | undefined;
    if (!revision) throw new PersistenceWorkerError("PROGRESS_REVISION_NOT_FOUND", "The playback revision no longer exists.");
    db().prepare(`
      UPDATE playback_revisions SET sync_state = 'succeeded', attempt_count = attempt_count + 1,
        synced_at = ?, last_error = NULL
      WHERE server_id = ? AND user_id = ? AND item_id = ? AND local_revision = ?
    `).run(syncedAt, serverId, userId, itemId, localRevision);
    db().prepare(`
      UPDATE playback_heads SET
        last_succeeded_revision = CASE WHEN ? > last_succeeded_revision THEN ? ELSE last_succeeded_revision END,
        last_succeeded_position_ticks = CASE WHEN ? > last_succeeded_revision THEN ? ELSE last_succeeded_position_ticks END,
        last_succeeded_watched = CASE WHEN ? > last_succeeded_revision THEN ? ELSE last_succeeded_watched END,
        updated_at = ?
      WHERE server_id = ? AND user_id = ? AND item_id = ?
    `).run(
      localRevision, localRevision,
      localRevision, Number(revision.position_ticks),
      localRevision, revision.watched === 1 ? 1 : 0,
      Date.now(), serverId, userId, itemId,
    );
  });
  return null;
}

function markProgressFailed(serverId: string, userId: string, itemId: string, localRevision: number, error: string): PlaybackRevisionRecord {
  const result = db().prepare(`
    UPDATE playback_revisions SET sync_state = 'failed', attempt_count = attempt_count + 1,
      last_error = ?, synced_at = NULL
    WHERE server_id = ? AND user_id = ? AND item_id = ? AND local_revision = ?
      AND sync_state IN ('pending', 'failed')
    RETURNING *
  `).get(error, serverId, userId, itemId, localRevision) as Record<string, unknown> | undefined;
  if (!result) throw new PersistenceWorkerError("PROGRESS_REVISION_NOT_PENDING", "The playback revision is no longer pending synchronization.");
  return playbackRevisionRow(result);
}

function markPlaybackSuperseded(serverId: string, userId: string, itemId: string, localRevision: number): PlaybackRevisionRecord {
  const result = db().prepare(`
    UPDATE playback_revisions SET sync_state = 'superseded', last_error = NULL, synced_at = NULL
    WHERE server_id = ? AND user_id = ? AND item_id = ? AND local_revision = ?
      AND sync_state IN ('pending', 'failed')
    RETURNING *
  `).get(serverId, userId, itemId, localRevision) as Record<string, unknown> | undefined;
  if (!result) throw new PersistenceWorkerError("PROGRESS_REVISION_NOT_SUPERSEDABLE", "The playback revision is no longer pending synchronization.");
  return playbackRevisionRow(result);
}

function execute(operation: PersistenceOperation): unknown {
  if (operation.kind === "initialize") return initialize();
  if (operation.kind === "close") {
    database?.close();
    database = null;
    health = null;
    return null;
  }
  initialize();
  switch (operation.kind) {
    case "getApplicationPreference": return getApplicationPreference(operation.key);
    case "setApplicationPreference": return setApplicationPreference(operation.key, operation.valueJson, operation.updatedAt);
    case "upsertCatalogIdentity": return upsertCatalogIdentity(operation.input);
    case "upsertMediaItem": return upsertMediaItem(operation.input);
    case "getMediaItem": return getMediaItem(operation.serverId, operation.userId, operation.itemId);
    case "upsertMediaSource": return upsertMediaSource(operation.input);
    case "createDownload": return createDownload(operation.input);
    case "createDownloadBundle": return createDownloadBundle(operation);
    case "transitionDownload": return transitionDownload(operation.input);
    case "getDownload": return getDownload(operation.downloadId);
    case "getDownloadBundle": return getDownloadBundle(operation.downloadId);
    case "listDownloadBundles": return listDownloadBundles(operation.serverId, operation.userId);
    case "setDownloadKeep": return setDownloadKeep(operation.downloadId, operation.keepDownloaded);
    case "setDownloadExpectedSize": return setDownloadExpectedSize(operation.downloadId, operation.expectedSize);
    case "registerLocalVersion": return registerLocalVersion(operation.input);
    case "updateLocalVersion": return updateLocalVersion(operation.input);
    case "listLocalVersions": return listLocalVersions(operation.serverId, operation.userId, operation.itemId);
    case "recordPlaybackRevision": return recordPlaybackRevision(operation.input);
    case "getPlaybackHead": return getPlaybackHead(operation.serverId, operation.userId, operation.itemId);
    case "listPendingProgress": return listPendingProgress(operation.limit);
    case "listPendingProgressForIdentity": return listPendingProgressForIdentity(
      operation.serverId, operation.userId, operation.limit,
    );
    case "markProgressSucceeded": return markProgressSucceeded(
      operation.serverId, operation.userId, operation.itemId, operation.localRevision, operation.syncedAt,
    );
    case "markProgressFailed": return markProgressFailed(
      operation.serverId, operation.userId, operation.itemId, operation.localRevision, operation.error,
    );
    case "markPlaybackSuperseded": return markPlaybackSuperseded(
      operation.serverId, operation.userId, operation.itemId, operation.localRevision,
    );
    case "health": return health;
  }
}

function safeError(error: unknown): { code: string; message: string } {
  if (error instanceof PersistenceWorkerError) return { code: error.code, message: error.message };
  const code = String((error as { code?: unknown })?.code ?? "");
  const internalMessage = String((error as { message?: unknown })?.message ?? "");
  if (/CONSTRAINT/.test(code) || /constraint|unique/i.test(internalMessage)) {
    return { code: "PERSISTENCE_CONSTRAINT", message: "Local data conflicts with an existing record." };
  }
  if (/CORRUPT|NOTADB/.test(code) || /not a database|malformed/i.test(internalMessage)) {
    return { code: "PERSISTENCE_CORRUPT", message: "Local data failed its integrity check." };
  }
  return { code: "PERSISTENCE_ERROR", message: "Local data could not be saved." };
}

port.on("message", (request: PersistenceRequest) => {
  let response: PersistenceResponse;
  try {
    response = { id: request.id, ok: true, result: execute(request.operation) };
  } catch (error) {
    response = { id: request.id, ok: false, error: safeError(error) };
  }
  port.postMessage(response);
  if (request.operation.kind === "close") port.close();
});
