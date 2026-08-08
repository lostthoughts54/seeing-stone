import { describe, expect, it, vi } from "vitest";
import { TrickplayService } from "../src/main/services/trickplay";
import type { PlaybackState } from "../src/shared/contracts";

const playbackId = "11111111-1111-4111-8111-111111111111";
const manifestMetadata = (sourceId = "source-a") => ({
  [sourceId]: {
    320: { Width: 320, Height: 180, Interval: 10_000, ThumbnailCount: 12, TileWidth: 3, TileHeight: 2 },
    160: { Width: 160, Height: 90, Interval: 10_000, ThumbnailCount: 12, TileWidth: 3, TileHeight: 2 },
  },
});

const activeState = (overrides: Partial<PlaybackState> = {}): PlaybackState => ({
  playbackId, itemId: "movie", phase: "playing", source: "server", positionTicks: 0, durationTicks: 1_200_000_000,
  paused: false, buffering: false, seekable: true, seekableUntilTicks: null, volume: 100, fullscreen: false,
  audioTracks: [], subtitleTracks: [], error: null, contentKind: "on-demand", ...overrides,
});

function harness(metadata: unknown = manifestMetadata()) {
  const api = {
    getTrickplayMetadata: vi.fn(async () => metadata),
    fetchTrickplayTile: vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { headers: { "Content-Type": "image/jpeg; charset=binary" } })),
  };
  let context = { itemId: "movie", mediaSourceId: "source-a", contentKind: "on-demand" as const };
  const service = new TrickplayService(api, () => context);
  service.setPlaybackState(activeState());
  return { service, api, setContext: (value: typeof context) => { context = value; } };
}

describe("TrickplayService", () => {
  it("normalizes only the active media source and selects the preferred width", async () => {
    const h = harness({ ...manifestMetadata("other"), ...manifestMetadata("source-a") });
    const manifest = await h.service.getManifest(playbackId);
    expect(manifest).toMatchObject({ playbackId, itemId: "movie", frameWidth: 320, frameHeight: 180, intervalTicks: 100_000_000, columns: 3, rows: 2, frameCount: 12, spriteCount: 2 });
    expect(JSON.stringify(manifest)).not.toContain("source-a");
  });

  it("rejects malformed metadata and mismatched active sources", async () => {
    const malformed = { "source-a": { 320: { Width: 320, Height: 180, Interval: 0, ThumbnailCount: 12, TileWidth: 3, TileHeight: 2 } } };
    await expect(harness(malformed).service.getManifest(playbackId)).resolves.toBeNull();
    const h = harness();
    h.setContext({ itemId: "movie", mediaSourceId: "other", contentKind: "on-demand" });
    await expect(h.service.getManifest(playbackId)).resolves.toBeNull();
  });

  it("serves opaque JPEG capabilities, coalesces cache loads, and revokes on replacement", async () => {
    const h = harness();
    const manifest = await h.service.getManifest(playbackId);
    if (!manifest) throw new Error("Expected manifest");
    const url = h.service.getSpriteUrl(playbackId, manifest.manifestId, 0);
    expect(url).toMatch(/^jellyfin-trickplay:\/\/asset\/[0-9a-f-]{36}$/);
    expect(url).not.toContain("movie");
    const [first, second] = await Promise.all([h.service.handle(new Request(url)), h.service.handle(new Request(url))]);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.headers.get("cache-control")).toBe("no-store");
    expect(first.headers.get("x-content-type-options")).toBe("nosniff");
    expect(h.api.fetchTrickplayTile).toHaveBeenCalledTimes(1);
    h.service.setPlaybackState(activeState({ playbackId: "22222222-2222-4222-8222-222222222222", itemId: "next" }));
    expect((await h.service.handle(new Request(url))).status).toBe(404);
  });

  it("rejects invalid indexes, MIME, and oversized image declarations", async () => {
    const h = harness();
    const manifest = await h.service.getManifest(playbackId);
    if (!manifest) throw new Error("Expected manifest");
    expect(() => h.service.getSpriteUrl(playbackId, manifest.manifestId, manifest.spriteCount)).toThrow();
    h.api.fetchTrickplayTile.mockResolvedValueOnce(new Response("{}", { headers: { "Content-Type": "application/json" } }));
    const invalidMime = h.service.getSpriteUrl(playbackId, manifest.manifestId, 0);
    await expect(h.service.handle(new Request(invalidMime))).rejects.toMatchObject({ code: "INVALID_TRICKPLAY" });
    h.api.fetchTrickplayTile.mockResolvedValueOnce(new Response("x", { headers: { "Content-Type": "image/jpeg", "Content-Length": String(9 * 1024 * 1024) } }));
    const oversized = h.service.getSpriteUrl(playbackId, manifest.manifestId, 1);
    await expect(h.service.handle(new Request(oversized))).rejects.toMatchObject({ code: "TRICKPLAY_TOO_LARGE" });
  });
});
