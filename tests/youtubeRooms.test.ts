import { describe, expect, it, vi } from "vitest";
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

function harness() {
  const youtubeRoomRequest = vi.fn(async (path: string, body?: unknown) => structuredClone(
    path === "/SeeingStone/YouTubeRooms" && body === undefined ? { protocolVersion: 2, roomLifetimeMinutes: 360 }
      : path.endsWith("/open") ? openRooms : room,
  ));
  const api = {
    getAuthenticatedContext: vi.fn(() => ({ userId: "user-1" })),
    youtubeRoomRequest,
  };
  return { service: new YouTubeRoomService(api as never, 1000), youtubeRoomRequest };
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

  it("normalizes the Jellyfin room clock to the receiving computer", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(5_000);
    const { service } = harness();
    const state = await service.create("YouTube night", "https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    expect(state.room?.serverNowUnixMs).toBe(5_000);
    expect(state.room?.timeline.anchoredAtUnixMs).toBe(5_000);
    now.mockRestore();
  });

  it("lists open rooms available to authenticated Jellyfin users", async () => {
    const { service, youtubeRoomRequest } = harness();
    await service.activate();
    const state = await service.refresh();
    expect(state.openRooms).toEqual(openRooms);
    expect(youtubeRoomRequest).toHaveBeenCalledWith("/SeeingStone/YouTubeRooms/open");
  });
});
