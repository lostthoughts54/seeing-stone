# PlayerController boundary

`PlayerController` is the main-process playback contract used by renderer IPC and, beginning in W3, the SyncPlay coordinator. `MpvPlayerService` is its current native implementation.

The abstraction deliberately contains no mpv command arrays, executable arguments, pipe names, filesystem paths, playback URLs, proxy details, Electron window handles, Jellyfin credentials, or renderer APIs. A future embedded-libmpv backend can implement the same contract.

## Capabilities

- resolve and load an exact Jellyfin item through the existing `PlaybackSessionService`;
- play/pause, seek, stop, fullscreen, audio/subtitle selection, and bounded on-video status messages;
- discover embedded mpv tracks and authenticated Jellyfin-managed external text subtitles for both local and server video;
- read sanitized position, duration, buffering, seekability, track, completion, error, source-kind, and item-transition state;
- apply bounded playback-rate correction from `0.9` through `1.1` and restore normal `1.0` speed;
- keep the main client reachable as a minimized taskbar window during native mpv playback, restore it on close, and preserve authoritative Jellyfin reporting.

`loadItem` still enters the established local-first resolver. The controller receives an item ID, never a preselected stream or path. Each machine therefore chooses its own verified local copy first and otherwise uses its own authenticated server delivery.

## Origin and revision model

Commands accept a `PlayerCommandContext`:

- `local-user`: renderer actions or native mpv controls;
- `remote-sync`: a validated SyncPlay command;
- `system`: startup, cleanup, completion, buffering, autoplay, or drift maintenance.

Controller events carry the action, origin, optional caller-owned command revision and opaque command ID, a controller-owned monotonic revision, and a monotonic timestamp. The controller suppresses the native property acknowledgement of a programmatic pause, seek, or fullscreen command from being reclassified as a new local action. This is the feedback-loop boundary used by SyncPlay.

Native mpv OSC/key actions remain observable: unprompted pause/play, meaningful position jumps, fullscreen changes, and the controlled `Ctrl+R` resync shortcut become `local-user` events. Ordinary position telemetry remains a `system` state event. SyncPlay handles the resync event through `PlayerController`, applies only remote-origin local correction commands, and never turns it into a group seek.

## Ownership invariants

- `MpvPlayerService` remains the only code that sends mpv IPC commands or handles its process/window.
- `PlaybackReportingService` continues to receive authoritative events from mpv-owned state.
- SyncPlay may call only `PlayerController`; it may not access mpv, `PlaybackProxy`, local paths, or server delivery URLs.
- The renderer receives the existing sanitized `PlaybackState`, not `PlayerControllerEvent` internals.
- Remote actions are applied with `origin: remote-sync` and must never be rebroadcast as local actions.

## Verification

`tests/playerController.test.ts` covers remote-origin preservation, native-control origin detection, the controlled resync event, bounded on-video feedback, monotonic controller revisions, bounded rate correction, buffering, and absence of media locations from emitted state. Playback-session, proxy, API-boundary, live SyncPlay, and native mpv completion acceptance additionally cover the local-only resync route, reachable taskbar window, sanitized external-subtitle discovery, exact media-source matching, opaque authenticated delivery, selectable track attachment, local playback, and server playback.
