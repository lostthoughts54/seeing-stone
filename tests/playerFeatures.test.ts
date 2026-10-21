import { afterEach, describe, expect, it, vi } from "vitest";
import { PlayerFeaturesService } from "../src/main/services/playerFeatures";
import { featureInputSchema, featurePosition, type FeatureRoom } from "../src/shared/playerFeatures";
import type { PlaybackState } from "../src/shared/contracts";
import { AppError } from "../src/main/services/errors";

const itemId = "1".repeat(32);
function roomFixture(): FeatureRoom {
  return { id: "a".repeat(32), name: "Night", serverNow: Date.now(), owner: true, hostOnly: false, waitForAll: true, minimumParticipants: 2, autoNext: true,
    timeline: { version: 1, generation: 1, positionTicks: 0, playing: false, anchoredAt: Date.now(), startAt: null, nextAt: null, phase: "preparing", targetRevision: 1 },
    media: { kind: "jellyfin", itemId, mediaSourceId: "chosen", title: "Film", durationTicks: 10_000_000_000, version: "fingerprint" }, queue: [], members: [], messages: [], events: [] };
}
const services: PlayerFeaturesService[] = [];
afterEach(() => { services.splice(0).forEach(s => s.deactivate()); vi.useRealTimers(); });
function harness() {
  vi.useFakeTimers(); vi.setSystemTime(100_000);
  const room = roomFixture(); room.queue = [{ id: "b".repeat(32), media: room.media!, addedBy: "Host", votes: 0, voted: false }];
  let playback: PlaybackState = { playbackId: null, itemId: null, phase: "idle", source: null, positionTicks: 0, durationTicks: 10_000_000_000, paused: true, buffering: false, seeking: false, seekable: true, seekableUntilTicks: null, volume: 100, fullscreen: false, audioTracks: [], subtitleTracks: [], error: null };
  const player = {
    onEvent: vi.fn(), setAutomaticTransitionsEnabled: vi.fn(), getState: () => structuredClone(playback),
    loadItem: vi.fn(async () => { playback = { ...playback, playbackId: "playback", itemId, phase: "paused", source: "server" }; return { playbackId: "playback", source: "server" }; }),
    setPaused: vi.fn(async (_id: string, paused: boolean) => { playback.paused = paused; playback.phase = paused ? "paused" : "playing"; return playback; }),
    seek: vi.fn(async (_id: string, position: number) => { playback.positionTicks = position; return playback; }),
    setSubtitleDelay: vi.fn(async () => undefined), stop: vi.fn(async () => playback),
    setRate: vi.fn(async () => playback),
  };
  const api = {
    getAuthenticatedContext: vi.fn(() => ({})),
    getMediaSourceCapabilities: vi.fn(async () => ({ sources: [{ id: "chosen", supportsDirectPlay: true }] })),
    getMediaSegments: vi.fn(async () => [{ type: "Intro", startTicks: 0, endTicks: 300_000_000 }]),
    playerFeaturesRequest: vi.fn(async (body?: Record<string, unknown>): Promise<unknown> => {
      if (!body) return { protocolVersion: 1, features: ["watch-now"] };
      if (body.operation === "list") return [];
      if (body.operation === "preflight") return { media: room.media, subtitles: [], delaySeconds: 0 };
      if (body.operation === "timing") return { delaySeconds: body.delaySeconds ?? 0 };
      return { ...structuredClone(room), serverNow: Date.now() };
    }),
  };
  const downloads = { start: vi.fn(async () => ({})) };
  const service = new PlayerFeaturesService(api as never, player as never, downloads as never); services.push(service);
  return { service, room, player, api, downloads, setPlayback: (patch: Partial<PlaybackState>) => { playback = { ...playback, ...patch }; } };
}
async function settle(ms = 1200) { await vi.advanceTimersByTimeAsync(ms); }

