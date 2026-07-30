# Seeing Stone libmpv native bridge

This directory contains the Windows x64 C++ Node-API bridge selected by the
staged libmpv migration. It contains the proven synthetic D3D11 shared-texture
producer plus a main-process-only libmpv lifecycle probe. The probe securely
loads the absolute manifest-controlled DLL, verifies the client ABI and required
render symbols, and repeatedly creates, initializes, terminates, and destroys
libmpv instances. ANGLE/libmpv rendering remains a later gate.

Run `pnpm run check:libmpv-toolchain` first. A passing result is a prerequisite,
not approval of the rendering gate. The first native implementation must:

- use RAII for COM, D3D11 textures and handles, completion queries or fences,
  Node-API callbacks, worker threads, EGL, and mpv objects;
- allocate a fixed-size pool of `DXGI_FORMAT_B8G8R8A8_UNORM` textures with
  `D3D11_RESOURCE_MISC_SHARED_NTHANDLE`;
- complete producer GPU work with a bounded wait before importing a texture;
- keep every texture and NT handle alive until Electron invokes
  `allReferencesReleased`;
- quarantine, rather than destroy, resources whose release acknowledgement
  times out; and
- expose handles only to the main-process host, never through public IPC or the
  preload bridge.

Do not add ANGLE or libmpv code here until the advancing synthetic pattern has
passed the documented rendering acceptance gate.
