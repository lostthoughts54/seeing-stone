import { describe, expect, it, vi } from "vitest";
import {
  CleanMachineDiagnosticsService,
  formatCleanMachineDiagnostics,
} from "../src/main/services/cleanMachineDiagnostics";
import type { PlaybackState } from "../src/shared/contracts";

const playbackState = (videoOutput: "libmpv-opengl-angle" | null = null): PlaybackState => ({
  playbackId: videoOutput ? "55555555-5555-4555-8555-555555555555" : null,
  itemId: videoOutput ? "episode-1" : null,
  phase: videoOutput ? "playing" : "idle",
  source: videoOutput ? "server" : null,
  sourceKind: videoOutput ? "direct-play" : null,
  diagnostics: videoOutput ? {
    sourceKind: "direct-play",
    container: "mkv",
    videoCodec: "hevc",
    audioCodec: "eac3",
    audioChannels: "5.1",
    resolution: "1920x1080",
    bitrate: 6_000_000,
    videoRange: "SDR",
    transcodeReason: null,
    playbackRate: 1,
    bufferAheadTicks: null,
    videoOutput,
    videoOutputHealthy: true,
    hardwareDecoding: true,
    directRendering: null,
    renderFallbackUsed: false,
    frameQueueDepth: 1,
    droppedFrames: 0,
  } : null,
  positionTicks: 0,
  durationTicks: 0,
  paused: false,
  buffering: false,
  seekable: false,
  volume: 100,
  fullscreen: false,
  audioTracks: [],
  subtitleTracks: [],
  nextEpisodeCountdown: null,
  error: null,
});

const readyOptions = () => ({
  applicationVersion: "0.4.3",
  packaged: true,
  internalLibMpvTestBuild: true,
  platform: "win32" as const,
  architecture: "x64",
  electronVersion: "43.1.0",
  runtime: {
    available: true,
    reason: null,
    clientApiVersion: "2.5",
    renderApi: "opengl-angle" as const,
    artifacts: {
      libraryPath: "C:\\private\\libmpv.dll",
      nativeAddonPath: "C:\\private\\bridge.node",
      companionPaths: ["C:\\private\\companion.dll"],
    },
  },
  adapterStatus: {
    launchSelection: "libmpv" as const,
    active: "libmpv" as const,
    embeddedAvailable: true,
    libmpvAvailable: true,
    fallbackActive: false,
    fallbackFrom: null,
    fallbackReason: null,
  },
  sharedTextureAvailable: true,
  getGpuFeatureStatus: () => ({
    gpu_compositing: "enabled",
    webgl: "enabled",
    video_decode: "enabled",
  }),
  probeNativeRuntime: vi.fn(() => ({ available: true as const })),
  getPlaybackState: () => playbackState("libmpv-opengl-angle"),
  now: () => new Date("2026-07-28T04:00:00.000Z"),
});

describe("clean-machine diagnostics", () => {
  it("reports a self-contained machine as ready after real-video presentation", async () => {
    const service = new CleanMachineDiagnosticsService(readyOptions());
    const snapshot = await service.getSnapshot();

    expect(snapshot).toMatchObject({
      overall: "ready",
      build: "internal-libmpv-test",
      platform: "windows",
      architecture: "x64",
      selectedEngine: "libmpv",
      activeEngine: "libmpv",
      fallbackReason: null,
    });
    expect(snapshot.checks).toHaveLength(10);
    expect(snapshot.checks.every((entry) => entry.status === "pass")).toBe(true);
  });

  it("identifies GPU and first-frame fallback failures without exposing machine data", async () => {
    const options = readyOptions();
    options.adapterStatus.active = "embedded";
    options.adapterStatus.fallbackActive = true;
    options.adapterStatus.fallbackFrom = "libmpv";
    options.adapterStatus.fallbackReason = "initialization-failed";
    options.getGpuFeatureStatus = () => ({
      gpu_compositing: "disabled_software",
      webgl: "unavailable_software",
      video_decode: "disabled_software",
    });
    options.getPlaybackState = () => playbackState();

    const snapshot = await new CleanMachineDiagnosticsService(options).getSnapshot();
    const report = formatCleanMachineDiagnostics(snapshot);

    expect(snapshot.overall).toBe("blocked");
    expect(snapshot.checks).toContainEqual(expect.objectContaining({
      id: "gpu-compositing",
      status: "fail",
    }));
    expect(snapshot.checks).toContainEqual(expect.objectContaining({
      id: "first-frame-presentation",
      status: "fail",
    }));
    expect(report).toContain("Fallback reason: initialization-failed");
    expect(report).not.toMatch(/C:\\private|https?:\/\/|secret-value/i);
  });
});
