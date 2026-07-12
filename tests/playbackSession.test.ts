import { describe, expect, it, vi } from "vitest";
import type { MediaItem } from "../src/shared/contracts";
import { PlaybackSessionService } from "../src/main/services/playbackSession";

const item: MediaItem = {
  id: "movie-1",
  name: "Movie",
  type: "Movie",
  overview: "",
  productionYear: 2026,
  premiereYear: null,
  officialRating: "PG-13",
  communityRating: 8.1,
  runTimeTicks: 100000000,
  genres: [],
  primaryImageAspectRatio: null,
  imageTags: {},
  backdropImageTag: null,
  parentThumbItemId: null,
  parentThumbImageTag: null,
  seriesId: null,
  seriesName: null,
  seasonId: null,
  indexNumber: null,
  parentIndexNumber: null,
  userData: { played: false, playbackPositionTicks: 50000000, playedPercentage: 50 },
  hasTrailer: false,
  playable: true,
};

describe("PlaybackSessionService", () => {
  it("keeps the authenticated source main-only and resolves an opaque internal stream", async () => {
    const fetchStaticStream = vi.fn(async () => new Response("video", { headers: { "Content-Type": "video/mp4" } }));
    const fetchTranscodedStream = vi.fn();
    const service = new PlaybackSessionService({
      async getDetails() { return item; },
      async getMediaSourceCapabilities() {
        return { itemId: item.id, sources: [{ id: "source-1", container: "mp4", size: 5, supportsDirectPlay: true, supportsDirectStream: true, supportsTranscoding: true }] };
      },
      fetchStaticStream,
      fetchTranscodedStream,
    });
    const started = await service.start(item.id, "resume");
    expect(started.mediaUrl).toBe(`jellyfin-media://stream/${started.playbackId}`);
    expect(started.mediaSourceId).toBe("source-1");
    expect(JSON.stringify(started)).not.toContain("http");
    expect(started.resumePositionTicks).toBe(50000000);
    expect(started.durationTicks).toBe(100000000);
    expect((await service.handle(new Request(started.mediaUrl))).status).toBe(200);
    expect((await service.handle(new Request(started.mediaUrl))).headers.get("Accept-Ranges")).toBe("bytes");
    expect(fetchStaticStream).toHaveBeenCalledWith("movie-1", "source-1", undefined, expect.any(AbortSignal));
    expect(fetchTranscodedStream).not.toHaveBeenCalled();

    const firstSignal = fetchStaticStream.mock.calls[0]?.[3] as AbortSignal;
    service.stop(started.playbackId);
    expect(firstSignal.aborted).toBe(true);

    const replacement = await service.start("movie-2", "start-over");
    expect((await service.handle(new Request(started.mediaUrl))).status).toBe(404);
    expect((await service.handle(new Request(replacement.mediaUrl))).status).toBe(200);
  });

  it("does not release a media response that finishes after playback is stopped", async () => {
    let release: ((response: Response) => void) | undefined;
    const fetchStaticStream = vi.fn(() => new Promise<Response>((resolve) => { release = resolve; }));
    const service = new PlaybackSessionService({
      async getDetails() { return item; },
      async getMediaSourceCapabilities() {
        return { itemId: item.id, sources: [{ id: "source-1", container: "mp4", size: 5, supportsDirectPlay: true, supportsDirectStream: true, supportsTranscoding: true }] };
      },
      fetchStaticStream,
      fetchTranscodedStream: vi.fn(),
    });
    const started = await service.start(item.id, "resume");
    const pending = service.handle(new Request(started.mediaUrl));
    await vi.waitFor(() => expect(fetchStaticStream).toHaveBeenCalledOnce());
    service.stop(started.playbackId);
    release?.(new Response("video", { headers: { "Content-Type": "video/mp4" } }));
    expect((await pending).status).toBe(404);
  });

  it("direct-plays MKV through the main proxy for mpv without browser transcoding", async () => {
    const fetchStaticStream = vi.fn(async () => new Response("matroska-video", {
      headers: { "Content-Type": "video/x-matroska", "Accept-Ranges": "bytes" },
    }));
    const fetchTranscodedStream = vi.fn(async () => new Response("transcoded-video", {
      headers: { "Content-Type": "application/octet-stream", "Accept-Ranges": "bytes" },
    }));
    const service = new PlaybackSessionService({
      async getDetails() { return item; },
      async getMediaSourceCapabilities() {
        return { itemId: item.id, sources: [{ id: "mkv-source", container: "mkv", size: 5, supportsDirectPlay: true, supportsDirectStream: true, supportsTranscoding: true }] };
      },
      fetchStaticStream,
      fetchTranscodedStream,
    });

    const started = await service.start(item.id, "start-over");
    const response = await service.handle(new Request(started.mediaUrl, { headers: { Range: "bytes=100-200" } }));

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("video/x-matroska");
    expect(response.headers.get("Accept-Ranges")).toBe("bytes");
    expect(fetchStaticStream).toHaveBeenCalledWith("movie-1", "mkv-source", "bytes=100-200", expect.any(AbortSignal));
    expect(fetchTranscodedStream).not.toHaveBeenCalled();
    expect(started.mediaSourceId).toBe("mkv-source");
    expect(JSON.stringify(started)).not.toContain("http");
  });

  it("fails clearly when Jellyfin offers neither direct delivery nor transcoding", async () => {
    const service = new PlaybackSessionService({
      async getDetails() { return item; },
      async getMediaSourceCapabilities() {
        return { itemId: item.id, sources: [{ id: "unavailable-source", container: "bin", size: 5, supportsDirectPlay: false, supportsDirectStream: false, supportsTranscoding: false }] };
      },
      fetchStaticStream: vi.fn(),
      fetchTranscodedStream: vi.fn(),
    });
    await expect(service.start(item.id, "resume")).rejects.toMatchObject({ code: "TRANSCODING_UNAVAILABLE" });
  });

  it("transcodes a nominally compatible container when Jellyfin denies direct playback", async () => {
    const fetchTranscodedStream = vi.fn(async () => new Response("video", { headers: { "Content-Type": "video/mp4" } }));
    const service = new PlaybackSessionService({
      async getDetails() { return item; },
      async getMediaSourceCapabilities() {
        return { itemId: item.id, sources: [{ id: "mp4-transcode", container: "mp4", size: 5, supportsDirectPlay: false, supportsDirectStream: false, supportsTranscoding: true }] };
      },
      fetchStaticStream: vi.fn(),
      fetchTranscodedStream,
    });
    const started = await service.start(item.id, "start-over");
    await service.handle(new Request(started.mediaUrl));
    expect(fetchTranscodedStream).toHaveBeenCalledWith("movie-1", "mp4-transcode", started.playbackId, expect.any(AbortSignal));
  });
});
