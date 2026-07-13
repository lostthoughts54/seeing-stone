# LocalFirst Jellyfin

Current application version: `0.4.0`.

This repository contains the Windows Electron client built from the accepted `0.3.0` interface baseline.

## What this milestone does

- Signs into a Jellyfin server with username/password.
- Finds Jellyfin servers on the local network using Jellyfin's UDP discovery protocol.
- Remembers Jellyfin sessions only through OS-protected storage; unavailable protection means signing in again.
- Loads the signed-in user's libraries.
- Builds a Plex-style home from Continue Watching, Next Up, and recently added library rows.
- Opens dedicated movie, show, and episode detail views.
- Loads show seasons and episode rows.
- Displays Jellyfin poster/backdrop images when available.
- Preserves primary artwork aspect ratios instead of cropping posters to fill cards.
- Streams playable Jellyfin items through a main-controlled native mpv window.
- Returns to the prior route and scroll position after playback.
- Sends authoritative playback reports from main-side mpv events.
- Closes movies at natural completion and uses Jellyfin Next Up for episode autoplay after a cancellable countdown.
- Initializes a versioned SQLite database in a worker thread for later downloads, verified local versions, and offline progress.
- Downloads individual movies and episodes into the user's Videos folder through a main-owned transfer queue.
- Shows transfer progress with pause, resume, retry, cancel, explicit delete, and Keep Downloaded controls.
- Verifies path containment, expected size when available, finalized-file state, existence, and mpv media probing before marking a copy downloaded.
- Pauses for manual cleanup when storage is insufficient and never auto-deletes media.
- Resolves every normal Play action through a main-only local-first boundary: an exact verified download is used first, otherwise Jellyfin direct streaming or transcoding is used.
- Revalidates the authorized root, path containment, existence, size, and media probe before every local playback.
- Keeps source resolution behind the Play action so the future local-first choice does not clutter browsing.

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
```

The download lifecycle is documented in [DOWNLOADS.md](DOWNLOADS.md), and unified source selection is documented in [LOCAL_PLAYBACK.md](LOCAL_PLAYBACK.md). The SQLite schema and invariants are documented in [DATABASE.md](DATABASE.md). The broader process and security model is in [ARCHITECTURE.md](ARCHITECTURE.md).

## Milestone boundary

Completed foundations are committed one milestone at a time. Local playback still reports directly to Jellyfin when reachable; durable offline progress queuing and conflict-safe synchronization belong to the next milestone.
