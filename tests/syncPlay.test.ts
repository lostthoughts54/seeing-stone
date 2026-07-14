import { describe, expect, it, vi } from "vitest";
import { SyncPlayService } from "../src/main/services/syncPlay";
import { AppError } from "../src/main/services/errors";
import type { PlayerControllerEvent } from "../src/main/services/playerController";
import type { PlaybackState } from "../src/shared/contracts";

const groupId = "11111111111141118111111111111111";
const otherGroupId = "22222222222242228222222222222222";
const itemId = "33333333333343338333333333333333";
const playlistItemId = "44444444444444448444444444444444";

function playbackState(overrides: Partial<PlaybackState> = {}): PlaybackState {
  return {
    playbackId: "55555555-5555-4555-8555-555555555555",
    itemId,
    phase: "playing",
    source: "local",
    positionTicks: 10_000_000,
    durationTicks: 600_000_000,
    paused: false,
    buffering: false,
    seekable: true,
    fullscreen: false,
    audioTracks: [],
    subtitleTracks: [],
    error: null,
    ...overrides,
  };
}

function harness() {
  const requests: Array<{ path: string; body: unknown; method: string }> = [];
  const api = {
    getDetails: vi.fn(async () => ({ userData: { playbackPositionTicks: 25_000_000 } })),
    getServerTime: vi.fn(async () => ({ requestReceptionTime: new Date().toISOString(), responseTransmissionTime: new Date().toISOString() })),
    syncPlayRequest: vi.fn(async (path: string, body?: unknown, method = body === undefined ? "GET" : "POST") => {
      requests.push({ path, body, method });
      if (path === "/SyncPlay/List") return [{
        GroupId: groupId,
        GroupName: "Movie night",
        State: "Paused",
        Participants: ["Adam", "Kayla"],
        LastUpdatedAt: "2026-07-13T20:00:00.000Z",
      }];
      return null;
    }),
  };
  let state = playbackState();
  let playbackRate = 1;
  const events = new Set<(event: PlayerControllerEvent) => void>();
  const player = {
    onState: vi.fn(() => () => undefined),
    onEvent(listener: (event: PlayerControllerEvent) => void) { events.add(listener); return () => events.delete(listener); },
    getState: () => structuredClone(state),
    getControllerRevision: () => 1,
    getPlaybackRate: () => playbackRate,
    setAutomaticTransitionsEnabled: vi.fn(),
    loadItem: vi.fn(async (nextItemId: string) => {
      state = playbackState({ itemId: nextItemId, source: "local", positionTicks: 0 });
      return { playbackId: state.playbackId!, resumePositionTicks: 0, durationTicks: state.durationTicks, source: "local" as const };
    }),
    setPaused: vi.fn(async (_playbackId: string, paused: boolean) => {
      state = playbackState({ paused, phase: paused ? "paused" : "playing" });
      return state;
    }),
    seek: vi.fn(async (_playbackId: string, positionTicks: number) => {
      state = playbackState({ positionTicks });
      return state;
    }),
    setPlaybackRate: vi.fn(async (_playbackId: string, rate: number) => { playbackRate = rate; return state; }),
    selectAudio: vi.fn(async () => state),
    selectSubtitle: vi.fn(async () => state),
    setFullscreen: vi.fn(async () => state),
    stop: vi.fn(async () => { state = playbackState({ playbackId: null, itemId: null, phase: "stopped", source: null }); return state; }),
    clear: vi.fn(async () => undefined),
  };
  const service = new SyncPlayService(api as never, player as never, { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, 60_000);
  const internals = service as unknown as Record<string, any>;
  internals.state = {
    availability: "available",
    connection: "connected",
    groups: [],
    joinedGroup: {
      groupId,
      name: "Movie night",
      playbackState: "Playing",
      participants: ["Adam", "Kayla"],
      participantCount: 2,
      lastUpdatedAt: "2026-07-13T20:00:00.000Z",
      currentItemId: itemId,
      playlistItemId,
    },
    sharedControls: true,
    error: null,
  };
  internals.currentPlaylistItemId = playlistItemId;
  internals.timeSyncReady = true;
  const receive = (value: unknown) => internals.receiveMessage(Buffer.from(JSON.stringify(value)));
  return { service, internals, api, player, requests, receive };
}

function envelope(messageId: string, messageType: "SyncPlayGroupUpdate" | "SyncPlayCommand", data: unknown) {
  return { MessageId: messageId, MessageType: messageType, Data: data };
}

describe("SyncPlayService", () => {
  it("sanitizes the authenticated server group list", async () => {
    const h = harness();
    const result = await h.service.list();
    expect(result.groups).toEqual([{
      groupId,
      name: "Movie night",
      playbackState: "Paused",
      participants: ["Adam", "Kayla"],
      participantCount: 2,
      lastUpdatedAt: "2026-07-13T20:00:00.000Z",
    }]);
    expect(JSON.stringify(result)).not.toMatch(/Token|authorization|Path|Url/);
  });

  it("loads the exact queue item through PlayerController and reports readiness", async () => {
    const h = harness();
    const nextItem = "66666666666646668666666666666666";
    const nextPlaylist = "77777777777747778777777777777777";
    const queueEnvelope = envelope("88888888888848888888888888888888", "SyncPlayGroupUpdate", {
      GroupId: groupId,
      Type: "PlayQueue",
      Data: {
        Reason: "NewPlaylist",
        LastUpdate: "2026-07-13T20:01:00.000Z",
        Playlist: [{ ItemId: nextItem, PlaylistItemId: nextPlaylist }],
        PlayingItemIndex: 0,
        StartPositionTicks: 30_000_000,
        IsPlaying: false,
        ShuffleMode: "Sorted",
        RepeatMode: "RepeatNone",
      },
    });
    h.receive(queueEnvelope);
    h.receive(queueEnvelope);
    await h.internals.queueTask;

    expect(h.player.loadItem).toHaveBeenCalledWith(nextItem, "start-over", expect.objectContaining({ origin: "remote-sync" }));
    expect(h.player.seek).toHaveBeenCalledWith(expect.any(String), 30_000_000, expect.objectContaining({ origin: "remote-sync" }));
    expect(h.requests.at(-1)).toMatchObject({
      path: "/SyncPlay/Ready",
      body: { PositionTicks: 30_000_000, PlaylistItemId: nextPlaylist },
    });
    expect(h.service.getState().joinedGroup).toMatchObject({ currentItemId: nextItem, playlistItemId: nextPlaylist });
  });

  it("rejects queue payloads containing unpinned media locations", async () => {
    const h = harness();
    h.receive(envelope("89898989898949898989898989898989", "SyncPlayGroupUpdate", {
      GroupId: groupId,
      Type: "PlayQueue",
      Data: {
        Reason: "NewPlaylist",
        LastUpdate: "2026-07-13T20:01:00.000Z",
        Playlist: [{ ItemId: itemId, PlaylistItemId: playlistItemId }],
        PlayingItemIndex: 0,
        StartPositionTicks: 0,
        IsPlaying: true,
        ShuffleMode: "Sorted",
        RepeatMode: "RepeatNone",
        MediaUrl: "https://untrusted.example/video.mkv",
      },
    }));
    await h.internals.queueTask;

    expect(h.player.loadItem).not.toHaveBeenCalled();
    expect(h.requests).toHaveLength(0);
  });

  it("cancels a scheduled command when the client leaves that membership", async () => {
    const h = harness();
    h.receive(envelope("dddddddddddd4ddd8ddddddddddddddd", "SyncPlayCommand", {
      GroupId: groupId,
      PlaylistItemId: playlistItemId,
      When: new Date(Date.now() + 50).toISOString(),
      PositionTicks: 40_000_000,
      Command: "Seek",
      EmittedAt: new Date().toISOString(),
    }));
    h.internals.clearJoinedGroup();
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(h.player.seek).not.toHaveBeenCalled();
  });

  it("rejects malformed, duplicate, wrong-group, and stale commands", async () => {
    const h = harness();
    const valid = {
      GroupId: groupId,
      PlaylistItemId: playlistItemId,
      When: new Date(Date.now() - 10).toISOString(),
      PositionTicks: 20_000_000,
      Command: "Seek",
      EmittedAt: new Date().toISOString(),
    };
    h.receive(envelope("99999999999949998999999999999999", "SyncPlayCommand", { ...valid, GroupId: otherGroupId }));
    h.receive(envelope("aaaaaaaaaaaa4aaa8aaaaaaaaaaaaaaa", "SyncPlayCommand", { ...valid, PlaylistItemId: "not-a-guid" }));
    h.receive(envelope("bbbbbbbbbbbb4bbb8bbbbbbbbbbbbbbb", "SyncPlayCommand", { ...valid, EmittedAt: "2020-01-01T00:00:00.000Z" }));
    h.receive(envelope("cccccccccccc4ccc8ccccccccccccccc", "SyncPlayCommand", valid));
    h.receive(envelope("cccccccccccc4ccc8ccccccccccccccc", "SyncPlayCommand", valid));
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(h.player.seek).toHaveBeenCalledTimes(1);
    expect(h.player.seek).toHaveBeenCalledWith(expect.any(String), 20_000_000, expect.objectContaining({ origin: "remote-sync" }));
  });

  it("does not rebroadcast remote player actions but forwards native local controls", async () => {
    const h = harness();
    const base = {
      action: "pause" as const,
      commandRevision: 1,
      commandId: "command-1",
      controllerRevision: 2,
      monotonicTimestampMs: 10,
      state: playbackState({ paused: true }),
    };
    await h.internals.handlePlayerEvent({ ...base, origin: "remote-sync" });
    expect(h.requests).toHaveLength(0);
    await h.internals.handlePlayerEvent({ ...base, origin: "local-user", commandId: null, commandRevision: null });
    expect(h.requests).toEqual([{ path: "/SyncPlay/Pause", body: {}, method: "POST" }]);
  });

  it("tolerates small drift, rate-corrects medium drift, and seeks only for large drift", async () => {
    const h = harness();
    const anchor = (positionTicks: number) => {
      h.internals.syncAnchor = {
        membershipRevision: h.internals.membershipRevision,
        playlistItemId,
        positionTicks,
        playing: true,
        monotonicTimestampMs: performance.now(),
      };
    };

    anchor(14_000_000);
    await h.internals.correctDrift();
    expect(h.player.setPlaybackRate).not.toHaveBeenCalled();
    expect(h.player.seek).not.toHaveBeenCalled();

    anchor(28_000_000);
    await h.internals.correctDrift();
    expect(h.player.setPlaybackRate).toHaveBeenLastCalledWith(expect.any(String), 1.02, expect.objectContaining({ origin: "remote-sync" }));
    expect(h.player.seek).not.toHaveBeenCalled();

    anchor(60_000_000);
    await h.internals.correctDrift();
    expect(h.player.setPlaybackRate).toHaveBeenLastCalledWith(expect.any(String), 1, expect.objectContaining({ origin: "remote-sync" }));
    expect(h.player.seek).toHaveBeenCalledTimes(1);
  });

  it("uses the lowest-delay NTP sample and reports half-round-trip ping", async () => {
    const h = harness();
    const dateNow = vi.spyOn(Date, "now").mockReturnValueOnce(1_000).mockReturnValueOnce(1_020);
    h.api.getServerTime.mockResolvedValueOnce({
      requestReceptionTime: new Date(1_105).toISOString(),
      responseTransmissionTime: new Date(1_105).toISOString(),
    });
    await h.internals.synchronizeTime(1);

    expect(h.internals.serverTimeOffsetMs).toBe(95);
    expect(h.internals.timeSyncReady).toBe(true);
    expect(h.internals.latencyMs).toBe(10);
    expect(h.requests.at(-1)).toEqual({ path: "/SyncPlay/Ping", body: { Ping: 10 }, method: "POST" });
    dateNow.mockRestore();
  });

  it("does not rejoin a remembered group that disappeared while disconnected", async () => {
    const h = harness();
    h.internals.activationRevision = 7;
    h.internals.rememberedGroupId = groupId;
    h.internals.reconciling = true;
    h.internals.openSocket = vi.fn(async () => undefined);
    h.internals.synchronizeTime = vi.fn(async () => { h.internals.timeSyncReady = true; });
    h.internals.startPeriodicTasks = vi.fn();
    h.api.syncPlayRequest.mockResolvedValueOnce([]);

    await h.internals.reconnect(7);

    expect(h.service.getState()).toMatchObject({
      availability: "available",
      connection: "connected",
      joinedGroup: null,
      error: { code: "SYNCPLAY_GROUP_ENDED" },
    });
    expect(h.internals.rememberedGroupId).toBeNull();
    expect(h.api.syncPlayRequest).toHaveBeenCalledTimes(1);
  });

  it("publishes one exact queue transition only from the deterministic participant", async () => {
    const h = harness();
    const nextItem = "eeeeeeeeeeee4eee8eeeeeeeeeeeeeee";
    h.internals.currentUserName = "Adam";
    h.internals.updateTransitionAuthority();
    expect(h.player.setAutomaticTransitionsEnabled).toHaveBeenLastCalledWith(true);
    await h.player.loadItem(nextItem, "start-over");
    const transition = {
      action: "item-transition" as const,
      origin: "system" as const,
      commandRevision: null,
      commandId: null,
      controllerRevision: 3,
      monotonicTimestampMs: performance.now(),
      state: h.player.getState(),
    };
    await h.internals.handlePlayerEvent(transition);
    await h.internals.handlePlayerEvent(transition);
    expect(h.requests.filter((request) => request.path === "/SyncPlay/SetNewQueue")).toEqual([{
      path: "/SyncPlay/SetNewQueue",
      body: { PlayingQueue: [nextItem], PlayingItemPosition: 0, StartPositionTicks: 0 },
      method: "POST",
    }]);

    h.internals.currentUserName = "Kayla";
    h.internals.updateTransitionAuthority();
    expect(h.player.setAutomaticTransitionsEnabled).toHaveBeenLastCalledWith(false);
  });

  it("reports buffering and readiness while surfacing a local player error safely", async () => {
    const h = harness();
    const base = {
      origin: "system" as const,
      commandRevision: null,
      commandId: null,
      controllerRevision: 4,
      monotonicTimestampMs: performance.now(),
    };
    await h.internals.handlePlayerEvent({ ...base, action: "buffering", state: playbackState({ buffering: true, phase: "buffering" }) });
    await h.internals.handlePlayerEvent({ ...base, action: "buffering", state: playbackState({ buffering: false, phase: "playing" }) });
    await h.internals.handlePlayerEvent({ ...base, action: "error", state: playbackState({ phase: "error", error: "Decoder unavailable" }) });

    expect(h.requests.map((request) => request.path)).toEqual(["/SyncPlay/Buffering", "/SyncPlay/Ready", "/SyncPlay/Buffering"]);
    expect(h.service.getState().error).toEqual({ code: "SYNCPLAY_PLAYBACK_FAILED", message: "Decoder unavailable" });
  });

  it("clears a server-deleted group and stops background work on session expiry", async () => {
    const h = harness();
    h.api.syncPlayRequest.mockResolvedValueOnce([]);
    await h.service.list();
    expect(h.service.getState()).toMatchObject({ joinedGroup: null, error: { code: "SYNCPLAY_GROUP_ENDED" } });
    h.internals.handleBackgroundFailure(new AppError("SESSION_EXPIRED", "Expired", 401));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.service.getState()).toMatchObject({ availability: "signed-out", connection: "disconnected", joinedGroup: null });
    expect(h.player.setAutomaticTransitionsEnabled).toHaveBeenLastCalledWith(true);
  });

  it("polls group discovery only while the watch-party view is visible", async () => {
    const h = harness();
    await h.service.setViewVisible(true);
    expect(h.internals.refreshTimer).not.toBeNull();
    await h.service.setViewVisible(false);
    expect(h.internals.refreshTimer).toBeNull();
  });
});
