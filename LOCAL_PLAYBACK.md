# Unified local-first playback

Milestone 6 keeps one Play action throughout Home, libraries, search, details, seasons, episode rows, and the Downloads panel. When Jellyfin cannot be reached, all last-known verified local items appear in a `Local playback available` row with cached title, episode, watched, and resume metadata. Availability is revalidated before every open, so a copy moved or deleted outside Seeing Stone is rejected and removed from future verified results. The renderer submits only a Jellyfin item ID and receives only sanitized playback state.

## Resolution order

1. Look up finalized local versions scoped to the active Jellyfin server, user, and exact item ID.
2. Use the same deterministic preference as online local playback: matched/imported local, Keep Downloaded, then newest.
3. Revalidate the configured download root, path containment, file existence, recorded actual size, expected size when available, and media usability through a fresh hidden mpv probe.
4. Give the validated path directly to the main-controlled mpv process.
5. When connection state is explicitly Offline or Reconnecting, make no Jellyfin details or capability request and open from the cached identity, metadata, diagnostics, and local resume head.
6. When Jellyfin is reachable, attach matching external text subtitles from the selected Jellyfin media source through a separate authenticated main-process proxy. Subtitle lookup failure never disqualifies the verified local video.
7. If no local candidate passes, use the existing Jellyfin Direct Play, Direct Stream, or transcode resolver and attach its matching external Jellyfin subtitles through the same proxy.

Titles and filenames are never used to substitute a different item. Missing, changed, path-escaped, or probe-invalid copies are marked unusable but never deleted automatically.

## Security boundary

- Absolute paths remain in Electron main and the SQLite worker.
- The local path is never returned through IPC, preload, renderer state, logs, or a tokenized URL.
- Jellyfin subtitle paths, delivery URLs, required headers, and tokens remain main-only. Native mpv receives only a random loopback capability for each validated subtitle stream.
- The renderer cannot choose a local file, media source, executable, or mpv argument.
- The same controlled mpv window, seeking, tracks, fullscreen, completion, and Jellyfin Next Up behavior apply to local and server playback.

## Resume and reporting

When Jellyfin is reachable, its current authoritative resume metadata is merged with the durable conflict rules. If a verified local file is available while Jellyfin is unreachable, the newest authoritative local playback head is used, falling back to cached server metadata and then the beginning.

The player and Session Panel expose `Offline`, `Reconnecting`, `Connected`, and `Offline Local` without inventing latency or buffer values. A successful reconnect refreshes current metadata, watched state, and Next Up in the background without changing the active playback ID or reopening the local file. A partial Next Up failure preserves the last verified cache instead of erasing it. Cached image tags are retained, but artwork bytes are not cached in this milestone, so the offline catalog deliberately uses placeholders and makes no artwork request.

Authoritative mpv events report local and server direct-play delivery as `DirectPlay`, direct-stream delivery as `DirectStream`, and transcoding as `Transcode`. Every authoritative event is also written to the durable main-side journal before the live report is attempted. See [OFFLINE_SYNCHRONIZATION.md](OFFLINE_SYNCHRONIZATION.md) for retry and conflict behavior.
