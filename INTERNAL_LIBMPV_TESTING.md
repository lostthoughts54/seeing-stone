# Seeing Stone libmpv acceptance build

This package is for private Windows x64 acceptance testing by the Seeing Stone
development team and invited testers. It is not the public release and must not
be redistributed.

The package:

- installs separately from the stable Seeing Stone client;
- selects the in-process libmpv player by default;
- includes the experimental native libmpv runtime and bridge;
- may fall back to the embedded player if the libmpv capability check fails;
- is unsigned, so Windows may identify the publisher as unknown.

## Build

From the repository root:

```powershell
pnpm run package:windows:libmpv-test
```

The command restages and hashes the already gate-approved Electron-matched native
addon, validates the internal package inputs, builds the separate
NSIS product, verifies every packaged native artifact, renders the H.264 gate
fixture through the packaged runtime and production presenter, installs the
generated setup executable into an isolated test location, and launches that
installed application to confirm that libmpv is its default active engine.

It deliberately does not rebuild the native bridge. Packaging must consume the
exact bridge that passed both real-video DPI gates; rebuilding it would
invalidate that evidence. After changing the native bridge, run
`pnpm run test:libmpv-real-video`, update the controlled provenance hashes, and
then run the packaging command.

The resulting installer is:

```text
.runtime/libmpv-test-release/Seeing-Stone-Libmpv-Test-Setup-0.7.0-x64.exe
```

Successful acceptance also writes a matching `.sha256.txt` sidecar and
`.runtime/libmpv-test-release/libmpv-test-acceptance.json`.

No pnpm, source checkout, Visual Studio, MSYS2, or separate mpv installation is
required on the tester's computer.

## Failure reporting

If libmpv cannot start, a persistent amber notice identifies the sanitized
reason and the fallback engine. The same finite status is stored in
`player-engine-status.json` beneath the application's user-data directory. It
contains no paths, URLs, tokens, headers, native handles, driver names, or raw
exception text.

Please test ordinary playback before testing SyncPlay. When reporting a problem,
include the media container, video and audio codecs, whether subtitles were
enabled, and the action immediately before the problem. Do not include server
passwords, access tokens, or private media URLs.
