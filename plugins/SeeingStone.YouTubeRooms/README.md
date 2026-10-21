# Seeing Stone Player Features — 2.1.0

The expanded Seeing Stone companion plugin for Jellyfin **10.11.11**. It keeps
the existing plugin ID, `SeeingStone.YouTubeRooms.dll` assembly name, and v3
YouTube routes so it can replace the original YouTube Rooms plugin.

The main **Watch Party** section in Watch Parties supports:

- Persistent rooms, mixed Jellyfin/YouTube queues, votes, and host/everyone controls.
- **Watch now** switches everyone between Jellyfin, YouTube and trailers in the same room. **Back to [title]** restores the queued movie's saved position, including after a server restart.
- Access and exact media-version preflight, delivery information, and subtitle discovery.
- Participant readiness, buffering and disconnect status; a shared 2.5-second start.
- A 1.5-second buffering grace period and coordinated recovery. Disconnected
  viewers receive a reconnect grace period; after 30 seconds the others may resume.
- Explicit downloads of the Jellyfin queue on each approving viewer's computer,
  using Seeing Stone's existing subtitle download/cache support.
- Subtitle delay saved separately for each user, media version and selected track.
- Shared intro/recap skips when Jellyfin provides segment metadata; a five-second
  next-item countdown for queued media after natural completion.
- Chat, reactions, timestamped comments and a bounded troubleshooting history.

In Seeing Stone rooms, use **React** in the desktop player controls or the emoji buttons in the room conversation to send applause, laughter, love, surprise, sadness or fire. Connected viewers see brief emoji bursts with the sender's name over the video. **Hide reactions** hides bursts locally; reactions remain in the conversation. Reduced-motion preferences display stationary reactions. Old reactions do not replay on rejoin or video changes. This uses Player Features room messages; standard Jellyfin SyncPlay parties do not carry these reactions.

The room panel moves into the player's Session sidebar during native playback.
Select a subtitle track in the player's normal controls before saving its delay.
The host's **Continue with ready viewers** action disables **Wait when someone
buffers**; the host can turn that setting back on afterward.

## Build and test

A .NET 9 SDK is required. Set `SEEING_STONE_DOTNET` to a portable SDK's executable
if needed; the build script also checks `.dotnet9-portable/dotnet.exe` before PATH.

```powershell
pnpm run test:player-features-plugin
pnpm run test:player-features
pnpm run build:player-features-plugin
pnpm run build
pnpm run test:player-features-ui
```

On other platforms the equivalent plugin commands are:

```sh
dotnet run --project plugins/SeeingStone.PlayerFeatures.Tests
dotnet publish plugins/SeeingStone.YouTubeRooms -c Release -o artifacts/SeeingStone.YouTubeRooms
```

Output: `artifacts/SeeingStone.YouTubeRooms/SeeingStone.YouTubeRooms.dll`.
The Windows build script also updates its `.sha256.txt` checksum. The adjacent
PDB, XML and deps files are build metadata; Jellyfin provides its own dependencies.

## Upgrade

1. Back up the existing plugin DLL and Jellyfin plugin configuration directory.
2. Stop Jellyfin and replace the DLL **in the existing plugin folder**. Do not
   install a second copy under a new name; the assembly and plugin ID are unchanged.
3. Start Jellyfin and confirm **Seeing Stone Player Features** appears in Plugins.
4. Run Seeing Stone 0.7.5 or later on both computers and open **Watch Parties → Watch Party**. Version 2.1.0 advertises the `watch-now` capability; older plugins prompt clients to update before switching.

For a new installation, create a folder under the configured Jellyfin plugins
directory and place the DLL there. No additional public port is required.

New room queues, positions, messages and events are stored in
`seeing-stone-rooms.json` under Jellyfin's plugin configuration directory.
Subtitle corrections use `seeing-stone-subtitle-timing.json` there. Rooms restart
paused, and clients must rejoin. The host can delete unused rooms. Existing v3
YouTube rooms retain their original in-memory, six-hour lifetime.

## Boundaries and limits

All feature commands require an authenticated Jellyfin user. Room membership is
bound to that exact authenticated session, without accessing private SyncPlay
internals. Library access is checked for each account. Another user's unavailable
media title/version is redacted. Credentials and media transport remain main-side.

There are at most 64 persistent rooms, eight per owner, 32 participant sessions
per room, 100 queue items, 200 messages and 300 events. The legacy YouTube service
is capped at 100 rooms and 32 participants each. Rooms are discoverable to signed-in
users of this server; they are not private invitation-only rooms.

YouTube continues to use its official iframe, including its ads and availability
rules. No YouTube videos are downloaded, proxied or stripped of ads. A viewer may
need to click **Enable YouTube playback** to satisfy browser playback restrictions.
Content identity and stable duration must be reported before synchronization.

The new rooms and ordinary Jellyfin SyncPlay are separate modes; leave one before
joining another. The older optional SyncPlay telemetry transport remains disabled.
The plugin cannot make an unsupported codec playable or guarantee frame-perfect
sync across devices and YouTube. Readiness comes from each cooperating player.

## Validation

The repository includes dependency-free C# behavioral checks, TypeScript service
and IPC tests, and an isolated Electron UI fixture. Those checks do not replace
a two-computer trial against the actual Jellyfin installation. This change does
not install the plugin or restart a server automatically.
