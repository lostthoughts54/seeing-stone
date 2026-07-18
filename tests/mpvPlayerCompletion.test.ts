import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { embeddedRenderProfileArgs, MpvPlayerService } from "../src/main/services/mpvPlayer";
import { PlaybackCompletionCoordinator } from "../src/main/services/playbackCompletion";
import { AppError } from "../src/main/services/errors";
import type { ResolvedPlaybackSource } from "../src/main/services/playbackSession";

const ticks = 10_000_000;

function source(
  itemId: string,
  playbackId: string,
  itemType: "Movie" | "Episode" = "Episode",
): ResolvedPlaybackSource {
  return {
    itemId,
    playbackId,
    serverPlaySessionId: playbackId,
    itemType,
    seriesId: itemType === "Episode" ? "series-1" : null,
    mediaSourceId: `media-${itemId}`,
    mediaUrl: `jellyfin-media://stream/${playbackId}`,
    delivery: "direct",
    resumePositionTicks: 0,
    durationTicks: 60 * ticks,
    source: "server",
    sourceKind: "direct-play",
    usesServerTimelineOffset: false,
    externalSubtitles: [],
    initialAction: "progress",
  };
}

function nextEpisode(itemId: string) {
  return {
    id: itemId,
    name: itemId,
    type: "Episode" as const,
    overview: "",
    productionYear: 2026,
    premiereYear: null,
    officialRating: null,
    communityRating: null,
    runTimeTicks: 60 * ticks,
    genres: [],
    primaryImageAspectRatio: null,
    imageTags: {},
    backdropImageTag: null,
    parentThumbItemId: null,
    parentThumbImageTag: null,
    seriesId: "series-1",
    seriesName: "Series",
    seasonId: "season-2",
    indexNumber: 1,
    parentIndexNumber: 2,
    userData: { played: false, playbackPositionTicks: 0, playedPercentage: 0 },
    hasTrailer: false,
    playable: true,
  };
}

