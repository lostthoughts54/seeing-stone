# LocalFirst Jellyfin

Current application version: `0.4.3`.

This repository contains the Windows Electron client built from the accepted `0.3.0` interface baseline.

## What this milestone does

- Signs into a Jellyfin server with username/password.
- Finds Jellyfin servers on the local network using Jellyfin's UDP discovery protocol.
- Remembers Jellyfin sessions only through OS-protected storage; unavailable protection means signing in again.
- Loads the signed-in user's libraries.
- Filters libraries by watched or local availability and sorts by title, year, or rating.
- Builds a Plex-style home from Continue Watching, Next Up, and recently added library rows.
- Opens dedicated movie, show, and episode detail views.
- Loads show seasons and episode rows.
- Displays Jellyfin poster/backdrop images when available.
- Preserves primary artwork aspect ratios instead of cropping posters to fill cards.
- Streams playable Jellyfin items through a main-controlled native mpv window.
- Returns to the prior route and scroll position after playback.
- Sends authoritative playback reports from main-side mpv events.
- Persists those events as per-server, per-user, per-item revisions and retries them when Jellyfin becomes reachable.
- Coalesces ordinary offline progress without dropping completion or newer explicit Start Over, replay, watched, or unwatched actions.
- Lets users explicitly mark movies or episodes watched or unwatched from details and episode rows; offline actions remain queued durably.
- Closes movies at natural completion and uses Jellyfin Next Up for episode autoplay after a cancellable countdown.
- Initializes a versioned SQLite database in a worker thread for later downloads, verified local versions, and offline progress.
- Downloads individual movies and episodes into the user's Videos folder through a main-owned transfer queue.
- Selects an entire season or any combination of episodes and queues them through the same item-ID-only download boundary.
- Shows transfer progress with pause, resume, retry, cancel, explicit delete, and Keep Downloaded controls.
- Lets the user choose a larger drive for future downloads, open the active folder in Windows, or return to the default Videos folder without orphaning existing copies.
- Verifies path containment, expected size when available, finalized-file state, existence, and mpv media probing before marking a copy downloaded.
- Pauses for manual cleanup when storage is insufficient and never auto-deletes media.
- Resolves every normal Play action through a main-only local-first boundary: an exact verified download is used first, otherwise Jellyfin direct streaming or transcoding is used.
- Exposes quick Play on Home, library, and search cards while retaining the existing details action.
- Shows completed downloads directly on Home when Jellyfin is unreachable, so offline playback does not require entering the Downloads panel.
- Revalidates the authorized root, path containment, existence, size, and media probe before every local playback.
- Keeps source resolution behind the Play action so the future local-first choice does not clutter browsing.
- Lists, creates, joins, and leaves authenticated same-Jellyfin-server watch parties through Jellyfin SyncPlay.
- Keeps watch-party synchronization in Electron main while every participant independently resolves the exact item ID to a verified local file or Jellyfin stream.
- Uses shared play, pause, seek, and item selection with bounded drift correction and feedback-loop prevention.
- Produces a branded x64 Windows installer with the sandboxed application and pinned mpv runtime packaged together.

## Try it

Install dependencies and the bundled mpv runtime once:

```powershell
pnpm install
pnpm setup:mpv
```

Start the development application:

```powershell
pnpm start
```

If `pnpm` is not installed globally, the same commands can be run as `npx pnpm install`, `npx pnpm setup:mpv`, and `npx pnpm start`.

Build the current unsigned Windows installer:

```powershell
pnpm package:windows
```

The installer is written to `.runtime\release\LocalFirst-Jellyfin-Setup-0.4.3-x64.exe`. It is currently an internal acceptance artifact; Windows may show a SmartScreen warning because no signing certificate is configured. See [WINDOWS_PACKAGING.md](WINDOWS_PACKAGING.md) before sharing it.

Example server URLs:

- `http://192.168.1.10:8096`
- `http://localhost:8096`
- `https://your-domain.example`

## Verification

```powershell
pnpm test
pnpm test:mpv-runtime
pnpm test:mpv-visual
pnpm test:mpv-completion
pnpm test:authenticated
pnpm test:syncplay-spike
pnpm test:syncplay-service
pnpm test:package
```

The download lifecycle is documented in [DOWNLOADS.md](DOWNLOADS.md), unified source selection is documented in [LOCAL_PLAYBACK.md](LOCAL_PLAYBACK.md), and durable progress behavior is documented in [OFFLINE_SYNCHRONIZATION.md](OFFLINE_SYNCHRONIZATION.md). The main-owned playback backend contract is documented in [PLAYER_CONTROLLER.md](PLAYER_CONTROLLER.md). The SyncPlay protocol pin and live proof are documented in [SYNCPLAY_W1.md](SYNCPLAY_W1.md), and the functional integration plus its verified boundary are documented in [SYNCPLAY_W3.md](SYNCPLAY_W3.md). The SQLite schema and invariants are documented in [DATABASE.md](DATABASE.md). Windows release construction and its current redistribution limitation are documented in [WINDOWS_PACKAGING.md](WINDOWS_PACKAGING.md). The broader process and security model is in [ARCHITECTURE.md](ARCHITECTURE.md).

## Milestone boundary

The SyncPlay W4 implementation, automated regressions, live two-service Jellyfin acceptance, packaged Windows acceptance, and initial Adam/Kayla field use are complete. The 0.4.3 timing retest and several extended physical scenarios were explicitly deferred as accepted follow-up risk; [SYNCPLAY_PHYSICAL_ACCEPTANCE.md](SYNCPLAY_PHYSICAL_ACCEPTANCE.md) remains the exact later regression sheet.
