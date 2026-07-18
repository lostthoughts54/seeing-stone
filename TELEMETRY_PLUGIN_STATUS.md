# Gate 5 optional telemetry safety report

Status: client protocol and fallback accepted; server plugin disabled.

This report records a source-only compatibility review. No Jellyfin server was contacted, modified, restarted, upgraded, load-tested, or given a plugin during this work.

## Detected compatibility target

The approved SyncPlay feasibility evidence previously detected Jellyfin `10.11.11` from the server's public system information and pinned its protected-session server identity. That report also pinned server tag `v10.11.11`, commit `1fbd8739292cce610231be93daf43368733edf63`, its source archive hash, and matching OpenAPI hash. Compatibility outside `10.11.11` is not claimed.

The review used the repository's immutable 10.11.11 source snapshot. It did not make a fresh request to the normal server.

## Hard authorization checkpoint

The plugin requirement is stronger than ordinary SyncPlay access: the telemetry connection's exact authenticated Jellyfin session must be provably in the claimed group.

In Jellyfin 10.11.11:

- `MediaBrowser.Controller.SyncPlay.ISyncPlayManager` exposes `GetGroup(SessionInfo, Guid)` and `IsUserActive(Guid)` but no exact session-membership query.
- `SyncPlayAccessHandler` uses `IsUserActive(userId)` for its `IsInGroup` policy. This is user-wide and does not distinguish multiple sessions for the same user.
- `Emby.Server.Implementations.SyncPlay.SyncPlayManager` owns the authoritative session-to-group relationship in a private `_sessionToGroupMap`.

Neither a custom WebSocket nor authenticated HTTP polling endpoint can meet the required fail-closed rule using the stable public plugin API. Accessing the private map by reflection would be unproven, version-fragile, and unsafe.

## Result

- `ParticipantTelemetryTransport` is implemented as a transport-neutral status-only boundary.
- Protocol v1 has strict client and server envelopes. Client messages contain no asserted identity; any future server must derive session and participant identity.
- Unknown fields, wrong groups, malformed identity, replayed sequence numbers, clock-skewed timestamps, URL- or credential-shaped identity strings, control characters, and free-form additions are rejected.
- Immediate state transitions and a two-second active-playback heartbeat are implemented.
- Status becomes stale after six seconds and disconnected after ten seconds or transport closure.
- The default buffering policy uses verified current telemetry only, waits through Jellyfin SyncPlay after a 1.5-second grace, supports Continue suppression, and clears on recovery or disconnect.
- Wait, Continue, and group Resync remain Jellyfin SyncPlay commands owned by `SyncPlayService`; telemetry has no playback-command surface.
- Standard Jellyfin SyncPlay is unaffected when the optional transport is disabled.
- The production transport is hard-disabled with a visible explanation. No plugin endpoint, DLL, binary, or release is produced.

## Deferred enablement

Enhanced telemetry requires a later Jellyfin version or supported API that proves exact session membership, a matching .NET SDK, and disposable-server validation. A future isolated matrix must cover authenticated success, unauthenticated rejection, wrong user/session/group rejection, membership changes, stale/disconnect behavior, plugin absence, and version incompatibility before the client flag can change.