function harness(options: { nextId?: string | null; failNextStart?: boolean; localNext?: boolean; externalSubtitleNext?: boolean; embedded?: boolean } = {}) {
  const current = source("episode-1", "playback-1");
  const replacement = source(options.nextId || "episode-2", "playback-2");
  if (options.localNext) {
    replacement.source = "local";
    replacement.delivery = "local";
    replacement.mediaUrl = "D:\\Authorized Downloads\\episode-2\\media.mkv";
  }
  if (options.externalSubtitleNext) {
    replacement.externalSubtitles = [{
      streamIndex: 4,
      format: "srt",
      title: "English - External",
      language: "eng",
      isDefault: false,
      isForced: false,
    }];
  }
  const reports: Array<{ kind: string; itemId: string }> = [];
  const reportedEvents: Array<Record<string, unknown>> = [];
  const stopped = new Set<string>();
  const playback = {
    start: vi.fn(async () => {
      if (options.failNextStart) throw new Error("resolution failed");
      return replacement;
    }),
    stop: vi.fn((playbackId: string) => {
      if (stopped.has(playbackId)) throw new Error("already stopped");
      stopped.add(playbackId);
      return {};
    }),
    clear: vi.fn(),
    getNextUpForSeries: vi.fn(async () => options.nextId === null ? null : nextEpisode(options.nextId || "episode-2")),
  };
  const window = {
    isDestroyed: () => false,
    minimize: vi.fn(),
    isMinimized: () => false,
    restore: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
  };
  const listeners = new Set<(message: Record<string, unknown>) => void>();
  const commands: unknown[][] = [];
  const ipc = {
    onMessage(listener: (message: Record<string, unknown>) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async command(command: unknown[]) {
      commands.push(command);
      if (command[0] === "get_property") {
        if (command[1] === "time-pos") return 0;
        if (command[1] === "fullscreen" || command[1] === "window-maximized") return false;
      }
      if (command[0] === "loadfile") queueMicrotask(() => {
        for (const listener of listeners) listener({ event: "file-loaded" });
      });
      return null;
    },
    close: vi.fn(),
  };
  const videoHost = {
    embedded: true as const,
    getWindowId: () => "1234",
    updateViewport: vi.fn(),
    raise: vi.fn(),
    setFullscreen: vi.fn(),
    hide: vi.fn(),
    destroy: vi.fn(),
  };
  const player = new MpvPlayerService(
    window as never,
    playback as never,
    { acceptAuthoritativeEvent: vi.fn(async (event) => {
      reports.push({ kind: event.kind, itemId: event.itemId });
      reportedEvents.push(event);
    }) } as never,
    { get: async () => ({ windowMaximized: true }), setWindowMaximized: async () => undefined },
    { executable: "mpv.exe", inputConfig: "input.conf" },
    options.embedded ? videoHost : undefined,
  );
  const internals = player as unknown as Record<string, unknown>;
  internals.source = current;
  internals.state = {
    playbackId: current.playbackId,
    itemId: current.itemId,
    phase: "playing",
    source: "server",
    positionTicks: 59 * ticks,
    durationTicks: 60 * ticks,
    paused: false,
    buffering: false,
    seekable: true,
    volume: 100,
    fullscreen: false,
    audioTracks: [],
    subtitleTracks: [],
    error: null,
  };
  internals.ipc = ipc;
  const proxy = {
    close: vi.fn(async () => undefined),
    open: vi.fn(async () => ({
      media: "http://127.0.0.1/next",
      subtitles: options.externalSubtitleNext
        ? [{ url: "http://127.0.0.1/subtitle.srt", title: "English - External", language: "eng", isDefault: false, streamIndex: 4 }]
        : [],
    })),
  };
  internals.proxy = proxy;
  internals.playbackTarget = { media: "http://127.0.0.1/current", subtitles: [] };
  internals.reportingActive = true;
  internals.playbackRevision = 1;
  internals.completion = new PlaybackCompletionCoordinator(10, 3, async () => undefined);
  return { player, internals, playback, reports, reportedEvents, commands, window, current, proxy, videoHost };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for player state.");
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe("MpvPlayerService natural completion", () => {
  it("uses the Windows D3D11 profile before the software-safe embedded fallback", () => {
    expect(embeddedRenderProfileArgs("d3d11")).toEqual([
      "--vo=gpu-next", "--gpu-api=d3d11", "--gpu-context=d3d11", "--hwdec=auto-safe", "--panscan=0",
    ]);
    expect(embeddedRenderProfileArgs("opengl-software")).toEqual([
      "--vo=gpu", "--gpu-api=opengl", "--gpu-context=win", "--hwdec=no", "--panscan=0",
    ]);
  });

  it("retries embedded rendering before emitting its single Jellyfin start report", async () => {
    const h = harness({ embedded: true });
    h.internals.source = null;
    h.internals.reportingActive = false;
    const candidate = { ...source("episode-1", "embedded-playback"), diagnostics: {
      sourceKind: "direct-play" as const, playbackRate: 1, bufferAheadTicks: null,
      container: "mkv", videoCodec: "h264", audioCodec: "aac", audioChannels: "stereo",
      resolution: "1920×1080", bitrate: null, videoRange: "SDR", transcodeReason: null,
    } };
    h.playback.start.mockResolvedValue(candidate);
    h.internals.openPlaybackTarget = vi.fn(async () => ({ media: candidate.mediaUrl, subtitles: [] }));
    const attempts = vi.fn()
      .mockRejectedValueOnce(new AppError("VIDEO_OUTPUT_UNAVAILABLE", "synthetic D3D11 failure", 503))
      .mockResolvedValueOnce(undefined);
    h.internals.launchProcessAttempt = attempts;

    await expect(h.player.start("episode-1", "resume")).resolves.toMatchObject({ playbackId: "embedded-playback" });

    expect(attempts.mock.calls.map((call) => call[4])).toEqual(["d3d11", "opengl-software"]);
    expect(h.reports).toEqual([{ kind: "start", itemId: "episode-1" }]);
    expect(h.player.getState().diagnostics).toMatchObject({
      videoOutput: "opengl-software",
      videoOutputHealthy: false,
      hardwareDecoding: false,
      renderFallbackUsed: true,
    });
  });

  it("requires configured output for video but allows genuine audio-only tracks", async () => {
    const h = harness({ embedded: true });
    const videoIpc = {
      command: vi.fn(async (command: unknown[]) => {
        const property = command[1];
        if (property === "track-list") return [{ type: "video" }, { type: "audio" }];
        if (property === "vo-configured") return true;
        if (property === "current-vo") return "gpu-next";
        if (property === "video-format") return "nv12";
        if (property === "hwdec-current") return "d3d11va";
        return null;
      }),
    };
    await expect((h.player as never as { waitForEmbeddedVideoOutput(ipc: unknown): Promise<unknown> })
      .waitForEmbeddedVideoOutput(videoIpc)).resolves.toEqual({ hasVideo: true, hardwareDecoding: true });

    h.current.diagnostics = undefined;
    const audioIpc = { command: vi.fn(async () => [{ type: "audio" }]) };
    await expect((h.player as never as { waitForEmbeddedVideoOutput(ipc: unknown): Promise<unknown> })
      .waitForEmbeddedVideoOutput(audioIpc)).resolves.toEqual({ hasVideo: false, hardwareDecoding: null });
  });

  it("falls through failed local launches and reports only the successful server source", async () => {
    const h = harness();
    h.internals.source = null;
    h.internals.reportingActive = false;
    const localOne = {
      ...source("episode-1", "local-playback-1"),
      source: "local" as const,
      sourceKind: "matched-local" as const,
      delivery: "local" as const,
      mediaUrl: "D:\\Synthetic\\local-one.mkv",
      localVersionId: "local-version-1",
    };
    const localTwo = {
      ...localOne,
      playbackId: "local-playback-2",
      serverPlaySessionId: "local-playback-2",
      mediaUrl: "D:\\Synthetic\\local-two.mkv",
      localVersionId: "local-version-2",
    };
    const server = source("episode-1", "server-playback");
    h.playback.start.mockResolvedValue(localOne);
    const retryAfterLocalFailure = vi.fn()
      .mockResolvedValueOnce(localTwo)
      .mockResolvedValueOnce(server);
    h.playback.retryAfterLocalFailure = retryAfterLocalFailure;
    const openPlaybackTarget = vi.fn(async (candidate: ResolvedPlaybackSource) => ({ media: candidate.mediaUrl, subtitles: [] }));
    const launchProcess = vi.fn()
      .mockRejectedValueOnce(new Error("local one rejected"))
      .mockRejectedValueOnce(new Error("local two rejected"))
      .mockResolvedValueOnce(undefined);
    h.internals.openPlaybackTarget = openPlaybackTarget;
    h.internals.launchProcess = launchProcess;

    const started = await h.player.start("episode-1", "resume");

    expect(started).toMatchObject({ playbackId: "server-playback", source: "server" });
    expect(Object.keys(started).sort()).toEqual([
      "durationTicks", "playbackId", "resumePositionTicks", "source", "sourceKind",
    ]);
    expect(JSON.stringify(started)).not.toMatch(/serverPlaySessionId|mediaUrl|Synthetic|jellyfin-media|api[_-]?key/i);
    expect(retryAfterLocalFailure).toHaveBeenNthCalledWith(1, "local-playback-1", "resume");
    expect(retryAfterLocalFailure).toHaveBeenNthCalledWith(2, "local-playback-2", "resume");
    expect(launchProcess).toHaveBeenCalledTimes(3);
    expect(h.reports).toEqual([{ kind: "start", itemId: "episode-1" }]);
    expect(h.playback.stop).not.toHaveBeenCalled();
  });

  it("does not resurrect playback when stop wins a deferred start-report race", async () => {
    const h = harness();
    h.internals.source = null;
    h.internals.reportingActive = false;
    const candidate = source("episode-1", "deferred-start");
    h.playback.start.mockResolvedValue(candidate);
    h.internals.openPlaybackTarget = vi.fn(async () => ({ media: candidate.mediaUrl, subtitles: [] }));
    h.internals.launchProcess = vi.fn(async () => undefined);
    let releaseStart!: () => void;
    let observeStart!: () => void;
    const startObserved = new Promise<void>((resolve) => { observeStart = resolve; });
    const blockedStart = new Promise<void>((resolve) => { releaseStart = resolve; });
    const accepted: string[] = [];
    h.internals.reporting = {
      acceptAuthoritativeEvent: vi.fn(async (event: { kind: string }) => {
        accepted.push(event.kind);
        if (event.kind === "start") {
          observeStart();
          await blockedStart;
        }
      }),
    };

    const starting = h.player.start("episode-1", "resume");
    await startObserved;
    await h.player.stop(candidate.playbackId);
    releaseStart();

    await expect(starting).rejects.toMatchObject({ code: "PLAYBACK_CANCELLED" });
    expect(accepted).toEqual(["start", "stop"]);
    expect(h.player.getState()).toMatchObject({ playbackId: null, itemId: null, phase: "stopped" });
    expect(h.internals.reportingActive).toBe(false);
  });

  it("does not loop when the server launch also fails after local fallback", async () => {
    const h = harness();
    h.internals.source = null;
    h.internals.reportingActive = false;
    const local = {
      ...source("episode-1", "local-playback"),
      source: "local" as const,
      sourceKind: "downloaded" as const,
      delivery: "local" as const,
      mediaUrl: "D:\\Synthetic\\local.mkv",
      localVersionId: "local-version",
    };
    const server = source("episode-1", "server-playback");
    h.playback.start.mockResolvedValue(local);
    h.playback.retryAfterLocalFailure = vi.fn(async () => server);
    h.internals.openPlaybackTarget = vi.fn(async (candidate: ResolvedPlaybackSource) => ({ media: candidate.mediaUrl, subtitles: [] }));
    h.internals.launchProcess = vi.fn(async () => { throw new Error("launch rejected"); });

    await expect(h.player.start("episode-1", "resume")).rejects.toThrow("launch rejected");
    expect(h.playback.retryAfterLocalFailure).toHaveBeenCalledOnce();
    expect(h.internals.launchProcess).toHaveBeenCalledTimes(2);
    expect(h.reports).toEqual([]);
    expect(h.player.getState()).toMatchObject({ phase: "error" });
  });

  it.each(["error", "exit"] as const)("keeps local fallback authoritative when mpv emits an early %s", async (failureEvent) => {
    const h = harness();
    h.internals.source = null;
    h.internals.process = null;
    h.internals.ipc = null;
    h.internals.reportingActive = false;
    const local = {
      ...source("episode-1", "local-playback"),
      serverPlaySessionId: "local-playback",
      source: "local" as const,
      sourceKind: "downloaded" as const,
      delivery: "local" as const,
      mediaUrl: "D:\\Synthetic\\local.mkv",
      localVersionId: "local-version",
    };
    const server = source("episode-1", "server-playback");
    h.playback.start.mockResolvedValue(local);
    h.playback.retryAfterLocalFailure = vi.fn(async () => server);

    const children = [0, 1].map(() => {
      const child = new EventEmitter() as EventEmitter & { killed: boolean; kill: ReturnType<typeof vi.fn> };
      child.killed = false;
      child.kill = vi.fn(() => { child.killed = true; return true; });
      return child;
    });
    const spawnProcess = vi.fn(() => {
      const child = children[spawnProcess.mock.calls.length - 1]!;
      if (child === children[0]) queueMicrotask(() => {
        if (failureEvent === "error") child.emit("error", new Error("synthetic spawn failure"));
        else child.emit("exit", 1, null);
      });
      return child;
    });
    const pendingIpc = {
      connect: vi.fn(() => new Promise<void>(() => undefined)),
      observe: vi.fn(async () => undefined),
      onMessage: vi.fn(() => () => undefined),
      command: vi.fn(async () => null),
      close: vi.fn(),
    };
    const readyIpc = {
      connect: vi.fn(async () => undefined),
      observe: vi.fn(async () => undefined),
      onMessage: vi.fn(() => () => undefined),
      command: vi.fn(async (command: unknown[]) => command[0] === "get_property" ? 0 : null),
      close: vi.fn(),
    };
    const createIpcClient = vi.fn()
      .mockReturnValueOnce(pendingIpc)
      .mockReturnValueOnce(readyIpc);
    const unexpectedExit = vi.fn(async () => undefined);
    h.internals.spawnProcess = spawnProcess;
    h.internals.createIpcClient = createIpcClient;
    h.internals.handleUnexpectedProcessExit = unexpectedExit;

    await expect(h.player.start("episode-1", "resume")).resolves.toMatchObject({
      playbackId: "server-playback",
      source: "server",
    });
    expect(h.playback.retryAfterLocalFailure).toHaveBeenCalledWith("local-playback", "resume");
    expect(spawnProcess).toHaveBeenCalledTimes(2);
    expect(unexpectedExit).not.toHaveBeenCalled();
    expect(h.reports).toEqual([{ kind: "start", itemId: "episode-1" }]);
    await h.player.clear();
  });

  it("restarts sequential server streams at an absolute offset and reports the seek once", async () => {
    const h = harness();
    const progressive = {
      ...source("episode-1", "progressive-playback"),
      serverPlaySessionId: "server-session-1",
      sourceKind: "transcode" as const,
      delivery: "transcode" as const,
      usesServerTimelineOffset: true,
      resumePositionTicks: 20 * ticks,
    };
    h.internals.source = progressive;
    h.internals.timelineBaseTicks = 20 * ticks;
    (h.internals.state as Record<string, unknown>).playbackId = progressive.playbackId;
    (h.internals.state as Record<string, unknown>).positionTicks = 20 * ticks;
    (h.internals.state as Record<string, unknown>).volume = 37;
    (h.internals.state as Record<string, unknown>).fullscreen = true;
    (h.internals.state as Record<string, unknown>).audioTracks = [{
      id: 2, streamIndex: 1, type: "audio", title: "Main", language: "eng", selected: true,
      codec: "aac", channels: 2, isDefault: true, isForced: false, external: false,
    }];
    (h.internals.state as Record<string, unknown>).subtitleTracks = [{
      id: 5, streamIndex: 4, type: "subtitle", title: "English", language: "eng", selected: true,
      codec: "subrip", channels: null, isDefault: true, isForced: false, external: false,
    }];
    h.internals.playbackRate = 1.5;
    const setStreamStart = vi.fn();
    h.playback.setStreamStart = setStreamStart;
    const retainedIpc = h.internals.ipc;
    const launchProcess = vi.fn(async () => { h.internals.ipc = retainedIpc; });
    h.internals.launchProcess = launchProcess;

    await h.player.seek(progressive.playbackId, 40 * ticks);

    expect(setStreamStart).toHaveBeenCalledWith(progressive.playbackId, 40 * ticks);
    expect(launchProcess).toHaveBeenCalledWith(expect.any(Object), 0, false, true);
    expect(h.commands.some((command) => command[0] === "seek")).toBe(false);
    expect(h.commands).toEqual(expect.arrayContaining([
      ["set_property", "volume", 37],
      ["set_property", "speed", 1.5],
      ["set_property", "fullscreen", true],
      ["set_property", "aid", 2],
      ["set_property", "sid", 5],
    ]));
    expect(h.player.getState()).toMatchObject({
      positionTicks: 40 * ticks,
      volume: 37,
      fullscreen: true,
      diagnostics: { playbackRate: 1.5 },
      audioTracks: [expect.objectContaining({ id: 2, selected: true })],
      subtitleTracks: [expect.objectContaining({ id: 5, selected: true })],
    });
    expect(h.reports).toEqual([{ kind: "progress", itemId: "episode-1" }]);
  });

  it("cleans a partially launched server-stream seek and publishes a terminal error", async () => {
    const h = harness();
    h.window.isMinimized = vi.fn(() => true);
    const progressive = {
      ...source("episode-1", "progressive-playback"),
      sourceKind: "direct-stream" as const,
      usesServerTimelineOffset: true,
    };
    h.internals.source = progressive;
    (h.internals.state as Record<string, unknown>).playbackId = progressive.playbackId;
    h.playback.setStreamStart = vi.fn();
    const kill = vi.fn();
    const close = vi.fn();
    const failedIpcCommand = vi.fn(async () => undefined);
    h.internals.launchProcess = vi.fn(async () => {
      h.internals.process = { killed: false, kill };
      h.internals.ipc = { command: failedIpcCommand, close };
      h.internals.playbackTarget = { media: "http://127.0.0.1/partial", subtitles: [] };
      throw new Error("synthetic initialization failure");
    });

    await expect(h.player.seek(progressive.playbackId, 30 * ticks)).rejects.toMatchObject({ code: "SEEK_UNAVAILABLE" });

    expect(failedIpcCommand).toHaveBeenCalledWith(["quit"]);
    expect(close).toHaveBeenCalledOnce();
    expect(kill).toHaveBeenCalledOnce();
    expect(h.playback.clear).toHaveBeenCalledOnce();
    expect(h.proxy.close).toHaveBeenCalledTimes(2);
    expect(h.internals.source).toBeNull();
    expect(h.internals.process).toBeNull();
    expect(h.internals.ipc).toBeNull();
    expect(h.window.restore).toHaveBeenCalledOnce();
    expect(h.window.show).toHaveBeenCalledOnce();
    expect(h.window.focus).toHaveBeenCalledOnce();
    expect(h.player.getState()).toMatchObject({
      playbackId: null,
      itemId: "episode-1",
      phase: "error",
      buffering: false,
      error: "Playback could not resume after seeking.",
    });
    expect(h.reports).toEqual([{ kind: "stop", itemId: "episode-1" }]);
  });

  it("restores an external subtitle by its Jellyfin stream index after a server-stream seek", async () => {
    const h = harness({ externalSubtitleNext: true });
    const progressive = {
      ...source("episode-1", "progressive-playback"),
      sourceKind: "direct-stream" as const,
      usesServerTimelineOffset: true,
    };
    const oldSubtitle = {
      id: 9, streamIndex: null, type: "subtitle" as const, title: "English", language: "eng", selected: true,
      codec: "subrip", channels: null, isDefault: false, isForced: false, external: true,
    };
    const replacementSubtitle = { ...oldSubtitle, id: 12, selected: false };
    h.internals.source = progressive;
    (h.internals.state as Record<string, unknown>).playbackId = progressive.playbackId;
    (h.internals.state as Record<string, unknown>).subtitleTracks = [oldSubtitle];
    (h.internals.externalSubtitleStreamByTrackId as Map<number, number>).set(9, 4);
    h.playback.setStreamStart = vi.fn();
    const retainedIpc = h.internals.ipc;
    h.internals.launchProcess = vi.fn(async () => {
      h.internals.ipc = retainedIpc;
      h.internals.externalSubtitleStreamByTrackId = new Map([[12, 4]]);
      (h.internals.state as Record<string, unknown>).subtitleTracks = [replacementSubtitle];
    });

    await h.player.seek(progressive.playbackId, 30 * ticks);

    expect(h.commands).toContainEqual(["set_property", "sid", 12]);
    expect(h.player.getState().subtitleTracks).toEqual([
      expect.objectContaining({ id: 12, external: true, selected: true }),
    ]);
  });

  it("keeps sequential stream position absolute and derives buffer-ahead from cache end", () => {
    const h = harness();
    const progressive = {
      ...source("episode-1", "progressive-playback"),
      sourceKind: "direct-stream" as const,
      usesServerTimelineOffset: true,
      resumePositionTicks: 50 * ticks,
    };
    h.internals.source = progressive;
    h.internals.timelineBaseTicks = 50 * ticks;
    const handleMessage = (h.player as never as { handleMessage(message: unknown): void }).handleMessage.bind(h.player);

    handleMessage({ event: "property-change", name: "time-pos", data: 2 });
    handleMessage({ event: "property-change", name: "demuxer-cache-time", data: 7 });

    expect(h.player.getState()).toMatchObject({
      positionTicks: 52 * ticks,
      diagnostics: { bufferAheadTicks: 5 * ticks },
    });
  });

  it("reports a forced playback-engine exit as a system error, never completion", async () => {
    const h = harness({ embedded: true });
    await (h.player as never as { handleUnexpectedProcessExit(): Promise<void> }).handleUnexpectedProcessExit();
    expect(h.player.getState()).toMatchObject({ phase: "disconnected", playbackId: null, error: "The playback engine disconnected unexpectedly." });
    expect(h.reports).toEqual([{ kind: "stop", itemId: "episode-1" }]);
    expect(h.reportedEvents[0]).toMatchObject({ actionKind: "progress", watched: false });
    expect(h.playback.getNextUpForSeries).not.toHaveBeenCalled();
    expect(h.videoHost.hide).toHaveBeenCalledOnce();
  });

  it("auto-closes a movie after exactly one authoritative stop report", async () => {
    const h = harness();
    h.internals.source = source("movie-1", "movie-playback", "Movie");
    (h.internals.state as Record<string, unknown>).itemId = "movie-1";
    (h.internals.state as Record<string, unknown>).playbackId = "movie-playback";

    const handleMessage = (h.player as never as { handleMessage(message: unknown): void }).handleMessage.bind(h.player);
    handleMessage({ event: "property-change", name: "eof-reached", data: false });
    handleMessage({ event: "property-change", name: "eof-reached", data: true });
    handleMessage({ event: "end-file", reason: "eof" });
    await waitFor(() => h.player.getState().phase === "ended" && h.window.show.mock.calls.length === 1);

    expect(h.reports).toEqual([{ kind: "stop", itemId: "movie-1" }]);
    expect(h.reportedEvents[0]).toMatchObject({
      playMethod: "DirectPlay",
      actionKind: "completed",
      watched: true,
    });
    expect(h.playback.getNextUpForSeries).not.toHaveBeenCalled();
  });

  it("reports episode stop, shows 10 seconds, replaces in the same mpv session, then reports start", async () => {
    const h = harness({ nextId: "episode-2" });

    (h.player as never as { handleMessage(message: unknown): void }).handleMessage({ event: "end-file", reason: "eof" });
    await waitFor(() => h.player.getState().itemId === "episode-2" && h.player.getState().phase === "playing");

    expect(h.reports).toEqual([
      { kind: "stop", itemId: "episode-1" },
      { kind: "start", itemId: "episode-2" },
    ]);
    expect(h.commands.filter((command) => command[0] === "show-text")).toHaveLength(10);
    expect(h.commands.filter((command) => command[0] === "loadfile")).toHaveLength(1);
    expect(h.reportedEvents).toMatchObject([
      { actionKind: "completed", watched: true },
      { actionKind: "progress", watched: false },
    ]);
  });

  it("autoplay resolves a downloaded Next Up episode locally without opening the Jellyfin proxy", async () => {
    const h = harness({ nextId: "episode-2", localNext: true });

    (h.player as never as { handleMessage(message: unknown): void }).handleMessage({ event: "end-file", reason: "eof" });
    await waitFor(() => h.player.getState().itemId === "episode-2" && h.player.getState().phase === "playing");

    expect(h.player.getState().source).toBe("local");
    expect(h.proxy.open).not.toHaveBeenCalled();
    expect(h.commands).toContainEqual(["loadfile", "D:\\Authorized Downloads\\episode-2\\media.mkv", "replace"]);
    expect(h.reportedEvents.at(-1)).toMatchObject({
      kind: "start",
      itemId: "episode-2",
      playMethod: "DirectPlay",
    });
  });

  it("falls back from an unreadable local Next Up and resets the previous server timeline", async () => {
    const h = harness({ nextId: "episode-2" });
    h.current.sourceKind = "direct-stream";
    h.current.usesServerTimelineOffset = true;
    h.current.resumePositionTicks = 40 * ticks;
    h.internals.timelineBaseTicks = 40 * ticks;
    (h.internals.state as Record<string, unknown>).volume = 37;
    (h.internals.state as Record<string, unknown>).fullscreen = true;
    const local = {
      ...source("episode-2", "local-next"),
      serverPlaySessionId: "local-next",
      source: "local" as const,
      sourceKind: "downloaded" as const,
      delivery: "local" as const,
      mediaUrl: "D:\\Synthetic\\episode-2.mkv",
      localVersionId: "local-next-version",
    };
    const server = source("episode-2", "server-next");
    h.playback.start.mockResolvedValue(local);
    h.playback.retryAfterLocalFailure = vi.fn(async () => server);
    const ipc = h.internals.ipc as { command(command: unknown[]): Promise<unknown> };
    const originalCommand = ipc.command.bind(ipc);
    let loadAttempts = 0;
    ipc.command = async (command: unknown[]) => {
      if (command[0] === "loadfile") {
        loadAttempts += 1;
        if (loadAttempts === 1) {
          h.commands.push(command);
          throw new Error("synthetic local load failure");
        }
      }
      return originalCommand(command);
    };

    (h.player as never as { handleMessage(message: unknown): void }).handleMessage({ event: "end-file", reason: "eof" });
    await waitFor(() => h.player.getState().itemId === "episode-2" && h.player.getState().phase === "playing");

    expect(h.playback.retryAfterLocalFailure).toHaveBeenCalledWith("local-next", "start-over");
    expect(loadAttempts).toBe(2);
    expect(h.internals.timelineBaseTicks).toBe(0);
    expect(h.player.getState()).toMatchObject({
      playbackId: "server-next",
      source: "server",
      positionTicks: 0,
      volume: 37,
      fullscreen: true,
      diagnostics: { sourceKind: "direct-play" },
    });
    expect(h.reports).toEqual([
      { kind: "stop", itemId: "episode-1" },
      { kind: "start", itemId: "episode-2" },
    ]);
  });

  it("attaches Jellyfin external subtitles after replacing the file for Next Up", async () => {
    const h = harness({ nextId: "episode-2", externalSubtitleNext: true });

    (h.player as never as { handleMessage(message: unknown): void }).handleMessage({ event: "end-file", reason: "eof" });
    await waitFor(() => h.player.getState().itemId === "episode-2" && h.player.getState().phase === "playing");

    expect(h.commands).toContainEqual([
      "sub-add",
      "http://127.0.0.1/subtitle.srt",
      "auto",
      "English - External",
      "eng",
    ]);
  });

  it("reports the selected external subtitle by its verified mpv track mapping", async () => {
    const h = harness();
    h.current.externalSubtitles = [
      { streamIndex: 4, format: "srt", title: "English", language: "eng", isDefault: false, isForced: false },
      { streamIndex: 7, format: "srt", title: "English", language: "eng", isDefault: false, isForced: false },
    ];
    (h.internals.state as Record<string, unknown>).subtitleTracks = [
      { id: 10, type: "subtitle", title: "English", language: "eng", selected: false, external: true, streamIndex: null },
      { id: 11, type: "subtitle", title: "English", language: "eng", selected: true, external: true, streamIndex: null },
    ];
    const mapping = h.internals.externalSubtitleStreamByTrackId as Map<number, number>;
    mapping.set(10, 4);
    mapping.set(11, 7);

    await (h.player as never as { report(kind: "progress"): Promise<void> }).report("progress");

    expect(h.reportedEvents.at(-1)).toMatchObject({ subtitleStreamIndex: 7 });
  });

  it("suppresses solo Next Up when a watch-party coordinator assigns another participant", async () => {
    const h = harness({ nextId: "episode-2" });
    h.player.setAutomaticTransitionsEnabled(false);

    (h.player as never as { handleMessage(message: unknown): void }).handleMessage({ event: "end-file", reason: "eof" });
    await waitFor(() => h.window.show.mock.calls.length === 1);

    expect(h.playback.getNextUpForSeries).not.toHaveBeenCalled();
    expect(h.commands.some((command) => command[0] === "loadfile")).toBe(false);
    expect(h.player.getState().phase).toBe("ended");
  });

  it.each([
    ["no next episode", { nextId: null }],
    ["next source resolution failure", { nextId: "episode-2", failNextStart: true }],
  ])("closes cleanly on %s without a stale start report", async (_name, options) => {
    const h = harness(options);

    (h.player as never as { handleMessage(message: unknown): void }).handleMessage({ event: "end-file", reason: "eof" });
    await waitFor(() => h.window.show.mock.calls.length === 1);

    expect(h.reports).toEqual([{ kind: "stop", itemId: "episode-1" }]);
    expect(h.player.getState().phase).toBe("ended");
  });

  it.each(["quit", "error", "stop"])("does not autoplay after mpv end reason %s", async (reason) => {
    const h = harness();
    (h.player as never as { handleMessage(message: unknown): void }).handleMessage({ event: "end-file", reason });
    await waitFor(() => h.window.show.mock.calls.length === 1);
    expect(h.playback.getNextUpForSeries).not.toHaveBeenCalled();
    expect(h.reports).toEqual([{ kind: "stop", itemId: "episode-1" }]);
  });

  it("cancels the countdown when Esc closes the player", async () => {
    const h = harness();
    let waits = 0;
    h.internals.completion = new PlaybackCompletionCoordinator(10, 3, async () => {
      waits += 1;
      if (waits === 1) {
        (h.player as never as { handleMessage(message: unknown): void }).handleMessage({
          event: "client-message",
          args: ["jellyfin-close"],
        });
      }
    });

    (h.player as never as { handleMessage(message: unknown): void }).handleMessage({ event: "end-file", reason: "eof" });
    await waitFor(() => h.window.show.mock.calls.length === 1);

    expect(h.commands.filter((command) => command[0] === "show-text")).toHaveLength(1);
    expect(h.commands.some((command) => command[0] === "loadfile")).toBe(false);
    expect(h.reports).toEqual([{ kind: "stop", itemId: "episode-1" }]);
  });

  it("cancels a pending Next Up lookup when logout clears the playback revision", async () => {
    const h = harness();
    let resolveLookup!: (value: ReturnType<typeof nextEpisode>) => void;
    h.playback.getNextUpForSeries.mockImplementation(() => new Promise((resolve) => { resolveLookup = resolve; }));

    (h.player as never as { handleMessage(message: unknown): void }).handleMessage({ event: "end-file", reason: "eof" });
    await waitFor(() => h.playback.getNextUpForSeries.mock.calls.length === 1);
    await h.player.clear();
    resolveLookup(nextEpisode("episode-2"));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(h.commands.some((command) => command[0] === "loadfile")).toBe(false);
    expect(h.reports).toEqual([{ kind: "stop", itemId: "episode-1" }]);
  });
});
