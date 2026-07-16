import { describe, expect, it } from "vitest";
import {
  downloadIdSchema,
  downloadStartSchema,
  loginSchema,
  playbackRateSchema,
  playbackStartSchema,
  playbackVolumeSchema,
  searchSchema,
  watchedStateSchema,
} from "../src/shared/schemas";

describe("IPC input schemas", () => {
  it("rejects extra privileged-looking properties", () => {
    expect(() => loginSchema.strict().parse({
      connectionId: "11111111-1111-4111-8111-111111111111",
      username: "viewer",
      password: "secret",
      remember: true,
      headers: { Authorization: "token" },
    })).toThrow();
    expect(() => loginSchema.strict().parse({
      connectionId: "11111111-1111-4111-8111-111111111111",
      serverUrl: "http://127.0.0.1:8096",
      username: "viewer",
      password: "secret",
      remember: true,
    })).toThrow();
    expect(() => searchSchema.strict().parse({ query: "movie", path: "D:\\Sensitive" })).toThrow();
    expect(() => playbackStartSchema.strict().parse({ itemId: "item", resumeMode: "resume", args: ["--script"] })).toThrow();
    const playbackId = "55555555-5555-4555-8555-555555555555";
    expect(playbackRateSchema.strict().parse({ playbackId, rate: 1.5 })).toEqual({ playbackId, rate: 1.5 });
    expect(() => playbackRateSchema.strict().parse({ playbackId, rate: 4.01 })).toThrow();
    expect(playbackVolumeSchema.strict().parse({ playbackId, volume: 42 })).toEqual({ playbackId, volume: 42 });
    expect(() => playbackVolumeSchema.strict().parse({ playbackId, volume: -1 })).toThrow();
    expect(() => downloadStartSchema.strict().parse({ itemId: "item", url: "http://server/media", path: "D:\\Sensitive" })).toThrow();
    expect(() => watchedStateSchema.strict().parse({ itemId: "item", watched: true, positionTicks: 50 })).toThrow();
    expect(() => downloadIdSchema.strict().parse({ downloadId: "not-an-opaque-id" })).toThrow();
  });
});
