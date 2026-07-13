import { describe, expect, it, vi } from "vitest";
import { MpvPlayerService } from "../src/main/services/mpvPlayer";
import { PlaybackCompletionCoordinator } from "../src/main/services/playbackCompletion";
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
    itemType,
    seriesId: itemType === "Episode" ? "series-1" : null,
    mediaSourceId: `media-${itemId}`,
    mediaUrl: `jellyfin-media://stream/${playbackId}`,
    delivery: "direct",
    resumePositionTicks: 0,
    durationTicks: 60 * ticks,
    source: "server",
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

function harness(options: { nextId?: string | null; failNextStart?: boolean; localNext?: boolean } = {}) {
  const current = source("episode-1", "playback-1");
  const replacement = source(options.nextId || "episode-2", "playback-2");
  if (options.localNext) {
    replacement.source = "local";
    replacement.delivery = "local";
    replacement.mediaUrl = "D:\\Authorized Downloads\\episode-2\\media.mkv";
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
  const window = { isDestroyed: () => false, hide: vi.fn(), show: vi.fn(), focus: vi.fn() };
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
  const player = new MpvPlayerService(
    window as never,
    playback as never,
    { acceptAuthoritativeEvent: vi.fn(async (event) => {
      reports.push({ kind: event.kind, itemId: event.itemId });
      reportedEvents.push(event);
    }) } as never,
    { get: async () => ({ windowMaximized: true }), setWindowMaximized: async () => undefined },
    { executable: "mpv.exe", inputConfig: "input.conf" },
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
    fullscreen: false,
    audioTracks: [],
    subtitleTracks: [],
    error: null,
  };
  internals.ipc = ipc;
  const proxy = { close: vi.fn(async () => undefined), open: vi.fn(async () => "http://127.0.0.1/next") };
  internals.proxy = proxy;
  internals.playbackTarget = "http://127.0.0.1/current";
  internals.reportingActive = true;
  internals.playbackRevision = 1;
  internals.completion = new PlaybackCompletionCoordinator(10, 3, async () => undefined);
  return { player, internals, playback, reports, reportedEvents, commands, window, current, proxy };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for player state.");
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe("MpvPlayerService natural completion", () => {
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
    expect(h.reportedEvents[0]).toMatchObject({ playMethod: "DirectStream" });
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
