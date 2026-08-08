# SQLite persistence model

Milestone 4 established the local data boundary. The database is now schema version 8. Every change preserves existing catalog, download, local-version, playback, preference, and Smart Download rows across upgrades.

## Process boundary

- Electron main owns `SqlitePersistenceService`.
- A dedicated Node worker owns the only `DatabaseSync` connection.
- SQLite calls never run synchronously on Electron's main event loop.
- No database method, SQL string, local path, or database record is exposed through preload or renderer IPC.
- The database is stored as `localfirst.sqlite3` under Electron's user-data directory.

The connection uses WAL mode, foreign keys, a bounded busy timeout, defensive mode, disabled extension loading, transactional migrations, and startup integrity checks.

## Schema version 1 foundation

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

Insufficient storage pauses a job with an actionable error and never triggers arbitrary cleanup. Automatic rotation is limited to version-8 Smart Download rules and only selects unkept, non-playing records whose `smart_managed` flag remains set after a complete series enumeration.

### Local versions

- `local_versions` stores the authorized storage root and main-only absolute path, Jellyfin identity, optional media-source and download identity, origin, smart-management and Keep Downloaded flags, expected and actual size, container, finalized-file state, and media-probe state.
- Paths must be absolute and contained by the authorized storage root before they can be stored.
- A version cannot become `finalized` unless probing is `valid`, an actual size exists, and the expected size matches when one is available.
- Full-file checksums are deliberately not required by the V1 schema.

Milestone 6 playback resolution additionally confirms the configured authorized root, current path containment, existence, finalized state, actual and expected size, and a fresh successful probe before using a local file. Failed validation marks the copy missing or invalid and falls back to Jellyfin without deleting it.

### Playback and synchronization foundation

- `playback_revisions` is an append-only local action journal per server, user, and item.
- `playback_heads` stores the newest authoritative local revision plus the newest revision successfully synchronized to Jellyfin.
- Actions distinguish normal progress, completion, Start Over, replay, mark watched, and mark unwatched.
- Completion is stored explicitly and is not lost when a newer position is recorded.
- A newer explicit action may intentionally lower position or change watched state.
- A late success for an older revision cannot move the stored successful head backward.

Milestone 7 coalesces redundant automatic progress while retaining completion and explicit actions. Failed attempts stay retryable with a bounded safe error code; superseded revisions remain in the journal for ordering evidence. Successful revisions advance the stored head transactionally, and older late results cannot move it backward.

## Additive schema versions 2 through 8

- Version 2 adds durable Jellyfin playback-report fields to each revision.
- Version 3 records whether a report is automatic or an explicit local action for conflict resolution.
- Version 6 expands application preferences for Companion Remote settings.
- Version 7 expands application preferences for the saved per-computer watch-party timing adjustment.
- Version 4 adds bounded application preferences for adapter selection and watchparty buffering policy. The legacy global diagnostics preference remains readable for compatibility but is not used by Gate 6.
- Version 5 adds bounded nullable `metadata_json` and `next_up_json` fields per server/user/item, plus `diagnostics_json` per exact media source. Strict main-process validation rejects unknown or privileged fields before storage and discards malformed cached values after retrieval.
- Version 5 also adds an identity-scoped partial index for verified local playback discovery. The renderer receives only sanitized item metadata and resume state; local roots, paths, local-version IDs, media-source IDs, stream URLs, and credentials remain main-only.
- Version 8 adds `smart_series_rules` keyed by server, user, and series, with a checked limit of one through five, nullable last-success timestamp, and nullable sanitized error fields. It also adds `smart_episode_skips`, whose rows cascade when the follow rule is deleted.
- Transient Smart Download states are not database columns. `checking` is owned by the active main-process service and `offline` comes from current Jellyfin connection diagnostics.
- Updating `smart_managed` for a download changes both the job and its associated local version in one transaction. Local **Keep copies** unfollow also unmanages every associated job/local-version pair and removes the rule and skips transactionally. `origin` is never rewritten.

Older rows with no version-5 cache remain valid and materialize as minimal safe item metadata until a successful Jellyfin request refreshes them.

## Migrations and failure behavior

- `PRAGMA user_version` is the authoritative schema version.
- Each migration runs inside `BEGIN IMMEDIATE` and is rolled back on failure.
- A database from a newer application version is refused without modification.
- A malformed database or failed integrity/foreign-key check is refused without deletion or silent replacement.
- Prepared statements bind every data value; no caller can submit arbitrary SQL.
