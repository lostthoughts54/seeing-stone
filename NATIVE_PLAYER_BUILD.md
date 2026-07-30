# Native player provenance and build policy

Seeing Stone's public source release targets a GPL-enabled mpv and FFmpeg stack.
The current internal Windows runtime remains pinned by `mpv-runtime.json`, but its
upstream archive is not approved for public redistribution because it does not
provide a complete corresponding-source bundle for every statically linked
component.

## Required reproducible build

The release build must use only freely available tools and must:

1. Fetch every component from the immutable revision and URL recorded in the
   runtime manifest, verify its archive hash, and never build from a moving branch.
2. Build FFmpeg with GPL support and without nonfree components or optional
   proprietary encoder SDKs.
3. Build the pinned mpv source as `mpv.exe` for the unchanged embedded and
   legacy adapters. A libmpv build is a separate gated artifact: its manifest
   must name the exact library file, client ABI, headers, companion DLLs,
   source revisions, build flags, toolchain, patches, hashes, and corresponding
   source. No arbitrary prebuilt libmpv binary is accepted.
4. Record the compiler, linker, Meson, Ninja, Python, and MSYS2 package versions,
   the complete configuration output, and hashes of produced artifacts.
5. Publish the build scripts, notices, and corresponding source beside any future
   redistributable installer.

This reproducible build must not block local player development. Gates 1–6 may
use the existing runtime after verifying its version, upstream source, license,
and SHA-256. Until the reproducible outputs are recorded and independently
reproduced, the Windows installer is an internal acceptance artifact. Gate 0
approves source publication, not binary redistribution.

## Libmpv rendering gate order

Run `pnpm run check:libmpv-toolchain` before adding native bridge outputs. The
synthetic D3D11 shared-texture producer must pass Electron presentation,
synchronization, reference-release, bounded-resource, resize/fullscreen/DPI,
renderer-reload, and shutdown acceptance before any ANGLE/libmpv integration.
See `LIBMPV_MIGRATION_STATUS.md` for the current go/no result.

After the synthetic gate passes, the controlled source-build workflow is:

1. `pnpm run check:libmpv-runtime-toolchain`
2. `pnpm run setup:libmpv-sources`
3. `pnpm run build:libmpv-runtime`
4. `pnpm run build:libmpv-native`
5. `pnpm run test:libmpv-lifecycle`
6. `pnpm run test:libmpv-render-context`
7. `pnpm run test:libmpv-real-video`
8. `pnpm run test:libmpv-integrated`

The setup command downloads only the source archives and immutable URLs locked
in `native/libmpv-runtime/source-lock.json`; it verifies both hashes before
extraction. Staging writes the exact library filename, client ABI, required
symbols, native addon, complete companion-DLL closure, owners, byte counts, and
hashes. A successful lifecycle probe is not approval of the real-video gate.
The real-video and integrated development gates now pass; see
`LIBMPV_MIGRATION_STATUS.md`. Public redistribution remains a separate no-go
until `pnpm run validate:libmpv-release` passes and the clean-machine/manual
release checklist is signed off.
