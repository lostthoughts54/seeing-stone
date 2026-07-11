# LocalFirst Jellyfin Client Foundation

Current interface milestone: `0.3.0`.

This is the first Jellyfin-first milestone. It is separate from the earlier local-file prototype.

## What this milestone does

- Signs into a Jellyfin server with username/password.
- Finds Jellyfin servers on the local network using Jellyfin's UDP discovery protocol.
- Saves the Jellyfin session token locally for quick reloads.
- Loads the signed-in user's libraries.
- Builds a Plex-style home from Continue Watching, Next Up, and recently added library rows.
- Opens dedicated movie, show, and episode detail views.
- Loads show seasons and episode rows.
- Displays Jellyfin poster/backdrop images when available.
- Preserves primary artwork aspect ratios instead of cropping posters to fill cards.
- Streams playable Jellyfin video items through the browser video player.
- Opens playback in a full-window player that returns to the prior browsing position.
- Sends best-effort playback start/progress/stop events back to Jellyfin.
- Keeps source resolution behind the Play action so the future local-first choice does not clutter browsing.

## Try it

Run the local client host, then open the address it prints:

```powershell
node server.js
```

The client searches the LAN automatically. Select a discovered server, then enter a username and password. A server URL can still be entered manually when discovery is disabled or the server is remote.

Example server URLs:

- `http://192.168.1.10:8096`
- `http://localhost:8096`
- `https://your-domain.example`

## Important prototype notes

- Browser playback depends on browser codec support. Some MKV, HEVC, subtitle, and audio combinations may not play until this becomes a desktop app with mpv/native playback.
- LAN discovery uses UDP port `7359`, the same discovery path used by Jellyfin clients. A plain web page cannot send UDP, so `server.js` is the first small native companion for the client.
- Multi-adapter machines can advertise a VPN address first. The companion also checks the standard Jellyfin public-info endpoint on the active physical LAN and prefers that matching server address.
- Jellyfin can disable automatic discovery. Manual server entry remains available for that case and for remote servers.
- The session token is stored in `localStorage` for prototype convenience. A desktop app should store it in a safer native credential store.

## Next milestone

Add the local-first layer:

1. Create a local download index keyed by Jellyfin item ID.
2. Add a download queue with states: queued, downloading, ready, failed, missing.
3. Download a single movie or episode into an app-controlled folder.
4. Change playback resolution to: local file first, then Jellyfin stream fallback.
5. Keep watch progress synced to Jellyfin in both cases.
