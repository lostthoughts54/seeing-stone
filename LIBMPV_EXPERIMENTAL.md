# Experimental libmpv player

The libmpv engine is an opt-in Windows x64 development feature. It renders into
Seeing Stone's existing viewport through libmpv OpenGL, ANGLE/D3D11 shared
textures, Electron `sharedTexture`, and a GPU-backed preload presenter. It does
not create a native overlay window and does not use a continuous CPU frame pump.

## Requirements

- Windows 10 or 11 x64 with a working D3D11 driver.
- The repository dependencies installed with pnpm.
- The exact manifest-controlled runtime staged at `.runtime/libmpv`.
- The C++ bridge built for the installed Electron/Node-API version.

The current public installer does not bundle this experimental runtime. The
development build preserves the embedded default; the packaged build preserves
the legacy default.

## Start the existing staged development build

Open PowerShell and run:

```powershell
cd "D:\docs\jellyfin player"
$env:SEEING_STONE_PLAYER = "libmpv"
pnpm start
```

You can instead save **Libmpv (experimental)** in Preferences and restart the
application. To remove the one-shell environment override later:

```powershell
Remove-Item Env:SEEING_STONE_PLAYER -ErrorAction SilentlyContinue
```

If dependencies or native outputs have been cleaned, rebuild and restage first:

```powershell
cd "D:\docs\jellyfin player"
pnpm install
pnpm run build:libmpv-runtime
pnpm run build:libmpv-native
pnpm run test:libmpv-real-video
$env:SEEING_STONE_PLAYER = "libmpv"
pnpm start
```

The runtime build expects the pinned MSYS2/Visual Studio toolchain described in
`native/libmpv-runtime/source-lock.json`. Source downloads are limited to the
immutable URLs in that lock and require the explicit
`pnpm run setup:libmpv-sources` step.

## Fallback behavior

The saved libmpv preference is allowed even when prerequisites are unavailable.
On the next application launch, missing files, a hash/ABI mismatch, or failed
first-frame initialization activates embedded playback and shows a sanitized
reason. If embedded initialization also fails, the router tries legacy external.
The saved selection is not changed, and libmpv is not retried until the next
application restart. Once playback reporting has started, the application does
not silently switch engines; it reports an error and stops that session.

## Morning manual acceptance

Use media you are entitled to access and check:

1. Local/downloaded playback and Jellyfin direct play, direct stream, and
   transcode each start in the existing viewport.
2. Audio is present and synchronized; pause/resume, seeking, playback rate,
   volume/mute, audio tracks, subtitle tracks, and external subtitles work.
3. Resize, Windows fullscreen enter/exit, DPI movement between monitors,
   minimize/restore, and a renderer reload never leave a stale frame or separate
   native video window.
4. Stop, item replacement, completion, Next Up, logout, and application exit
   release the session cleanly.
5. Jellyfin progress/start/stop reporting occurs once, completion is correct,
   and SyncPlay leader/follower actions do not echo or double-apply.
6. Diagnostics identify `libmpv-opengl-angle`, show hardware-decoding state and
   bounded queue/drop counters, and contain no access tokens, request headers,
   local paths, or unsanitized media URLs.
7. In Task Manager, memory/handles remain bounded across repeated load/stop;
   CPU does not resemble a software bitmap pump. GPU usage may appear under 3D,
   copy, or video decode depending on the driver and codec.
8. Temporarily rename one controlled runtime DLL before launch, confirm a finite
   fallback reason and embedded playback, restore the DLL, and confirm the saved
   libmpv preference did not change. Do not perform this while playback is active.

## Known limitations

- The H.264 automated gate has no audio; audio and hardware decode require manual
  testing on representative media and GPUs.
- Authenticated Jellyfin delivery/reporting/SyncPlay parity is covered by shared
  coordinator tests but has not been accepted against your server in this build.
- Device-loss and clean-machine installed-layout acceptance are pending.
- Public-release provenance is not complete, so libmpv remains excluded from
  the installer.

## Bug reports

Include the application version, Windows build, GPU and driver version, delivery
mode, codec/resolution, exact action sequence, active/fallback diagnostics, and
whether the issue survives restart. Attach only sanitized logs: remove server
URLs, usernames, filesystem paths, tokens, cookies, headers, and media URLs.
