# Seeing Stone 0.7.4 release handoff

## For Kayla

Close Seeing Stone and run `Seeing-Stone-Setup-0.7.4-x64.exe` once under your
normal Windows account. Use the default installation choice. Your existing
profile and preferences are retained. Open **Settings > About / Updates** and
confirm version **0.7.4**.

Future versions download automatically when available. Choose **Restart & Update**
when convenient, or **Later** to keep watching. During playback or a room session,
the app asks before restarting. It does not install when you simply close it.

An older all-users installation should be migrated to the normal per-user install;
the `/allusers` option does not support automatic updates in this release.

## Upload instructions

The prepared folder is `artifacts/release-0.7.4`. Upload these six assets together
to a GitHub release in `lostthoughts54/seeing-stone`, tagged **v0.7.4**:

- `Seeing-Stone-Setup-0.7.4-x64.exe`
- `Seeing-Stone-Setup-0.7.4-x64.exe.sha256.txt`
- `Seeing-Stone-Setup-0.7.4-x64.exe.blockmap`
- `latest.yml`
- `Seeing-Stone-0.7.4-corresponding-source.zip`
- `Seeing-Stone-0.7.4-corresponding-source.zip.sha256.txt`

Commit and push the release source changes before creating the tag. Initially save
the release as a draft, check every attachment, and complete the repository's
clean-machine acceptance (or obtain an explicit release-specific waiver) before
publishing. Publish as a normal stable release, not a prerelease; drafts are
invisible to the updater. Keep filenames unchanged. Do not upload `win-unpacked`.
The source ZIP includes the actual current source, not just the preceding Git commit.

This installer is unsigned. Windows may show an unknown-publisher/SmartScreen
prompt. Signed-release acceptance is not claimed. No GitHub publication or actual
installed upgrade has been performed by the local downloader tests.

## Release notes to paste

Seeing Stone now checks for updates and downloads them in the background.
Use Settings > About / Updates to check manually or restart into a downloaded
update. Playback and room sessions are protected by a confirmation before restart.

Existing users: install this version manually once to enable future updates.

Seeing Stone is GPL-2.0-or-later. Complete application source, native corresponding
source, build materials, and notices are in the attached corresponding-source ZIP.

## Verification and release gate

The updater previously passed 704 unit tests, 52 core tests, 28 Electron runtime
checks, and ten real downloader/UI scenarios. The 0.7.4 package and redistribution
checks are recorded under `.runtime/release-074-*.log`.

`pnpm validate:libmpv-release` separately requires clean-machine
install/playback/uninstall evidence tied to this exact installer and source ZIP.
The historical 0.7.1 waiver does not cover 0.7.4. The local machine already has an
installed player, so package acceptance preserves it and tests the unpacked release
with an isolated profile. This does not substitute for the clean-machine gate.

For later versions: bump the version and legal metadata, build, regenerate the
native inventory, copy the finalized inventory to packaged legal resources, rebuild
NSIS from that prepackaged directory, build corresponding source, run validators,
and run `node scripts/prepare-release-assets.mjs`. Never publish a rebuilt installer
with metadata or checksums from an earlier build.
