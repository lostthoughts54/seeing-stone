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
  it("keeps verified local video first while adding best-effort Jellyfin external subtitles", async () => {
    const api = {
      getDetails: vi.fn(),
      getMediaSourceCapabilities: vi.fn(async () => ({
        itemId: "movie-1",
        sources: [{
          id: "source-1",
          container: "mkv",
          size: 5,
          supportsDirectPlay: true,
          supportsDirectStream: true,
          supportsTranscoding: true,
          externalSubtitles: [{ streamIndex: 4, format: "srt" as const, title: "English", language: "eng", isDefault: false, isForced: false }],
        }],
      })),
      fetchStaticStream: vi.fn(),
      fetchTranscodedStream: vi.fn(),
      fetchExternalSubtitle: vi.fn(),
    };
    const local = {
      resolve: vi.fn(async () => ({
        playbackId: "11111111-1111-4111-8111-111111111111",
        itemId: "movie-1",
        itemType: "Movie" as const,
        seriesId: null,
        mediaSourceId: "source-1",
        mediaUrl: "D:\\Authorized Downloads\\movie-1\\media.mkv",
        resumePositionTicks: 50000000,
        durationTicks: 100000000,
        source: "local" as const,
        delivery: "local" as const,
        externalSubtitles: [],
        initialAction: "progress" as const,
      })),
    };
    const service = new PlaybackSessionService(api, local);
    const started = await service.start("movie-1", "resume");
    expect(started.source).toBe("local");
    expect(started.delivery).toBe("local");
    expect(started.externalSubtitles).toEqual([expect.objectContaining({ streamIndex: 4, title: "English" })]);
    expect(started.initialAction).toBe("progress");
    expect(local.resolve).toHaveBeenCalledWith("movie-1", "resume");
    expect(api.getDetails).not.toHaveBeenCalled();
    expect(api.getMediaSourceCapabilities).toHaveBeenCalledWith("movie-1", expect.any(AbortSignal));
    expect((await service.handle(new Request("jellyfin-media://stream/11111111-1111-4111-8111-111111111111"))).status).toBe(404);
  });

  it("falls back to the existing Jellyfin resolver when no valid local copy is available", async () => {
    const local = { resolve: vi.fn(async () => null) };
    const getDetails = vi.fn(async () => item);
    const getMediaSourceCapabilities = vi.fn(async () => ({
      itemId: item.id,
      sources: [{ id: "source-1", container: "mp4", size: 5, supportsDirectPlay: true, supportsDirectStream: true, supportsTranscoding: true }],
    }));
    const service = new PlaybackSessionService({
      getDetails,
      getMediaSourceCapabilities,
      fetchStaticStream: vi.fn(),
      fetchTranscodedStream: vi.fn(),
    }, local);
    const started = await service.start(item.id, "resume");
    expect(started.source).toBe("server");
    expect(started.initialAction).toBe("progress");
    expect(getDetails).toHaveBeenCalledOnce();
    expect(getMediaSourceCapabilities).toHaveBeenCalledOnce();
  });

  it("keeps the authenticated source main-only and resolves an opaque internal stream", async () => {
    const fetchStaticStream = vi.fn(async () => new Response("video", { headers: { "Content-Type": "video/mp4" } }));
    const fetchTranscodedStream = vi.fn();
    const fetchExternalSubtitle = vi.fn(async () => new Response("subtitle", { headers: { "Content-Type": "application/x-subrip" } }));
    const subtitle = { streamIndex: 4, format: "srt" as const, title: "English", language: "eng", isDefault: false, isForced: false };
    const service = new PlaybackSessionService({
      async getDetails() { return item; },
      async getMediaSourceCapabilities() {
        return { itemId: item.id, sources: [{ id: "source-1", container: "mp4", size: 5, supportsDirectPlay: true, supportsDirectStream: true, supportsTranscoding: true, externalSubtitles: [subtitle] }] };
      },
      fetchStaticStream,
      fetchTranscodedStream,
      fetchExternalSubtitle,
    });
    const started = await service.start(item.id, "resume");
    expect(started.mediaUrl).toBe(`jellyfin-media://stream/${started.playbackId}`);
    expect(started.mediaSourceId).toBe("source-1");
    expect(started.itemType).toBe("Movie");
    expect(started.seriesId).toBeNull();
    expect(JSON.stringify(started)).not.toContain("http");
    expect(started.resumePositionTicks).toBe(50000000);
    expect(started.durationTicks).toBe(100000000);
    expect((await service.handle(new Request(started.mediaUrl))).status).toBe(200);
    expect((await service.handle(new Request(started.mediaUrl))).headers.get("Accept-Ranges")).toBe("bytes");
    expect(fetchStaticStream).toHaveBeenCalledWith("movie-1", "source-1", undefined, expect.any(AbortSignal));
    expect(fetchTranscodedStream).not.toHaveBeenCalled();
    expect(started.externalSubtitles).toEqual([subtitle]);
    const subtitleResponse = await service.fetchExternalSubtitle(started.playbackId, subtitle);
    expect(await subtitleResponse.text()).toBe("subtitle");
    expect(fetchExternalSubtitle).toHaveBeenCalledWith("movie-1", "source-1", 4, "srt", expect.any(AbortSignal));
    expect((await service.fetchExternalSubtitle(started.playbackId, { ...subtitle, streamIndex: 99 })).status).toBe(404);

    const firstSignal = fetchStaticStream.mock.calls[0]?.[3] as AbortSignal;
    service.stop(started.playbackId);
    expect(firstSignal.aborted).toBe(true);

    const replacement = await service.start("movie-2", "start-over");
    expect(replacement.initialAction).toBe("start_over");
    expect((await service.handle(new Request(started.mediaUrl))).status).toBe(404);
    expect((await service.handle(new Request(replacement.mediaUrl))).status).toBe(200);
  });

  it("persists played catalog identity and represents replay as a newer explicit action", async () => {
    const played = {
      ...item,
      userData: { played: true, playbackPositionTicks: 0, playedPercentage: 100 },
    };
    const upsertMediaItem = vi.fn(async () => undefined);
    const upsertMediaSource = vi.fn(async () => undefined);
    const service = new PlaybackSessionService({
      getAuthenticatedContext: () => ({ serverId: "server-1", userId: "user-1" }),
      async getDetails() { return played; },
      async getMediaSourceCapabilities() {
        return { itemId: played.id, sources: [{ id: "source-1", container: "mkv", size: 5, supportsDirectPlay: true, supportsDirectStream: true, supportsTranscoding: true }] };
      },
      fetchStaticStream: vi.fn(),
      fetchTranscodedStream: vi.fn(),
    }, undefined, { upsertMediaItem, upsertMediaSource } as never);

    const started = await service.start(played.id, "start-over");
    expect(started.initialAction).toBe("replay");
    expect(upsertMediaItem).toHaveBeenCalledWith(expect.objectContaining({
      serverId: "server-1",
      userId: "user-1",
      itemId: played.id,
      itemType: "Movie",
      name: played.name,
    }));
    expect(upsertMediaSource).toHaveBeenCalledWith(expect.objectContaining({
      serverId: "server-1",
      userId: "user-1",
      itemId: played.id,
      mediaSourceId: "source-1",
    }));
  });

  it("carries episode identity main-side and delegates cross-season Next Up to Jellyfin", async () => {
    const episode = { ...item, id: "episode-1", name: "Episode 1", type: "Episode" as const, seriesId: "series-1", seasonId: "season-1" };
    const nextEpisode = { ...episode, id: "episode-2", name: "Episode 2", seasonId: "season-2" };
    const getNextUpForSeries = vi.fn(async () => nextEpisode);
    const service = new PlaybackSessionService({
      async getDetails() { return episode; },
      getNextUpForSeries,
      async getMediaSourceCapabilities() {
        return { itemId: episode.id, sources: [{ id: "source-1", container: "mkv", size: 5, supportsDirectPlay: true, supportsDirectStream: true, supportsTranscoding: true }] };
      },
      fetchStaticStream: vi.fn(),
      fetchTranscodedStream: vi.fn(),
    });

    const started = await service.start(episode.id, "start-over");
    expect(started).toMatchObject({ itemType: "Episode", seriesId: "series-1" });
    expect(await service.getNextUpForSeries("series-1")).toMatchObject({ id: "episode-2", seasonId: "season-2" });
    expect(getNextUpForSeries).toHaveBeenCalledWith("series-1");
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
