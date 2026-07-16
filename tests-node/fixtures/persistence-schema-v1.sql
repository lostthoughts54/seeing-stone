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

PRAGMA user_version = 1;
