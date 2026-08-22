# YouTube Watch Together MVP

Seeing Stone can create an open YouTube room on the same remotely accessible
Jellyfin server that both viewers already use. Open rooms are discoverable only
to authenticated users of that server. There is no separately hosted room
service and no second account system.

## Why this is a plugin plus client feature

This repository is an Electron client: `ARCHITECTURE.md` assigns privileged
networking and authentication to Electron main, while `src/main/services/jellyfinApi.ts`
owns the Jellyfin access token. The repository is not the Jellyfin server and
cannot add server routes from its Electron process. The closest deployable,
Jellyfin-native integration is therefore the source plugin under
`plugins/SeeingStone.YouTubeRooms`, paired with the client service under
`src/main/services/youtubeRooms.ts`.

The older `SeeingStone.ParticipantTelemetry` directory could not safely prove
that an exact session belonged to a Jellyfin SyncPlay group. YouTube rooms do
not depend on that private mapping: each plugin route uses Jellyfin's normal
`[Authorize]` policy, derives the user id from the authenticated request
principal, and records room membership itself.

```text
official YouTube iframe
        ↕ content clock only
sandboxed renderer
        ↕ typed IPC (no token)
Electron main
        ↕ authenticated HTTPS through the saved Jellyfin session
Jellyfin + SeeingStone.YouTubeRooms plugin
```

## MVP behavior

- Creating a room gives it a name and publishes it in the plugin's authenticated
  open-room list, like Jellyfin SyncPlay parties. A viewer can join from that list.
- Every viewer still needs a valid Jellyfin user session. The 43-character room
  id is an opaque identifier, not an anonymous access credential.
- Rooms live in memory for six hours and disappear on Jellyfin restart. This is
  intentional for temporary-by-default rooms.
- The plugin serializes actions under one lock and assigns a monotonically
  increasing version. The last play, pause, seek, or video-change request received
  by Jellyfin wins.
- Each client sends a one-second authenticated presence heartbeat. A member is
  shown disconnected after ten seconds and removed after one minute without a
  heartbeat.
- A late join receives the current server anchor. While playing, clients derive
  the target from the anchor position plus elapsed server time.
- The renderer retries polling after ordinary network failures and retains the
  last room snapshot while reconnecting.
- Each room owns an ordered queue of up to 100 videos. Members can paste up to
  25 video links at once, add them to **Up Next**, play an entry immediately,
  reorder or remove upcoming entries, and advance manually. The first client to
  report that the content video ended advances the server queue; the expected
  video id makes duplicate end reports harmless.
- A member can create (or reuse) a normal Jellyfin SyncPlay group and publish it
  as the room's handoff destination. Other room members receive an explicit
  **Join Jellyfin party** prompt. The YouTube room remains available as a
  temporary redirect for late or reconnecting members until it expires.

## YouTube and ads

Playback uses `https://www.youtube.com/embed/<video-id>` with YouTube's embedded
player API enabled. Seeing Stone does not fetch media URLs, hide ad surfaces,
block requests, accelerate ads, or report ad transitions as shared user actions.
Both viewers control the content through Seeing Stone's shared play/pause/timeline
controls; the iframe's native transport controls are hidden so an ad-driven state
change cannot masquerade as a user's room command.

Timeline correction is sent only when the iframe reports the room's content video
identity and a stable duration. During an ad or player transition, the client
reports `recovering` and leaves the iframe alone. Once content identity returns,
the next convergence pass seeks to the current shared content position. Because
YouTube does not expose an official ad-state event, this is deliberately
fail-closed and best-effort: it may wait longer than necessary, but it does not
attempt to detect, skip, or manipulate the ad.

## Install and run

1. Use a .NET 9 SDK on the machine used to build the plugin. A system install is
   not required. For example, Microsoft's signed `dotnet-install.ps1` can unpack
   a portable SDK into `.dotnet9-portable`, after which this command builds with it:

   ```powershell
   & .\.dotnet9-portable\dotnet.exe publish `
     .\plugins\SeeingStone.YouTubeRooms\SeeingStone.YouTubeRooms.csproj `
     -c Release -o .\artifacts\SeeingStone.YouTubeRooms
   ```

   With .NET 9 already on `PATH`, `pnpm build:youtube-rooms-plugin` is equivalent.
2. Create a `SeeingStone YouTube Rooms` folder in the Jellyfin plugin directory
   and copy
   `artifacts/SeeingStone.YouTubeRooms/SeeingStone.YouTubeRooms.dll` into it.
   The `.deps.json`, `.pdb`, and `.xml` publish outputs are build metadata and are
   not required for this dependency-free plugin. See the plugin's own README for
   common locations.
3. Restart Jellyfin and confirm **Seeing Stone YouTube Rooms** appears in the
   server's plugin list.
4. Run Seeing Stone with `pnpm start`, sign in to that server, and open
   **Watch Parties**.

Protocol version 3 is required for queues and Jellyfin handoff. If Seeing Stone
reports that the plugin is outdated, stop Jellyfin, replace the existing DLL
with the newly published one, and restart Jellyfin before testing the client.

The plugin is pinned to Jellyfin 10.11.11 because that is the version already
tested and pinned by this repository's SyncPlay work. Match the package versions
to the server before claiming compatibility with another Jellyfin release.

## Verify

```powershell
pnpm test:youtube-rooms
pnpm typecheck
pnpm build
& .\.dotnet9-portable\dotnet.exe publish `
  .\plugins\SeeingStone.YouTubeRooms\SeeingStone.YouTubeRooms.csproj `
  -c Release -o .\artifacts\SeeingStone.YouTubeRooms
```

The protocol-v3 plugin has been compiled locally with portable .NET SDK 9.0.317 against the
pinned Jellyfin 10.11.11 packages. The publish artifact is
`artifacts/SeeingStone.YouTubeRooms/SeeingStone.YouTubeRooms.dll`. A live release
gate must still run a two-account test against a disposable Jellyfin 10.11.11
server; this repository does not automatically modify or deploy to a live server.

## Deliberately deferred

- General in-app YouTube search and automatic expansion of playlist URLs. The
  official iframe can play known videos, but catalog search and playlist item
  discovery require an optional YouTube Data API project and credentials. The
  queue therefore accepts individual video URLs, including several pasted one
  per line, without introducing a shared API key in this MVP.
- Chat, room history, persistent rooms, host roles, moderation, and kick controls.
- WebSocket push; one-second polling is the reconnect-friendly MVP transport.
- Automatic installation or modification of a live Jellyfin server.
- Compatibility claims beyond Jellyfin 10.11.11.
