# Architecture Direction

The app should be Jellyfin-first, not file-first.

## Core model

Every playable thing starts as a Jellyfin item:

- Movie
- Episode
- Trailer or extra
- Future: playlists, collections, live TV, music

Playback goes through one resolver:

```text
Jellyfin item selected
-> look for ready local download by Jellyfin item ID
-> if found, play local file
-> otherwise stream from Jellyfin
-> report watch progress back to Jellyfin
```

Connection starts with one discovery boundary:

```text
Client starts
-> native host broadcasts Jellyfin discovery on UDP 7359
-> bounded LAN fallback checks the standard Jellyfin endpoint on port 8096
-> matching server IDs are deduplicated and the physical LAN route is preferred
-> user selects a discovered server
-> manual URL remains available for remote or discovery-disabled servers
-> authenticate and keep that server as the library source of truth
```

## Current layers

- `JellyfinApi`: main-owned authentication, libraries, metadata, images, streaming, and playback reporting.
- `ServerDiscovery`: native LAN discovery plus manual server entry.
- `SecureSessionStore`: OS-protected token persistence with no plaintext fallback.
- `SqlitePersistenceService`: asynchronous main-side facade over the dedicated SQLite worker.
- `PersistenceWorker`: migrations and all synchronous SQLite work off Electron's event loop.
- `DownloadManager`: main-owned queue, authenticated ranged transfers, lifecycle authorization, and sanitized state events.
- `MediaProbeService`: controlled hidden mpv process that validates finalized media without blocking Electron's event loop.
- `LocalPlaybackResolver`: exact Jellyfin-identity lookup plus authorized-root, containment, existence, size, and probe validation before mpv receives a local path.
- `PlaybackSessionService`: main-only Jellyfin source authorization.
- `PlaybackProxy`: private loopback capability consumed only by mpv.
- `MpvPlayerService`: native player control and authoritative playback events.
- `ClientViews`: sandboxed Home, Search, Library, Details, Season, and Episode UI.

Planned layers build on the SQLite and download boundaries without changing renderer trust:

- `OfflineSynchronization`: revision coalescing and conflict-safe reporting.

## Desktop process model

Electron main owns every privileged capability. The renderer is sandboxed, context-isolated, has Node integration disabled, and communicates only through the typed preload bridge.

Potentially blocking work is isolated:

- SQLite uses a dedicated worker thread.
- mpv is a controlled child process with narrow JSON IPC.
- Large transfers use asynchronous network and filesystem APIs; media probing uses a controlled child process. Neither performs synchronous transfer or probe work on Electron's event loop.

See [DATABASE.md](DATABASE.md) for the versioned persistence model.

## Mobile path

Keep API and resolver logic portable so a later mobile shell can share the model:

- React Native or Expo.
- Native mobile video player.
- Mobile download storage.
- Same local-first resolver concept.

## Watch party path

Watch party should be a later sync layer:

- A room chooses one Jellyfin item.
- Each client resolves local or server playback independently.
- A session coordinator syncs play, pause, seek, and time drift.
- Sync should tolerate buffering differences between local and server sources.
