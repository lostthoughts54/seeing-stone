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

## Suggested layers

- `JellyfinApi`: auth, libraries, metadata, images, streaming URLs, playback reporting.
- `ServerDiscovery`: native LAN discovery plus manual and remembered-server fallbacks.
- `LocalIndex`: maps Jellyfin item IDs to downloaded files and health/state.
- `DownloadQueue`: creates and tracks download jobs.
- `PlaybackResolver`: picks local or server source.
- `PlayerShell`: browser/native video UI.
- `ClientViews`: home, search, library, detail, season, episode list.

## Desktop path

`server.js` is the first native companion: it owns UDP discovery now and can later own local downloads and filesystem access. Once server playback is proven, package this foundation into a desktop shell:

- Tauri or Electron shell.
- SQLite local index.
- Native filesystem access.
- mpv playback for better MKV/HEVC/subtitle support.
- Secure token storage.

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
