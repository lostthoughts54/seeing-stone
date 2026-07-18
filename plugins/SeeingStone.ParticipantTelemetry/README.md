# Seeing Stone Participant Telemetry

License: GPL-2.0-or-later

Status: protocol complete; Jellyfin plugin endpoint intentionally disabled and not buildable in this milestone.

This directory is the separate, optional component boundary for enhanced Seeing Stone watch-party status. Standard Jellyfin SyncPlay does not depend on it. The client-side transport interface, strict protocol validators, heartbeat/freshness behavior, and buffering policy are implemented and tested in the application. No relay is used.

## Compatibility checkpoint

The actual Jellyfin version previously detected and pinned by the approved SyncPlay feasibility work is `10.11.11`. Its source snapshot is tag `v10.11.11`, commit `1fbd8739292cce610231be93daf43368733edf63`.

The public `ISyncPlayManager` API cannot prove that one exact authenticated Jellyfin session belongs to one claimed SyncPlay group:

- `IsUserActive(Guid userId)` is user-wide and can be true because a different session for the same user is active.
- `GetGroup(SessionInfo session, Guid groupId)` returns group information subject to access filtering, but does not assert that the supplied session is a member.
- the authoritative `_sessionToGroupMap` exists only on the internal `SyncPlayManager` implementation and is private.

A plugin WebSocket or HTTP polling endpoint built on only those public APIs could therefore accept status for the wrong session or group. Reflection into a private implementation field would be version-fragile and does not meet the fail-closed compatibility requirement.

Consequently:

- no plugin is installed, upgraded, or loaded on any Jellyfin server;
- no endpoint is exposed;
- both WebSocket and HTTP polling transport flags remain disabled;
- no separate relay is introduced;
- standard Jellyfin SyncPlay continues normally;
- the UI explains that enhanced status is unavailable and never invents participant diagnostics.

## Future enablement requirements

Before this component may expose an endpoint, all of the following are required:

1. A supported Jellyfin version must provide a stable public API that maps the exact authenticated `SessionInfo.Id` to the claimed SyncPlay group, or an equivalent server-owned authorization primitive.
2. A disposable isolated server running that exact version must validate authentication, wrong-session and wrong-group rejection, connection closure, and membership changes.
3. The component must target the server's supported .NET SDK and remain GPL-compatible. The development machine currently exposes only the .NET 6.0.100 SDK, so no Jellyfin 10.11 plugin build was attempted.
4. Protocol v1 must pass the shared client/server fixtures. The wire contract accepts only status fields plus server-derived account/session identity; it rejects unknown fields, URL- or credential-shaped identity strings, control characters, media, chat, and free-form message fields.
5. The client feature flag may be enabled only after the isolated acceptance report is committed.

`protocol-v1.schema.json` is the transport-neutral, status-only wire contract reserved for that future implementation.
