# Seeing Stone Gates 0–6 Acceptance

## 0.6.0 Beta — Companion Remote

- No LAN listener exists on a fresh install or before explicit enablement.
- The listener binds only the selected RFC1918 IPv4 adapter and high persisted port.
- Pairing is five-minute, single-use, throttled, and produces only an HttpOnly device cookie.
- Logout, server change, disable, and exit close HTTP, WebSocket, mDNS, pairing, capabilities, and queue reservations.
- Desktop and phone actions use the same playback command service and preserve SyncPlay routing.
- Explicit queue continuation works after movies, episodes, and videos; Jellyfin Next Up is episode-only.
- Queue reservation and commit use the exact queue entry ID, including duplicate media.
- The packaged mobile UI shows “Seeing Stone — Companion Remote,” uses 44×44 CSS-pixel targets, and contains no service worker or external assets.
- Port regeneration cannot proceed without the Home Screen shortcut warning.
- Physical iPhone acceptance still requires Safari/Home Screen, Wi-Fi loss, DHCP change, mDNS fallback, VoiceOver, orientation, and 200% text checks.

This record contains only sanitized, synthetic, or repository-owned evidence. It intentionally omits media locations, server addresses, credentials, authenticated URLs, and user data.

## Safety boundary

- The packaged production application always selects the controlled libmpv adapter; legacy and embedded-WID adapters are development/regression-only.
- Unpackaged development builds default to the validated embedded adapter after the Gate 3 checks; the persisted developer preference or explicit development override can select the legacy fallback.
- The legacy adapter remains implemented and selectable only outside normal packaged production.
- No Windows binary or release is published by this work.
- The controlled libmpv artifacts are built and packaged only for internal acceptance; no Windows binary or release is published by this work.
- Enhanced participant telemetry remains disabled unless isolated-server compatibility and group-membership authorization can be proven.

## Gate 0 — Licensing, branding, and runtime provenance

Status: accepted for source publication; Windows binary redistribution remains internal.

Evidence:

- `c9154a0` establishes GPL-2.0-or-later licensing, third-party notices, asset provenance, central branding, the original violet orb, and a versioned native-runtime manifest.
- `dfe0f8f` makes dependency-license policy fail closed and adds forbidden-license fixtures.
- The pinned mpv executable version and SHA-256 are verified by the local runtime acceptance script.
- The native-runtime record identifies mpv and FFmpeg source revisions, licenses, build metadata, executable hash, and corresponding-source requirements.
- libmpv render-API adoption is deferred and no libmpv binary is produced.

Limitations:

- A fully reproducible mpv/FFmpeg Windows build and corresponding-source bundle remain mandatory before public Windows binary distribution.

## Gate 1 — Playback boundary and native Windows host

Status: accepted for guarded development use.

Architecture:

- A content-free Electron `BaseWindow` owns the native video surface and is parented to the main `BrowserWindow`.
- mpv receives the verified decimal Win32 handle through `--wid`.
- Embedded playback disables mpv OSC and direct keyboard bindings; Seeing Stone retains focus and input ownership.
- Embedded playback uses mpv's OpenGL GPU API. The default D3D11 surface decoded correctly but could not be captured as visible evidence in the automated Windows run.
- Packaged builds remain on the legacy external adapter.

Automated Windows evidence:

- `gate1-embedded-window.png`: isolated-window screenshot containing only the synthetic test pattern and acceptance background.
- `gate1-embedded-surface.png`: cropped synthetic video-surface evidence.
- `gate1-embedded-window.json`: normal-scale lifecycle results.
- `gate1-embedded-window-scale125.json`: forced 125% scale lifecycle results; desktop capture is deliberately disabled in this mode.

Verified behaviors:

- Non-zero Windows handle conversion accepted by mpv.
- Synthetic media actively decoded with a configured `gpu-next` video output.
- Visible video surface verified by measured non-dark pixel ratio and color range.
- Native owner relationship and bounds verified after initial attach, move, resize, two-monitor movement, minimize, restore, fullscreen entry and exit, Session Panel width change, route hide, and route restore.
- Main-window focus retained before and after route restoration.
- Host cleanup verified on route hide, application shutdown paths, and forced mpv termination.
- A separate run forced Electron to 125% display scaling and repeated bounds, focus, fullscreen, collapse, route, and termination checks without capturing any desktop pixels.

Deferred manual evidence:

- Unusual GPU and driver combinations.
- HDR display output and tone mapping.
- Mixed-DPI physical monitors beyond the forced 125% lifecycle run.
- Subjective motion quality and long-duration playback.

## Gate 2 — Embedded Jellyfin playback and durable reporting

Status: accepted for guarded development use. The packaged application still selects the legacy adapter.

Implemented behavior:

