# Download lifecycle

Seeing Stone downloads individual Jellyfin movies and episodes and can maintain a bounded set of upcoming episodes for explicitly followed series. Quality selection remains outside the current feature set.

## Security and process boundary

- The renderer sends only an item ID or an opaque download ID through strict IPC schemas.
- Electron main selects the authenticated Jellyfin media source and constructs the authorized destination.
- Tokens, stream URLs, media-source IDs, absolute paths, request headers, and filesystem methods never cross preload.
- Transfer I/O uses asynchronous fetch and filesystem calls. SQLite remains in its worker thread and probing runs in a controlled hidden mpv child process.
- Renderer download state is an allowlisted summary containing identity, display name, progress, safe errors, and allowed actions.

## Storage

Downloads initially live under `LocalFirst Jellyfin Downloads` in the current Windows user's Videos known folder. The Downloads panel can open a native Windows folder picker to place future downloads on another drive, open the active folder in Explorer, or return to the default Videos folder. The app creates or reuses a `LocalFirst Jellyfin Downloads` child folder at the chosen location.

Changing the active location does not move or invalidate existing media. Each queued, paused, or completed copy retains its original main-owned storage root, and only roots selected through the native picker remain authorized after restart. New downloads use the newly selected root. The renderer receives only a summary such as `Custom folder on D:`; exact paths and filesystem operations remain main-only.

Each download receives an opaque folder and a single finalized media file. The exact path is main-only.

The queue reserves free space before a transfer. If capacity is insufficient or Windows reports `ENOSPC`, the transfer becomes Paused with a manual-cleanup message. Storage pressure never chooses a file to delete; only a successful Smart Download reconciliation may rotate an eligible managed episode.

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
- Keep Downloaded prevents Smart Download rotation. Manual and unmanaged downloads are never selected for automatic cleanup.

## Smart Downloads

A series can be followed from its details page with an independent limit of one through five episodes. The first configured number of regular, playable, unwatched, unskipped episodes are the exact targets. Existing queued, downloading, paused, downloaded, or failed jobs occupy their episode's target even when they were started manually. Failed jobs remain visible for an explicit Retry and never cause a duplicate or allow a later episode to jump the queue.

The main process checks followed series after launch or session restoration, an actual offline/reconnecting-to-connected transition, watched/completion changes, limit changes, explicit **Check now**, and every three hours while the application is running. Repeated healthy connection diagnostics do not trigger checks. Episodes are enumerated in exact pages of 200. No download is queued or rotated unless every page succeeds under one authenticated session revision, reports one stable total, advances continuously, contains unique opaque identities, and produces exactly the reported number of episodes. Specials, virtual or missing entries, and malformed episode numbering do not participate.

Only copies with `smartManaged: true` may be rotated. Historical `origin: "smart"` metadata is retained after a copy becomes ordinary. Kept copies, manual copies, unmanaged copies, unexpectedly absent episodes, and the currently playing copy are preserved. Cleanup of a playing copy is deferred until playback stops and a new complete enumeration succeeds.

Choosing **Skip episode** or **Remove & skip** records an identity-scoped durable skip before cleanup; marking the episode unwatched does not clear it. Unfollowing and following again clears the series' skips. Unfollowing is entirely local and works without Jellyfin:

- **Keep copies** converts every associated job and local version to unmanaged in one persistence transaction, then removes the follow rule and skips.
- **Remove smart copies** removes eligible local managed copies, converts kept or currently playing copies to ordinary unmanaged downloads, and retains/unmanages any copy whose validated cleanup fails.

Only durable successful-check timestamps and sanitized errors are stored. `checking` and `offline` are derived at runtime, so an interrupted process cannot leave a series permanently marked as checking.

## Watch while downloading

Movie and episode transfers expose a stable **Watch now** action while a known-size download is active or paused. Eligibility is checked authoritatively only when the action is selected: a partial file that has buffered at least 30 seconds by the selected source bitrate, with an 8 MiB minimum and a 32 MiB fallback when bitrate is unavailable, opens progressively; an earlier attempt reports that it is still buffering and never falls through to Jellyfin. Queued, unknown-size, and newly failed transfers explain why the partial copy cannot be attempted. A lease that was already playing remains alive across a transfer failure so Retry can continue feeding the same player.

Progressive media is served through an opaque main-owned loopback capability; mpv never receives the `media.part` path. The capability advertises the stable expected size, accepts one strict byte range, waits at the current byte frontier, and is invalidated by cancellation, deletion, session changes, shutdown, or failed final probing. During the initial paused open only, mpv may fetch up to 16 MiB of exact-source container metadata beyond the partial prefix. Those bytes are never written locally and never count toward download progress or seeking.

Seeking is restricted to the contiguous beginning-of-file range confirmed by mpv's demuxer cache. A disconnected metadata range cannot extend the timeline frontier. Completion switches the active lease to the validated final file and removes the progressive restriction without reloading playback.

Normal Play actions select an exact verified downloaded copy, then an eligible progressive copy, before falling back to Jellyfin. Completed entries expose Play directly in the Downloads panel and join other verified local copies in the `Local playback available` Home row while the server is unreachable. Partial copies remain excluded from offline and downloaded-library surfaces. See [LOCAL_PLAYBACK.md](LOCAL_PLAYBACK.md).
