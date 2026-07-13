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
    const markCaptureFailed = vi.fn(async () => undefined);
    const reportAuthoritativePlayback = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error("offline"), { code: "NETWORK_ERROR" }))
      .mockResolvedValueOnce(undefined);
    const warn = vi.fn();
    const service = new PlaybackReportingService(
      { reportAuthoritativePlayback } as never,
      { capture, setActive, markCaptureFailed },
      { info() {}, warn, error() {} },
    );

    await service.acceptAuthoritativeEvent({
      kind: "start",
      itemId: "episode-1",
      mediaSourceId: "source-1",
      playMethod: "DirectPlay",
      positionTicks: 0,
      paused: false,
      actionKind: "replay",
      watched: false,
    });
    await service.acceptAuthoritativeEvent({
      kind: "stop",
      itemId: "episode-1",
      mediaSourceId: "source-1",
      playMethod: "DirectPlay",
      positionTicks: 200,
      paused: false,
      actionKind: "progress",
      watched: false,
    });

    expect(capture).toHaveBeenNthCalledWith(1, {
      itemId: "episode-1",
      actionKind: "replay",
      positionTicks: 0,
      watched: false,
    });
    expect(setActive).toHaveBeenNthCalledWith(1, first, true);
    expect(setActive).toHaveBeenNthCalledWith(2, second, false);
    expect(markCaptureFailed).toHaveBeenCalledWith(first, expect.objectContaining({ code: "NETWORK_ERROR" }));
    expect(reportAuthoritativePlayback).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith("Authoritative playback reporting was deferred.", expect.any(Object));
  });
});
