import { describe, expect, it } from "vitest";
import { iptvSetupSchema, iptvCatalogueSchema, iptvGuideSearchSchema, iptvGuideWindowSchema, iptvPlaybackSchema, iptvChannelPreferencesSchema } from "../src/shared/iptv";

const providerId = "11111111-1111-4111-8111-111111111111";
describe("independent IPTV request boundary", () => {
  it("accepts both provider kinds without a Jellyfin identity and preserves password whitespace", () => {
    expect(iptvSetupSchema.parse({ kind: "xtream", name: "Trex", address: "https://example.test/base", username: "viewer", password: " secret " }).kind).toBe("xtream");
    expect(iptvSetupSchema.parse({ kind: "m3u", name: "Live", playlistUrl: "https://example.test/list?token=secret" }).kind).toBe("m3u");
    expect(iptvSetupSchema.parse({ kind: "xtream", name: "Test", address: "http://localhost:8900", username: "viewer", password: " secret " })).toHaveProperty("password", " secret ");
  });
  it.each(["not a URL", "file:///C:/secrets", "ftp://example.test/list", "https://user:secret@example.test/list", "https://example.test/list#token"])("rejects unsupported setup address %s", (playlistUrl) => {
    expect(iptvSetupSchema.safeParse({ kind: "m3u", name: "Live", playlistUrl }).success).toBe(false);
  });
  it("rejects extra privileged inputs and credentials outside the setup boundary", () => {
    expect(iptvSetupSchema.safeParse({ kind: "m3u", name: "Live", playlistUrl: "https://example.test/list", headers: { Authorization: "secret" } }).success).toBe(false);
    expect(iptvGuideSearchSchema.safeParse({ providerId, query: "film", resultType: "programmes", url: "https://example.test/stream" }).success).toBe(false);
    expect(iptvPlaybackSchema.safeParse({ identity: { providerId, contentType: "movie", itemId: "1", serverId: "jellyfin" }, resumeMode: "resume" }).success).toBe(false);
  });
  it("defaults to all non-hidden channels with bounded independent search pages", () => {
    expect(iptvGuideSearchSchema.parse({ providerId, query: "日本語", resultType: "channels" })).toEqual({ providerId, query: "日本語", resultType: "channels", limit: 50, favouritesOnly: false, includeHidden: false });
    for (const limit of [50, 100, 150, 200]) expect(iptvCatalogueSchema.parse({ providerId, contentType: "series", limit }).limit).toBe(limit);
    expect(iptvCatalogueSchema.safeParse({ providerId, contentType: "series", limit: 201 }).success).toBe(false);
    expect(iptvGuideSearchSchema.safeParse({ providerId, query: "x", resultType: "programmes", limit: 0 }).success).toBe(false);
  });
  it("requires a playable content identity and never accepts a raw playback URL", () => {
    const identity = { providerId, contentType: "live", itemId: "same-id" };
    expect(iptvPlaybackSchema.parse({ identity, resumeMode: "start-over" }).identity).toEqual(identity);
    expect(iptvPlaybackSchema.safeParse({ identity: { ...identity, contentType: "series" }, resumeMode: "resume" }).success).toBe(false);
    expect(iptvPlaybackSchema.safeParse({ identity, resumeMode: "resume", streamUrl: "https://example.test/live" }).success).toBe(false);
  });
  it("bounds visible channels and validates elapsed time across timezone offsets", () => {
    const request = { providerId, channelIds: ["1"], startUtc: "2026-11-01T01:30:00-07:00", endUtc: "2026-11-01T01:30:00-08:00" };
    expect(iptvGuideWindowSchema.safeParse(request).success).toBe(true);
    expect(iptvGuideWindowSchema.safeParse({ ...request, endUtc: request.startUtc }).success).toBe(false);
    expect(iptvGuideWindowSchema.safeParse({ ...request, channelIds: Array(51).fill("1") }).success).toBe(false);
    expect(iptvGuideWindowSchema.safeParse({ ...request, endUtc: "2026-11-03T01:30:00-08:00" }).success).toBe(false);
  });
  it("supports resetting a manual mapping without a full guide or Jellyfin session", () => {
    expect(iptvChannelPreferencesSchema.parse({ providerId, channelId: "1", xmltvChannelId: null }).xmltvChannelId).toBeNull();
    expect(iptvChannelPreferencesSchema.safeParse({ providerId, channelId: "1" }).success).toBe(false);
  });
});
