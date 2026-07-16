import { describe, expect, it, vi } from "vitest";
import { MpvPlayerService, parsePlaybackTracks } from "../src/main/services/mpvPlayer";
import type { PlayerControllerEvent } from "../src/main/services/playerController";

function harness() {
  const commands: unknown[][] = [];
  const player = new MpvPlayerService(
    { isDestroyed: () => false, minimize: vi.fn(), isMinimized: () => false, restore: vi.fn(), show: vi.fn(), focus: vi.fn() } as never,
    { clear: vi.fn(), stop: vi.fn() } as never,
    { acceptAuthoritativeEvent: vi.fn(async () => undefined) } as never,
    { get: async () => ({ windowMaximized: true }), setWindowMaximized: async () => undefined },
    { executable: "mpv.exe", inputConfig: "input.conf" },
  );
  const internals = player as unknown as Record<string, unknown>;
  internals.source = {
    itemId: "movie-1",
    playbackId: "playback-1",
    itemType: "Movie",
    seriesId: null,
    mediaSourceId: "source-1",
    mediaUrl: "jellyfin-media://stream/playback-1",
    delivery: "direct",
    resumePositionTicks: 0,
    durationTicks: 600_000_000,
    source: "server",
    initialAction: "progress",
  };
  internals.state = {
    playbackId: "playback-1",
    itemId: "movie-1",
    phase: "playing",
    source: "server",
    positionTicks: 10_000_000,
    durationTicks: 600_000_000,
    paused: false,
    buffering: false,
    seekable: true,
    volume: 100,
    fullscreen: false,
    audioTracks: [],
    subtitleTracks: [],
    error: null,
  };
  internals.reportingActive = true;
  internals.ipc = {
    async command(command: unknown[]) { commands.push(command); return null; },
  };
  const events: PlayerControllerEvent[] = [];
  player.onEvent((event) => events.push(event));
  const message = (value: unknown) => (player as never as { handleMessage(message: unknown): void }).handleMessage(value);
  return { player, commands, events, message };
}

describe("PlayerController mpv adapter", () => {
  it("preserves remote origin and revision without reclassifying mpv acknowledgement as local", async () => {
    const h = harness();
    await h.player.setPaused("playback-1", true, {
      origin: "remote-sync",
      commandRevision: 12,
      commandId: "command-12",
    });
    h.message({ event: "property-change", name: "pause", data: true });

    expect(h.commands).toContainEqual(["set_property", "pause", true]);
    expect(h.events[0]).toMatchObject({
      action: "pause",
      origin: "remote-sync",
      commandRevision: 12,
      commandId: "command-12",
    });
    expect(h.events.some((event) => event.origin === "local-user")).toBe(false);
  });

  it("classifies native mpv play, pause, seek, and fullscreen changes as local user actions", () => {
    const h = harness();
    h.message({ event: "property-change", name: "pause", data: true });
    h.message({ event: "property-change", name: "pause", data: false });
    h.message({ event: "property-change", name: "time-pos", data: 20 });
    h.message({ event: "property-change", name: "fullscreen", data: true });

    expect(h.events.filter((event) => event.origin === "local-user").map((event) => event.action)).toEqual([
      "pause",
      "play",
      "seek",
      "fullscreen",
    ]);
    expect(new Set(h.events.map((event) => event.controllerRevision)).size).toBe(h.events.length);
    expect(h.events.every((event) => event.monotonicTimestampMs >= 0)).toBe(true);
  });

  it("supports user playback speeds while bounding automatic drift correction", async () => {
    const h = harness();
    await h.player.setPlaybackRate("playback-1", 1.05, { origin: "remote-sync", commandRevision: 3 });
    expect(h.player.getPlaybackRate()).toBe(1.05);
    expect(h.commands).toContainEqual(["set_property", "speed", 1.05]);
    await expect(h.player.setPlaybackRate("playback-1", 1.5, { origin: "remote-sync" })).rejects.toMatchObject({ code: "INVALID_PLAYBACK_RATE" });
    await expect(h.player.setRate("playback-1", 1.5)).resolves.toMatchObject({
      diagnostics: expect.objectContaining({ playbackRate: 1.5 }),
    });
  });

  it("sets bounded volume and publishes the new state immediately", async () => {
    const h = harness();
    const states: number[] = [];
    h.player.onState((state) => states.push(state.volume));

    await expect(h.player.setVolume("playback-1", 42)).resolves.toMatchObject({ volume: 42 });
    expect(h.commands).toContainEqual(["set_property", "volume", 42]);
    expect(states).toEqual([42]);
    expect(h.events.at(-1)).toMatchObject({ action: "volume", origin: "local-user", state: { volume: 42 } });
    await expect(h.player.setVolume("playback-1", 101)).rejects.toMatchObject({ code: "INVALID_PLAYBACK_VOLUME" });
  });

  it("turns the native Ctrl+R message into a local resync request and can show safe feedback", async () => {
    const h = harness();
    h.message({ event: "client-message", args: ["jellyfin-resync"] });
    await h.player.showMessage("playback-1", "Resynced\nthis computer", 25_000);

    expect(h.events.at(-1)).toMatchObject({ action: "resync-request", origin: "local-user" });
    expect(h.commands).toContainEqual(["show-text", "Resynced this computer", 5000]);
  });

  it("tracks buffering and item-independent state without exposing mpv internals", () => {
    const h = harness();
    h.message({ event: "property-change", name: "paused-for-cache", data: true });
    expect(h.player.getState()).toMatchObject({ buffering: true, phase: "buffering" });
    expect(h.events.at(-1)).toMatchObject({ action: "buffering", origin: "system" });
    expect(JSON.stringify(h.events.at(-1))).not.toContain("jellyfin-media://");
  });

  it("promotes a continuous measured cache wait to stalled and recovers cleanly", async () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      h.message({ event: "property-change", name: "paused-for-cache", data: true });
      expect(h.player.getState().phase).toBe("buffering");
      await vi.advanceTimersByTimeAsync(10_000);
      expect(h.player.getState().phase).toBe("stalled");
      expect(h.events.at(-1)).toMatchObject({ action: "stalled", origin: "system" });
      h.message({ event: "property-change", name: "paused-for-cache", data: false });
      expect(h.player.getState().phase).toBe("playing");
    } finally {
      vi.useRealTimers();
    }
  });

  it("sanitizes rich mpv track metadata while retaining future stream mapping", () => {
    expect(parsePlaybackTracks([
      { id: 1, type: "audio", title: "English", lang: "eng", selected: true, codec: "aac", "ff-index": 2, "demux-channel-count": 6, default: true },
      { id: 3, type: "sub", title: "Signs", lang: "eng", selected: false, codec: "subrip", "ff-index": 4, forced: true, external: true },
      { id: "bad", type: "audio", title: "ignored" },
    ])).toEqual({
      audioTracks: [expect.objectContaining({ id: 1, streamIndex: 2, codec: "aac", channels: 6, isDefault: true })],
      subtitleTracks: [expect.objectContaining({ id: 3, streamIndex: 4, codec: "subrip", isForced: true, external: true })],
    });
  });
});
