import { describe, expect, it } from "vitest";
import { requestedPlayerAdapterMode } from "../src/main/services/playerAdapterSelection";

describe("player adapter selection", () => {
  it("keeps legacy as the packaged-safe default when no mode was explicitly stored", () => {
    expect(requestedPlayerAdapterMode(undefined, undefined)).toBe("legacy");
  });

  it("honors an explicit stored embedded adapter choice", () => {
    expect(requestedPlayerAdapterMode(undefined, "embedded")).toBe("embedded");
  });

  it("lets the environment override choose either engine", () => {
    expect(requestedPlayerAdapterMode("embedded", "legacy")).toBe("embedded");
    expect(requestedPlayerAdapterMode("legacy", "embedded")).toBe("legacy");
  });

  it("ignores unknown environment values", () => {
    expect(requestedPlayerAdapterMode("external", "embedded")).toBe("embedded");
    expect(requestedPlayerAdapterMode("external", undefined)).toBe("legacy");
  });
});
