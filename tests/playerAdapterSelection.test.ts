import { describe, expect, it } from "vitest";
import { requestedPlayerAdapterMode, resolvePlayerAdapterLaunch } from "../src/main/services/playerAdapterSelection";

describe("player adapter selection", () => {
  it("keeps legacy as the packaged-safe default when no mode was explicitly stored", () => {
    expect(requestedPlayerAdapterMode(undefined, undefined)).toBe("legacy");
  });

  it("forces libmpv for packaged production regardless of stale preferences or environment", () => {
    expect(requestedPlayerAdapterMode(undefined, undefined, true)).toBe("libmpv");
    expect(requestedPlayerAdapterMode(undefined, "legacy", true)).toBe("libmpv");
    expect(requestedPlayerAdapterMode(undefined, "embedded", true)).toBe("libmpv");
    expect(requestedPlayerAdapterMode("legacy", "legacy", true)).toBe("libmpv");
  });

  it("honors an explicit stored embedded adapter choice", () => {
    expect(requestedPlayerAdapterMode(undefined, "embedded")).toBe("embedded");
  });

  it("lets the environment override choose either engine", () => {
    expect(requestedPlayerAdapterMode("embedded", "legacy")).toBe("embedded");
    expect(requestedPlayerAdapterMode("legacy", "embedded")).toBe("legacy");
    expect(requestedPlayerAdapterMode("libmpv", "embedded")).toBe("libmpv");
  });

  it("ignores unknown environment values", () => {
    expect(requestedPlayerAdapterMode("external", "embedded")).toBe("embedded");
    expect(requestedPlayerAdapterMode("external", undefined)).toBe("legacy");
  });

  it("keeps a libmpv request while selecting embedded as the unavailable fallback", () => {
    expect(resolvePlayerAdapterLaunch("libmpv", {
      available: false,
      reason: "library-not-configured",
      clientApiVersion: null,
      renderApi: null,
    })).toEqual({
      launchSelection: "libmpv",
      active: "embedded",
      embeddedAvailable: true,
      libmpvAvailable: false,
      fallbackActive: true,
      fallbackFrom: "libmpv",
      fallbackReason: "library-not-configured",
    });
  });

  it("activates libmpv only after the capability gate passes", () => {
    expect(resolvePlayerAdapterLaunch("libmpv", {
      available: true,
      reason: null,
      clientApiVersion: "2.3",
      renderApi: "opengl-angle",
    })).toMatchObject({ active: "libmpv", fallbackActive: false, libmpvAvailable: true });
  });

  it("keeps production on libmpv and reports a safe unavailable state without fallback", () => {
    expect(resolvePlayerAdapterLaunch("libmpv", {
      available: false,
      reason: "library-missing",
      clientApiVersion: null,
      renderApi: null,
    }, false)).toEqual({
      launchSelection: "libmpv",
      active: "libmpv",
      embeddedAvailable: false,
      libmpvAvailable: false,
      fallbackActive: false,
      fallbackFrom: null,
      fallbackReason: "library-missing",
    });
  });
});
