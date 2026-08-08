# Controlled mpv/libmpv runtime

Seeing Stone's production Windows package uses a controlled source build of mpv
0.41.0 and FFmpeg 8.1.2. The source archives, hashes, revisions, toolchain,
configuration, build inventory, and packaged hashes are recorded in:

- `native/libmpv-runtime/source-lock.json`
- `native/libmpv-runtime/build-result.json`
- `libmpv-runtime.json`

Libmpv and the Seeing Stone native bridge are the production playback engine.
The `mpv.exe` produced by that same build is packaged only as a headless media
probe for downloaded/local-file validation. It is not a playback fallback.

License texts are provided in `licenses/`. The historical prebuilt mpv runtime
is separately recorded by `legacy-mpv-runtime.json` for explicit development
and regression adapters and is excluded from the production package.

## Redistribution status

Retiring the old prebuilt runtime removes a known provenance blocker, but it
does not by itself approve public binary redistribution. Complete companion
dependency provenance, corresponding-source archives, final notices,
clean-machine/manual acceptance, signing, and every requirement enforced by
`pnpm run validate:libmpv-release` remain outstanding.
