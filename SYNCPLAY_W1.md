# SyncPlay W1 protocol and feasibility report

Status: **W1 accepted candidate — implementation may proceed only after explicit approval.**

This report covers protocol inspection and a reproducible spike only. It does not add watch-party UI, renderer access to Jellyfin credentials, or SyncPlay behavior to `PlayerController`.

## Verdict

Jellyfin's built-in SyncPlay is a viable coordination layer for this client on the tested Jellyfin 10.11.11 server.

The live spike proved that two distinct authenticated sessions on the same Jellyfin server can create, discover, join, select an exact Jellyfin item, become ready, receive shared play/pause/seek commands, leave, and remove an empty group. A signed-out request could not list groups. An authenticated user on a separate, isolated Jellyfin 10.11.11 server could not see the first server's group.

The protocol coordinates an item identifier, playlist-item identifier, position, readiness, timing, and transport commands. It does **not** carry a file path, playback-info response, stream URL, or media bytes.

## Non-negotiable local-first boundary

SyncPlay must never become the media resolver.

For every participant, the received Jellyfin `ItemId` must enter the client's existing item-based playback path. `LocalPlaybackResolver` remains authoritative on that machine:

- if Kayla has a verified local download of the exact item, her client plays her local copy;
- if another participant has a verified local copy, that client independently uses its own copy;
- a participant without a valid local copy may stream from their authenticated Jellyfin server as today;
- no participant sends a local path or resolved stream URL to another participant;
- renderer-facing state remains limited to sanitized item, group, participant, and playback-state data.

This is compatible with SyncPlay because the tested `PlayQueue` update contained `ItemId` and `PlaylistItemId` only. The spike rejects queue messages containing media-location or playback-info fields.

## Pinned compatibility target

| Component | Pin | Evidence |
| --- | --- | --- |
| Live Jellyfin server | `10.11.11` | `/System/Info/Public`; server ID matched the protected session |
| Jellyfin server source | tag `v10.11.11`, commit `1fbd8739292cce610231be93daf43368733edf63` | inspected controller, authorization handler, manager, group state machine, session/WebSocket code |
| Jellyfin Web source | tag `v10.11.11`, commit `35c0793ece3adbd247eab290ae1effab851f3d37` | inspected SyncPlay manager, controller, playback, queue, settings, time-sync, and group-list hook |
| Server source archive | SHA-256 `71E1126D6ADA344230C3BCFBCCCD71E46921CC950C1B13877858E3A5FE011BAF` | downloaded release archive |
| Web source archive | SHA-256 `B0208CB217D4584A8FD238B414EA77BA50E299C40EF16C3BC2C362545A7D0029` | downloaded release archive |
| Live OpenAPI | Jellyfin `10.11.11`, SHA-256 `0DD63207766645840891A8AD1C960DAC48535CBE04A8592C6E3B99E2263FC9EC` | downloaded from the tested server |
| WebSocket client used by spike | `ws@8.18.3` | exact development dependency |

Compatibility outside Jellyfin 10.11.11 is not claimed. Before supporting another server version, rerun the spike and review its OpenAPI and SyncPlay state-machine changes.

## Authentication and session model

- SyncPlay REST actions are protected by Jellyfin's `SyncPlayHasAccess` policy.
- The tested WebSocket endpoint is `/socket` on the same Jellyfin origin, using `ws:` or `wss:` to match HTTP or HTTPS.
- The custom client authenticated the WebSocket upgrade with `X-Emby-Authorization`. The token was not placed in the URL.
- REST and WebSocket use the same token and device ID so Jellyfin associates them with the same server session.
- Each participant needs a distinct Jellyfin session/device identity. Group membership is keyed by server session ID, not merely user ID.
- Tokens remain in Electron main and the existing protected session store. The renderer must not create the WebSocket or receive a token/authentication header.

Jellyfin user policy values are `CreateAndJoinGroups`, `JoinGroups`, and `None`. Create requires `CreateAndJoinGroups`; list/join accept create-and-join or join-only access. Member actions require the user to be active in a group. The server also prevents a user from joining a queue containing library items they cannot access.

## REST surface used or pinned

| Purpose | Endpoint |
| --- | --- |
| List/get groups | `GET /SyncPlay/List`, `GET /SyncPlay/{id}` |
| Create/join/leave | `POST /SyncPlay/New`, `/Join`, `/Leave` |
| Set exact queue/current item | `POST /SyncPlay/SetNewQueue`, `/SetPlaylistItem` |
| Transport | `POST /SyncPlay/Unpause`, `/Pause`, `/Seek`, `/Stop` |
| Readiness and buffering | `POST /SyncPlay/Ready`, `/Buffering`, `/SetIgnoreWait` |
| Timing | `POST /SyncPlay/Ping` |
| Queue navigation | `POST /SyncPlay/NextItem`, `/PreviousItem`, `/Queue`, `/RemoveFromPlaylist`, `/MovePlaylistItem` |
| Queue modes | `POST /SyncPlay/SetRepeatMode`, `/SetShuffleMode` |

The tested new-queue body was `PlayingQueue`, `PlayingItemPosition`, and `StartPositionTicks`. Readiness used `When`, `PositionTicks`, `IsPlaying`, and `PlaylistItemId`.

## WebSocket messages and validation

The relevant envelopes are:

