import { afterEach, describe, expect, it, vi } from "vitest";
import { AppError } from "../src/main/services/errors";
import { YouTubeRoomService } from "../src/main/services/youtubeRooms";

const token = "A".repeat(43);
const room = {
  inviteToken: token,
  name: "YouTube night",
  serverNowUnixMs: 2_000,
  createdAtUnixMs: 1_000,
  expiresAtUnixMs: 21_601_000,
  timeline: {
    videoId: "dQw4w9WgXcQ",
    positionSeconds: 12,
    playing: false,
    anchoredAtUnixMs: 2_000,
    version: 1,
    changedBy: "Adam",
  },
  queue: [{ queueItemId: "1".repeat(32), videoId: "dQw4w9WgXcQ", addedBy: "Adam", addedAtUnixMs: 1_000 }],
  transition: null,
  members: [{ memberId: "member-1", displayName: "Adam", status: "paused", connected: true, lastSeenAtUnixMs: 2_000 }],
} as const;
const openRooms = [{
  roomId: token,
  name: "YouTube night",
  videoId: "dQw4w9WgXcQ",
  memberCount: 1,
  connectedMemberCount: 1,
  createdAtUnixMs: 1_000,
  expiresAtUnixMs: 21_601_000,
}] as const;

const services: YouTubeRoomService[] = [];
afterEach(() => { for (const service of services.splice(0)) service.deactivate(); vi.useRealTimers(); vi.restoreAllMocks(); });
function harness() {
  const youtubeRoomRequest = vi.fn(async (path: string, body?: unknown) => structuredClone(
    path === "/SeeingStone/YouTubeRooms" && body === undefined ? { protocolVersion: 3, roomLifetimeMinutes: 360 }
      : path.endsWith("/open") ? openRooms : room,
  ));
  const api = {
    getAuthenticatedContext: vi.fn(() => ({ userId: "user-1" })),
    youtubeRoomRequest,
  };
  const service = new YouTubeRoomService(api as never, 1000); services.push(service);
  return { service, youtubeRoomRequest };
}

