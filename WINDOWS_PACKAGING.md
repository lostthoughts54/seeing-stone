# Windows packaging

Milestone 8 packages the accepted application as a branded x64 Windows desktop installer. It does not change the renderer-facing product scope.

## Release shape

- Electron Builder `26.15.3` creates an assisted NSIS installer for x64 Windows.
- The stable application ID is `com.localfirst.jellyfin`; the product and executable name remain `LocalFirst Jellyfin` so existing Electron user data, protected sessions, device identity, SQLite state, and player preferences keep the same identity.
- Application code is stored in `resources\app.asar`. Only the SQLite worker and its runtime constants module are unpacked so Node's worker loader can execute them outside the archive. Before execution, main hashes both loose modules and compares them with a manifest stored inside the integrity-protected ASAR.
- The verified mpv runtime, controlled `input.conf`, manifest, and notice files are copied to `resources\mpv`. Packaged playback never falls back to a system mpv executable.
- Source maps, the imported prototype source, project tests, and development source folders are excluded from the application archive.
- Electron fuses disable Run-as-Node, Node environment/inspection arguments, and extra `file:` privileges; they require the embedded ASAR integrity record and loading the application from ASAR.
- The assisted installer defaults to the current user, offers an installation-directory choice, and creates Start Menu and desktop shortcuts. Uninstall removes installed program files without deliberately deleting Jellyfin downloads or Electron user data.

## Build

```powershell
pnpm install
pnpm package:windows
```

`package:windows` verifies the pinned mpv archive and notice hashes, recreates the runtime directory inside the workspace, builds every Electron target, and writes the installer under `.runtime\release`.

## Package acceptance

```powershell
pnpm test:package
```

The package test refuses to replace an existing LocalFirst Jellyfin installation. In an isolated workspace directory it verifies:

- x64 PE metadata, product name and version, artifact hash, and signing status;
- the required controlled ASAR, unpacked-worker, Electron, mpv, manifest, and notice inventory;
- every Electron 43 fuse state;
- a silent current-user install and matching uninstall registration;
- a visible, responsive, non-black renderer capture with SQLite and device identity initialized;
- single-instance behavior and stable device identity across restart;
- the installed pinned mpv runtime, media parsing, seek, and authoritative time behavior; and
- uninstall cleanup while the isolated user-data directory remains intact.

The harness stops only processes whose executable path is inside its isolated install directory. A normal user-driven X/close action is covered by the application runtime and manual parity checks rather than simulated by the installer harness.

## Signing and redistribution status

No Windows code-signing certificate is configured. The resulting installer is therefore unsigned and may trigger Windows SmartScreen; signing is an external release prerequisite, not an application fallback.

The pinned first-party mpv archive is reproducibly checksum-verified, but its upstream build fetched several statically linked dependencies from moving branches and did not publish a complete dependency lock or corresponding-source archive. `assets\mpv\licenses` contains the verified pragmatic notice set recorded in `mpv-runtime.json`, but it is not a complete independently audited SBOM or GPL corresponding-source bundle.

The current installer is suitable for internal Milestone 8 acceptance. Do not publish or redistribute it until mpv is rebuilt from fully pinned sources and the complete notices and corresponding source are archived.
