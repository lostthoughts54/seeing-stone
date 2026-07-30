import { describe, expect, it } from "vitest";
import {
  cachedMediaItemSchema,
  cachedPlaybackDiagnosticsSchema,
  downloadIdSchema,
  downloadStartSchema,
  loginSchema,
  liveTvCreateRecordingSchema,
  liveTvGuideSchema,
  liveTvPlaybackSchema,
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

  it("strictly bounds Live TV guide, playback, and recording mutations", () => {
    const startUtc = "2026-07-29T12:00:00.000Z";
    const endUtc = "2026-07-29T18:00:00.000Z";
    expect(liveTvGuideSchema.parse({ startUtc, endUtc })).toEqual({ startUtc, endUtc });
    expect(() => liveTvGuideSchema.parse({ startUtc, endUtc: "2026-07-31T18:00:00.000Z" })).toThrow();
    expect(() => liveTvGuideSchema.parse({ startUtc: endUtc, endUtc: startUtc })).toThrow();
    expect(() => liveTvPlaybackSchema.parse({ channelId: "../token" })).toThrow();
    expect(() => liveTvCreateRecordingSchema.parse({
      programId: "program-1",
      series: true,
      options: { prePaddingSeconds: 120, providerUrl: "https://secret.example/list.m3u" },
    })).toThrow();
    expect(liveTvCreateRecordingSchema.parse({
      programId: "program-1",
      series: false,
      options: { prePaddingSeconds: 120, postPaddingSeconds: 300 },
    }).options).toEqual({ prePaddingSeconds: 120, postPaddingSeconds: 300 });
  });
});

describe("offline cache schemas", () => {
  const item = {
    id: "episode-1",
    name: "The First Door",
    type: "Episode" as const,
    overview: "Cached metadata",
    productionYear: 2026,
    premiereYear: 2026,
    officialRating: "TV-14",
    communityRating: 8.4,
    runTimeTicks: 600_000_000,
    genres: ["Adventure"],
    primaryImageAspectRatio: 0.67,
    imageTags: { Primary: "primary-tag" },
    backdropImageTag: "backdrop-tag",
    parentThumbItemId: "series-1",
    parentThumbImageTag: "thumb-tag",
    seriesId: "series-1",
    seriesName: "Echoes Beyond",
    seasonId: "season-1",
    indexNumber: 1,
    parentIndexNumber: 1,
    userData: { played: false, playbackPositionTicks: 10_000_000, playedPercentage: 1.67 },
    hasTrailer: false,
    playable: true,
  };
  const diagnostics = {
    sourceKind: "offline-local" as const,
    playbackRate: 1,
    bufferAheadTicks: null,
    container: "mkv",
    videoCodec: "h264",
    audioCodec: "aac",
    audioChannels: "5.1",
    resolution: "1920×1080",
    bitrate: 5_000_000,
    videoRange: "SDR",
    transcodeReason: null,
    videoOutput: "d3d11" as const,
    videoOutputHealthy: true,
    hardwareDecoding: true,
    renderFallbackUsed: false,
  };

  it("accepts bounded sanitized values and rejects privileged or unknown fields", () => {
    expect(cachedMediaItemSchema.parse(item)).toEqual(item);
    expect(cachedPlaybackDiagnosticsSchema.parse(diagnostics)).toEqual(diagnostics);
    expect(() => cachedMediaItemSchema.parse({ ...item, localPath: "D:\\private\\media.mkv" })).toThrow();
    expect(() => cachedMediaItemSchema.parse({ ...item, overview: "x".repeat(32_769) })).toThrow();
    expect(() => cachedMediaItemSchema.parse({ ...item, userData: { ...item.userData, playedPercentage: Number.NaN } })).toThrow();
    expect(() => cachedPlaybackDiagnosticsSchema.parse({ ...diagnostics, accessToken: "secret" })).toThrow();
    expect(() => cachedPlaybackDiagnosticsSchema.parse({ ...diagnostics, bitrate: Number.POSITIVE_INFINITY })).toThrow();
  });
});
