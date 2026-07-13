# SyncPlay W3: functional watch parties

W3 integrates Jellyfin SyncPlay into the application without changing the native mpv backend or the local-first resolver.

## Implemented

- Electron main owns the authenticated WebSocket, SyncPlay REST requests, group membership, validated protocol messages, and lifecycle state.
- The tested compatibility target fails closed unless Jellyfin reports `10.11.11`.
- The renderer receives only sanitized group summaries and narrow list, create, join, and leave actions.
- The Active Watch Parties view lists same-server groups, creates and joins groups, shows participants, and explains shared controls and per-computer local-first resolution.
- Playback selection sends the exact Jellyfin item ID. Every participant then calls its own main-side `PlayerController.loadItem`, preserving independent local-file or Jellyfin-stream selection.
- Play, pause, seek, and stop use Jellyfin SyncPlay shared-control endpoints while joined. Native mpv controls are forwarded only when their origin is `local-user`.
- Remote commands carry `remote-sync` origin metadata and cannot be rebroadcast as local commands.
- Strict envelope, group, queue, command, GUID, and IPC validation rejects malformed, duplicated, wrong-group, wrong-item, prior-membership, and stale messages.
- A membership revision cancels delayed commands and queue work after leave, logout, or a group change.
- Drift under 0.75 seconds is tolerated. Drift from 0.75 to 3 seconds uses bounded `0.98x` or `1.02x` correction with a 0.35-second reset threshold. Drift of at least 3 seconds seeks once to the projected group position.
- Leaving restores normal playback rate and independent solo controls.

## Security boundary

- The access token and authenticated WebSocket header remain inside `JellyfinApi` and `SyncPlayService` in Electron main.
- WebSocket authentication uses `X-Emby-Authorization`; the token is never placed in the URL.
- No server URL, local path, media URL, authenticated URL, header, raw protocol message, socket object, or unrestricted networking action is present in the renderer contract.
- The existing sandbox, context isolation, disabled Node integration, `connect-src 'none'`, sender validation, and main-owned playback reporting remain unchanged.
- User-facing errors contain allowlisted codes and messages only; logs never include raw server payloads.

## Verification performed on 2026-07-13

- TypeScript main, preload, and renderer typechecks passed.
- Unit suite: 22 files and 96 tests passed.
- Main-process core/security/persistence suite: 18 tests passed.
- Electron runtime: 18 tests passed, including the frozen preload bridge, OS sandbox, real IPC sender checks, and visible watch-party list/create/join/leave flow.
- Live `SyncPlayService` acceptance against Jellyfin `10.11.11`: 7 tests passed using two authenticated service instances and a temporary second user. It exercised authenticated sockets, create/discover/join, exact item identity, shared pause, shared seek, leave, and empty-group removal.
- The live service test used separate player doubles reporting `local` and `server` sources. This verifies that SyncPlay does not prescribe a delivery URL or source. It does not claim that two physical computers simultaneously played one real downloaded file and one real stream.
- W1 separately proved anonymous denial, different-server isolation, two authenticated protocol clients, and shared controls. Existing authenticated playback acceptance separately proved real verified-local selection and real server fallback through the production resolver.

Run the W3 live service gate with the visible client closed:

```powershell
pnpm test:syncplay-service
```

The harness restores the OS-protected production session, creates a temporary Jellyfin user with explicit SyncPlay access, and removes that user during cleanup. It never prints credentials or tokens.

## Deferred to W4

- Bounded reconnect and membership restoration after a temporary socket loss.
- Timing offset calibration against Jellyfin and live mpv drift acceptance under induced latency.
- Buffering recovery and readiness convergence with real players.
- Group deletion and session-expiration edge cases beyond current deterministic cleanup.
- Coordinated Jellyfin Next Up and cross-season episode transitions.
- Complete authenticated, native mpv, download, offline, packaging, and installer regression reruns.
- Packaged two-computer acceptance with Adam and Kayla, including one verified local download and one real stream or transcode.

No W4 behavior is claimed as verified by W3.