- The public player contract now exposes source kind, real buffer-ahead data when mpv supplies it, track metadata, volume, rate, selection, fullscreen, lifecycle state, and sanitized diagnostics.
- Source resolution tries verified matched-local and downloaded candidates in order before direct play, true direct stream, and transcode. A failed local candidate advances without reporting a false start.
- Direct-stream and transcode playback use explicit zero-based server streams plus an application-owned timeline offset.
- Jellyfin start, progress, pause, resume, seek, stop, and completion envelopes are persisted before delivery and retain their exact order across restart and temporary reporting failure.
- Automatic queued progress cannot overwrite newer remote progress; newer explicit local actions retain priority.
- A pending explicit rewind or start-over remains authoritative across restart even after later automatic progress, until that explicit lineage synchronizes.
- Server-stream seek restarts retain volume, playback rate, fullscreen state, and selected audio/subtitle tracks; partial restart failure destroys the new process and exposes a terminal error state.
- Next Up reuses the normal fallback and source-adoption path, resets timeline state, and preserves volume and fullscreen preference.
- Authenticated external subtitles retain a stable mpv-track-to-Jellyfin-stream mapping even when labels are identical.
- Public results, diagnostics, logs, and acceptance output remove or reject paths, tokens, server playback URLs, and credential-like values.

Autonomous evidence:

- Three TypeScript targets passed type checking.
- 164 unit tests passed across 25 files.
- 22 compiled SQLite/core tests passed, including additive schema 1-to-3 migration, identity-scoped replay, close/reopen lifecycle replay, and offline failure/recovery.
- 20 hidden Electron security and narrow-IPC tests passed against in-process synthetic services. The restricted Codex process sandbox could not launch Electron renderer subprocesses; the same harness passed when granted its required GUI-process permission.
- The pinned real mpv runtime passed checksum/version validation, duration, play, pause, exact seek, rate, audio selection, subtitle selection, and track discovery.
- The headless real-mpv completion harness passed local external subtitles, MP4 completion, MKV Next Up after the ten-second countdown, and cancellation.
- Real mpv probing accepted valid media and rejected corrupt media and path escape.
- Electron SQLite runtime acceptance passed on schema 3 with WAL, foreign keys, integrity check, and a worker thread.

Safety and limitations:

- No authenticated request was sent to the user's Jellyfin server. No server, service, or plugin was modified, restarted, upgraded, or load-tested.
- Direct play, direct stream, transcode, reporting outage, and recovery are covered by deterministic API and process tests, not yet by a disposable full Jellyfin service.
- A live isolated Jellyfin matrix remains deferred until a disposable server can be provisioned without touching the user's normal server.
- The embedded adapter remains disabled in packaged builds, and the legacy player remains selectable.

## Gates 3–4 — Seeing Stone shell and solo Session Panel

Status: accepted for guarded development use. The packaged application still selects the legacy adapter.

Implemented behavior:

- The placeholder player route is replaced by the approved Now Playing hierarchy: existing navigation rail, identity and status bar, native video surface, external controls, media metadata, Next Up, and a contextual Session Panel.
- Original replaceable orb branding, locally bundled Inter and Spectral fonts, obsidian/plum surfaces, restrained violet focus and active states, and semantic blue, green, amber, and rose state colors are applied through reusable tokens.
- Play/pause, ten-second seek, timeline, time labels, volume, mute, playback rate, audio, subtitles, fullscreen, settings, and Next Up use the narrow playback bridge. Controls have accessible names, visible focus, familiar shortcuts, and tooltips.
- Required rate and track controls remain reachable at compact widths through a real playback-settings surface; compact layouts no longer remove the volume slider.
- The Session Panel supports solo and Watchparty views while reserving disabled chat architecture. Panel toggles expose expanded state, tabs support arrow navigation, and drawer focus is restored on close.
- Solo diagnostics show only sanitized available connection, source, state, buffer, media, selected-track, transcode, server-version, and Next Up data. Missing values create no placeholder rows.
- High-frequency position events update playback controls without rebuilding the Session Panel. Open diagnostics, panel scroll, and focused dynamic actions survive ordinary playback ticks.
- Automatic item transitions refresh the top identity and lower metadata. Forced player termination hides the native surface while retaining a visible, sanitized disconnected state and the legacy fallback guidance.
- Open Source Licenses is backed by the generated Gate 0 inventory and rendered through a modal with filtering, keyboard containment, Escape handling, and focus return.

Autonomous evidence:

