# Seeing Stone — Companion Remote (Beta)

Companion Remote is an opt-in feature in Seeing Stone `0.6.0 Beta`. It serves a
phone-friendly remote from the desktop over one explicitly selected RFC1918
IPv4 network. The desktop must be running and signed in.

## Enable and pair

1. Open the profile menu and choose **Companion Remote (Beta)**.
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
