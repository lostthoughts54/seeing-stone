# Goal: Server-visible watch parties using Jellyfin SyncPlay

Add dependable server-visible watch-party support to the existing LocalFirst Jellyfin Windows client by integrating Jellyfin's built-in SyncPlay APIs and WebSocket protocol.

## Repository

`D:\docs\jellyfin player`

## Primary users

Adam and Kayla.

## Established architecture

Use the existing native main-controlled mpv player. Do not begin the embedded-player rewrite as part of this goal.

Before changing anything:

1. Inspect the current repository, documentation, tests, Git history, tags, and working tree.
2. Treat the completed Electron security, Jellyfin networking, local-first playback, downloads, SQLite persistence, offline synchronization, native mpv, and Windows packaging work as established architecture.
3. Review the current Jellyfin SyncPlay REST API, authenticated WebSocket messages, server implementation, official clients, user-access policies, and compatibility behavior.
4. Determine how a custom Electron client participates in SyncPlay without loading Jellyfin Web.
5. Pin the tested Jellyfin server version, API/OpenAPI contract, and relevant SyncPlay protocol behavior. Do not rely on undocumented behavior from a floating server release.
6. Do not install or depend on OpenWatchParty, an OpenWatchParty Jellyfin plugin, or a separate OpenWatchParty session server.

## Product goal

Authenticated users connected to the same Jellyfin server should be able to see active SyncPlay groups, create a group, join an existing group, and watch the same Jellyfin item in synchronization.

Groups do not need to be private. A secret invitation or room code is not required. Groups must remain scoped to the currently authenticated Jellyfin server and must not be visible to anonymous users or users authenticated only to unrelated Jellyfin servers.

All joined participants may control playback. The first version does not need a permanent host, host-only controls, control requests, host transfer, or host election.

## Required architecture

- Electron main owns the authenticated Jellyfin WebSocket connection, SyncPlay REST calls, group discovery, group membership, synchronization, reconnection, and session lifecycle.
- Reuse the existing authenticated Jellyfin session, stable server identity, access token, and device/session identity entirely within Electron main.
- The renderer receives only sanitized group summaries, participant state, playback state, and narrowly typed actions.
- The renderer may request actions such as list groups, create group, join group, leave group, select an item, play, pause, or seek.
- Jellyfin tokens, authenticated URLs, local paths, raw WebSocket messages, unrestricted networking, protocol internals, and server response bodies must never reach the renderer or logs.
- Keep the renderer sandboxed with context isolation and Node integration disabled.
- Validate every IPC message and every remote SyncPlay message.
- Introduce a stable internal `PlayerController` abstraction around the existing mpv implementation.
- The SyncPlay coordinator communicates with `PlayerController`, never directly with mpv IPC, executable arguments, filesystem paths, stream URLs, or Windows window handles.
- A later embedded-libmpv backend must be able to implement the same `PlayerController` interface without rewriting SyncPlay synchronization.
- Each client independently resolves playback through the existing main-side local-first resolver.
- One participant may use a downloaded local file while another streams or transcodes the same Jellyfin item.
- Continue using authoritative main-side Jellyfin playback reporting.
- The renderer must never submit authoritative Jellyfin playback reports.

## Group visibility and authorization

- Add an Active Watch Parties view listing SyncPlay groups visible to the authenticated user on the current Jellyfin server.
- Each group summary may show its group name, current media, playback status, and participant count when those fields can be obtained safely and reliably from the pinned SyncPlay contract.
- Users can create a server-visible group or join one directly from the active-group list.
- Group discovery must use the authenticated SyncPlay API of the current Jellyfin server.
- Groups from unrelated Jellyfin servers must never be mixed.
- Anonymous or signed-out clients must not be able to enumerate, create, or join groups.
- Respect Jellyfin's SyncPlay user-access policy for listing, creating, and joining groups. Present a clear error when the current user's policy denies an action.
- Logout, session expiration, device-session replacement, or a Jellyfin server change must immediately disconnect SyncPlay, leave or abandon group membership as safely as possible, and clear all local group state.
- Do not add a cross-server discovery service, plugin-managed token exchange, or separate session server.
- If Jellyfin SyncPlay cannot securely provide authenticated same-server discovery to this custom client, stop and report the exact limitation before implementing a workaround.

