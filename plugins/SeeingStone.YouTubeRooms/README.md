# Seeing Stone YouTube Rooms plugin

This Jellyfin 10.11.11 plugin is the coordination backend for Seeing Stone's
YouTube **Watch Together** MVP. It is not a relay and has no account system.
Every endpoint requires a normal Jellyfin user session. Named active rooms are
listed to authenticated users of the same server and can be joined directly.

Rooms are held in server memory and expire six hours after creation. Restarting
Jellyfin intentionally removes them. The server assigns every play, pause, seek,
and video change a new monotonically increasing version while holding one lock;
the last request received by the server wins.

## Build and install

The plugin targets the repository's pinned Jellyfin server version, 10.11.11,
and requires a .NET 9 SDK used by that server. With .NET 9 on `PATH`:

```powershell
dotnet publish .\plugins\SeeingStone.YouTubeRooms\SeeingStone.YouTubeRooms.csproj -c Release -o .\artifacts\SeeingStone.YouTubeRooms
```

A system-wide SDK install is not required. A portable SDK unpacked into
`.dotnet9-portable` can build the same artifact with:

```powershell
& .\.dotnet9-portable\dotnet.exe publish `
  .\plugins\SeeingStone.YouTubeRooms\SeeingStone.YouTubeRooms.csproj `
  -c Release -o .\artifacts\SeeingStone.YouTubeRooms
```

Create a `SeeingStone YouTube Rooms` folder under Jellyfin's plugin directory,
copy `SeeingStone.YouTubeRooms.dll` from the publish output into it, then restart
Jellyfin. On a standard Windows install the plugin root is normally beneath
`%PROGRAMDATA%\Jellyfin\Server\plugins`; in Docker it is beneath `/config/plugins`.
Use the actual data directory configured for your server.

The exact required file is
`artifacts/SeeingStone.YouTubeRooms/SeeingStone.YouTubeRooms.dll`. The adjacent
`.deps.json`, `.pdb`, and `.xml` files are publish/debug metadata and do not need
to be copied because all Jellyfin references are supplied by the server.

After restart, sign into Seeing Stone, open **Watch Parties**, and create or join
a YouTube room. No new public port or reverse-proxy route is needed: the plugin
uses the same Jellyfin base URL and authentication that Seeing Stone already uses.

## Security and scope

- Room ids contain 256 random bits and appear in the authenticated open-room list.
- A request must authenticate as a Jellyfin user; room ids do not grant anonymous
  access.
- A client must join before it can publish presence or playback actions.
- Request bodies contain only a YouTube video id, client instance id, playback
  state, and position. Jellyfin credentials remain in Seeing Stone's main process.
- Chat, history, durable rooms, roles, and moderation are intentionally absent.
