# SyncPlay W4: resilience and Windows acceptance

W4 completes the implementation work required before Adam and Kayla perform the physical two-computer acceptance run. The compatibility target remains Jellyfin `10.11.11`; other versions fail closed.

## Resilience implemented

- Jellyfin server time is calibrated with multiple NTP-style samples. The lowest-delay sample supplies the server offset, command schedule, readiness timestamps, and reported half-round-trip ping.
- An interrupted authenticated WebSocket reconnects after bounded exponential delays of 1, 2, 4, 8, 15, and 15 seconds. Shared commands are disabled while membership is being reconciled.
- A remembered group is rejoined only if the authenticated group list still contains it. A deleted or vanished group clears local membership and presents an actionable error.
- Buffering sends SyncPlay `Buffering`; recovery sends `Ready`. Temporary playback-rate correction is reset on buffering, player error, leave, or deactivation.
- Logout, session expiration, device-session replacement, and server changes deactivate SyncPlay, stop periodic work, clear membership, and restore solo playback behavior.
- Active group discovery refreshes only while the Active Watch Parties screen is visible. Timing and drift work continue only as needed while joined.
- The joined-party card visibly reports `This computer: Local download` or `This computer: Jellyfin stream` from the existing sanitized playback state, so the physical local-versus-streamed condition can be verified without exposing a path or URL.
- `Resync This Computer` reloads the validated shared item through that computer's local-first resolver when needed, restores normal speed, and aligns only that player to the last authoritative group item, position, and play/pause state. It never sends a group-wide seek.
- During native playback the main app is minimized, not hidden, so the same button remains reachable from the Windows taskbar. `Ctrl+R` inside mpv performs the identical local-only correction without leaving the player and shows its result on the video.
- Incoming group state, queue, command, and envelope messages use exact strict schemas pinned to Jellyfin 10.11.11. Extra media URLs, paths, fields, malformed IDs, stale commands, duplicate commands, wrong-group messages, and wrong-item messages are rejected.

## Episode transitions

- Exactly one deterministic transition authority is selected from the connected participants by case-insensitive name order.
- Only that participant runs the existing Jellyfin Next Up transition while joined. Its exact new Jellyfin item ID is published through `SetNewQueue` once.
- Other participants wait for that exact item ID and independently call the existing main-side player resolver.
- This preserves the central local-first rule: one computer can select a verified downloaded file while another selects Direct Play, streaming, or transcoding. SyncPlay never sends a filesystem path or delivery URL between clients.
- Leaving or losing the group restores ordinary solo Next Up behavior on every computer.

## Verification performed through 2026-07-14

- TypeScript main, preload, and renderer typechecks passed.
- Unit suite: 22 files and 111 tests passed, including the native `Ctrl+R` event, local-only routing, bounded on-video feedback, and taskbar window boundary.
- Main-process security, persistence, download, offline-sync, reporting, and networking suite: 18 tests passed.
- Electron runtime: 19 tests passed, including the real sandboxed preload bridge, visible per-computer delivery status, watch-party UI, strict IPC, sender validation, and renderer network denial.
- Live SyncPlay acceptance against Jellyfin 10.11.11: 12 tests passed with two actual `SyncPlayService` clients. It exercised a real account denied by Jellyfin's SyncPlay policy, create/discover/join after access was granted, forced socket loss and membership restoration, independent local/server source selection, one exact automatic transition, buffering wait/readiness recovery, peer pause, creator seek, the in-player local-only resync request, leave, and empty-group removal.
- Authenticated application acceptance: 18 tests passed. It exercised real protected-session restoration, UI navigation, native mpv, a verified downloaded item using the local file, an undownloaded item falling back to Jellyfin streaming, and authoritative main-owned reporting.
- A focused authenticated rerun against Jellyfin 10.11.11 found a real server-managed external subtitle and exposed it as a selectable native mpv track. The expanded 19-scenario run passed 17 scenarios; its two download-dependent legacy checks could not run because the current protected profile no longer contains a verified completed app download.
- Native mpv runtime and completion acceptance passed with mpv `v0.41.0-dev-ge5486b96d`, including keeping the main app reachable as a minimized taskbar window, restoring it after playback, a local video with an authenticated external Jellyfin subtitle, movie completion, the existing 10-second Next Up flow, and cancellation.
- Persistence runtime and media-probe acceptance passed.
- The complete Windows NSIS installer was rebuilt and accepted. The test installed it, launched the packaged UI, verified hardened Electron fuses and packaged resources (including `ws` and mpv), checked stable device identity across restart, ran packaged mpv, uninstalled it, and verified cleanup.

Installer artifact:

```text
D:\docs\jellyfin player\.runtime\release\LocalFirst-Jellyfin-Setup-0.4.0-x64.exe
SHA-256: 4cc12534a0393705434363458d2979a99d7efff2ca7281df16dfc4181bbe0827
```

The installer is not Authenticode-signed. Windows may therefore show an unknown-publisher warning.

## Physical Adam/Kayla acceptance still required

Automated tests cannot claim the final physical two-computer conditions. The following is the final acceptance gate:

Use `SYNCPLAY_PHYSICAL_ACCEPTANCE.md` as the fillable run sheet for the exact packaged build.

1. Install the rebuilt package on both Windows computers.
2. Sign in as Adam and Kayla to the same Jellyfin 10.11.11 server. Existing credentials are not embedded in the installer; each computer keeps its own session in Windows protected storage after sign-in.
3. Download the chosen test episode through Kayla's client and confirm it appears in Downloads. Leave Adam's copy undownloaded.
4. Open Active Watch Parties on both clients. Create a group on either computer and confirm it appears automatically on the other.
5. Join from the second computer, choose the exact test episode, and confirm both players start. The joined-party card should say `This computer: Local download` on Kayla's computer and `This computer: Jellyfin stream` on Adam's.
6. From each computer in turn, test pause, play, and a substantial seek. Confirm both converge without repeated bouncing. If a player needs correction, press `Ctrl+R` in that player and confirm only that computer resyncs. Restore the app from the taskbar to test the visible button too.
7. Temporarily interrupt one computer's network, restore it, and confirm membership and playback recover or show the documented actionable failure.
8. Let an episode finish across a season boundary and confirm both clients transition to the same exact Next Up episode.
9. Leave the party and confirm each computer returns to independent playback and solo Next Up behavior.

Keep the client closed before rerunning automated live gates:

```powershell
pnpm test:syncplay-service
pnpm test:authenticated
pnpm test:package
```

No claim is made yet that the physical downloaded-versus-streamed pair, induced real-network drift, or cross-season two-computer Next Up acceptance has passed. Those are the only remaining goal acceptance items.
