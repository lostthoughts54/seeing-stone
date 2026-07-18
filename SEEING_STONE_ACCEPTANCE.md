# Seeing Stone Gates 0–6 Acceptance

This record contains only sanitized, synthetic, or repository-owned evidence. It intentionally omits media locations, server addresses, credentials, authenticated URLs, and user data.

## Safety boundary

- The packaged application always selects the legacy external mpv adapter.
- The embedded adapter is available only in unpackaged development builds through the persisted developer preference or explicit development override.
- The legacy adapter remains implemented and selectable.
- No Windows binary or release is published by this work.
- No libmpv artifact is built.
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

## Gates 5–6

Status: in progress. Later sections will be added only as their acceptance evidence passes.
