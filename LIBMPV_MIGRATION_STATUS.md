# Libmpv migration status

The migration is gated. Passing an earlier rendering gate does not approve a
public installer or make libmpv the default player.

## Milestone 0 — architecture scaffolding: passed

- `LibMpvHost` is a main-process-only, generation-tagged host/session boundary.
  Initialization, stop, and destruction are idempotent and stale callbacks are
  rejected.
- Runtime detection accepts only the exact files and hashes in
  `mpv-runtime.json`, beneath a controlled application directory. It never
  searches `PATH` or downloads a binary.
- The saved preference accepts `libmpv`. An unavailable or failed startup falls
  back without changing that preference or creating a restart loop.
- Public fallback reasons are a finite sanitized enum. Renderer contracts do
  not expose media URLs, credentials, paths, DLL names, native handles, or
  pointers.
- Existing embedded and legacy implementations retain their development and
  packaged defaults.

## Milestone 1 — synthetic Electron shared texture: passed

The Windows x64 C++ Node-API producer generated an advancing pattern in a
fixed three-texture BGRA D3D11 pool. Producer completion was bounded before
transfer, and each slot was held until Electron's all-references-released
notification.

Visible automated acceptance passed at 100% and forced 150% DPI in the existing
viewport, including resize, fullscreen, minimize/restore, renderer reload,
stale-generation rejection, and deterministic shutdown. Resources stayed
bounded with no continuous CPU readback or bitmap IPC.

`MediaStreamTrackGenerator` was evaluated and rejected for this Electron 43
path because its initial write and abort cleanup were unreliable.
`ImageBitmapRenderingContext` was selected for the production preload
presenter. The decision and measurements are recorded in
`native/libmpv-bridge/synthetic-gate-result.json`.

## Milestone 2 — reproducible runtime and bridge: passed for development

- mpv 0.41.0 and FFmpeg 8.1.2 are locked to immutable sources, revisions,
  archive hashes, flags, and a recorded MSYS2 UCRT64 toolchain in
  `native/libmpv-runtime/source-lock.json`.
- The build produced the manifest-named `libmpv-2.dll`, client ABI 2.5,
  companion DLL closure, headers, `mpv.exe`, and exact artifact inventory.
  All 14 enabled upstream mpv/libmpv tests passed.
- The native bridge securely loads only an absolute controlled DLL path and
  validates the ABI and all required client/render symbols.
- RAII owns COM, D3D11, EGL/ANGLE, mpv, render context, callbacks, textures,
  and the render thread. JavaScript is never called from an mpv callback
  thread. Render notifications are coalesced onto a dedicated native thread.
- Repeated headless mpv and render-context lifecycle tests passed.

This is a reproducible development build, not yet a redistributable public
runtime. The complete companion-package corresponding source and release
archive still have to pass Milestone 5.

## Milestone 3 — real libmpv render-API video: passed

The provenance-recorded H.264 fixture was rendered through
`mpv_render_context_render()` into the proven ANGLE/D3D11 shared-texture pool.
Both 100% and forced 150% DPI gates passed advancing video, seek/pause/resume,
track/property queries, aspect-fit viewport presentation, resize, fullscreen,
minimize/restore, renderer reload, bounded backpressure, complete Electron
reference release, and deterministic shutdown.

The final recorded runs transferred 170/167 frames, presented 165/160, released
all 170/167 imported references, and never exceeded the three-slot pool. No
continuous CPU readback or per-frame bitmap IPC occurred. See
`native/libmpv-runtime/real-video-gate-result-scale-1.json` and
`native/libmpv-runtime/real-video-gate-result-scale-1-5.json`.

Only this milestone establishes actual libmpv render-API video.

## Milestone 4 — controller integration: implemented; manual parity pending

- `LibMpvAdapter` uses the existing `MpvPlayerService` coordinator rather than
  duplicating source resolution, proxy ownership, Jellyfin reporting,
  completion/Next Up, revisions, track handling, or SyncPlay semantics.
- The narrow TypeScript host contract maps commands and property observation to
  the native bridge, so another native implementation can replace C++ without
  changing renderer, IPC, controller, reporting, or SyncPlay contracts.
- Launch routing is libmpv → embedded → legacy. Automatic fallback is limited
  to initialization before a session has begun reporting. Later failure is an
  error and clean stop, never a silent engine switch.
- The saved libmpv selection survives fallback. Libmpv is disabled only for the
  remainder of that process after failed initialization.
- Production-preload transport, renderer reload, fullscreen, commands,
  properties, and shutdown passed the integrated automated smoke test.

Focused controller, stale-event, fallback, preference, reporting, completion,
track, and SyncPlay tests pass. Authenticated Jellyfin direct-play,
direct-stream, transcode, audio, subtitle, Next Up, and SyncPlay behavior still
requires the manual acceptance checklist in `LIBMPV_EXPERIMENTAL.md`.

## Milestone 5 — packaging and public release: no-go

Libmpv is intentionally not included in `electron-builder.yml`. The stable
installer continues to package the existing player runtime and retains the
legacy packaged default.

A separate `electron-builder.libmpv-test.yml` path now produces an internal,
self-contained Windows x64 acceptance product with a distinct application ID,
name, install location, and libmpv default. Its package command rebuilds and
restages the exact native addon/runtime, validates the manifest-controlled
closure, excludes unrelated runtime executables, verifies the unpacked layout,
runs real render-API video through the packaged runtime, and confirms the
unpacked application reports libmpv active with no fallback. This does not
change the public-release no-go below.

Public release remains blocked until all of the following are complete:

- corresponding source archives and license records for every exact companion
  DLL and build dependency;
- a finalized Seeing Stone corresponding-source archive (no pending hashes or
  placeholder references);
- generated notices and a packaged dependency inventory covering every bundled
  DLL, addon, artifact, font, icon, and asset;
- clean-machine package/install/uninstall acceptance and secure absolute-load
  verification from the installed layout;
- authenticated controller parity, hardware/audio testing, device-loss stress,
  and the manual release checklist;
- explicit approval to add libmpv resources to packaging or change defaults.

Run `pnpm run validate:libmpv-release` for the hard release gate. It must remain
red until those records and acceptance artifacts genuinely exist.
