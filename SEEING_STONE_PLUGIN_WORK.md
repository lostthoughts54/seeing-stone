# Seeing Stone Player Features implementation

User-authorized scope: expand the existing YouTube Rooms Jellyfin plugin into a general Seeing Stone plugin, implement the ten proposed room features, and review/fix the YouTube plugin and player integration.

Keep the existing plugin ID, assembly and v3 YouTube endpoints upgrade-compatible. Add a versioned `/SeeingStone/PlayerFeatures` API for plugin-owned, authenticated rooms; do not rely on private SyncPlay membership internals. Existing Jellyfin SyncPlay remains available independently. No production server install/restart has been requested.

## Delivery checklist

- [x] General plugin branding, capability discovery, upgrade/build instructions.
- [x] Persistent rooms with authenticated membership and shared media queue.
- [x] Participant readiness/buffering/connection status, shared startup countdown.
- [x] Preflight media access/version/subtitle/delivery checks.
- [x] Automatic buffering wait, recovery, reconnect and late-join behavior.
- [x] Shared queue voting and host/everyone controls.
- [x] Explicit local download preparation for the room queue, including existing subtitle caching.
- [x] Subtitle preparation and per-user, media-version-specific subtitle timing corrections.
- [x] Synchronized segment skips and next-item countdown.
- [x] Chat, reactions and timestamped comments.
- [x] Bounded session event timeline.
- [x] Player UI and authenticated IPC/service integration for the above.
- [x] YouTube review fixes: route allowlist, stale responses/session changes, background presence, clock estimation, duplicate queue advancement and server limits.
- [x] Behavioral C# and TypeScript regression tests, type checks and build artifacts.

## Environment and existing findings

- Workspace has extensive preexisting uncommitted changes; preserve them.
- No AGENTS.md found. Do not delegate to agents without explicit authorization.
- A usable .NET 9.0.317 SDK exists at `C:/Users/lostt/.codex/worktrees/5fb7/jellyfin player/.dotnet9-portable/dotnet.exe`; system `dotnet` is SDK 6.
- Jellyfin 10.11.11 NuGet packages are cached. Its source is in `.runtime/jellyfin-10.11.11`.
- Use `functions` apply_patch for source writes; subprocess writes to source files can receive EPERM.
- Existing `youtubeRoomRequest` allowlist excludes queue/add, queue/action, advance and handoff even though the client calls these endpoints.
- Current YouTube polling stops when the room view is hidden, has no session/generation guards and can apply stale responses. Server rooms have no global or member bounds despite client limits, and advance only compares video IDs (unsafe for repeated videos).
- Existing full-unit baseline has one unrelated packaging assertion failure expecting `*.node` rather than the explicitly named native bridge.


## Completed validation (2026-09-17)

- Full TypeScript unit suite: 563 tests passed across 71 files.
- C# plugin behavior harness: 29 checks passed, including persistence, exact session membership, host policy, startup, seek acknowledgements, buffering recovery, reconnect, and completion countdowns.
- Main, preload, renderer and Companion type checks passed.
- Player production build and plugin publish passed; plugin assembly version is 2.0.0 with the original assembly name and plugin GUID.
- Isolated Electron UI fixture passed with network blocked: preserved input/focus, escaped chat text, playback intents, and visible room controls without horizontal overflow in the player panel. Screenshots are under artifacts/player-features-ui.
- The Electron fixture needed execution outside the sandbox because its GPU/renderer subprocess could not start within it. No production server was contacted by the fixture.
- Corrected the existing packaging test's stale expectations to assert the explicit bridge filename and current hash-checked corresponding-source cache policy.
- Production installation/restart and real two-computer playback remain unperformed; the plugin README includes the upgrade procedure and this limitation.
