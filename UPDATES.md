# Application updates

Seeing Stone uses `electron-updater` 6.8.9 with electron-builder 26.15.3. The
public GitHub Releases feed is `lostthoughts54/seeing-stone`, confirmed by the Git
remote, README, and anonymous GitHub access. No token belongs in the app.

## User behavior

Open **Settings > About / Updates** from the account menu or sign-in screen.
During playback, open playback settings and choose **About / Updates**.
The version comes from Electron. Check for Updates and background checks share
one main-owned lifecycle. Checks start 1.5 seconds after loading and repeat every
six hours. An applicable update downloads automatically. Settings shows progress,
unknown sizes, actionable errors, and the retained downloaded version.

Ready notifications are passive in-app banners, suppressed during native playback
(including paused/buffering playback and episode countdowns), Jellyfin SyncPlay,
YouTube rooms, and Seeing Stone rooms. Settings remains usable during sessions.
Later hides the banner for this run, keeping the update available in Settings.
There are no OS notifications, automatic restarts, or installation on normal exit.
After an ordinary relaunch the startup check can revalidate and reuse the updater's
download cache; there is no unsafe persisted “ready” flag.

Restart & Update asks for native confirmation if a session is active, rechecks
session identity after confirmation, blocks new renderer commands, and awaits
the same resource cleanup used on normal exit before calling the installer.
Cancel leaves playback and the downloaded update intact.

Only per-user installed Windows 10/11 x64 NSIS releases are enabled. The installer
defaults to the current Windows account, avoiding an elevation helper. Explicit
`/allusers` installs remain manually upgradable and report updates unavailable.
The NSIS install hook
writes `resources/seeing-stone-install-type`; the app also requires the uninstaller
and `app-update.yml`. Development, `--dir`, portable, internal libmpv test builds,
macOS, Linux, and other architectures explicitly report updates unavailable.
Existing installers predating this feature need a one-time manual installation
of the first updater-capable version.

## Release requirements

- Increment `package.json` using SemVer; the release tag must be `v<version>`.
  Historical `Seeing.Stone.beta.*` tags are not used by the new updater.
- Stable versions use `latest` / `latest.yml` and exclude prereleases. Versions
  such as `0.7.5-beta.1` use the beta channel and GitHub prerelease selection.
  Alpha may advance to beta/stable; beta excludes alpha. Downgrades are disabled.
  Custom prerelease identifiers remain on their matching channel. Do not change
  the installed channel through renderer input.
- Publish the complete builder output for the version: `Seeing-Stone-Setup-<version>-x64.exe`,
  its `.exe.blockmap`, and generated channel YAML (`latest.yml`, `beta.yml`, etc.).
  Keep older blockmaps available for differential updates. SHA-256 sidecars are
  useful for users but do not replace the YAML's SHA-512 metadata.
- `app-update.yml` is generated inside the packaged resources. Do not manually
  construct feed metadata or embed release credentials. Builder's publisher
  configuration creates draft releases; drafts are invisible to update clients.
- Normal package commands use `--publish never`, even when CI credentials exist.
  This repository has no existing release CI workflow. On an authorized release
  runner, use a CI secret `GH_TOKEN` with repository Contents write access (or a
  scoped `GITHUB_TOKEN` for that repository). Only the publishing job receives it.
  Build with `pnpm package:windows`, finalize the native inventory and source
  bundle, then run `node scripts/prepare-release-assets.mjs`. Upload the verified
  assets together to a GitHub draft without rebuilding them. Review the draft
  and generated artifacts before making it public. Preserve all existing native
  provenance/corresponding-source release gates in `WINDOWS_PACKAGING.md`.
- Windows signing is not configured in this checkout. Supply `CSC_LINK` and
  `CSC_KEY_PASSWORD` as release-runner secrets, and a stable trusted publisher
  identity. Electron-builder generates publisher metadata for updater signature
  validation. Never disable signature verification to fix a signed-release failure.
  Unsigned local installers can test the mechanics, but do not establish signed
  production upgrade acceptance. No macOS signing/notarization pipeline exists;
  supporting it would require a signed/notarized macOS target and separate testing.
