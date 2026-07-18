import { describe, expect, it, vi } from "vitest";
import type { JellyfinConnectionDiagnostics, MediaItem, PlaybackState, SoloSessionDiagnostics } from "../src/shared/contracts";
import { SoloSessionDiagnosticsService } from "../src/main/services/soloSessionDiagnostics";

const connection: JellyfinConnectionDiagnostics = {
  state: "connected",
  serverName: "Test Jellyfin",
  serverVersion: "10.11.0",
  requestLatencyMs: 24,
  measuredAt: "2026-07-16T12:00:00.000Z",
};

function playback(overrides: Partial<PlaybackState> = {}): PlaybackState {
  return {
    playbackId: "11111111-1111-4111-8111-111111111111",
    itemId: "episode-1",
    phase: "playing",
    source: "server",
    diagnostics: {
      sourceKind: "direct-play",
      playbackRate: 1,
      bufferAheadTicks: 50_000_000,
      container: "mkv",
      videoCodec: "h264",
      audioCodec: "aac",
      audioChannels: "5.1",
      resolution: "1920x1080",
      bitrate: 5_000_000,
      videoRange: "SDR",
      transcodeReason: null,
    },
    positionTicks: 20_000_000,
    durationTicks: 600_000_000,
    paused: false,
    buffering: false,
    seekable: true,
    volume: 80,
    fullscreen: false,
    audioTracks: [],
    subtitleTracks: [],
    error: null,
    ...overrides,
  };
}

function item(overrides: Partial<MediaItem> = {}): MediaItem {
  return {
    id: "episode-1",
    name: "The First Door",
    type: "Episode",
    overview: "",
    productionYear: 2026,
    premiereYear: 2026,
    officialRating: null,
    communityRating: null,
    runTimeTicks: 600_000_000,
    genres: [],
    primaryImageAspectRatio: null,
    imageTags: {},
    backdropImageTag: null,
    parentThumbItemId: null,
    parentThumbImageTag: null,
    seriesId: "series-1",
    seriesName: "Echoes Beyond",
    seasonId: "season-1",
    indexNumber: 1,
    parentIndexNumber: 1,
    userData: { played: false, playbackPositionTicks: 0, playedPercentage: 0 },
    hasTrailer: false,
    playable: true,
    ...overrides,
  };
}