describe("Seeing Stone player features", () => {
  it("sends Watch now as one guarded request and normalizes the pasted YouTube link", async () => {
    const h = harness(); await h.service.command({ operation: "join", roomId: h.room.id });
    h.api.playerFeaturesRequest.mockClear();
    await h.service.command({ operation: "watch-now", kind: "youtube", itemId: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" });
    expect(h.api.playerFeaturesRequest).toHaveBeenCalledWith({
      operation: "watch-now", kind: "youtube", itemId: "dQw4w9WgXcQ", roomId: h.room.id, expectedGeneration: 1,
    });
    expect(h.api.playerFeaturesRequest.mock.calls.filter(([b]) => b?.operation === "watch-now")).toHaveLength(1);
    expect(h.api.playerFeaturesRequest.mock.calls.some(([b]) => b?.operation === "add" || b?.operation === "action")).toBe(false);
  });
  it("leaves playback and the queue untouched when the server needs an upgrade", async () => {
    const h = harness(); const request = h.api.playerFeaturesRequest.getMockImplementation()!;
    h.api.playerFeaturesRequest.mockImplementation(async body => body ? request(body) : { protocolVersion: 1 });
    await h.service.command({ operation: "join", roomId: h.room.id });
    h.api.playerFeaturesRequest.mockClear();
    await expect(h.service.command({ operation: "watch-now", kind: "youtube", itemId: "dQw4w9WgXcQ" })).rejects.toThrow("Update");
    await expect(h.service.command({ operation: "action", action: { action: "watch-item", queueItemId: "b".repeat(32) } })).rejects.toThrow("Update");
    expect(h.api.playerFeaturesRequest.mock.calls.some(([b]) => b?.operation === "watch-now" || b?.operation === "action" || b?.operation === "add")).toBe(false);
    expect(h.service.getState().room?.media?.itemId).toBe(itemId);
  });
  it("pauses the movie for YouTube and returns to the room's saved position without leaving", async () => {
    const h = harness(); await h.service.command({ operation: "join", roomId: h.room.id }); await settle();
    const movie = h.room.media!;
    h.setPlayback({ paused: false, phase: "playing", positionTicks: 420_000_000 });
    h.room.media = { kind: "youtube", itemId: "dQw4w9WgXcQ", mediaSourceId: null, title: "Trailer", durationTicks: 0, version: "dQw4w9WgXcQ" };
    h.room.timeline = { ...h.room.timeline, version: 2, generation: 2, targetRevision: 2, positionTicks: 0 };
    await h.service.command({ operation: "watch-now", kind: "youtube", itemId: "dQw4w9WgXcQ" }); await settle();
    expect(h.player.setPaused).toHaveBeenCalledWith("playback", true, { origin: "remote-sync" });
    h.room.media = movie;
    h.room.timeline = { ...h.room.timeline, version: 3, generation: 3, targetRevision: 3, positionTicks: 420_000_000 };
    await h.service.command({ operation: "action", action: { action: "watch-item", queueItemId: "b".repeat(32) } }); await settle();
    expect(h.player.seek).toHaveBeenLastCalledWith("playback", 420_000_000, { origin: "remote-sync" });
    expect(h.service.getState().room?.id).toBe(h.room.id);
    expect(h.api.playerFeaturesRequest.mock.calls.some(([b]) => b?.operation === "leave")).toBe(false);
  });
  it("preflights the selected version and loads paused using the group origin", async () => {
    const h = harness(); await h.service.command({ operation: "join", roomId: h.room.id }); await settle();
    expect(h.api.playerFeaturesRequest).toHaveBeenCalledWith(expect.objectContaining({ operation: "preflight", mediaSourceId: "chosen" }));
    expect(h.player.loadItem).toHaveBeenCalledWith(itemId, "start-over", { origin: "remote-sync", preferredMediaSourceId: "chosen" });
    expect(h.api.playerFeaturesRequest).toHaveBeenCalledWith(expect.objectContaining({ operation: "report", report: expect.objectContaining({ ready: true, targetRevision: 1 }) }));
  });
  it("does not advertise readiness while the engine is buffering or seeking", async () => {
    const h = harness(); await h.service.command({ operation: "join", roomId: h.room.id }); await settle();
    h.setPlayback({ seeking: true }); h.api.playerFeaturesRequest.mockClear(); await settle();
    expect(h.api.playerFeaturesRequest).toHaveBeenCalledWith(expect.objectContaining({ operation: "report", report: expect.objectContaining({ ready: false, state: "buffering" }) }));
  });
  it("waits for the scheduled start and cancels it when a pause arrives", async () => {
    const h = harness(); await h.service.command({ operation: "join", roomId: h.room.id }); await settle();
    h.room.timeline = { ...h.room.timeline, version: 2, playing: true, startAt: Date.now() + 3000, anchoredAt: Date.now() + 3000 };
    await h.service.command({ operation: "action", action: { action: "play" } }); await settle(500);
    expect(h.player.setPaused).not.toHaveBeenCalledWith("playback", false, expect.anything());
    h.room.timeline = { ...h.room.timeline, version: 3, playing: false, startAt: null };
    await h.service.command({ operation: "action", action: { action: "pause" } }); await settle(4000);
    expect(h.player.setPaused).not.toHaveBeenCalledWith("playback", false, expect.anything());
  });
  it("rejects changed media versions without loading them", async () => {
    const h = harness(); const request = h.api.playerFeaturesRequest.getMockImplementation()!;
    h.api.playerFeaturesRequest.mockImplementation(async b => b?.operation === "preflight" ? { media: { ...h.room.media, version: "changed" }, subtitles: [], delaySeconds: 0 } : request(b));
    await h.service.command({ operation: "join", roomId: h.room.id }); await settle();
    expect(h.player.loadItem).not.toHaveBeenCalled(); expect(h.service.getState().local.issue).toContain("changed");
  });
  it("never starts downloads on a host invitation or a received queue", async () => {
    const h = harness(); await h.service.command({ operation: "join", roomId: h.room.id }); await settle();
    await h.service.command({ operation: "action", action: { action: "prepare" } });
    expect(h.downloads.start).not.toHaveBeenCalled();
    await h.service.command({ operation: "prepare" }); await settle(1);
    expect(h.downloads.start).toHaveBeenCalledWith(itemId, "chosen");
  });
  it("uses shared timeline position for timestamped comments and segment skips", async () => {
    const h = harness(); await h.service.command({ operation: "join", roomId: h.room.id }); await settle();
    await h.service.command({ operation: "message", kind: "comment", text: "Hello" });
    expect(h.api.playerFeaturesRequest).toHaveBeenCalledWith(expect.objectContaining({ operation: "message", positionTicks: 0 }));
    await h.service.command({ operation: "skip" });
    expect(h.api.playerFeaturesRequest).toHaveBeenCalledWith(expect.objectContaining({ operation: "action", action: expect.objectContaining({ action: "seek", positionTicks: 300_000_000, expectedGeneration: 1 }) }));
  });
  it("saves timing against the selected track and applies it to the local engine", async () => {
    const h = harness(); h.setPlayback({ subtitleTracks: [{ id: 1, streamIndex: 7, type: "subtitle", title: "English", language: "eng", selected: true }] });
    await h.service.command({ operation: "join", roomId: h.room.id }); await settle();
    await h.service.command({ operation: "timing", delaySeconds: 1.2 });
    expect(h.api.playerFeaturesRequest).toHaveBeenCalledWith(expect.objectContaining({ operation: "timing", stream: "7", mediaSourceId: "chosen", delaySeconds: 1.2 }));
    expect(h.player.setSubtitleDelay).toHaveBeenCalledWith("playback", 1.2);
  });
  it("shares reactions through the room transport and normalizes their server timestamps", async () => {
    const h = harness();
    const request = h.api.playerFeaturesRequest.getMockImplementation()!;
    h.api.playerFeaturesRequest.mockImplementation(async body => {
      const result = await request(body);
      if (body?.operation !== "message") return result;
      return { ...result as object, serverNow: Date.now() + 60_000, messages: [{
        id: "f".repeat(32), author: "Guest", kind: "reaction", text: "👏",
        createdAt: Date.now() + 60_000, positionTicks: null, generation: 1,
      }] };
    });
    await h.service.command({ operation: "join", roomId: h.room.id }); await settle();
    const state = await h.service.command({ operation: "message", kind: "reaction", text: "👏" });
    expect(h.api.playerFeaturesRequest).toHaveBeenCalledWith(expect.objectContaining({ operation: "message", kind: "reaction", text: "👏", roomId: h.room.id }));
    expect(state.room!.messages[0].createdAt).toBe(state.room!.serverNow);
  });
  it("pauses native playback when connectivity is lost", async () => {
    const h = harness(); await h.service.command({ operation: "join", roomId: h.room.id }); await settle();
    h.setPlayback({ paused: false, phase: "playing" });
    const request = h.api.playerFeaturesRequest.getMockImplementation()!;
    h.api.playerFeaturesRequest.mockImplementation(async b => { if (b?.operation === "report") throw new AppError("NETWORK", "Disconnected", 503); return request(b); });
    await settle();
    expect(h.service.getState().connection).toBe("reconnecting"); expect(h.player.setPaused).toHaveBeenCalledWith("playback", true, { origin: "remote-sync" });
  });
  it("ignores a room response completed after the account was cleared", async () => {
    const h = harness(); let resolve!: (value: unknown) => void;
    h.api.playerFeaturesRequest.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
    const joining = h.service.command({ operation: "join", roomId: h.room.id }); await settle(1);
    h.service.deactivate(); resolve(h.room); await joining;
    expect(h.service.getState().room).toBeNull(); expect(h.service.getState().connection).toBe("signed-out");
  });
  it("bounds renderer inputs and excludes native readiness reports and transport data", () => {
    for (const input of [{ operation: "report", ready: true }, { operation: "timing", delaySeconds: 999 }, { operation: "join", roomId: "../../" }, { operation: "add", kind: "jellyfin", itemId, accessToken: "secret" }]) expect(featureInputSchema.safeParse(input).success).toBe(false);
  });
  it("retains completion across native player teardown for the shared next countdown", async () => {
    const h = harness(); await h.service.command({ operation: "join", roomId: h.room.id }); await settle();
    const listener = h.player.onEvent.mock.calls[0][0] as (event: unknown) => void;
    listener({ action: "completed", origin: "system", state: { playbackId: "playback", itemId, positionTicks: 10_000_000_000 } });
    h.setPlayback({ playbackId: null, itemId: null, phase: "ended", positionTicks: 0 });
    h.api.playerFeaturesRequest.mockClear(); await settle();
    expect(h.api.playerFeaturesRequest).toHaveBeenCalledWith(expect.objectContaining({ operation: "report", report: expect.objectContaining({ state: "ended", positionTicks: 10_000_000_000 }) }));
  });
  it("holds the base position until a future anchor and clamps at the media end", () => {
    const r = roomFixture(); r.timeline.playing = true; r.timeline.anchoredAt = 5000; r.timeline.positionTicks = 20_000_000;
    expect(featurePosition(r, 4000)).toBe(20_000_000); expect(featurePosition(r, 7000)).toBe(40_000_000);
    expect(featurePosition(r, 1_000_000_000)).toBe(r.media!.durationTicks);
  });
});