- If the release repository becomes private, anonymous updates will fail visibly.
  Use a public binary distribution repository or an authenticated update service
  with user-scoped credentials; never ship a GitHub publishing token.

At verification on October 15, 2026, the public `v0.7.3` release contained an
installer, corresponding-source archive, and SHA-256 sidecars, but no channel YAML
or blockmap. It cannot serve this updater until a properly packaged release is
published. Missing metadata is an error, never “up to date.”

## Local checks and real upgrade acceptance

Run `pnpm typecheck`, `pnpm test:unit`, `pnpm build`, and
`node scripts/update-runtime-acceptance.cjs`. The last command uses a hidden
Electron window, an isolated profile under `artifacts/update-acceptance`, the real
NSIS updater/HTTP downloader, and an inert test payload. It verifies discovery,
automatic download, checksum rejection, missing metadata, UI state retention,
Later, and restart cancellation. It never executes an installer or modifies a
real profile. Results and a screenshot are saved alongside the test profile.

To validate an actual GitHub-delivered installed upgrade:

1. In a disposable Windows x64 VM, build this code as `0.7.4-beta.1`, install its
   NSIS installer, and confirm Settings shows that installed version and beta.
2. Build the next version as `0.7.4-beta.2` with the same app ID, architecture,
   installer configuration, and signing identity. After release authorization,
   publish tag `v0.7.4-beta.2` as a GitHub prerelease with its installer, blockmap,
   and `beta.yml` (plus any other builder-generated channel metadata).
3. Run beta.1 and choose Check for Updates. Verify beta.2 downloads, shows actual
   progress, survives closing/reopening Settings, and remains ready after Later.
4. Repeat with playback and each room system active. Verify downloads never stop
   playback, the ready banner stays hidden, Cancel retains the session, and
   Restart & Update requires confirmation even if activity started after download.
5. Confirm Restart & Update and verify that
   the app restarts at beta.2 with the same profile, preferences, and media library.
   Verify the old process/player exits cleanly. Check normal exit does not install.
6. Repeat without network, with missing YAML, and with a deliberately corrupt
   test-release download; verify an actionable error and recovery on Retry.
   Test stable-to-stable separately and ensure a stable install ignores beta releases.

No local unit/downloader test constitutes this installed-upgrade acceptance.

### Verification completed October 15, 2026

- Type checks for main, preload, renderer, and companion: passed.
- Unit tests: 704 passed across 84 files; core tests: 52 passed.
- Existing sandboxed Electron acceptance: 28 passed.
- Real downloader and Electron update UI acceptance: all 10 scenarios passed.
- Persistence and media-probe runtime acceptance: passed.
- Full application build and Windows NSIS packaging: passed, publishing disabled.
- Package verification (resources, Electron fuses, media probe): passed.
- Generated `app-update.yml` points to the intended public GitHub repository with
  no token. `latest.yml` version, installer size, and SHA-512 checksum match the
  generated installer; the blockmap exists. The unpacked build correctly has no
  installation marker.
- No signed production upgrade, installer execution, or GitHub release publication
  was performed. The release requirements and installed-upgrade steps above remain.

The packaging run also exposed and corrected native staging's unnecessary owner
version change for an unchanged add-on binary, preserving its original provenance.
The existing Electron test now recognizes the new narrow bridge and records the
episode/series requests before asynchronous Back navigation adds another request.

Local verification logs are under `.runtime/update-*.log`; downloader/UI evidence
is under `artifacts/update-acceptance`.

For project work on D:, set `$env:TEMP` and `$env:TMP` to
`D:\docs\jellyfin player\.runtime\tmp` before running package/tests (create the
directory first). This keeps test fixtures and temporary build files off C:
without changing global Windows settings or the user's installed app profile.
During this work, 357 identified project test folders (14,317,914 bytes) were moved
from C: to `.runtime/migrated-temp-2026-10-15`. Its `migration.json` records each
source and destination. Shared caches and installed application data were retained.