- Three TypeScript targets passed type checking and the deterministic license policy passed.
- 192 unit tests passed across 30 files, including shell structure, contrast, responsive settings, state presentation, diagnostics suppression, license inventory, and boundary enforcement.
- 22 compiled SQLite/core tests passed.
- 21 hidden Electron integration and security tests passed, including the generated license view and narrow renderer bridge.
- Persistence, media-probe, pinned-mpv runtime, and real-mpv completion acceptance all passed.
- `player-shell-acceptance.json` records an isolated-fixture run with source revision, platform/runtime provenance, screenshot hashes, zero renderer errors, and successful assertions for:
  - wide, intermediate, constrained, compact drawer, compact settings, and 125% text-scale layouts;
  - viewport/control separation and native-host hide/restore on player scrolling;
  - focus traversal, bundled font loading, reduced motion, unavailable-data suppression, and sensitive-text rejection;
  - trusted K, Space, J, L, M, and F input;
  - timeline, volume, rate, audio, subtitle, settings Escape/focus return, and fullscreen auto-hide;
  - focus-preserving high-frequency updates, automatic item transitions, and forced-player termination.
- Eight sanitized screenshots are stored under `artifacts/gate-3-4`, including a compact settings surface and disconnected terminal state. Every screenshot is generated from the visibly named isolated visual fixture; no real account or server data is used.

Deferred manual evidence:

- Subjective visual approval on the user's physical displays.
- Screen-reader testing with the user's preferred assistive technology.
- Physical keyboard/media-key variations and unusual Windows text-rendering configurations.
- GPU, HDR, and multi-device scenarios remain deferred with Gate 1 physical checks.

## Gate 5 — Watchparty and optional participant telemetry

Status: accepted for native Jellyfin SyncPlay and the safely disabled enhanced-telemetry fallback. The optional server plugin remains disabled.

Implemented behavior:

- Jellyfin SyncPlay remains authoritative for shared item, play, pause, seek, stop, late join, time synchronization, and drift correction. Remote command origin and feedback-loop suppression remain inside `PlaybackAdapter` routing.
- Wait and Continue issue Jellyfin group pause/unpause commands. Group Resync sends one bounded Jellyfin seek to the current authoritative timeline, while Ctrl+R retains the separate local-only correction.
- The Watchparty Session Panel shows the real group, native Jellyfin participants, real measured latency/drift only while the timeline is connected and authoritative, session controls, buffering preference, and Leave Party.
- `ParticipantTelemetryTransport` is a status-only boundary with no playback-command surface. Protocol v1 strictly validates client and server envelopes, rejects unknown and sensitive-shaped fields, derives identity server-side, enforces group/session/sequence/timestamp rules, publishes immediate transitions plus a two-second heartbeat, and marks data stale/disconnected at six/ten seconds.
- The buffering coordinator uses only current verified session telemetry, applies the 1.5-second grace, distinguishes multiple sessions for one user, supports per-incident Continue suppression, and fails open if telemetry or the authoritative pause command fails.
- Optional transport operations are bounded, lifecycle-revision guarded, sanitized, and unable to delay standard SyncPlay. A slow prior-group connection cannot publish into a later group.
- SQLite schema 4 adds identity-independent application preferences without altering existing playback, download, local-version, or reporting rows. Adapter selection remains packaged-legacy and the buffering preference is durable.
- The separate GPL-compatible plugin source boundary and protocol schema are recorded, but no endpoint, plugin binary, relay, install, restart, or server modification is produced.

Autonomous evidence:

- `1acdc1c` is the reviewed Gate 5 source checkpoint; subsequent small commits make the hidden visual capture deterministic without changing runtime behavior.
- All three TypeScript targets and the deterministic license policy passed.
- The complete unit suite passed 219 tests across 33 files. The final post-review telemetry and SyncPlay delta passed 36 focused tests.
- All 22 compiled core/SQLite checks, all 21 hidden Electron integration/security checks, and Electron schema-4 persistence acceptance passed.
- `artifacts/gate-5/gate5-visual-acceptance.json` records the clean source revision, environment, screenshot hash, strict disabled fallback, working Wait/Continue controls, group Resync visibility, buffering-policy round trip, suppressed unavailable rows, zero sensitive-looking text, and zero renderer errors.
- `artifacts/gate-5/watchparty-disabled-fallback.png` is a sanitized isolated-fixture screenshot with no account, server, credential, path, URL, or fabricated participant-status data.
- An independent read-only safety review found no remaining checkpoint blocker after lifecycle, cleanup, exact-session, outbound-validation, clock-skew, stale-drift, and evidence-provenance fixes.

Safety and limitations:

- The previously approved compatibility evidence identified Jellyfin 10.11.11. No fresh request was made to the normal server, and compatibility with any other version is not claimed.
- Jellyfin 10.11.11's public plugin API cannot prove that the exact authenticated session belongs to the claimed SyncPlay group. Both WebSocket and authenticated HTTP fallback endpoints therefore remain disabled.
- No disposable Jellyfin service with a matching plugin SDK was available, so no plugin build or live two-service plugin matrix was run. Standard SyncPlay remains independent and available.
- Automatic participant buffering identification is intentionally unavailable while the verified telemetry transport is disabled; participant rows show only native Jellyfin membership and no invented state.

