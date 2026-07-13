import { describe, expect, it, vi } from "vitest";
import { MpvPlayerService } from "../src/main/services/mpvPlayer";
import type { PlayerControllerEvent } from "../src/main/services/playerController";

function harness() {
  const commands: unknown[][] = [];
  const player = new MpvPlayerService(
    { isDestroyed: () => false, hide: vi.fn(), show: vi.fn(), focus: vi.fn() } as never,
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

  it("supports only bounded drift-correction playback rates", async () => {
    const h = harness();
    await h.player.setPlaybackRate("playback-1", 1.05, { origin: "remote-sync", commandRevision: 3 });
    expect(h.player.getPlaybackRate()).toBe(1.05);
    expect(h.commands).toContainEqual(["set_property", "speed", 1.05]);
    await expect(h.player.setPlaybackRate("playback-1", 1.5)).rejects.toMatchObject({ code: "INVALID_PLAYBACK_RATE" });
  });

  it("tracks buffering and item-independent state without exposing mpv internals", () => {
    const h = harness();
    h.message({ event: "property-change", name: "paused-for-cache", data: true });
    expect(h.player.getState()).toMatchObject({ buffering: true, phase: "buffering" });
    expect(h.events.at(-1)).toMatchObject({ action: "buffering", origin: "system" });
    expect(JSON.stringify(h.events.at(-1))).not.toContain("jellyfin-media://");
  });
});
