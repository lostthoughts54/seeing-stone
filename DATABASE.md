# SQLite persistence model

Milestone 4 establishes the local data boundary. It does not download, probe, delete, or select media yet.

## Process boundary

- Electron main owns `SqlitePersistenceService`.
- A dedicated Node worker owns the only `DatabaseSync` connection.
- SQLite calls never run synchronously on Electron's main event loop.
- No database method, SQL string, local path, or database record is exposed through preload or renderer IPC.
- The database is stored as `localfirst.sqlite3` under Electron's user-data directory.

The connection uses WAL mode, foreign keys, a bounded busy timeout, defensive mode, disabled extension loading, transactional migrations, and startup integrity checks.

## Schema version 1

### Catalog identity

- `servers`: stable Jellyfin server identity and current address.
- `profiles`: Jellyfin user identity scoped to a server.
- `media_items`: Jellyfin item identity and the minimum metadata needed by later offline features.
- `media_sources`: media-source identity, container, and expected size when Jellyfin provides one.

Every download, local version, and progress revision is scoped by server, user, and item. A title or filename is never treated as identity.

### Download foundation

- `download_jobs` stores manual versus smart origin, transfer state, bytes, expected size, quality profile, retry count, error state, smart-management status, and Keep Downloaded status.
- Active transfer identity is unique, preventing duplicate queued/running/paused/failed jobs for the same item, media source, and quality.
- A job left `downloading` by a process exit is changed to `paused` with the `INTERRUPTED` reason on the next startup.
- Terminal completed jobs are retained as history; later manual deletion can mark the associated local version missing and permit a deliberate replacement download.

Milestone 4 does not automatically remove any row or media file. Storage-limit behavior and cleanup remain manual in V1.

### Local versions

- `local_versions` stores the authorized storage root and main-only absolute path, Jellyfin identity, optional media-source and download identity, origin, smart-management and Keep Downloaded flags, expected and actual size, container, finalized-file state, and media-probe state.
- Paths must be absolute and contained by the authorized storage root before they can be stored.
- A version cannot become `finalized` unless probing is `valid`, an actual size exists, and the expected size matches when one is available.
- Full-file checksums are deliberately not required by the V1 schema.

Later playback resolution must additionally confirm current path containment, existence, finalized state, size when available, and a successful probe before using a local file.

### Playback and synchronization foundation

- `playback_revisions` is an append-only local action journal per server, user, and item.
- `playback_heads` stores the newest authoritative local revision plus the newest revision successfully synchronized to Jellyfin.
- Actions distinguish normal progress, completion, Start Over, replay, mark watched, and mark unwatched.
- Completion is stored explicitly and is not lost when a newer position is recorded.
- A newer explicit action may intentionally lower position or change watched state.
- A late success for an older revision cannot move the stored successful head backward.

Offline coalescing and Jellyfin synchronization policy are implemented in the later offline-synchronization milestone. The persistence model supplies the revisions needed to do it safely.

## Migrations and failure behavior

- `PRAGMA user_version` is the authoritative schema version.
- Each migration runs inside `BEGIN IMMEDIATE` and is rolled back on failure.
- A database from a newer application version is refused without modification.
- A malformed database or failed integrity/foreign-key check is refused without deletion or silent replacement.
- Prepared statements bind every data value; no caller can submit arbitrary SQL.