## Shared-control behavior

- Every joined participant may authoritatively select an item, play, pause, or seek through the permissions and semantics provided by Jellyfin SyncPlay.
- Clearly indicate that playback controls are shared by the group.
- Do not add a host role, permanent room owner, host-only restrictions, control-request system, host transfer, or host election in the first version.
- Follow the pinned Jellyfin SyncPlay behavior when a participant leaves or disconnects.
- Define and document deterministic client behavior when the group becomes empty, is deleted, becomes unavailable, or this client is removed from it.
- Leaving a group must restore ordinary independent solo playback.

## Required first-version behavior

- List active SyncPlay groups for the authenticated Jellyfin server.
- Create a server-visible SyncPlay group.
- Join and leave a group.
- Display participants when the pinned protocol provides sufficient participant data.
- Synchronize the exact Jellyfin item ID. Never match media by title or filename.
- Allow any joined participant to select the item, play, pause, and seek.
- Synchronize episode transitions and the existing Jellyfin Next Up autoplay behavior.
- Translate Jellyfin SyncPlay commands into a validated internal command model with origin tracking, session revisions, group identity, item identity, and monotonic local timestamps.
- Reject messages belonging to an old authentication session, old server, old group, superseded item, or already-applied command.
- A remote command applied to mpv must not be rebroadcast as a new local user command.
- Tolerate small timing differences and correct meaningful drift without constant seeking or oscillation.
- Handle participants using different delivery methods, including verified local playback, Direct Play, streaming, and transcoding.
- Handle buffering, temporary disconnection, reconnection, group deletion, participant departure, logout, player errors, denied SyncPlay access, and session changes cleanly.
- Use Jellyfin's SyncPlay readiness, buffering, timing, and command semantics where they are compatible with the existing native player.
- Continue using authoritative main-side Jellyfin playback reporting.
- Preserve ordinary solo playback outside a group.
- Preserve the existing UI, CSS, navigation, playback, downloads, offline synchronization, device identity, secure sessions, and Windows installer.

## Compatibility and protocol rules

- Treat the tested Jellyfin server release and its generated OpenAPI contract as a pinned compatibility target.
- Document the minimum and maximum Jellyfin server versions actually verified.
- Feature-detect SyncPlay availability and required server messages where practical.
- Fail closed with an actionable compatibility error when the server lacks required SyncPlay endpoints, user policy, message types, or semantics.
- Do not silently fall back to OpenWatchParty, anonymous rooms, title matching, polling an unrelated service, or renderer-owned networking.
- Do not claim compatibility with a Jellyfin version that was not tested.

## Scope exclusions

- No OpenWatchParty dependency, plugin, protocol, or session server.
- No custom replacement session server.
- No embedded-player rewrite.
- No chat, voice, reactions, friend systems, permanent host roles, or unrelated social features.
- No anonymous or internet-wide group discovery.
- No secret invitation or room-code system.
- No unrelated UI redesign.
- No replacement media server or media-management system.
- Do not modify the Jellyfin server or ship a Jellyfin plugin unless a later, separately approved goal explicitly requires it.
- If native SyncPlay proves unsuitable, stop and report the evidence, security implications, missing behavior, and recommended alternatives for approval before proceeding.

## Independently testable milestones

### W1. Jellyfin SyncPlay protocol and compatibility spike

- Inspect the current Jellyfin SyncPlay REST API, authenticated WebSocket transport, server implementation, official client behavior, access policies, group lifecycle, readiness, buffering, timing, queue, and playback commands.
- Pin the tested Jellyfin server release, relevant source commit/tag, generated OpenAPI contract, and observed WebSocket message shapes.
- Confirm that a custom Electron main process can participate without loading Jellyfin Web and without exposing credentials to the renderer.
- Prove that two authenticated test clients on the same Jellyfin server can list groups, create a group, discover it, join it, exchange validated item and playback state, exercise shared play/pause/seek control, and leave.
- Prove that a signed-out client cannot list groups and that a client connected only to a different Jellyfin server cannot discover the group.
- Determine the exact WebSocket session requirements, including device ID, session ID, authentication, reconnect behavior, and relevant server-message types.
- Determine how group updates become visible automatically and whether a safe bounded REST refresh is also required.
- Document installation assumptions, server settings, SyncPlay user-policy requirements, reverse-proxy/WebSocket requirements, compatibility, and unresolved protocol limitations.
- Do not build product UI during this spike.
- Commit only stable spike tooling or documentation.
- Stop for explicit approval.

