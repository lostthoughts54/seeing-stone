import { describe, expect, it, vi } from "vitest";
import { SharedTextureSlotLifecycle } from "../src/main/services/libMpvSharedTextureLifecycle";

describe("SharedTextureSlotLifecycle", () => {
  it("waits for the precise renderer GPU completion before reusing a native slot", () => {
    const releaseNative = vi.fn(() => true);
    const lifecycle = new SharedTextureSlotLifecycle();
    lifecycle.claim({ slot: 1, sequence: 10, surfaceGeneration: 1, releaseNative });

    lifecycle.markAllReferencesReleased(10);
    expect(releaseNative).not.toHaveBeenCalled();

    lifecycle.markRendererGpuReleaseComplete(10);
    expect(releaseNative).toHaveBeenCalledOnce();
    expect(lifecycle.pendingCount).toBe(0);
  });

  it("does not wait for the coarse global reference callback after GPU completion", () => {
    const releaseNative = vi.fn(() => true);
    const lifecycle = new SharedTextureSlotLifecycle();
    lifecycle.claim({ slot: 2, sequence: 20, surfaceGeneration: 1, releaseNative });

    lifecycle.markRendererGpuReleaseComplete(20);
    expect(releaseNative).toHaveBeenCalledOnce();
    expect(lifecycle.pendingCount).toBe(0);
  });

  it("fails loudly when a native slot is offered before definitive release", () => {
    const lifecycle = new SharedTextureSlotLifecycle();
    lifecycle.claim({ slot: 0, sequence: 1, surfaceGeneration: 1, releaseNative: () => true });
    expect(() => lifecycle.claim({ slot: 0, sequence: 2, surfaceGeneration: 1, releaseNative: () => true }))
      .toThrow("LIBMPV_TEXTURE_SLOT_REUSED_BEFORE_GPU_RELEASE:0:1:2");
  });

  it("fails loudly when native release rejects a supposedly completed slot", () => {
    const lifecycle = new SharedTextureSlotLifecycle();
    lifecycle.claim({ slot: 0, sequence: 1, surfaceGeneration: 1, releaseNative: () => false });
    lifecycle.markAllReferencesReleased(1);
    expect(() => lifecycle.markRendererGpuReleaseComplete(1))
      .toThrow("LIBMPV_NATIVE_TEXTURE_SLOT_RELEASE_REJECTED:0:1");
  });

  it("can immediately release a slot when Electron import never happened", () => {
    const releaseNative = vi.fn(() => true);
    const lifecycle = new SharedTextureSlotLifecycle();
    lifecycle.claim({ slot: 0, sequence: 3, surfaceGeneration: 1, releaseNative });
    lifecycle.abandonUnimported(3);
    expect(releaseNative).toHaveBeenCalledOnce();
    expect(lifecycle.pendingCount).toBe(0);
  });
});
