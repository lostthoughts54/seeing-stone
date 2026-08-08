# Windows packaging

Milestone 8 packages the accepted application as a branded x64 Windows desktop installer. It does not change the renderer-facing product scope.

## Release shape

- Electron Builder `26.15.3` creates an assisted NSIS installer for x64 Windows.
- The stable application ID is `com.localfirst.jellyfin`; the product and executable name remain `LocalFirst Jellyfin` so existing Electron user data, protected sessions, device identity, SQLite state, and player preferences keep the same identity.
- Application code is stored in `resources\app.asar`. Only the SQLite worker and its runtime constants module are unpacked so Node's worker loader can execute them outside the archive. Before execution, main hashes both loose modules and compares them with a manifest stored inside the integrity-protected ASAR.
- The controlled source-built runtime is copied to `resources\libmpv`. `libmpv-2.dll` and the native bridge provide production playback; the same build's verified `mpv.exe` is present only for headless downloaded-media validation. The historical `resources\mpv` hierarchy is prohibited.
- Source maps, the imported prototype source, project tests, and development source folders are excluded from the application archive.
- Electron fuses disable Run-as-Node, Node environment/inspection arguments, and extra `file:` privileges; they require the embedded ASAR integrity record and loading the application from ASAR.
- The assisted installer defaults to the current user, offers an installation-directory choice, and creates Start Menu and desktop shortcuts. Uninstall removes installed program files without deliberately deleting Jellyfin downloads or Electron user data.

## Build

```powershell
pnpm install
pnpm package:windows
```

`package:windows` restages and verifies the pinned source-built libmpv closure, validates provenance, builds every Electron target, and writes the installer under `.runtime\release`. It does not download or stage the legacy prebuilt mpv runtime.

## Package acceptance

```powershell
pnpm test:package
```

The package test refuses to replace an existing LocalFirst Jellyfin installation. In an isolated workspace directory it verifies:

- x64 PE metadata, product name and version, artifact hash, and signing status;
- the required controlled ASAR, unpacked-worker, Electron, libmpv, media-probe, manifest, and notice inventory, including the absence of `resources\mpv`;
- every Electron 43 fuse state;
- a silent current-user install and matching uninstall registration;
- a visible, responsive, non-black renderer capture with SQLite and device identity initialized;
- single-instance behavior and stable device identity across restart;
- the source-built headless media probe against valid and corrupt media; and
- uninstall cleanup while the isolated user-data directory remains intact.

The harness stops only processes whose executable path is inside its isolated install directory. A normal user-driven X/close action is covered by the application runtime and manual parity checks rather than simulated by the installer harness.

## Signing and redistribution status

No Windows code-signing certificate is configured. The resulting installer is therefore unsigned and may trigger Windows SmartScreen; signing is an external release prerequisite, not an application fallback.

The production player and probe now share the pinned mpv 0.41.0 / FFmpeg 8.1.2 source build recorded by `native\libmpv-runtime\source-lock.json`, `native\libmpv-runtime\build-result.json`, and `libmpv-runtime.json`. The old prebuilt runtime remains available only to explicit development/regression workflows through `legacy-mpv-runtime.json` and is not a production input.

This removes the known legacy-runtime blocker but does not approve public binary redistribution. Complete companion provenance, corresponding-source archives, notices, clean-machine/manual acceptance, signing, and the remaining `validate:libmpv-release` requirements are still required.
