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
    volume: 100,
    fullscreen: false,
    audioTracks: [],
    subtitleTracks: [],
    error: null,
    ...overrides,
  };
}

function harness(preferences?: {
  getBufferingPolicy: () => Promise<"wait-for-all" | "continue">;
  setBufferingPolicy: (mode: "wait-for-all" | "continue") => Promise<void>;
  getWatchPartySyncOffset?: () => Promise<number>;
  setWatchPartySyncOffset?: (offsetMilliseconds: number) => Promise<void>;
}) {
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
      state = { ...state, paused, phase: paused ? "paused" : "playing" };
      return state;
    }),
    seek: vi.fn(async (_playbackId: string, positionTicks: number) => {
      state = { ...state, positionTicks };
      return state;
    }),
    adjustLocalTimeline: vi.fn(async (_playbackId: string, deltaTicks: number) => {
      state = { ...state, positionTicks: state.positionTicks + deltaTicks };
      return state;
    }),
    setPlaybackRate: vi.fn(async (_playbackId: string, rate: number) => { playbackRate = rate; return state; }),
    selectAudio: vi.fn(async () => state),
    selectSubtitle: vi.fn(async () => state),
    setFullscreen: vi.fn(async () => state),
    showMessage: vi.fn(async () => undefined),
    stop: vi.fn(async () => { state = playbackState({ playbackId: null, itemId: null, phase: "stopped", source: null }); return state; }),
    clear: vi.fn(async () => undefined),
  };
  const service = new SyncPlayService(api as never, player as never, { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, 60_000, preferences);
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
    preparation: {
      phase: "playing",
      minimumParticipants: 2,
      localSyncOffsetMilliseconds: 0,
      scheduledStartAtUnixMs: null,
    },
    error: null,
  };
  internals.currentPlaylistItemId = playlistItemId;
  internals.timeSyncReady = true;
  internals.localItemPrepared = true;
  internals.currentItemStarted = true;
  const receive = (value: unknown) => internals.receiveMessage(Buffer.from(JSON.stringify(value)));
  const setPlayerState = (value: PlaybackState) => { state = structuredClone(value); };
  return { service, internals, api, player, requests, receive, setPlayerState };
}

function envelope(messageId: string, messageType: "SyncPlayGroupUpdate" | "SyncPlayCommand", data: unknown) {
  return { MessageId: messageId, MessageType: messageType, Data: data };
}

