# Manual download lifecycle

Milestone 5 downloads individual Jellyfin movies and episodes. Series-level rotation, quality selection, and smart downloads remain outside this milestone.

## Security and process boundary

- The renderer sends only an item ID or an opaque download ID through strict IPC schemas.
- Electron main selects the authenticated Jellyfin media source and constructs the authorized destination.
- Tokens, stream URLs, media-source IDs, absolute paths, request headers, and filesystem methods never cross preload.
- Transfer I/O uses asynchronous fetch and filesystem calls. SQLite remains in its worker thread and probing runs in a controlled hidden mpv child process.
- Renderer download state is an allowlisted summary containing identity, display name, progress, safe errors, and allowed actions.

## Storage

Downloads live under `LocalFirst Jellyfin Downloads` in the current Windows user's Videos known folder. Each download receives an opaque folder and a single finalized media file. The exact path is main-only.

The queue reserves free space before a transfer. If capacity is insufficient or Windows reports `ENOSPC`, the transfer becomes Paused with a manual-cleanup message. No existing file is selected or deleted automatically.

## State and validation

1. Jellyfin item and source identities are recorded transactionally with a queued job and staged local version.
2. A partial file is resumed only through a validated HTTP range response; a full response safely restarts it from byte zero.
3. Expected size comes from Jellyfin playback information or response headers when available.
4. The partial file is flushed and atomically renamed within the authorized storage root.
5. A hidden mpv process must decode the media successfully.
6. SQLite marks the local version finalized and valid before the job becomes Downloaded.

Startup converts an interrupted Downloading job to Paused. A finalized file left by a crash is rechecked and can complete without downloading again. Missing or size-mismatched finalized files are reported as Missing.

## User actions

- Download is available on movie details and individual episode rows. A season view can select all or any subset of its episodes and queues each selection through the same validated item-ID-only action.
- The account menu opens the download manager.
- Queued or active transfers can pause or cancel.
- Paused transfers can resume; failed transfers can retry.
- Completed copies can be explicitly deleted.
- Keep Downloaded is durable metadata for future smart-download policy; Milestone 5 never auto-deletes either kept or ordinary downloads.

Normal Play actions now select an exact verified downloaded copy before falling back to Jellyfin. Completed entries expose Play directly in the Downloads panel and in a Downloaded Media row on Home while the server is unreachable. See [LOCAL_PLAYBACK.md](LOCAL_PLAYBACK.md).