- `MessageType: SyncPlayGroupUpdate`
- `MessageType: SyncPlayCommand`
- `MessageId`: a compact 32-hex-character GUID on the tested server
- `Data`: a typed object

Group-update types pinned from source/OpenAPI are `UserJoined`, `UserLeft`, `GroupJoined`, `GroupLeft`, `StateUpdate`, `PlayQueue`, `NotInGroup`, `GroupDoesNotExist`, and `LibraryAccessDenied`.

Commands are `Unpause`, `Pause`, `Stop`, and `Seek`. A valid command includes `GroupId`, `PlaylistItemId`, `When`, `PositionTicks` when applicable, `Command`, and `EmittedAt`. W2 must reject malformed envelopes, unknown command values, invalid IDs/times, commands for another group or playlist item, stale commands emitted before the current join, and duplicate `MessageId` values.

Jellyfin Web queues commands until its time sync is ready, rejects commands for the wrong playlist item, ignores commands older than the SyncPlay enable time, and schedules commands using server-adjusted time. It combines speed correction with bounded seeks. The native client should preserve those behavioral guards while applying commands only through main-owned mpv control.

## Lifecycle observed

1. Create returns through `GroupJoined`; join returns `GroupJoined` to the joining session and `UserJoined` to existing members.
2. Setting a new queue broadcasts `PlayQueue`, marks all members buffering, and waits for readiness.
3. When every participant reports `Ready`, the server issues a scheduled `Unpause` to the group.
4. Either participant can issue pause, unpause, and seek. The live spike observed matching validated commands on both WebSocket sessions.
5. Seek resets readiness/buffering expectations; production code must report the resulting player state rather than assuming convergence from the REST response.
6. Leave produces `GroupLeft` for the leaver and `UserLeft` for remaining members. The server removes a group when it becomes empty.

Group state is server-process memory. A server restart therefore ends groups. Reconnect must reopen an authenticated WebSocket with the same device/session identity, refresh group state, and re-join the remembered group ID only if it still exists and the user still has access. No command should be applied until that reconciliation and time sync complete.

## Discovery and refresh conclusion

`GET /SyncPlay/List` is the authoritative active-group list for the authenticated server. `GroupInfoDto` exposes group ID, name, state, participant usernames, and `LastUpdatedAt`; it does not expose the current media item.

The WebSocket sends updates to current group members. It does not broadcast global create/delete events to every authenticated user. Jellyfin Web's group hook performs a REST query and does not establish global push invalidation. Therefore the future Active view needs a bounded REST refresh while visible, plus immediate refresh on sign-in, server change, window focus, create, join, leave, and WebSocket reconnect. A five-second visible-view interval is the initial W2 recommendation; stop it when signed out, hidden, offline, or the server changes.

Do not join a room merely to discover its media. The active list should omit media until the server offers it safely or the user joins and receives the authoritative `PlayQueue` update.

## Server and reverse-proxy requirements

- Every participant must authenticate to the same Jellyfin server origin and have SyncPlay permission.
- Every queued item must be visible to every participant's Jellyfin user.
- Reverse proxies must forward WebSocket upgrades on Jellyfin's `/socket` route, preserve the normal authenticated Jellyfin origin, and use TLS (`https`/`wss`) off-machine.
- The client must derive the WebSocket URL from the normalized authenticated server URL; no second coordination host is configured.
- A group is isolated to one Jellyfin process. The disposable second-server test verified that a different server ID on another port listed no group from the primary server.

## Reproducible W1 spike

Run with the visible client closed and under the same Windows account that owns the protected session:

```powershell
pnpm run test:syncplay-spike
```

The harness:

- restores the production session through Windows-protected storage without printing the token;
- creates a random temporary second Jellyfin user and distinct device session, then deletes it in `finally` cleanup;
- authenticates two REST clients and two header-authenticated WebSockets;
- validates group discovery, exact queue item, readiness, shared controls, and lifecycle;
- launches an isolated Jellyfin 10.11.11 instance on `127.0.0.1:18096`, completes its startup with generated credentials, proves cross-server isolation, stops it, and removes its runtime data;
- emits TAP output containing no password, token, authorization header, media path, or stream URL.

The accepted live run on 2026-07-13 passed all 15 checks. The temporary test user and disposable server data were removed.

## W1 limitations carried forward

- No product UI or production SyncPlay service exists yet.
- Full mpv drift correction, buffering transitions, reconnect under network failure, duplicate/reordered command rejection, server restart behavior, offline handling, and packaged-build behavior belong to W2–W4.
- `GroupInfoDto` cannot safely show the current title before join.
- Participant display is distinct usernames; multiple sessions for one username are not separately named in the group summary.
- All members can control playback. This is an accepted product behavior for this goal.
- SyncPlay coordinates shared intent but cannot guarantee identical decoder timing. Main-owned player telemetry, time sync, scheduled execution, and bounded correction remain necessary.

## W2 implementation gate

If W1 is approved, W2 should introduce a main-process SyncPlay service and tests only after preserving these boundaries:

1. credentials, WebSocket, protocol validation, time sync, retry, and group state remain in main;
2. renderer receives only typed sanitized summaries and sends allowlisted user intents;
3. `PlayerController` remains the sole owner of mpv actions and authoritative telemetry;
4. incoming `ItemId` goes through the existing local-first resolver independently on every client;
5. no SyncPlay path weakens downloads, persistence, offline synchronization, navigation, or packaging.