describe("SyncPlayService", () => {
  function pausedTimingHarness(offset = 300) {
    const h = harness();
    h.setPlayerState(playbackState({ phase: "paused", paused: true, positionTicks: 400_000_000, durationTicks: 2_000_000_000 }));
    h.internals.syncAnchor = {
      membershipRevision: h.internals.membershipRevision, playlistItemId,
      positionTicks: 400_000_000, playing: false, monotonicTimestampMs: performance.now(),
    };
    return { ...h, offset };
  }

  it.each([300, -300, 100, -100])("retains a %i ms adjustment through group pause and seek", async (offset) => {
    const h = pausedTimingHarness(offset);
    await h.service.setLocalSyncOffset(offset);
    await h.internals.handleCommand("pause", { ...command("Pause"), PositionTicks: 400_000_000 });
    expect(h.player.getState().positionTicks).toBe(400_000_000 + offset * 10_000);
    await h.internals.handleCommand("seek", { ...command("Seek"), PositionTicks: 600_000_000 });
    expect(h.player.getState().positionTicks).toBe(600_000_000 + offset * 10_000);
    expect(h.internals.syncAnchor.positionTicks).toBe(600_000_000);
    expect(h.requests.at(-1)).toMatchObject({ path: "/SyncPlay/Ready", body: { PositionTicks: 600_000_000 } });
  });

  it.each([300, -300])("does not compound a %i ms adjustment across repeated local resyncs", async (offset) => {
    const h = pausedTimingHarness(offset);
    await h.service.setLocalSyncOffset(offset);
    const anchor = h.internals.syncAnchor;
    for (let index = 0; index < 3; index += 1) {
      await h.service.resyncLocal();
      expect(h.player.getState().positionTicks).toBe(400_000_000 + offset * 10_000);
      expect(h.internals.syncAnchor).toBe(anchor);
      expect(h.requests.at(-1)).toMatchObject({ path: "/SyncPlay/Ready", body: { PositionTicks: 400_000_000 } });
    }
  });

  it("applies the latest adjustment after buffering ends while still paused", async () => {
    const h = pausedTimingHarness();
    h.setPlayerState(playbackState({ phase: "buffering", paused: true, buffering: true, positionTicks: 400_000_000 }));
    await h.service.setLocalSyncOffset(300);
    await h.service.setLocalSyncOffset(-200);
    expect(h.player.adjustLocalTimeline).not.toHaveBeenCalled();
    h.setPlayerState(playbackState({ phase: "paused", paused: true, positionTicks: 400_000_000 }));
    await h.internals.handlePlayerEvent({ action: "buffering", origin: "system", state: h.player.getState() });
    expect(h.player.getState().positionTicks).toBe(398_000_000);
    expect(h.player.getState().paused).toBe(true);
    expect(h.requests.at(-1)).toMatchObject({ body: { PositionTicks: 400_000_000 } });
  });

  it("keeps the startup position unchanged and applies the saved adjustment at shared start", async () => {
    const h = pausedTimingHarness();
    h.internals.currentItemStarted = false;
    h.internals.localItemPrepared = false;
    h.internals.state.preparation.phase = "preparing";
    await h.service.setLocalSyncOffset(300);
    expect(h.player.adjustLocalTimeline).not.toHaveBeenCalled();
    await expect(h.internals.waitForPlayerTarget(itemId, 400_000_000, true, 100)).resolves.toBeDefined();
    h.internals.localItemPrepared = true;
    const dateNow = vi.spyOn(Date, "now").mockReturnValue(Date.now());
    const performanceNow = vi.spyOn(performance, "now").mockReturnValue(performance.now());
    try {
      await h.internals.handleCommand("start", { ...command("Unpause"), PositionTicks: 400_000_000 });
      expect(h.player.getState()).toMatchObject({ positionTicks: 403_000_000, paused: false });
      expect(h.internals.syncAnchor.positionTicks).toBe(400_000_000);
    } finally { dateNow.mockRestore(); performanceNow.mockRestore(); }
  });

  it("waits for an existing seek to settle before applying a timing change", async () => {
    const h = pausedTimingHarness();
    h.setPlayerState({ ...h.player.getState(), seeking: true });
    await h.service.setLocalSyncOffset(300);
    expect(h.player.adjustLocalTimeline).not.toHaveBeenCalled();
    h.setPlayerState({ ...h.player.getState(), seeking: false });
    await h.internals.handlePlayerEvent({ action: "state", origin: "system", state: h.player.getState() });
    expect(h.player.getState().positionTicks).toBe(403_000_000);
  });

  it("resets an offset saved while paused for buffering when the group resumes", async () => {
    const h = pausedTimingHarness();
    await h.service.setLocalSyncOffset(300);
    h.setPlayerState({ ...h.player.getState(), buffering: true, phase: "buffering" });
    await h.service.setLocalSyncOffset(0);
    h.setPlayerState({ ...h.player.getState(), buffering: false, phase: "paused" });
    const dateNow = vi.spyOn(Date, "now").mockReturnValue(Date.now());
    const performanceNow = vi.spyOn(performance, "now").mockReturnValue(performance.now());
    try {
      await h.internals.handleCommand("resume", { ...command("Unpause"), PositionTicks: 400_000_000 });
      expect(h.player.getState()).toMatchObject({ positionTicks: 400_000_000, paused: false });
    } finally { dateNow.mockRestore(); performanceNow.mockRestore(); }
  });

  it("coalesces a second timing adjustment while the first player command is pending", async () => {
    const h = pausedTimingHarness();
    let release!: () => void;
    const adjust = h.player.adjustLocalTimeline.getMockImplementation()!;
    h.player.adjustLocalTimeline.mockImplementationOnce(async (id, delta) => {
      await new Promise<void>((resolve) => { release = resolve; });
      return adjust(id, delta);
    });
    const first = h.service.setLocalSyncOffset(300);
    await vi.waitFor(() => expect(release).toBeDefined());
    await h.service.setLocalSyncOffset(-200);
    expect(h.player.adjustLocalTimeline).toHaveBeenCalledTimes(1);
    release();
    await first;
    expect(h.player.getState().positionTicks).toBe(398_000_000);
    expect(h.service.getState().preparation.localSyncOffsetMilliseconds).toBe(-200);
  });

  it("does not reapply a deferred adjustment after leaving the party", async () => {
    const h = pausedTimingHarness();
    h.setPlayerState({ ...h.player.getState(), buffering: true, phase: "buffering" });
    await h.service.setLocalSyncOffset(300);
    h.internals.clearJoinedGroup();
    h.setPlayerState({ ...h.player.getState(), buffering: false, phase: "paused" });
    await h.internals.handlePlayerEvent({ action: "state", origin: "system", state: h.player.getState() });
    await h.internals.correctDrift();
    expect(h.player.adjustLocalTimeline).not.toHaveBeenCalled();
  });

  it("preserves the moving group clock across local resync and waits out engine seeks before drift correction", async () => {
    const h = pausedTimingHarness();
    const performanceNow = vi.spyOn(performance, "now").mockReturnValue(1000);
    try {
      h.internals.localSyncOffsetMilliseconds = 300;
      h.internals.syncAnchor = { ...h.internals.syncAnchor, playing: true, monotonicTimestampMs: 1000 };
      const anchor = h.internals.syncAnchor;
      await h.service.resyncLocal();
      expect(h.player.getState().positionTicks).toBe(403_000_000);
      performanceNow.mockReturnValue(2000);
      h.setPlayerState({ ...h.player.getState(), positionTicks: 413_000_000 });
      await h.service.resyncLocal();
      expect(h.player.getState().positionTicks).toBe(413_000_000);
      expect(h.internals.syncAnchor).toBe(anchor);
      h.player.seek.mockClear();
      h.setPlayerState({ ...h.player.getState(), positionTicks: 0, seeking: true });
      await h.internals.correctDrift();
      expect(h.player.seek).not.toHaveBeenCalled();
      expect(h.player.setPlaybackRate).not.toHaveBeenCalled();
    } finally { performanceNow.mockRestore(); }
  });

  it.each([{ group: 0, offset: -300, local: 0 }, { group: 2_000_000_000, offset: 300, local: 2_000_000_000 }])(
    "clamps local offsets at media boundaries without shifting group reports: %j", async ({ group, offset, local }) => {
      const h = pausedTimingHarness();
      h.internals.syncAnchor.positionTicks = group;
      h.setPlayerState({ ...h.player.getState(), positionTicks: group });
      await h.service.setLocalSyncOffset(offset);
      await h.service.resyncLocal();
      expect(h.player.getState().positionTicks).toBe(local);
      expect(h.requests.at(-1)).toMatchObject({ body: { PositionTicks: group } });
    },
  );

  const command = (kind: "Pause" | "Unpause" | "Seek" | "Stop", when = Date.now(), emittedAt = Date.now()) => ({
    GroupId: groupId, PlaylistItemId: playlistItemId, Command: kind,
    When: new Date(when).toISOString(), EmittedAt: new Date(emittedAt).toISOString(), PositionTicks: 0,
  });
  const startupQueue = (nextItem = itemId, nextPlaylist = playlistItemId) => ({
    Reason: "NewPlaylist", LastUpdate: new Date().toISOString(),
    Playlist: [{ ItemId: nextItem, PlaylistItemId: nextPlaylist }], PlayingItemIndex: 0,
    StartPositionTicks: 30_000_000, IsPlaying: false, ShuffleMode: "Sorted", RepeatMode: "RepeatNone",
  });

  it("finishes buffering before announcing a newly prepared queue", async () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      h.setPlayerState(playbackState({ phase: "buffering", buffering: true, paused: true, positionTicks: 30_000_000 }));
      h.internals.enqueuePreparation(startupQueue());
      await vi.advanceTimersByTimeAsync(1000);
      expect(h.requests.some((request) => request.path === "/SyncPlay/Ready")).toBe(false);
      expect(h.service.getState().preparation.phase).toBe("buffering");
      h.setPlayerState(playbackState({ phase: "paused", paused: true, positionTicks: 30_000_000 }));
      await vi.advanceTimersByTimeAsync(25);
      await h.internals.queueTask;
      expect(h.requests.filter((request) => request.path === "/SyncPlay/Ready")).toHaveLength(1);
    } finally { vi.useRealTimers(); }
  });

  it("retries failed local preparation at the shared position without replacing the party queue", async () => {
    const h = harness();
    const nextItem = "66666666666646668666666666666666";
    h.player.loadItem.mockRejectedValueOnce(new Error("Cold stream timed out"));
    h.internals.enqueuePreparation(startupQueue(nextItem));
    await h.internals.queueTask;
    expect(h.service.getState().preparation.phase).toBe("error");
    await expect(h.service.retryPreparation()).resolves.toMatchObject({ preparation: { phase: "ready" } });
    expect(h.player.getState()).toMatchObject({ itemId: nextItem, paused: true, positionTicks: 30_000_000 });
    expect(h.requests.filter((request) => request.path === "/SyncPlay/Ready")).toHaveLength(1);
    expect(h.requests.some((request) => request.path === "/SyncPlay/SetNewQueue")).toBe(false);
    await expect(h.service.retryPreparation()).rejects.toMatchObject({ code: "SYNCPLAY_RETRY_NOT_READY" });
  });

  it("abandons an old buffering preparation when a newer episode is selected", async () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      h.setPlayerState(playbackState({ phase: "buffering", buffering: true, paused: true, positionTicks: 30_000_000 }));
      h.internals.enqueuePreparation(startupQueue());
      await vi.advanceTimersByTimeAsync(50);
      const nextItem = "66666666666646668666666666666666";
      const nextPlaylist = "77777777777747778777777777777777";
      h.internals.enqueuePreparation(startupQueue(nextItem, nextPlaylist));
      await vi.advanceTimersByTimeAsync(50);
      await h.internals.queueTask;
      expect(h.requests.filter((request) => request.path === "/SyncPlay/Ready")).toEqual([
        expect.objectContaining({ body: expect.objectContaining({ PlaylistItemId: nextPlaylist }) }),
      ]);
      expect(h.service.getState().error).toBeNull();
    } finally { vi.useRealTimers(); }
  });

  it("does not report ready while reconnecting, and reports it when reconciliation finishes", async () => {
    const h = harness();
    h.internals.currentItemStarted = false;
    h.internals.reconciling = true;
    h.setPlayerState(playbackState({ phase: "paused", paused: true }));
    await h.internals.maybeReportReady();
    expect(h.requests).toHaveLength(0);
    h.internals.reconciling = false;
    await h.internals.maybeReportReady();
    expect(h.requests.at(-1)?.path).toBe("/SyncPlay/Ready");
  });

  it("ignores a failed readiness response from the previous party membership", async () => {
    const h = harness();
    h.internals.currentItemStarted = false;
    h.setPlayerState(playbackState({ phase: "paused", paused: true }));
    let rejectReady!: (error: Error) => void;
    h.api.syncPlayRequest.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectReady = reject; }));
    const pending = h.internals.maybeReportReady();
    h.internals.clearJoinedGroup();
    rejectReady(new Error("Request ended after leaving"));
    await pending;
    expect(h.service.getState()).toMatchObject({ joinedGroup: null, preparation: { phase: "idle" }, error: null });
    expect(h.internals.readyRetryTimer).toBeNull();
  });

  it.each([
    { phase: "buffering", buffering: true },
    { phase: "loading" },
    { phase: "paused", seeking: true },
  ] as Partial<PlaybackState>[])("waits for a healthy player at the target: %j", async (unready) => {
    vi.useFakeTimers();
    try {
      const h = harness();
      h.setPlayerState(playbackState({ paused: true, positionTicks: 0, ...unready }));
      let complete = false;
      const waiting = h.internals.waitForPlayerTarget(itemId, 0, true, 1000).then(() => { complete = true; });
      await vi.advanceTimersByTimeAsync(200);
      expect(complete).toBe(false);
      h.setPlayerState(playbackState({ phase: "paused", paused: true, positionTicks: 0 }));
      await vi.advanceTimersByTimeAsync(25);
      await waiting;
      expect(complete).toBe(true);
    } finally { vi.useRealTimers(); }
  });

  it("rejects a player error even when its reported position matches the target", async () => {
    const h = harness();
    h.setPlayerState(playbackState({ phase: "error", paused: true, positionTicks: 0, error: "Decoder failed" }));
    await expect(h.internals.waitForPlayerTarget(itemId, 0, true, 1000)).rejects.toMatchObject({ code: "SYNCPLAY_PLAYBACK_FAILED" });
  });

  it("does not announce readiness from an early buffering-ended event or start before preparation", async () => {
    const h = harness();
    h.internals.currentItemStarted = false;
    h.internals.localItemPrepared = false;
    h.setPlayerState(playbackState({ phase: "paused", paused: true, positionTicks: 0 }));
    await h.internals.handlePlayerEvent({ action: "buffering", origin: "system", state: h.player.getState() });
    await h.internals.handleCommand("early-start", command("Unpause"));
    expect(h.requests.some((request) => request.path === "/SyncPlay/Ready")).toBe(false);
    expect(h.player.setPaused).not.toHaveBeenCalled();
    h.internals.localItemPrepared = true;
    h.internals.state.joinedGroup.participantCount = 1;
    await h.internals.handlePlayerEvent({ action: "buffering", origin: "system", state: h.player.getState() });
    expect(h.requests.some((request) => request.path === "/SyncPlay/Ready")).toBe(false);
    expect(h.service.getState().preparation.phase).toBe("waiting-for-participant");
  });

  it("cancels a scheduled start when a newer pause arrives", async () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      const starting = h.internals.handleCommand("old-start", command("Unpause", Date.now() + 4000));
      await h.internals.handleCommand("new-pause", command("Pause"));
      await vi.advanceTimersByTimeAsync(5000);
      await starting;
      expect(h.player.setPaused).toHaveBeenCalledTimes(1);
      expect(h.player.getState().paused).toBe(true);
    } finally { vi.useRealTimers(); }
  });

  it("cancels a scheduled start when this player starts buffering", async () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      const starting = h.internals.handleCommand("start", command("Unpause", Date.now() + 4000));
      h.setPlayerState(playbackState({ paused: true, phase: "buffering", buffering: true }));
      await h.internals.handlePlayerEvent({ action: "buffering", origin: "system", state: h.player.getState() });
      await vi.advanceTimersByTimeAsync(5000);
      await starting;
      expect(h.player.setPaused).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it("honors a start more than two seconds away even when its on-screen message is slow", async () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      h.internals.currentItemStarted = false;
      h.setPlayerState(playbackState({ paused: true, phase: "paused", positionTicks: 0 }));
      h.player.showMessage.mockImplementation(() => new Promise(() => {}));
      const starting = h.internals.handleCommand("start", command("Unpause", Date.now() + 4000));
      await vi.advanceTimersByTimeAsync(3999);
      expect(h.player.setPaused).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await starting;
      expect(h.player.getState().paused).toBe(false);
    } finally { vi.useRealTimers(); }
  });

  it("ignores an older emitted start after a newer pause", async () => {
    const h = harness();
    const now = Date.now();
    await h.internals.handleCommand("pause", command("Pause", now, now));
    await h.internals.handleCommand("old-start", command("Unpause", now, now - 100));
    expect(h.player.setPaused).toHaveBeenCalledTimes(1);
    expect(h.player.getState().paused).toBe(true);
  });

  it("retries a transient readiness failure without needing another player event", async () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      h.internals.currentItemStarted = false;
      h.setPlayerState(playbackState({ phase: "paused", paused: true }));
      h.api.syncPlayRequest.mockRejectedValueOnce(new Error("Connection reset"));
      await h.internals.maybeReportReady();
      expect(h.service.getState().preparation.phase).toBe("retrying");
      await vi.advanceTimersByTimeAsync(500);
      expect(h.api.syncPlayRequest).toHaveBeenCalledTimes(2);
      expect(h.internals.readyReported).toBe(true);
      expect(h.service.getState().preparation.phase).toBe("ready");
    } finally { vi.useRealTimers(); }
  });

  it("bounds readiness retries and exposes a recoverable preparation error", async () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      h.internals.currentItemStarted = false;
      h.setPlayerState(playbackState({ phase: "paused", paused: true }));
      h.api.syncPlayRequest.mockRejectedValue(new Error("Offline"));
      await h.internals.maybeReportReady();
      await vi.advanceTimersByTimeAsync(30000);
      expect(h.api.syncPlayRequest).toHaveBeenCalledTimes(5);
      expect(h.service.getState().preparation.phase).toBe("error");
      await h.internals.maybeReportReady();
      expect(h.api.syncPlayRequest).toHaveBeenCalledTimes(5);
    } finally { vi.useRealTimers(); }
  });

  it("cancels readiness retries on leaving the party", async () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      h.internals.currentItemStarted = false;
      h.setPlayerState(playbackState({ phase: "paused", paused: true }));
      h.api.syncPlayRequest.mockRejectedValue(new Error("Offline"));
      await h.internals.maybeReportReady();
      h.internals.clearJoinedGroup();
      await vi.advanceTimersByTimeAsync(10000);
      expect(h.api.syncPlayRequest).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });

  it("finds join confirmations after the rolling message history fills", async () => {
    const h = harness();
    const receiveState = (index: number) => h.receive(envelope(index.toString(16).padStart(32, "0"), "SyncPlayGroupUpdate", {
      GroupId: groupId, Type: "StateUpdate", Data: { State: "Paused", Reason: "Pause" },
    }));
    for (let index = 1; index <= 205; index += 1) receiveState(index);
    const request = h.api.syncPlayRequest.getMockImplementation()!;
    h.api.syncPlayRequest.mockImplementation(async (path, body, method) => {
      if (path === "/SyncPlay/Join") h.receive(envelope("aaaaaaaaaaaa4aaa8aaaaaaaaaaaaaaa", "SyncPlayGroupUpdate", {
        GroupId: groupId, Type: "GroupJoined", Data: { GroupId: groupId, GroupName: "Movie night", State: "Paused", Participants: ["Adam", "Kayla"], LastUpdatedAt: new Date().toISOString() },
      }));
      return request(path, body, method);
    });
    await expect(h.service.join(groupId)).resolves.toMatchObject({ joinedGroup: { groupId } });
    expect(h.internals.messageHistory).toHaveLength(200);
  });

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

  it("holds the first item for one participant and reports ready when a second joins", async () => {
    const h = harness();
    h.internals.state.joinedGroup.participants = ["Adam"];
    h.internals.state.joinedGroup.participantCount = 1;
    const nextItem = "66666666666646668666666666666666";
    const nextPlaylist = "77777777777747778777777777777777";
    h.receive(envelope("88888888888848888888888888888881", "SyncPlayGroupUpdate", {
      GroupId: groupId,
      Type: "PlayQueue",
      Data: {
        Reason: "NewPlaylist",
        LastUpdate: "2026-07-13T20:01:00.000Z",
        Playlist: [{ ItemId: nextItem, PlaylistItemId: nextPlaylist }],
        PlayingItemIndex: 0,
        StartPositionTicks: 0,
        IsPlaying: false,
        ShuffleMode: "Sorted",
        RepeatMode: "RepeatNone",
      },
    }));
    await h.internals.queueTask;

    expect(h.requests.some((request) => request.path === "/SyncPlay/Ready")).toBe(false);
    expect(h.service.getState().preparation.phase).toBe("waiting-for-participant");

    h.receive(envelope("88888888888848888888888888888882", "SyncPlayGroupUpdate", {
      GroupId: groupId,
      Type: "UserJoined",
      Data: "Kayla",
    }));
    await vi.waitFor(() => expect(h.requests.at(-1)?.path).toBe("/SyncPlay/Ready"));
    expect(h.service.getState().preparation.phase).toBe("ready");
  });

  it("does not erase an active queue and resync anchor when GroupJoined is handled twice", async () => {
    const h = harness();
    const nextItem = "66666666666646668666666666666666";
    const nextPlaylist = "77777777777747778777777777777777";
    h.receive(envelope("88888888888848888888888888888889", "SyncPlayGroupUpdate", {
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
    }));
    await h.internals.queueTask;
    const playbackStateBeforeDuplicate = h.service.getState().joinedGroup?.playbackState;

    h.internals.applyJoinedGroup({
      GroupId: groupId,
      Type: "GroupJoined",
      Data: {
        GroupId: groupId,
        GroupName: "Movie night",
        State: "Waiting",
        Participants: ["Adam", "Noah"],
        LastUpdatedAt: "2026-07-13T20:01:01.000Z",
      },
    });

    expect(h.internals.currentPlaylistItemId).toBe(nextPlaylist);
    expect(h.internals.syncAnchor).toMatchObject({ playlistItemId: nextPlaylist, positionTicks: 30_000_000 });
    expect(h.service.getState().joinedGroup).toMatchObject({
      participants: ["Adam", "Noah"],
      currentItemId: nextItem,
      playlistItemId: nextPlaylist,
      playbackState: playbackStateBeforeDuplicate,
    });
    await expect(h.service.resyncLocal()).resolves.toMatchObject({ itemId: nextItem });
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

  it("rounds the public scheduled start timestamp while retaining a fractional clock offset", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse("2026-07-13T20:00:00.000Z"));
    const h = harness();
    h.internals.serverTimeOffsetMs = 0.5;
    h.internals.currentItemStarted = false;

    try {
      const command = h.internals.handleCommand("dddddddddddd4ddd8ddddddddddddddd", {
        GroupId: groupId,
        PlaylistItemId: playlistItemId,
        When: new Date(Date.now() + 1).toISOString(),
        PositionTicks: 40_000_000,
        Command: "Unpause",
        EmittedAt: new Date().toISOString(),
      });

      const scheduledStartAtUnixMs = h.service.getState().preparation.scheduledStartAtUnixMs;
      expect(h.internals.serverTimeOffsetMs).toBe(0.5);
      expect(scheduledStartAtUnixMs).not.toBeNull();
      expect(Number.isInteger(scheduledStartAtUnixMs)).toBe(true);
      expect(scheduledStartAtUnixMs).toBe(Date.now() + 1);

      await vi.runAllTimersAsync();
      await command;
    } finally {
      vi.useRealTimers();
    }
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
    expect(h.requests.at(-1)).toMatchObject({
      path: "/SyncPlay/Ready",
      body: { PositionTicks: 20_000_000, IsPlaying: true, PlaylistItemId: playlistItemId },
    });
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

  it("keeps enhanced telemetry hard-disabled while standard Jellyfin SyncPlay remains available", () => {
    const h = harness();
    expect(h.service.getState()).toMatchObject({
      availability: "available",
      connection: "connected",
      telemetry: {
        availability: "disabled",
        transport: "none",
        participants: [],
        reason: expect.stringContaining("exact authenticated session's SyncPlay-group membership"),
      },
    });
  });

  it("routes explicit Wait and Continue through Jellyfin group commands", async () => {
    const h = harness();

    await h.service.waitForAll();
    await h.service.continueAfterBuffering();

    expect(h.requests).toEqual([
      { path: "/SyncPlay/Pause", body: {}, method: "POST" },
      { path: "/SyncPlay/Unpause", body: {}, method: "POST" },
    ]);
  });

  it("issues group Resync at the current authoritative timeline while retaining local Resync separately", async () => {
    const h = harness();
    const performanceNow = vi.spyOn(performance, "now").mockReturnValue(25_000);
    h.internals.syncAnchor = {
      membershipRevision: h.internals.membershipRevision,
      playlistItemId,
      positionTicks: 70_000_000,
      playing: true,
      monotonicTimestampMs: 24_500,
    };

    try {
      await h.service.resyncGroup();
      expect(h.requests).toEqual([{
        path: "/SyncPlay/Seek",
        body: { PositionTicks: 75_000_000 },
        method: "POST",
      }]);
      expect(h.player.seek).not.toHaveBeenCalled();
    } finally {
      performanceNow.mockRestore();
    }
  });

  it("publishes only measured latency, drift, and anchor readiness", async () => {
    const h = harness();
    h.internals.timeSyncReady = false;
    expect(h.service.getState().sync).toEqual({
      serverLatencyMs: null,
      localDriftTicks: null,
      authoritativeTimelineReady: false,
      measuredAtUnixMs: null,
    });

    const dateNow = vi.spyOn(Date, "now").mockReturnValueOnce(1_000).mockReturnValueOnce(1_020).mockReturnValue(2_000);
    h.api.getServerTime.mockResolvedValueOnce({
      requestReceptionTime: new Date(1_105).toISOString(),
      responseTransmissionTime: new Date(1_105).toISOString(),
    });
    await h.internals.synchronizeTime(1);
    h.internals.syncAnchor = {
      membershipRevision: h.internals.membershipRevision,
      playlistItemId,
      positionTicks: 12_000_000,
      playing: true,
      monotonicTimestampMs: performance.now(),
    };
    h.internals.lastDriftTicks = -250_000;
    h.internals.driftMeasuredAtUnixMs = 2_000;

    expect(h.service.getState().sync).toEqual({
      serverLatencyMs: 10,
      localDriftTicks: -250_000,
      authoritativeTimelineReady: true,
      measuredAtUnixMs: 2_000,
    });
    h.internals.reconciling = true;
    expect(h.service.getState().sync).toEqual({
      serverLatencyMs: 10,
      localDriftTicks: null,
      authoritativeTimelineReady: false,
      measuredAtUnixMs: null,
    });
    h.internals.reconciling = false;
    h.internals.syncAnchor = null;
    expect(h.service.getState().sync).toEqual({
      serverLatencyMs: 10,
      localDriftTicks: null,
      authoritativeTimelineReady: false,
      measuredAtUnixMs: null,
    });
    dateNow.mockRestore();
  });

  it("manually resyncs only this player to the validated paused anchor", async () => {
    const h = harness();
    h.internals.syncAnchor = {
      membershipRevision: h.internals.membershipRevision,
      playlistItemId,
      positionTicks: 80_000_000,
      playing: false,
      monotonicTimestampMs: performance.now(),
    };

    const state = await h.service.resyncLocal();

    expect(state).toMatchObject({ itemId, positionTicks: 80_000_000, paused: true });
    expect(h.player.setPaused).toHaveBeenCalledWith(expect.any(String), true, expect.objectContaining({ origin: "remote-sync" }));
    expect(h.player.seek).toHaveBeenCalledWith(expect.any(String), 80_000_000, expect.objectContaining({
      origin: "remote-sync",
      commandId: expect.stringContaining("manual-resync:"),
    }));
    expect(h.requests.some((request) => request.path === "/SyncPlay/Seek")).toBe(false);
    expect(h.requests.at(-1)).toMatchObject({
      path: "/SyncPlay/Ready",
      body: { PositionTicks: 80_000_000, IsPlaying: false, PlaylistItemId: playlistItemId },
    });
  });

  it("handles the in-player resync shortcut locally and shows confirmation", async () => {
    const h = harness();
    h.internals.syncAnchor = {
      membershipRevision: h.internals.membershipRevision,
      playlistItemId,
      positionTicks: 90_000_000,
      playing: false,
      monotonicTimestampMs: performance.now(),
    };

    await h.internals.handlePlayerEvent({
      action: "resync-request",
      origin: "local-user",
      commandRevision: null,
      commandId: null,
      controllerRevision: 4,
      monotonicTimestampMs: performance.now(),
      state: h.player.getState(),
    });

    expect(h.player.seek).toHaveBeenCalledWith(expect.any(String), 90_000_000, expect.objectContaining({ origin: "remote-sync" }));
    expect(h.player.showMessage).toHaveBeenCalledWith(expect.any(String), "Resynced this computer to the watch party.", 2500);
    expect(h.requests.some((request) => request.path === "/SyncPlay/Seek")).toBe(false);
  });

  it("rejects manual resync before the group has an authoritative item anchor", async () => {
    const h = harness();
    h.internals.syncAnchor = null;

    await expect(h.service.resyncLocal()).rejects.toMatchObject({ code: "SYNCPLAY_RESYNC_NOT_READY" });
    expect(h.player.seek).not.toHaveBeenCalled();
    expect(h.requests).toHaveLength(0);
  });

  it("reloads the authoritative item through PlayerController before manual resync", async () => {
    const h = harness();
    h.setPlayerState(playbackState({ itemId: otherGroupId, source: "server", positionTicks: 40_000_000 }));
    h.internals.syncAnchor = {
      membershipRevision: h.internals.membershipRevision,
      playlistItemId,
      positionTicks: 60_000_000,
      playing: false,
      monotonicTimestampMs: performance.now(),
    };

    const state = await h.service.resyncLocal();

    expect(h.player.loadItem).toHaveBeenCalledWith(itemId, "start-over", expect.objectContaining({ origin: "remote-sync" }));
    expect(state).toMatchObject({ itemId, source: "local", positionTicks: 60_000_000, paused: true });
  });

  it("scales smooth drift correction through three bands and seeks only at three seconds", async () => {
    const h = harness();
    const now = 25_000;
    const performanceNow = vi.spyOn(performance, "now").mockReturnValue(now);
    const anchor = (driftTicks: number) => {
      const playerPositionTicks = 40_000_000;
      h.setPlayerState(playbackState({ positionTicks: playerPositionTicks }));
      h.internals.syncAnchor = {
        membershipRevision: h.internals.membershipRevision,
        playlistItemId,
        positionTicks: playerPositionTicks + driftTicks,
        playing: true,
        monotonicTimestampMs: now,
      };
    };

    try {
      anchor(999_999);
      await h.internals.correctDrift();
      expect(h.player.setPlaybackRate).not.toHaveBeenCalled();
      expect(h.player.seek).not.toHaveBeenCalled();

      anchor(1_000_000);
      await h.internals.correctDrift();
      expect(h.player.setPlaybackRate).toHaveBeenLastCalledWith(expect.any(String), 1.02, expect.objectContaining({ origin: "remote-sync" }));

      anchor(4_000_000);
      await h.internals.correctDrift();
      expect(h.player.setPlaybackRate).toHaveBeenLastCalledWith(expect.any(String), 1.04, expect.objectContaining({ origin: "remote-sync" }));

      anchor(16_000_000);
      await h.internals.correctDrift();
      expect(h.player.setPlaybackRate).toHaveBeenLastCalledWith(expect.any(String), 1.06, expect.objectContaining({ origin: "remote-sync" }));

      anchor(-16_000_000);
      await h.internals.correctDrift();
      expect(h.player.setPlaybackRate).toHaveBeenLastCalledWith(expect.any(String), 0.94, expect.objectContaining({ origin: "remote-sync" }));

      anchor(30_000_000);
      await h.internals.correctDrift();
      expect(h.player.setPlaybackRate).toHaveBeenLastCalledWith(expect.any(String), 1, expect.objectContaining({ origin: "remote-sync" }));
      expect(h.player.seek).toHaveBeenCalledTimes(1);
    } finally {
      performanceNow.mockRestore();
    }
  });

  it("applies local timing adjustments immediately without seeking the SyncPlay group", async () => {
    const setWatchPartySyncOffset = vi.fn(async () => undefined);
    const h = harness({
      getBufferingPolicy: vi.fn(async () => "wait-for-all" as const),
      setBufferingPolicy: vi.fn(async () => undefined),
      getWatchPartySyncOffset: vi.fn(async () => 0),
      setWatchPartySyncOffset,
    });
    const now = 25_000;
    const performanceNow = vi.spyOn(performance, "now").mockReturnValue(now);
    try {
      h.setPlayerState(playbackState({ positionTicks: 40_000_000 }));
      h.internals.syncAnchor = {
        membershipRevision: h.internals.membershipRevision,
        playlistItemId,
        positionTicks: 40_000_000,
        playing: true,
        monotonicTimestampMs: now,
      };

      await h.service.setLocalSyncOffset(100);

      expect(setWatchPartySyncOffset).toHaveBeenLastCalledWith(100);
      expect(h.service.getState().preparation.localSyncOffsetMilliseconds).toBe(100);
      expect(h.player.adjustLocalTimeline).toHaveBeenLastCalledWith(expect.any(String), 1_000_000, expect.objectContaining({
        origin: "remote-sync",
        commandId: expect.stringContaining("local-offset:"),
      }));
      expect(h.requests.some((request) => request.path === "/SyncPlay/Seek")).toBe(false);
      h.player.adjustLocalTimeline.mockClear();
      await h.internals.correctDrift();
      expect(h.player.adjustLocalTimeline).not.toHaveBeenCalled();
      expect(h.player.getPlaybackRate()).toBe(1);

      await h.service.setLocalSyncOffset(-100);
      expect(h.service.getState().preparation.localSyncOffsetMilliseconds).toBe(-100);
      expect(h.player.adjustLocalTimeline).toHaveBeenLastCalledWith(expect.any(String), -2_000_000, expect.objectContaining({
        origin: "remote-sync",
        commandId: expect.stringContaining("local-offset:"),
      }));

      await h.service.setLocalSyncOffset(0);
      expect(h.service.getState().preparation.localSyncOffsetMilliseconds).toBe(0);
      expect(h.player.adjustLocalTimeline).toHaveBeenLastCalledWith(expect.any(String), 1_000_000, expect.objectContaining({ origin: "remote-sync" }));
      await h.internals.correctDrift();
      expect(h.player.getPlaybackRate()).toBe(1);
      expect(h.requests.some((request) => request.path === "/SyncPlay/Seek")).toBe(false);
    } finally {
      performanceNow.mockRestore();
    }
  });

  it("saves a timing preference without seeking when no authoritative timeline is available", async () => {
    const setWatchPartySyncOffset = vi.fn(async () => undefined);
    const h = harness({
      getBufferingPolicy: vi.fn(async () => "wait-for-all" as const),
      setBufferingPolicy: vi.fn(async () => undefined),
      setWatchPartySyncOffset,
    });
    h.internals.syncAnchor = null;

    await h.service.setLocalSyncOffset(100);

    expect(setWatchPartySyncOffset).toHaveBeenCalledWith(100);
    expect(h.service.getState().preparation.localSyncOffsetMilliseconds).toBe(100);
    expect(h.player.seek).not.toHaveBeenCalled();
    expect(h.requests.some((request) => request.path === "/SyncPlay/Seek")).toBe(false);
  });

  it("uses a saved local timing preference when Watch Party playback starts", async () => {
    const h = harness();
    h.internals.localSyncOffsetMilliseconds = 100;
    h.internals.state.preparation.localSyncOffsetMilliseconds = 100;
    h.internals.state.joinedGroup.lastUpdatedAt = new Date(1_000_000).toISOString();
    h.setPlayerState(playbackState({ paused: true, phase: "paused", positionTicks: 40_000_000 }));
    const dateNow = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    const performanceNow = vi.spyOn(performance, "now").mockReturnValue(25_000);
    try {
      await h.internals.handleCommand("eeeeeeeeeeee4eee8eeeeeeeeeeeeeee", {
        GroupId: groupId,
        PlaylistItemId: playlistItemId,
        When: new Date(1_000_000).toISOString(),
        PositionTicks: 40_000_000,
        Command: "Unpause",
        EmittedAt: new Date(1_000_000).toISOString(),
      });

      expect(h.player.adjustLocalTimeline).toHaveBeenCalledWith(expect.any(String), 1_000_000, expect.objectContaining({ origin: "remote-sync" }));
      expect(h.player.seek).not.toHaveBeenCalled();
      expect(h.requests.some((request) => request.path === "/SyncPlay/Seek")).toBe(false);
    } finally {
      dateNow.mockRestore();
      performanceNow.mockRestore();
    }
  });

  it("uses hysteresis before returning a corrected player to normal speed", async () => {
    const h = harness();
    const now = 25_000;
    const performanceNow = vi.spyOn(performance, "now").mockReturnValue(now);
    const anchor = (driftTicks: number) => {
      h.internals.syncAnchor = {
        membershipRevision: h.internals.membershipRevision,
        playlistItemId,
        positionTicks: 10_000_000 + driftTicks,
        playing: true,
        monotonicTimestampMs: now,
      };
    };

    try {
      anchor(2_000_000);
      await h.internals.correctDrift();
      anchor(750_000);
      await h.internals.correctDrift();
      expect(h.player.setPlaybackRate).toHaveBeenCalledTimes(1);

      anchor(500_000);
      await h.internals.correctDrift();
      expect(h.player.setPlaybackRate).toHaveBeenLastCalledWith(expect.any(String), 1, expect.objectContaining({ origin: "remote-sync" }));
    } finally {
      performanceNow.mockRestore();
    }
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