### W2. PlayerController abstraction

- Wrap the current mpv implementation behind a main-only `PlayerController`.
- Include load item, play, pause, seek, position, duration, playback rate when safely supported, buffering, completion, errors, track state, fullscreen state, and item transitions where relevant.
- Preserve authoritative playback reporting and the existing player-window behavior.
- Add origin and revision metadata needed to distinguish local user actions from remotely applied synchronization commands.
- Preserve all existing authenticated, local, streamed, downloaded, autoplay, reporting, and packaging behavior.
- Add automated tests and rerun playback regressions.
- Commit stable work.
- Stop for explicit approval.

### W3. Functional group discovery and synchronization

- Add the main-side SyncPlay client and coordinator.
- Add narrow typed IPC and preload interfaces.
- Add the Active Watch Parties view and minimal group controls without redesigning existing screens.
- Implement authenticated group listing, group creation, joining, leaving, participants, item identity, shared play/pause/seek, readiness, drift correction, and feedback-loop prevention.
- Ensure every participant resolves the item independently through the existing local-first resolver.
- Add automated protocol, authorization, stale-session, origin, IPC, validation, and renderer-boundary tests.
- Commit stable work.
- Stop for explicit approval.

### W4. Resilience and Windows acceptance

- Add reconnect behavior, buffering handling, participant departure, group deletion, episode transitions, logout cleanup, server changes, denied-access handling, protocol-version failure handling, and actionable errors.
- Verify ordinary solo playback remains unchanged outside a group.
- Rerun the complete Electron, authenticated Jellyfin, local playback, download, offline-sync, mpv, security, and installer suites.
- Rebuild and test the Windows installer.
- Perform real two-computer acceptance using two authenticated users or sessions.
- Commit stable work.
- Stop at the final acceptance gate.

## Required real two-client acceptance

- A group created on one client appears automatically in the Active Watch Parties list on another client authenticated to the same Jellyfin server.
- A client authenticated only to a different Jellyfin server cannot see or join that group.
- A signed-out client cannot enumerate groups.
- Jellyfin SyncPlay access policies are enforced for list, create, and join actions.
- Joining a listed group synchronizes the exact Jellyfin item ID.
- One client plays a verified downloaded copy while the other streams or transcodes.
- Play, pause, and seek initiated by either joined participant converge on both clients.
- Small drift is tolerated and meaningful drift is corrected without repeated oscillation.
- Remote commands do not create command feedback loops.
- Stale, duplicated, wrong-group, wrong-server, and prior-session messages are ignored.
- Buffering does not permanently desynchronize the group.
- Temporary connection loss recovers cleanly or fails with an actionable state when the server cannot restore membership.
- Cross-season Jellyfin Next Up transitions to the same exact item on both clients.
- Participant departure follows the documented Jellyfin SyncPlay behavior.
- When the group is deleted or becomes empty, it disappears from the active-group list.
- Leaving a group restores independent solo playback.
- Jellyfin playback reporting remains main-owned and accurate.
- No credentials, authenticated URLs, filesystem paths, raw protocol messages, arbitrary networking, or authoritative reporting interfaces are exposed to the renderer.
- Packaged Windows execution works on both clients.

## Milestone process

For every milestone:

1. Inspect the current repository and recent commits before editing.
2. Confirm the milestone acceptance criteria.
3. Implement only the current milestone.
4. Preserve all accepted functionality from earlier milestones.
5. Add automated tests alongside implementation.
6. Run relevant regression, security, authenticated, and runtime checks.
7. Fix failures caused by the milestone.
8. Document files changed, features implemented, tests run, manual checks, unverified scenarios, and known risks.
9. Commit completed stable work with a clear message.
10. Stop for explicit approval before advancing.

Do not claim two-client, authenticated, packaged, local-versus-streamed, reconnect, automatic discovery, cross-server isolation, or SyncPlay compatibility behavior was verified unless it was actually exercised under those conditions.
