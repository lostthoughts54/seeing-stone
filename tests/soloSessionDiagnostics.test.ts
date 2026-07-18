import { describe, expect, it, vi } from "vitest";
import type { JellyfinConnectionDiagnostics, MediaItem, PlaybackState } from "../src/shared/contracts";
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
});
