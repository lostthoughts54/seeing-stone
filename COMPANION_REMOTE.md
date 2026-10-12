# Seeing Stone — Companion Remote (Beta)

Companion Remote is an opt-in feature in Seeing Stone `0.7.0 Beta`. It serves a
phone-friendly remote from the desktop over one explicitly selected RFC1918
IPv4 network. The desktop must be running and signed in.

## Enable and pair

1. Choose **Phone Remote** in the primary navigation.
2. Select the trusted private network used by the phone.
3. Enable Companion Remote.
4. Choose **Pair a phone**, then scan the QR code or enter the eight-digit code.
5. In Safari, use Share → **Add to Home Screen** if desired.

The preferred address is `seeing-stone-<suffix>.local`; the settings panel also
shows a direct-IP fallback. mDNS can be blocked by some guest networks, VPNs,
and access points.

Pairing is single-use and expires after five minutes. Paired phones receive an
HttpOnly, SameSite=Strict device cookie. Device verifiers are scoped to the
current Jellyfin server and user and are kept in Windows protected storage.
They never cross Electron IPC.

## Browse on the phone

Browse is divided into the movie, TV, Anime, and other supported video
libraries configured in Jellyfin. Each library can be sorted by recently
added, release date, or alphabetical title. The phone requests 30 items at a
time and exposes **Load more**, so a large library is not downloaded as one
long list. TV-style libraries open at the series level; choose **Episodes** to
drill into a show. Search continues to work across all libraries.

## Network and security boundaries

The listener binds only the selected private IPv4 address. It does not bind a
wildcard address, configure Windows Firewall, request elevation, create a port
forward, use UPnP/NAT traversal, or contact a relay. If Windows asks about
network access, allow **Private networks only**.

The Beta uses same-origin HTTP and `ws://`. LAN HTTP is not a secure context, so
there is no service worker or offline shell. HTTP cannot protect against a
hostile LAN observer or man-in-the-middle attacker. Do not enable the feature
on public, hotel, school, or other untrusted networks.

Requests require the paired credential, an exact Host and Origin, Fetch
Metadata checks, CSRF token, runtime epoch, increasing sequence, UUID command
ID, and the current playback or queue revision where applicable. WebSocket
tickets are single-use and expire after 30 seconds; WebSockets push state only.

## Queue and continuation

The queue is profile-scoped, in memory, limited to 200 entries, and cleared on
logout or server change. Each entry has its own queue entry ID, so the same
movie, episode, or video can be queued more than once.

At natural completion, Seeing Stone first finalizes reporting and closes the
old playback source. It checks whether automatic transitions are enabled before
consulting the continuation resolver. This prevents local queue or Next Up
activity during SyncPlay.

While the desktop is in a watch party, the phone also shows preparation status
and can move that desktop's playback timing earlier or later in 100 ms steps.
The saved adjustment is local to that computer and is applied gradually.

When automatic transitions are enabled, the explicit queue is checked after
movies, episodes, and videos. An exact queue entry is reserved for the
countdown, then committed only after the next playback session is adopted and
reported successfully. Cancellation, stale playback, failure, logout, and
shutdown release the reservation without advancing it. When the explicit queue
is empty, episodes may use Jellyfin Next Up; movies and videos retain their
existing ended behavior.

## Port and address changes

The random high TCP port is reused until changed. **Choose a new port** always
shows this warning:

> Existing bookmarks and Home Screen shortcuts contain the old port and may
> need to be removed and added again.

Cancelling makes no change. DHCP address changes can break direct-IP
installations and may require pairing or adding the Home Screen shortcut again.

## Mobile accessibility

The mobile interface supports safe areas, portrait and landscape layouts down
to 320 CSS pixels, visible keyboard focus, semantic landmarks, VoiceOver,
reduced motion, 200% text zoom, and touch targets of at least 44×44 CSS pixels.
It uses only packaged scripts, styles, and artwork; there are no CDN resources,
analytics, external fonts, embeds, or HTTP-mode service worker.

## Troubleshooting

- Confirm the phone and desktop are on the same private IPv4 subnet.
- Turn off guest isolation or client isolation on the access point.
- Temporarily disconnect a VPN that replaces the selected route.
- Allow Seeing Stone through Windows Firewall on Private networks only.
- Try the direct-IP address if the `.local` name does not resolve.
- Select the adapter again after changing networks.
- If the port is occupied, choose a new port and re-add old shortcuts.

iOS before 17.2 may require pairing again after adding the site to the Home
Screen. Remote DVR mutation, downloads, watched-state editing, TLS provisioning,
Web Push, wake/relay support, and background media controls are deferred.

## YouTube discovery and queueing

**Launch Seeing Stone.cmd** opens `.runtime/release/win-unpacked/Seeing Stone.exe`
with the current YouTube, phone remote, Jellyfin and IPTV features. All features
share the normal `%APPDATA%\Seeing Stone` profile. Rebuild this same location with
`pnpm run package:windows:dir`; do not create a new hotfix launcher or output folder.

The phone remote's **YouTube** tab searches videos, browses popular US videos,
and adds a selected video or pasted link to the desktop's active YouTube room.
Open or join the room under **Watch Parties** on the desktop first. The room's
existing Player Features server plugin and official embedded player still handle
the queue and playback. The tab shows the target room and its queue, refreshing
every two seconds while visible. Controls include **Play/Pause**, **Next video**,
**Restart video**, **−10 seconds**, **+30 seconds**, and **Play now** from results
or links. Queue entries support playing, removing, and moving upcoming videos.
Transport requests target the current queue entry so a stale phone cannot skip
the next occurrence of a repeated video. These controls affect the YouTube room,
not the separate Jellyfin player. They do not control the standalone **Test alone**
trailer. YouTube may require an initial click on the desktop to allow playback.
The tab does not expose a personal
YouTube home feed, subscriptions, or a Google sign-in.

Search and popular browsing require a Google project with **YouTube Data API v3**
enabled and an API key. Follow Google's setup instructions:
https://developers.google.com/youtube/v3/getting-started

Restrict the key to YouTube Data API v3. On the desktop, open **Phone Remote →
YouTube search**, paste it in **YouTube API key**, and choose **Save key**.
**YouTube search settings** under Watch Parties opens the same panel. The input
is masked and cleared after saving. Saving takes effect without restarting.
**Remove saved key** deletes the saved key. Windows-protected storage keeps it
in the local app profile; the settings response never returns the key.
`SEEING_STONE_YOUTUBE_API_KEY` remains supported as a fallback when no saved key
exists. The panel identifies when this environment fallback is active.

The key stays in the desktop process and is never returned to the phone. Search
runs on form submission and pages are cached for five minutes to reduce quota
use. Google's daily quotas apply. Search failures appear in the tab, and pasted
video links continue to work without a key or when search quota is exhausted.
Thumbnails load from YouTube's image host. Searches request embeddable videos,
but YouTube can still restrict playback by region, age, or availability.
