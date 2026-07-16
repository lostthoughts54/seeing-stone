import { describe, expect, it, vi } from "vitest";
import { PlaybackReportingService } from "../src/main/services/playbackReporting";
import type { PlaybackRevisionRecord } from "../src/main/services/persistenceTypes";

function revision(localRevision: number): PlaybackRevisionRecord {
  return {
    serverId: "server-1",
    userId: "user-1",
    itemId: "episode-1",
    localRevision,
    actionKind: localRevision === 1 ? "replay" : "progress",
    positionTicks: 0,
    watched: false,
    completionEvent: false,
    occurredAt: localRevision,
    syncState: "pending",
    attemptCount: 0,
    lastError: null,
    syncedAt: null,
    report: null,
  };
}

describe("PlaybackReportingService durable main-side boundary", () => {
  it("persists authoritative events, tracks active playback, and defers network failures", async () => {
    const first = revision(1);
    const second = revision(2);
    const capture = vi.fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);
    const setActive = vi.fn();
    const flushCapture = vi.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const reportAuthoritativePlayback = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error("offline"), { code: "NETWORK_ERROR" }))
      .mockResolvedValueOnce(undefined);
    const warn = vi.fn();
    const service = new PlaybackReportingService(
      { reportAuthoritativePlayback } as never,
      { capture, setActive, flushCapture },
      { info() {}, warn, error() {} },
    );

    await service.acceptAuthoritativeEvent({
      kind: "start",
      itemId: "episode-1",
      mediaSourceId: "source-1",
      playMethod: "DirectPlay",
      playSessionId: "play-session-1",
      positionTicks: 0,
      paused: false,
      canSeek: true,
      audioStreamIndex: 1,
      subtitleStreamIndex: null,
      actionKind: "replay",
      watched: false,
      conflictPolicy: "explicit",
    });
    await service.acceptAuthoritativeEvent({
      kind: "stop",
      itemId: "episode-1",
      mediaSourceId: "source-1",
      playMethod: "DirectPlay",
      playSessionId: "play-session-1",
      positionTicks: 200,
      paused: false,
      canSeek: true,
      audioStreamIndex: 1,
      subtitleStreamIndex: null,
      actionKind: "progress",
      watched: false,
      conflictPolicy: "explicit",
    });

    expect(capture).toHaveBeenNthCalledWith(1, {
      itemId: "episode-1",
      actionKind: "replay",
      positionTicks: 0,
      watched: false,
      report: {
        kind: "start",
        mediaSourceId: "source-1",
        playMethod: "DirectPlay",
        playSessionId: "play-session-1",
        paused: false,
        canSeek: true,
        audioStreamIndex: 1,
        subtitleStreamIndex: null,
        conflictPolicy: "explicit",
      },
    });
    expect(setActive).toHaveBeenNthCalledWith(1, first, true);
    expect(setActive).toHaveBeenNthCalledWith(2, second, false);
    expect(flushCapture).toHaveBeenNthCalledWith(1, first);
    expect(flushCapture).toHaveBeenNthCalledWith(2, second);
    expect(reportAuthoritativePlayback).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith("Authoritative playback reporting was deferred.", expect.any(Object));
  });

  it("does not bypass older durable rows when persistence capture fails", async () => {
    const capture = vi.fn(async () => { throw new Error("database unavailable"); });
    const reportAuthoritativePlayback = vi.fn();
    const warn = vi.fn();
    const service = new PlaybackReportingService(
      { reportAuthoritativePlayback } as never,
      { capture, setActive: vi.fn(), flushCapture: vi.fn() },
      { info() {}, warn, error() {} },
    );

    await service.acceptAuthoritativeEvent({
      kind: "progress",
      itemId: "episode-1",
      mediaSourceId: "source-1",
      playMethod: "DirectPlay",
      playSessionId: "play-session-1",
      positionTicks: 100,
      paused: false,
      canSeek: true,
      audioStreamIndex: null,
      subtitleStreamIndex: null,
      actionKind: "progress",
      watched: false,
      conflictPolicy: "automatic",
    });

    expect(reportAuthoritativePlayback).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      "Authoritative playback reporting was not sent because durable capture was unavailable.",
      { kind: "progress" },
    );
  });
});