describe("SoloSessionDiagnosticsService", () => {
  it("returns only current real playback, item, connection, and episode Next Up data", async () => {
    const current = playback();
    const next = item({ id: "episode-2", name: "The Second Door", indexNumber: 2 });
    const api = {
      getConnectionDiagnostics: vi.fn(() => connection),
      getDetails: vi.fn(async () => item()),
      getNextUpForSeries: vi.fn(async () => next),
    };
    const service = new SoloSessionDiagnosticsService(api, { getState: () => current });

    await expect(service.getSnapshot()).resolves.toEqual({
      playback: current,
      connection,
      item: item(),
      nextUp: next,
    });
    expect(api.getNextUpForSeries).toHaveBeenCalledWith("series-1");
    expect(JSON.stringify(await service.getSnapshot())).not.toMatch(/path|token|streamUrl|authorization/i);
  });

  it("suppresses unavailable server-only rows without inventing values", async () => {
    const current = playback({ source: "local", diagnostics: { ...playback().diagnostics!, sourceKind: "offline-local" } });
    const api = {
      getConnectionDiagnostics: () => ({ ...connection, state: "offline" as const, requestLatencyMs: null, measuredAt: null }),
      getDetails: vi.fn(async () => { throw new Error("offline"); }),
      getNextUpForSeries: vi.fn(),
    };
    const service = new SoloSessionDiagnosticsService(api, { getState: () => current });
    const result = await service.getSnapshot();
    expect(result.item).toBeNull();
    expect(result.nextUp).toBeNull();
    expect(result.connection.requestLatencyMs).toBeNull();
    expect(api.getNextUpForSeries).not.toHaveBeenCalled();
  });

  it("discards metadata when playback changes during an asynchronous snapshot", async () => {
    let release!: (value: MediaItem) => void;
    let current = playback();
    const api = {
      getConnectionDiagnostics: () => connection,
      getDetails: () => new Promise<MediaItem>((resolve) => { release = resolve; }),
      getNextUpForSeries: vi.fn(async () => null),
    };
    const service = new SoloSessionDiagnosticsService(api, { getState: () => current });
    const pending = service.getSnapshot();
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    current = playback({ playbackId: "22222222-2222-4222-8222-222222222222", itemId: "movie-2" });
    release(item());
    await expect(pending).resolves.toMatchObject({ playback: current, item: null, nextUp: null });
  });

  it("does not query metadata when no item is active", async () => {
    const current = playback({ playbackId: null, itemId: null, phase: "idle", source: null });
    const api = {
      getConnectionDiagnostics: () => connection,
      getDetails: vi.fn(),
      getNextUpForSeries: vi.fn(),
    };
    const service = new SoloSessionDiagnosticsService(api, { getState: () => current });
    await expect(service.getSnapshot()).resolves.toMatchObject({ playback: current, item: null, nextUp: null });
    expect(api.getDetails).not.toHaveBeenCalled();
  });

  it("returns cached metadata and Next Up offline without a Jellyfin request", async () => {
    const current = playback({ source: "local", diagnostics: { ...playback().diagnostics!, sourceKind: "offline-local" } });
    const cached = item({ overview: "Cached while offline" });
    const next = item({ id: "episode-2", name: "The Second Door", indexNumber: 2 });
    const api = {
      getConnectionDiagnostics: () => ({ ...connection, state: "offline" as const, requestLatencyMs: null, measuredAt: null }),
      getAuthenticatedContext: () => ({ serverId: "server-1", userId: "user-1" }),
      getDetails: vi.fn(async () => item()),
      getNextUpForSeries: vi.fn(async () => next),
    };
    const persistence = {
      getMediaItem: vi.fn(async () => ({
        serverId: "server-1",
        userId: "user-1",
        itemId: cached.id,
        itemType: "Episode" as const,
        name: cached.name,
        seriesId: cached.seriesId,
        seasonId: cached.seasonId,
        runTimeTicks: cached.runTimeTicks,
        metadata: cached,
        nextUp: next,
        createdAt: 1,
        updatedAt: 1,
      })),
      getPlaybackHead: vi.fn(async () => null),
      upsertMediaItem: vi.fn(),
      setMediaItemNextUp: vi.fn(),
    };
    const service = new SoloSessionDiagnosticsService(api, { getState: () => current }, persistence as never);

    await expect(service.getSnapshot()).resolves.toMatchObject({
      playback: current,
      connection: { state: "offline" },
      item: { id: cached.id, overview: "Cached while offline" },
      nextUp: { id: next.id, name: next.name },
    });
    expect(api.getDetails).not.toHaveBeenCalled();
    expect(api.getNextUpForSeries).not.toHaveBeenCalled();
  });

  it("trusts newer cached remote progress after the local head has fully synchronized", async () => {
    const current = playback({ source: "local", diagnostics: { ...playback().diagnostics!, sourceKind: "offline-local" } });
    const remote = item({
      userData: { played: false, playbackPositionTicks: 30_000_000, playedPercentage: 5 },
    });
    const api = {
      getConnectionDiagnostics: () => ({ ...connection, state: "offline" as const, requestLatencyMs: null, measuredAt: null }),
      getAuthenticatedContext: () => ({ serverId: "server-1", userId: "user-1" }),
      getDetails: vi.fn(),
      getNextUpForSeries: vi.fn(),
    };
    const persistence = {
      getMediaItem: vi.fn(async () => ({
        serverId: "server-1",
        userId: "user-1",
        itemId: remote.id,
        itemType: "Episode" as const,
        name: remote.name,
        seriesId: remote.seriesId,
        seasonId: remote.seasonId,
        runTimeTicks: remote.runTimeTicks,
        metadata: remote,
        nextUp: null,
        createdAt: 1,
        updatedAt: 2,
      })),
      getPlaybackHead: vi.fn(async () => ({
        serverId: "server-1",
        userId: "user-1",
        itemId: remote.id,
        latestRevision: 4,
        lastSucceededRevision: 4,
        positionTicks: 90_000_000,
        watched: true,
        actionKind: "completed" as const,
        conflictPolicy: "explicit" as const,
        lastSucceededPositionTicks: 90_000_000,
        lastSucceededWatched: true,
        updatedAt: 1,
      })),
      upsertMediaItem: vi.fn(),
      setMediaItemNextUp: vi.fn(),
    };
    const service = new SoloSessionDiagnosticsService(api, { getState: () => current }, persistence as never);

    await expect(service.getSnapshot()).resolves.toMatchObject({
      item: {
        userData: { played: false, playbackPositionTicks: 30_000_000, playedPercentage: 5 },
      },
    });
  });

  it("uses the durable succeeded head for legacy rows that have no cached metadata", async () => {
    const current = playback({ source: "local", diagnostics: { ...playback().diagnostics!, sourceKind: "offline-local" } });
    const api = {
      getConnectionDiagnostics: () => ({ ...connection, state: "offline" as const, requestLatencyMs: null, measuredAt: null }),
      getAuthenticatedContext: () => ({ serverId: "server-1", userId: "user-1" }),
      getDetails: vi.fn(),
      getNextUpForSeries: vi.fn(),
    };
    const persistence = {
      getMediaItem: vi.fn(async () => ({
        serverId: "server-1",
        userId: "user-1",
        itemId: "episode-1",
        itemType: "Episode" as const,
        name: "Legacy cached episode",
        seriesId: "series-1",
        seasonId: "season-1",
        runTimeTicks: 600_000_000,
        metadata: null,
        nextUp: null,
        createdAt: 1,
        updatedAt: 1,
      })),
      getPlaybackHead: vi.fn(async () => ({
        serverId: "server-1",
        userId: "user-1",
        itemId: "episode-1",
        latestRevision: 3,
        lastSucceededRevision: 3,
        positionTicks: 90_000_000,
        watched: false,
        actionKind: "progress" as const,
        conflictPolicy: "automatic" as const,
        lastSucceededPositionTicks: 90_000_000,
        lastSucceededWatched: false,
        updatedAt: 1,
      })),
      upsertMediaItem: vi.fn(),
      setMediaItemNextUp: vi.fn(),
    };
    const service = new SoloSessionDiagnosticsService(api, { getState: () => current }, persistence as never);

    await expect(service.getSnapshot()).resolves.toMatchObject({
      item: {
        id: "episode-1",
        name: "Legacy cached episode",
        userData: { played: false, playbackPositionTicks: 90_000_000, playedPercentage: 15 },
      },
    });
  });

  it("preserves cached Next Up when a partial reconnect cannot refresh it", async () => {
    const current = playback({ source: "local", diagnostics: { ...playback().diagnostics!, sourceKind: "offline-local" } });
    let connectionState: JellyfinConnectionDiagnostics["state"] = "offline";
    let connectionListener: ((value: JellyfinConnectionDiagnostics) => void) | null = null;
    let recordItem = item({ overview: "Old cached overview" });
    const cachedNext = item({ id: "episode-2", name: "Cached next episode", indexNumber: 2 });
    const refreshed = item({ overview: "Current item refreshed" });
    const diagnostics = () => ({ ...connection, state: connectionState, requestLatencyMs: connectionState === "connected" ? 21 : null });
    const api = {
      getConnectionDiagnostics: diagnostics,
      getAuthenticatedContext: () => ({ serverId: "server-1", userId: "user-1" }),
      onConnectionDiagnostics: (listener: (value: JellyfinConnectionDiagnostics) => void) => {
        connectionListener = listener;
        return () => { connectionListener = null; };
      },
      getDetails: vi.fn(async () => refreshed),
      getNextUpForSeries: vi.fn(async () => { throw new Error("partial reconnect"); }),
    };
    const setMediaItemNextUp = vi.fn();
    const persistence = {
      getMediaItem: vi.fn(async () => ({
        serverId: "server-1",
        userId: "user-1",
        itemId: recordItem.id,
        itemType: "Episode" as const,
        name: recordItem.name,
        seriesId: recordItem.seriesId,
        seasonId: recordItem.seasonId,
        runTimeTicks: recordItem.runTimeTicks,
        metadata: recordItem,
        nextUp: cachedNext,
        createdAt: 1,
        updatedAt: 1,
      })),
      getPlaybackHead: vi.fn(async () => null),
      upsertMediaItem: vi.fn(async (input: { metadata: MediaItem }) => {
        if (input.metadata.id === current.itemId) recordItem = input.metadata;
      }),
      setMediaItemNextUp,
    };
    const service = new SoloSessionDiagnosticsService(api, { getState: () => current }, persistence as never);
    const snapshots: SoloSessionDiagnostics[] = [];
    service.onState((snapshot) => snapshots.push(snapshot));

    connectionState = "connected";
    connectionListener?.(diagnostics());
    await vi.waitFor(() => expect(snapshots.at(-1)?.item?.overview).toBe("Current item refreshed"));

    expect(api.getNextUpForSeries).toHaveBeenCalledWith("series-1");
    expect(setMediaItemNextUp).not.toHaveBeenCalled();
    expect(snapshots.at(-1)?.nextUp).toMatchObject({ id: cachedNext.id, name: cachedNext.name });
  });

  it("refreshes cached metadata after reconnect without changing active playback", async () => {
    const current = playback({ source: "local", diagnostics: { ...playback().diagnostics!, sourceKind: "offline-local" } });
    let connectionState: JellyfinConnectionDiagnostics["state"] = "offline";
    let connectionListener: ((value: JellyfinConnectionDiagnostics) => void) | null = null;
    let recordItem = item({ overview: "Old cached overview" });
    let recordNext: MediaItem | null = null;
    const refreshed = item({ overview: "Refreshed after reconnect", userData: { played: false, playbackPositionTicks: 40_000_000, playedPercentage: 6.67 } });
    const next = item({ id: "episode-2", name: "The Second Door", indexNumber: 2 });
    const diagnostics = () => ({ ...connection, state: connectionState, requestLatencyMs: connectionState === "connected" ? 18 : null });
    const api = {
      getConnectionDiagnostics: diagnostics,
      getAuthenticatedContext: () => ({ serverId: "server-1", userId: "user-1" }),
      onConnectionDiagnostics: (listener: (value: JellyfinConnectionDiagnostics) => void) => {
        connectionListener = listener;
        return () => { connectionListener = null; };
      },
      getDetails: vi.fn(async () => refreshed),
      getNextUpForSeries: vi.fn(async () => next),
    };
    const persistence = {
      getMediaItem: vi.fn(async () => ({
        serverId: "server-1",
        userId: "user-1",
        itemId: recordItem.id,
        itemType: "Episode" as const,
        name: recordItem.name,
        seriesId: recordItem.seriesId,
        seasonId: recordItem.seasonId,
        runTimeTicks: recordItem.runTimeTicks,
        metadata: recordItem,
        nextUp: recordNext,
        createdAt: 1,
        updatedAt: 1,
      })),
      getPlaybackHead: vi.fn(async () => null),
      upsertMediaItem: vi.fn(async (input: { metadata: MediaItem }) => {
        if (input.metadata.id === current.itemId) recordItem = input.metadata;
      }),
      setMediaItemNextUp: vi.fn(async (_serverId: string, _userId: string, _itemId: string, value: MediaItem | null) => { recordNext = value; }),
    };
    const service = new SoloSessionDiagnosticsService(api, { getState: () => current }, persistence as never);
    const snapshots: SoloSessionDiagnostics[] = [];
    service.onState((snapshot) => snapshots.push(snapshot));

    connectionState = "reconnecting";
    connectionListener?.(diagnostics());
    await vi.waitFor(() => expect(snapshots.at(-1)?.connection.state).toBe("reconnecting"));
    connectionState = "connected";
    connectionListener?.(diagnostics());
    await vi.waitFor(() => expect(snapshots.at(-1)?.item?.overview).toBe("Refreshed after reconnect"));

    expect(api.getDetails).toHaveBeenCalledWith(current.itemId);
    expect(api.getNextUpForSeries).toHaveBeenCalledWith("series-1");
    expect(snapshots.at(-1)).toMatchObject({
      playback: { playbackId: current.playbackId, itemId: current.itemId },
      connection: { state: "connected", requestLatencyMs: 18 },
      nextUp: { id: next.id },
    });
    expect(current.playbackId).toBe("11111111-1111-4111-8111-111111111111");
  });
});
