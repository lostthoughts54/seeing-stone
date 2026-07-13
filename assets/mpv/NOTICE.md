# Bundled mpv runtime

The Windows playback runtime is mpv `v0.41.0-dev-ge5486b96d`, built from
commit `e5486b96d7d06dd148337899bfdc46bf25101663` by the mpv project's
first-party GitHub Actions release workflow. The checked archive checksum and
the checksums of every notice copied into this package are recorded in
`mpv-runtime.json`.

- Project: https://mpv.io/
- Source: https://github.com/mpv-player/mpv/tree/e5486b96d7d06dd148337899bfdc46bf25101663
- Build archive and checksum: `mpv-runtime.json` in this repository
- License information: `licenses/`

The runtime reports `-Dgpl=true` and `-Dffmpeg:gpl=enabled`. The notice bundle
therefore includes the exact mpv copyright and GPL/LGPL texts from the pinned
commit, the exact FFmpeg licensing files from its embedded revision, and the
identified Vulkan Loader and AMD AMF license texts.

## Redistribution status

The upstream binary archive contains no license files or corresponding source
archive. Its build recipe also fetched several statically linked dependencies
from moving branches instead of recording every source revision. The files in
this directory are a verified pragmatic notice set, but they are not a
complete independently audited dependency bill of materials or corresponding
source bundle.

The unsigned installer produced by this repository is suitable for internal
Milestone 8 acceptance. Do not publish or redistribute it until the runtime is
rebuilt from fully pinned sources and the complete applicable notices and GPL
corresponding source are prepared.
