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
    expect(local.resolve).toHaveBeenCalledWith("movie-1", "resume", expect.any(Set));
    expect(api.getDetails).not.toHaveBeenCalled();
    expect(api.getMediaSourceCapabilities).toHaveBeenCalledWith("movie-1", expect.any(AbortSignal));
    expect((await service.handle(new Request("jellyfin-media://stream/11111111-1111-4111-8111-111111111111"))).status).toBe(404);
  });

  it("does not request subtitle capabilities for a verified local item while offline", async () => {
    const getMediaSourceCapabilities = vi.fn(async () => { throw new Error("must not be called"); });
    const service = new PlaybackSessionService({
      getConnectionDiagnostics: () => ({
        state: "offline",
        serverName: "Test Jellyfin",
        serverVersion: "10.11.11",
        requestLatencyMs: null,
        measuredAt: null,
      }),
      getDetails: vi.fn(),
      getMediaSourceCapabilities,
      fetchStaticStream: vi.fn(),
      fetchTranscodedStream: vi.fn(),
      fetchExternalSubtitle: vi.fn(),
    }, {
      resolve: vi.fn(async () => ({
        playbackId: "22222222-2222-4222-8222-222222222222",
        serverPlaySessionId: "22222222-2222-4222-8222-222222222222",
        itemId: "movie-1",
        itemType: "Movie" as const,
        seriesId: null,
        mediaSourceId: "source-1",
        mediaUrl: "D:\\Authorized Downloads\\movie-1\\media.mkv",
        resumePositionTicks: 50_000_000,
        durationTicks: 100_000_000,
        source: "local" as const,
        sourceKind: "offline-local" as const,
        delivery: "local" as const,
        usesServerTimelineOffset: false,
        externalSubtitles: [],
        initialAction: "progress" as const,
      })),
    });

    const started = await service.start("movie-1", "resume");

    expect(started.sourceKind).toBe("offline-local");
    expect(started.externalSubtitles).toEqual([]);
    expect(getMediaSourceCapabilities).not.toHaveBeenCalled();
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

  it("keeps the private live stream identifier main-only and closes it exactly once", async () => {
    const closeLiveStream = vi.fn(async () => undefined);
    const channel: MediaItem = { ...item, id: "channel-1", name: "News", type: "TvChannel", runTimeTicks: 0, playable: true };
    const service = new PlaybackSessionService({
      getDetails: vi.fn(async () => channel),
      getMediaSourceCapabilities: vi.fn(),
      getPlaybackSourceInfo: vi.fn(async () => ({
        capabilities: {
          itemId: channel.id,
          sources: [{ id: "source-live", container: "ts", size: null, supportsDirectPlay: true, supportsDirectStream: true, supportsTranscoding: true }],
        },
        playSessionId: "play-session-live",
        liveStreamId: "private-live-stream-1",
      })),
      fetchStaticStream: vi.fn(async () => new Response("video")),
      fetchTranscodedStream: vi.fn(async () => new Response("video")),
      fetchExternalSubtitle: vi.fn(async () => new Response("subtitle")),
      closeLiveStream,
    });
    const started = await service.start(channel.id, "start-over");
    expect(started.liveStreamId).toBe("private-live-stream-1");
    expect(service.getState().contentKind).toBe("live-tv");
    service.stop(started.playbackId);
    await Promise.resolve();
    expect(closeLiveStream).toHaveBeenCalledOnce();
    expect(closeLiveStream).toHaveBeenCalledWith("private-live-stream-1");
  });

  it("waits for the previous tuner session to close before resolving a channel switch", async () => {
    let releaseTuner!: () => void;
    const tunerReleased = new Promise<void>((resolve) => { releaseTuner = resolve; });
    const closeLiveStream = vi.fn(() => tunerReleased);
    const getDetails = vi.fn(async (itemId: string) => ({
      ...item,
      id: itemId,
      name: itemId === "channel-1" ? "News" : "Sports",
      type: "TvChannel" as const,
      runTimeTicks: 0,
    }));
    const service = new PlaybackSessionService({
      getDetails,
      getMediaSourceCapabilities: vi.fn(),
      getPlaybackSourceInfo: vi.fn(async (itemId: string) => ({
        capabilities: {
          itemId,
          sources: [{ id: `source-${itemId}`, container: "ts", size: null, supportsDirectPlay: true, supportsDirectStream: true, supportsTranscoding: true }],
        },
        playSessionId: `session-${itemId}`,
        liveStreamId: `live-${itemId}`,
      })),
      fetchStaticStream: vi.fn(async () => new Response("video")),
      fetchTranscodedStream: vi.fn(async () => new Response("video")),
      fetchExternalSubtitle: vi.fn(async () => new Response("subtitle")),
      closeLiveStream,
    });

    await service.start("channel-1", "start-over");
    const switched = service.start("channel-2", "start-over");
    await Promise.resolve();
    await Promise.resolve();

    expect(closeLiveStream).toHaveBeenCalledWith("live-channel-1");
    expect(getDetails).toHaveBeenCalledTimes(1);
    releaseTuner();
    const next = await switched;
    expect(next.itemId).toBe("channel-2");
    expect(getDetails).toHaveBeenCalledTimes(2);
  });

  it("uses Jellyfin's negotiated infinite Live TV stream instead of the on-demand mp4 route", async () => {
    const channel: MediaItem = { ...item, id: "channel-1", name: "News", type: "TvChannel", runTimeTicks: 0, playable: true };
    const fetchNegotiatedLiveStream = vi.fn(async () => new Response("transport-stream", {
      headers: { "Content-Type": "video/mp2t", "Accept-Ranges": "none" },
    }));
    const fetchTranscodedStream = vi.fn();
    const service = new PlaybackSessionService({
      getDetails: vi.fn(async () => channel),
      getMediaSourceCapabilities: vi.fn(),
      getPlaybackSourceInfo: vi.fn(async () => ({
        capabilities: {
          itemId: channel.id,
          sources: [{ id: "source-live", container: "ts", size: null, supportsDirectPlay: false, supportsDirectStream: false, supportsTranscoding: true }],
        },
        playSessionId: "play-session-live",
        liveStreamId: "private-live-stream-1",
        negotiatedSources: [{
          sourceId: "source-live",
          directStreamUrl: null,
          transcodingUrl: "/Videos/private/live-stream",
        }],
      })),
      fetchStaticStream: vi.fn(),
      fetchTranscodedStream,
      fetchNegotiatedLiveStream,
      fetchExternalSubtitle: vi.fn(async () => new Response("subtitle")),
      closeLiveStream: vi.fn(async () => undefined),
    });

    const started = await service.start(channel.id, "start-over");
    const response = await service.handle(new Request(started.mediaUrl));
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("video/mp2t");
    expect(response.headers.has("Accept-Ranges")).toBe(false);
    expect(await response.text()).toBe("transport-stream");
    expect(fetchNegotiatedLiveStream).toHaveBeenCalledWith("/Videos/private/live-stream", expect.any(AbortSignal));
    expect(fetchTranscodedStream).not.toHaveBeenCalled();
    expect(JSON.stringify(started)).not.toContain("/Videos/private/live-stream");
  });

  it("keeps the authenticated source main-only and resolves an opaque internal stream", async () => {
    const fetchStaticStream = vi.fn(async () => new Response("video", { headers: { "Content-Type": "video/mp4" } }));
    const fetchTranscodedStream = vi.fn();
    const fetchExternalSubtitle = vi.fn(async () => new Response("subtitle", { headers: { "Content-Type": "application/x-subrip" } }));
    const subtitle = { streamIndex: 4, format: "srt" as const, title: "English", language: "eng", isDefault: false, isForced: false };
    const service = new PlaybackSessionService({
      async getDetails(itemId: string) { return { ...item, id: itemId }; },
      async getMediaSourceCapabilities(itemId: string) {
        return { itemId, sources: [{ id: "source-1", container: "mp4", size: 5, supportsDirectPlay: true, supportsDirectStream: true, supportsTranscoding: true, externalSubtitles: [subtitle] }] };
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
    const getPlaybackHead = vi.fn(async () => null);
    const service = new PlaybackSessionService({
      getAuthenticatedContext: () => ({ serverId: "server-1", userId: "user-1" }),
      async getDetails() { return played; },
      async getMediaSourceCapabilities() {
        return { itemId: played.id, sources: [{ id: "source-1", container: "mkv", size: 5, supportsDirectPlay: true, supportsDirectStream: true, supportsTranscoding: true }] };
      },
      fetchStaticStream: vi.fn(),
      fetchTranscodedStream: vi.fn(),
    }, undefined, { upsertMediaItem, upsertMediaSource, getPlaybackHead } as never);

    const started = await service.start(played.id, "start-over");
    expect(started.initialAction).toBe("replay");
    expect(upsertMediaItem).toHaveBeenCalledWith(expect.objectContaining({
      serverId: "server-1",
      userId: "user-1",
      itemId: played.id,
      itemType: "Movie",
      name: played.name,
      metadata: played,
    }));
    expect(upsertMediaSource).toHaveBeenCalledWith(expect.objectContaining({
      serverId: "server-1",
      userId: "user-1",
      itemId: played.id,
      mediaSourceId: "source-1",
      diagnostics: expect.objectContaining({ sourceKind: "direct-play", container: "mkv" }),
    }));
  });

  it("resumes from newer unsynchronized local progress instead of stale server progress", async () => {
    const serverItem = {
      ...item,
      userData: { ...item.userData, playbackPositionTicks: 30000000 },
    };
    const persistence = {
      upsertMediaItem: vi.fn(async () => undefined),
      upsertMediaSource: vi.fn(async () => undefined),
      getPlaybackHead: vi.fn(async () => ({
        serverId: "server-1",
        userId: "user-1",
        itemId: item.id,
        latestRevision: 2,
        conflictPolicy: "automatic" as const,
        actionKind: "progress" as const,
        positionTicks: 70000000,
        watched: false,
        occurredAt: 2,
        lastSucceededRevision: 1,
        lastSucceededPositionTicks: 20000000,
        lastSucceededWatched: false,
        updatedAt: 2,
      })),
    };
    const service = new PlaybackSessionService({
      getAuthenticatedContext: () => ({ serverId: "server-1", userId: "user-1" }),
      async getDetails() { return serverItem; },
      async getMediaSourceCapabilities() {
        return { itemId: item.id, sources: [{ id: "source-1", container: "mp4", size: 5, supportsDirectPlay: true, supportsDirectStream: true, supportsTranscoding: true }] };
      },
      fetchStaticStream: vi.fn(),
      fetchTranscodedStream: vi.fn(),
    }, undefined, persistence);

    const started = await service.start(item.id, "resume");
    expect(started.resumePositionTicks).toBe(70000000);
    expect(persistence.getPlaybackHead).toHaveBeenCalledWith("server-1", "user-1", item.id);
  });

  it("keeps an unsynchronized explicit rewind authoritative over later server progress", async () => {
    const serverItem = {
      ...item,
      userData: { ...item.userData, playbackPositionTicks: 70000000 },
    };
    const persistence = {
      upsertMediaItem: vi.fn(async () => undefined),
      upsertMediaSource: vi.fn(async () => undefined),
      getPlaybackHead: vi.fn(async () => ({
        serverId: "server-1",
        userId: "user-1",
        itemId: item.id,
        latestRevision: 3,
        conflictPolicy: "explicit" as const,
        actionKind: "progress" as const,
        positionTicks: 20000000,
        watched: false,
        occurredAt: 3,
        lastSucceededRevision: 1,
        lastSucceededPositionTicks: 60000000,
        lastSucceededWatched: false,
        updatedAt: 3,
      })),
    };
    const service = new PlaybackSessionService({
      getAuthenticatedContext: () => ({ serverId: "server-1", userId: "user-1" }),
      async getDetails() { return serverItem; },
      async getMediaSourceCapabilities() {
        return { itemId: item.id, sources: [{ id: "source-1", container: "mp4", size: 5, supportsDirectPlay: true, supportsDirectStream: true, supportsTranscoding: true }] };
      },
      fetchStaticStream: vi.fn(),
      fetchTranscodedStream: vi.fn(),
    }, undefined, persistence);

    const started = await service.start(item.id, "resume");

    expect(started.resumePositionTicks).toBe(20000000);
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
    expect(started.sourceKind).toBe("direct-play");
    const response = await service.handle(new Request(started.mediaUrl, { headers: { Range: "bytes=100-200" } }));

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("video/x-matroska");
    expect(response.headers.get("Accept-Ranges")).toBe("bytes");
    expect(fetchStaticStream).toHaveBeenCalledWith("movie-1", "mkv-source", "bytes=100-200", expect.any(AbortSignal));
    expect(fetchTranscodedStream).not.toHaveBeenCalled();
    expect(started.mediaSourceId).toBe("mkv-source");
    expect(JSON.stringify(started)).not.toContain("http");
  });

  it("uses Jellyfin direct stream distinctly when direct play is unavailable", async () => {
    const fetchStaticStream = vi.fn();
    const fetchDirectStream = vi.fn(async function (this: { bindingMarker?: string }) {
      if (this.bindingMarker !== "direct-api") throw new Error("direct-stream method lost its receiver");
      return new Response("remuxed", { headers: { "Content-Type": "video/mp4" } });
    });
    const fetchTranscodedStream = vi.fn();
    const service = new PlaybackSessionService({
      async getDetails() { return item; },
      async getMediaSourceCapabilities() {
        return { itemId: item.id, sources: [{ id: "unused", container: "mkv", size: 5, supportsDirectPlay: false, supportsDirectStream: false, supportsTranscoding: false }] };
      },
      async getPlaybackSourceInfo() {
        return {
          playSessionId: "server-session-1",
          capabilities: { itemId: item.id, sources: [{ id: "remux-source", container: "mkv", size: 5, supportsDirectPlay: false, supportsDirectStream: true, supportsTranscoding: true }] },
        };
      },
      bindingMarker: "direct-api",
      fetchStaticStream,
      fetchDirectStream,
      fetchTranscodedStream,
    });
    const started = await service.start(item.id, "resume");
    const response = await service.handle(new Request(started.mediaUrl));
    expect(started.sourceKind).toBe("direct-stream");
    expect(started.playbackId).not.toBe(started.serverPlaySessionId);
    expect(started.usesServerTimelineOffset).toBe(true);
    expect(response.headers.get("Content-Type")).toBe("video/mp4");
    expect(response.headers.has("Accept-Ranges")).toBe(false);
    expect(fetchDirectStream).toHaveBeenNthCalledWith(1, "movie-1", "remux-source", "server-session-1", 50000000, expect.any(AbortSignal));
    service.setStreamStart(started.playbackId, 75000000);
    await service.handle(new Request(started.mediaUrl));
    expect(fetchDirectStream).toHaveBeenNthCalledWith(2, "movie-1", "remux-source", "server-session-1", 75000000, expect.any(AbortSignal));
    expect(fetchStaticStream).not.toHaveBeenCalled();
    expect(fetchTranscodedStream).not.toHaveBeenCalled();
  });

  it("never labels a static stream as direct-stream when the direct-stream adapter is unavailable", async () => {
    const fetchStaticStream = vi.fn();
    const fetchTranscodedStream = vi.fn(async () => new Response("video", { headers: { "Content-Type": "video/mp4" } }));
    const service = new PlaybackSessionService({
      async getDetails() { return item; },
      async getMediaSourceCapabilities() {
        return { itemId: item.id, sources: [{ id: "remux-source", container: "mkv", size: 5, supportsDirectPlay: false, supportsDirectStream: true, supportsTranscoding: true }] };
      },
      fetchStaticStream,
      fetchTranscodedStream,
    });

    const started = await service.start(item.id, "resume");
    await service.handle(new Request(started.mediaUrl));
    expect(started.sourceKind).toBe("transcode");
    expect(fetchStaticStream).not.toHaveBeenCalled();
    expect(fetchTranscodedStream).toHaveBeenCalledWith(
      item.id,
      "remux-source",
      started.serverPlaySessionId,
      item.userData.playbackPositionTicks,
      expect.any(AbortSignal),
    );
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
    expect(fetchTranscodedStream).toHaveBeenCalledWith("movie-1", "mp4-transcode", started.serverPlaySessionId, 0, expect.any(AbortSignal));
  });

  it("prefers an eligible progressive lease and skips it for the server fallback attempt", async () => {
    const release = vi.fn();
    const lease = {
      descriptor: {
        item,
        itemId: item.id,
        itemType: "Movie" as const,
        seriesId: null,
        mediaSourceId: "source-1",
        durationTicks: item.runTimeTicks,
        expectedSize: 64 * 1024 * 1024,
        container: "mkv",
        diagnostics: {
          sourceKind: "downloading" as const,
          playbackRate: 1,
          bufferAheadTicks: null,
          container: "mkv",
          videoCodec: "h264",
          audioCodec: "aac",
          audioChannels: 2,
          resolution: "1920×1080",
          bitrate: 8_000_000,
          videoRange: "SDR",
          transcodeReason: null,
        },
      },
      handle: vi.fn(),
      endMetadataAllowance: vi.fn(),
      onEvent: vi.fn(() => vi.fn()),
      release,
    };
    const acquireProgressive = vi.fn(async () => lease);
    const getDetails = vi.fn(async () => item);
    const getMediaSourceCapabilities = vi.fn(async () => ({
      itemId: item.id,
      sources: [{ id: "source-1", container: "mkv", size: 64 * 1024 * 1024, supportsDirectPlay: true, supportsDirectStream: true, supportsTranscoding: true }],
    }));
    const service = new PlaybackSessionService({
      getConnectionDiagnostics: () => ({ state: "offline" as const, serverName: null, serverVersion: null, lastCheckedAt: 0, lastError: null }),
      getDetails,
      getMediaSourceCapabilities,
      fetchStaticStream: vi.fn(),
      fetchTranscodedStream: vi.fn(),
      fetchExternalSubtitle: vi.fn(),
    }, { resolve: vi.fn(async () => null) }, undefined, undefined, { acquireProgressive });

    const progressive = await service.start(item.id, "resume");
    expect(progressive).toMatchObject({
      sourceKind: "downloading",
      source: "local",
      resumePositionTicks: 0,
      preferredResumePositionTicks: item.userData.playbackPositionTicks,
      progressiveLease: lease,
    });
    expect(service.getState().seekableUntilTicks).toBe(0);
    expect(getDetails).not.toHaveBeenCalled();

    const server = await service.retryAfterLocalFailure(progressive.playbackId, "resume");
    expect(server.sourceKind).toBe("direct-play");
    expect(acquireProgressive).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledOnce();
    expect(getDetails).toHaveBeenCalledOnce();
  });

  it("rejects an early Watch now attempt without falling through to Jellyfin", async () => {
    const getDetails = vi.fn(async () => item);
    const getMediaSourceCapabilities = vi.fn(async () => ({
      itemId: item.id,
      sources: [{ id: "source-1", container: "mkv", size: 64 * 1024 * 1024, supportsDirectPlay: true, supportsDirectStream: true, supportsTranscoding: true }],
    }));
    const acquireProgressive = vi.fn(async () => null);
    const service = new PlaybackSessionService({
      getDetails,
      getMediaSourceCapabilities,
      fetchStaticStream: vi.fn(),
      fetchTranscodedStream: vi.fn(),
      fetchExternalSubtitle: vi.fn(),
    }, { resolve: vi.fn(async () => null) }, undefined, undefined, { acquireProgressive });

    await expect(service.start(item.id, "resume", { requireProgressive: true })).rejects.toMatchObject({
      code: "PROGRESSIVE_NOT_READY",
      message: expect.stringContaining("still buffering"),
    });
    expect(acquireProgressive).toHaveBeenCalledOnce();
    expect(getDetails).not.toHaveBeenCalled();
    expect(getMediaSourceCapabilities).not.toHaveBeenCalled();
  });
});