describe("YouTubeRoomService", () => {
  it("normalizes the URL to a video id and creates through the authenticated plugin boundary", async () => {
    const { service, youtubeRoomRequest } = harness();
    const state = await service.create("YouTube night", "https://youtu.be/dQw4w9WgXcQ?t=10");
    expect(state.connection).toBe("connected");
    expect(state.room?.inviteToken).toBe(token);
    expect(youtubeRoomRequest).toHaveBeenCalledWith("/SeeingStone/YouTubeRooms", {
      clientId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      name: "YouTube night",
      videoId: "dQw4w9WgXcQ",
    });
  });

  it("rejects non-YouTube and lookalike URLs before contacting Jellyfin", async () => {
    const { service, youtubeRoomRequest } = harness();
    await expect(service.create("YouTube night", "https://youtube.com.attacker.invalid/watch?v=dQw4w9WgXcQ")).rejects.toMatchObject({ code: "INVALID_YOUTUBE_URL" });
    expect(youtubeRoomRequest).not.toHaveBeenCalled();
  });

  it("publishes last-action-wins input with a bounded content position", async () => {
    const { service, youtubeRoomRequest } = harness();
    await service.join(token);
    youtubeRoomRequest.mockClear();
    await service.action({ action: "seek", positionSeconds: 42.25 });
    expect(youtubeRoomRequest).toHaveBeenCalledWith(`/SeeingStone/YouTubeRooms/${token}/action`, {
      clientId: expect.any(String),
      action: "seek",
      positionSeconds: 42.25,
    });
  });

  it("adds several newline-separated links to the shared queue", async () => {
    const { service, youtubeRoomRequest } = harness();
    await service.join(token);
    youtubeRoomRequest.mockClear();
    await service.addToQueue({
      youtubeUrls: "https://youtu.be/dQw4w9WgXcQ\nhttps://www.youtube.com/watch?v=9bZkp7q19f0",
      playNow: false,
    });
    expect(youtubeRoomRequest).toHaveBeenCalledWith(`/SeeingStone/YouTubeRooms/${token}/queue/add`, {
      clientId: expect.any(String),
      videoIds: ["dQw4w9WgXcQ", "9bZkp7q19f0"],
      playNow: false,
    });
  });

  it("uses an expected video id when advancing so duplicate end events are idempotent", async () => {
    const { service, youtubeRoomRequest } = harness();
    await service.join(token);
    youtubeRoomRequest.mockClear();
    await service.advance("dQw4w9WgXcQ");
    expect(youtubeRoomRequest).toHaveBeenCalledWith(`/SeeingStone/YouTubeRooms/${token}/advance`, {
      clientId: expect.any(String),
      expectedVideoId: "dQw4w9WgXcQ",
      expectedQueueItemId: "1".repeat(32),
    });
  });

  it("publishes a Jellyfin SyncPlay destination through the room", async () => {
    const { service, youtubeRoomRequest } = harness();
    await service.join(token);
    youtubeRoomRequest.mockClear();
    await service.handoff({ groupId: "11111111-1111-1111-1111-111111111111", groupName: "Show night" });
    expect(youtubeRoomRequest).toHaveBeenCalledWith(`/SeeingStone/YouTubeRooms/${token}/handoff`, {
      clientId: expect.any(String),
      groupId: "11111111-1111-1111-1111-111111111111",
      groupName: "Show night",
    });
  });

  it("normalizes the Jellyfin room clock to the receiving computer", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(5_000);
    const { service } = harness();
    const state = await service.create("YouTube night", "https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    expect(state.room?.serverNowUnixMs).toBe(5_000);
    expect(state.room?.timeline.anchoredAtUnixMs).toBe(5_000);
    expect(state.room?.queue[0]?.addedAtUnixMs).toBe(4_000);
    now.mockRestore();
  });

  it("lists open rooms available to authenticated Jellyfin users", async () => {
    const { service, youtubeRoomRequest } = harness();
    await service.activate();
    const state = await service.refresh();
    expect(state.openRooms).toEqual(openRooms);
    expect(youtubeRoomRequest).toHaveBeenCalledWith("/SeeingStone/YouTubeRooms/open");
  });

  it("ignores an outstanding presence response after leaving", async () => {
    const { service, youtubeRoomRequest } = harness(); await service.join(token);
    let resolve!: (value: typeof room) => void;
    youtubeRoomRequest.mockImplementationOnce(() => new Promise(r => { resolve = r as typeof resolve; }));
    const pending = service.setPresence("playing");
    await service.leave(); resolve(room); await pending;
    expect(service.getState().room).toBeNull();
  });

  it("ignores a room creation completed after sign-out", async () => {
    const { service, youtubeRoomRequest } = harness();
    let resolve!: (value: typeof room) => void;
    youtubeRoomRequest.mockImplementationOnce(() => new Promise(r => { resolve = r as typeof resolve; }));
    const pending = service.create("Night", "https://youtu.be/dQw4w9WgXcQ");
    service.deactivate(); resolve(room); await pending;
    expect(service.getState()).toMatchObject({ connection: "signed-out", room: null });
  });

  it("does not overwrite a newer timeline with a slower old response", async () => {
    const { service, youtubeRoomRequest } = harness(); await service.join(token);
    let resolve!: (value: typeof room) => void;
    youtubeRoomRequest.mockImplementationOnce(() => new Promise(r => { resolve = r as typeof resolve; }));
    const pending = service.setPresence("paused");
    youtubeRoomRequest.mockResolvedValueOnce({ ...room, timeline: { ...room.timeline, version: 2, positionSeconds: 55 } } as never);
    await service.action({ action: "seek", positionSeconds: 55 }); resolve(room); await pending;
    expect(service.getState().room?.timeline.positionSeconds).toBe(55);
  });

  it("keeps presence alive with the room view hidden", async () => {
    vi.useFakeTimers(); const { service, youtubeRoomRequest } = harness(); await service.join(token);
    service.setVisible(false); youtubeRoomRequest.mockClear();
    await vi.advanceTimersByTimeAsync(1100);
    expect(youtubeRoomRequest).toHaveBeenCalledWith(expect.stringContaining("/presence"), expect.any(Object));
  });

  it("distinguishes an expired room from a missing plugin", async () => {
    const { service, youtubeRoomRequest } = harness(); await service.join(token);
    youtubeRoomRequest.mockRejectedValueOnce(new AppError("NOT_FOUND", "Missing", 404));
    await service.refresh();
    expect(service.getState()).toMatchObject({ connection: "connected", room: null, error: { code: "YOUTUBE_ROOM_EXPIRED" } });
  });

  it("estimates the room clock at the round-trip midpoint", async () => {
    const { service, youtubeRoomRequest } = harness();
    vi.spyOn(Date, "now").mockReturnValueOnce(5000).mockReturnValue(5200);
    youtubeRoomRequest.mockResolvedValueOnce(structuredClone(room));
    const state = await service.join(token);
    expect(state.room?.timeline.anchoredAtUnixMs).toBe(5100);
  });
});
