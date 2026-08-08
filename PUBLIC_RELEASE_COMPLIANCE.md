# Public Windows release compliance

This is an engineering checklist for the current Windows x64 beta, not legal advice and not a substitute for the stricter internal release gate.

## Build and verify the public assets

1. Start from the release commit/tag with the controlled runtime already built under `.runtime/libmpv-build`.
2. Run `pnpm run package:windows`.
3. Run `pnpm run generate:redistribution-inventory` to record the exact native files in the resulting `win-unpacked` package.
4. Run `pnpm run licenses:write` if that inventory or legal metadata changed.
5. Run `pnpm run source:corresponding -- --download`. Downloads are pinned by SHA-256 in `redistribution-compliance.json`; later runs can use the local cache without `--download`.
6. Run `pnpm run validate:redistribution-compliance` and the other release-relevant tests.
7. Compute the installer SHA-256 and publish these assets together:

   - `Seeing-Stone-Setup-<version>-x64.exe`
   - `Seeing-Stone-Setup-<version>-x64.exe.sha256.txt`
   - `Seeing-Stone-<version>-corresponding-source.zip`
   - `Seeing-Stone-<version>-corresponding-source.zip.sha256.txt`

The repository release tag/source archive supplies the complete Seeing Stone application source. The separate corresponding-source archive supplies pinned upstream/MSYS2 source archives, Electron FFmpeg source and patch metadata, native bridge source, build scripts/configuration, the binary-to-source manifest, and notices. Do not put the large corresponding-source archive inside the installer.

The production installer must contain `resources/libmpv`, must not contain the historical `resources/mpv`, and must expose notices under `resources/legal`. Electron's `LICENSE.electron.txt` and `LICENSES.chromium.html` remain alongside the application executable as supplied by Electron.

## Suggested release-note wording

> Seeing Stone is distributed under GPL-2.0-or-later. Source for Seeing Stone is available from this release tag/source archive. Corresponding source and required notices for bundled native components are provided in the attached corresponding-source archive. SHA-256 files are provided for the Windows installer and corresponding-source archive.

Do not describe this work as legally certified, legally approved, or lawyer-reviewed. The narrow validator intentionally does not check code signing, SmartScreen reputation, clean-machine acceptance, playback acceptance, reproducible builds, signed commits/tags, or the full internal `validate:libmpv-release` policy.
