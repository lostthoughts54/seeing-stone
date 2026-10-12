import { describe, expect, it, vi } from "vitest";
import { SharedTextureSlotLifecycle } from "../src/main/services/libMpvSharedTextureLifecycle";

describe("SharedTextureSlotLifecycle", () => {
  it("retains a native slot until Electron releases all managed references and GPU work", () => {
    const releaseNative = vi.fn(() => true);
    const lifecycle = new SharedTextureSlotLifecycle();
    lifecycle.claim({ slot: 1, sequence: 10, surfaceGeneration: 1, releaseNative });

    expect(releaseNative).not.toHaveBeenCalled();
    lifecycle.markAllReferencesReleased(10);
    expect(releaseNative).toHaveBeenCalledOnce();
    expect(lifecycle.pendingCount).toBe(0);
  });

  it("rejects duplicate release callbacks without freeing the native slot twice", () => {
    const releaseNative = vi.fn(() => true);
    const lifecycle = new SharedTextureSlotLifecycle();
    lifecycle.claim({ slot: 2, sequence: 20, surfaceGeneration: 1, releaseNative });

    lifecycle.markAllReferencesReleased(20);
    expect(() => lifecycle.markAllReferencesReleased(20)).toThrow("LIBMPV_TEXTURE_RELEASE_SIGNAL_WITHOUT_SLOT:20");
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
    expect(() => lifecycle.markAllReferencesReleased(1))
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
