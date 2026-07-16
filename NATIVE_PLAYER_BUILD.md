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
3. Build the pinned mpv source as one `mpv.exe` for Windows x64. Both the
   embedded and legacy adapters use this executable; libmpv is intentionally
   deferred until a future render-API milestone has a demonstrated need.
4. Record the compiler, linker, Meson, Ninja, Python, and MSYS2 package versions,
   the complete configuration output, and hashes of produced artifacts.
5. Publish the build scripts, notices, and corresponding source beside any future
   redistributable installer.

This reproducible build must not block local player development. Gates 1–6 may
use the existing runtime after verifying its version, upstream source, license,
and SHA-256. Until the reproducible outputs are recorded and independently
reproduced, the Windows installer is an internal acceptance artifact. Gate 0
approves source publication, not binary redistribution.
