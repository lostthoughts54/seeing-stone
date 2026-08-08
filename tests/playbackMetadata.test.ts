import { describe, expect, it, vi } from "vitest";
import { PlaybackMetadataService } from "../src/main/services/playbackMetadata";
import type { PlaybackState } from "../src/shared/contracts";

const active = (overrides: Partial<PlaybackState> = {}): PlaybackState => ({
  playbackId: "11111111-1111-4111-8111-111111111111", itemId: "movie", phase: "playing", source: "server",
  positionTicks: 0, durationTicks: 1000, paused: false, buffering: false, seekable: true, seekableUntilTicks: null,
  volume: 100, fullscreen: false, audioTracks: [], subtitleTracks: [], error: null, contentKind: "on-demand", ...overrides,
});

describe("PlaybackMetadataService", () => {
  it("returns only metadata for the current active playback", async () => {
    const api = { getMediaSegments: vi.fn(async () => [{ type: "Intro" as const, startTicks: 0, endTicks: 10 }]) };
    const service = new PlaybackMetadataService(api);
    service.setPlaybackState(active());
    await expect(service.getMediaSegments(active().playbackId!)).resolves.toEqual({
      playbackId: active().playbackId, itemId: "movie", segments: [{ type: "Intro", startTicks: 0, endTicks: 10 }],
    });
    await expect(service.getMediaSegments("22222222-2222-4222-8222-222222222222")).rejects.toMatchObject({ code: "INVALID_PLAYBACK" });
  });

  it("invalidates pending metadata on item replacement, stop, and Live TV", async () => {
    let resolve!: (segments: []) => void;
    const api = { getMediaSegments: vi.fn(() => new Promise<[]>(r => { resolve = r; })) };
    const service = new PlaybackMetadataService(api);
    service.setPlaybackState(active());
    const pending = service.getMediaSegments(active().playbackId!);
    service.setPlaybackState(active({ playbackId: "33333333-3333-4333-8333-333333333333", itemId: "next" }));
    resolve([]);
    await expect(pending).rejects.toMatchObject({ code: "INVALID_PLAYBACK" });
    service.setPlaybackState(active({ playbackId: null, itemId: null, phase: "stopped" }));
    await expect(service.getMediaSegments("33333333-3333-4333-8333-333333333333")).rejects.toMatchObject({ code: "INVALID_PLAYBACK" });
    service.setPlaybackState(active({ contentKind: "live-tv" }));
    await expect(service.getMediaSegments(active().playbackId!)).rejects.toMatchObject({ code: "INVALID_PLAYBACK" });
  });
});
