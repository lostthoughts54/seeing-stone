# Unified local-first playback

Milestone 6 keeps one Play action throughout Home, libraries, search, details, seasons, episode rows, and the Downloads panel. A finalized download remains playable from Downloads when the Jellyfin home screen cannot be reached. The renderer submits only a Jellyfin item ID and receives only sanitized playback state.

## Resolution order

1. Look up finalized local versions scoped to the active Jellyfin server, user, and exact item ID.
2. Prefer the newest protected verified version when more than one exists.
3. Revalidate the configured download root, path containment, file existence, recorded actual size, expected size when available, and media usability through a fresh hidden mpv probe.
4. Give the validated path directly to the main-controlled mpv process.
5. If no candidate passes, use the existing Jellyfin Direct Stream or transcode resolver.

Titles and filenames are never used to substitute a different item. Missing, changed, path-escaped, or probe-invalid copies are marked unusable but never deleted automatically.

## Security boundary

- Absolute paths remain in Electron main and the SQLite worker.
- The local path is never returned through IPC, preload, renderer state, logs, or a tokenized URL.
- The renderer cannot choose a local file, media source, executable, or mpv argument.
- The same controlled mpv window, seeking, tracks, fullscreen, completion, and Jellyfin Next Up behavior apply to local and server playback.

## Resume and reporting

When Jellyfin is reachable, its current authoritative resume metadata is used. If a verified local file is available while Jellyfin is unreachable, the newest local playback head is used, falling back to the beginning when no position has been recorded.

Authoritative mpv events report local playback to Jellyfin as `DirectPlay`. Server direct delivery reports `DirectStream`, and transcoding reports `Transcode`. Durable queuing and conflict-safe synchronization of reports while offline are intentionally deferred to the offline-synchronization milestone.