Deferred manual evidence:

- Physical multi-device SyncPlay behavior across independent networks and clock conditions.
- Subjective watchparty ergonomics and assistive-technology review.
- Plugin enablement remains a future isolated-server task if a supported exact-session membership API becomes available.

## Gate 6 — Offline player completion

Status: accepted for guarded development use with the packaged legacy fallback retained.

Implemented behavior:

- SQLite schema 5 additively stores strict, bounded, sanitized media metadata, Next Up metadata, and source diagnostics without changing or deleting existing download, local-version, playback-head, or revision rows.
- The authenticated identity can list every last-known verified local or downloaded item through a path-free `Local playback available` catalog. Legacy rows without full metadata retain their durable resume head.
- Every offline open revalidates the authorized root, containment, file existence, exact recorded size, and real mpv probe before the path is given to the main-owned player. Missing or altered files fail safely and are marked unusable.
- Explicit `Offline` or `Reconnecting` state suppresses Jellyfin details, capability, subtitle, artwork, and reporting requests. Offline cards use cached text and local placeholders because artwork bytes are not cached.
- Authoritative start, progress, pause, seek, completion, and stop events commit to SQLite before returning. They remain pending without a transport attempt while offline, drain on a verified connected transition, and stop the whole drain as soon as any request proves the connection unavailable.
- Reconnection refreshes the current item's sanitized metadata, watched state, and Next Up without stopping, seeking, reopening, or replacing active local playback. A partial Next Up failure preserves the last verified cache.
- Conflict materialization uses pending explicit local actions when authoritative, protects newer remote watched/progress state once local revisions are synchronized, and retains the best durable head for pre-schema-5 cache rows.
- `Offline`, `Reconnecting`, `Connected`, `Local playback available`, and `Offline Local` are visible states. Unavailable request latency, buffer, codecs, and server-only metadata remain omitted rather than invented.

Autonomous evidence:

- All three TypeScript targets, both Vite builds, the main build, generated worker integrity, and deterministic license policy passed.
- The complete unit suite passed 232 tests across 33 files, including network-free offline capture, mid-drain disconnect, stop-during-start cancellation, legacy resume, remote-conflict precedence, partial Next Up preservation, placeholder-only offline catalog rendering, and sanitized cache validation.
- All 23 compiled core/SQLite checks passed, including additive v1-to-v5 migration, identity isolation, path-free offline listing, durable download metadata, and outage/reconnect conflict synchronization.
- All 21 hidden Electron integration and security checks passed after updating the frozen bridge and offline-card fixtures for the additive Gate 6 APIs.
- Electron schema-5 persistence acceptance and real-mpv media probing passed.
- `artifacts/gate-6/offline-runtime-acceptance.json` records a real pinned-mpv launch, advancing playback, durable stop, zero playback-resolution or reporting Jellyfin calls before reconnection, ordered start/stop synchronization afterward, no pending rows after recovery, and no exposed local path.
- `artifacts/gate-6/gate6-visual-acceptance.json` and three sanitized screenshots record clear Offline, Reconnecting, and Connected states; stable `Offline Local` source; unchanged playback identity; cached metadata; zero sensitive-looking text; and zero renderer errors in the isolated visual fixture.
- An independent read-only safety review found and verified fixes for synchronized-head precedence, reporting-time network attempts, stale start resurrection, offline artwork fetches, partial Next Up erasure, mid-drain disconnects, and legacy cache resume. Its final verdict was safe to checkpoint.

Safety and limitations:

- No authenticated or destructive request was sent to the user's Jellyfin server. No server, service, plugin, or production configuration was modified, restarted, upgraded, installed, or load-tested.
- `Local playback available` is last-known catalog state; the file is freshly revalidated at open rather than polled continuously. A file deleted outside Seeing Stone can remain listed until that open attempt.
- Offline artwork uses a placeholder because only safe artwork references, not image bytes, are cached in this milestone.
- Packaged production builds are hard-wired to libmpv with no legacy/embedded fallback; unpackaged development builds retain explicit adapter selection. Enhanced telemetry remains disabled, no binary or release is published, and Gate 7 is not started.

Deferred manual evidence:

- Physical multi-device SyncPlay across independent networks.
- Unusual GPU and driver combinations, HDR output and tone mapping, and mixed-DPI physical monitors.
- Long-duration playback, subjective motion and visual approval, preferred screen-reader testing, and physical keyboard/media-key variations.
