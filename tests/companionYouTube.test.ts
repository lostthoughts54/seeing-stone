import { describe, expect, it, vi } from "vitest";
import { CompanionYouTubeService } from "../src/main/services/companionYouTube";
import { companionCommandEnvelopeSchema } from "../src/shared/companionSchemas";
import type { YouTubeRoomViewState } from "../src/shared/contracts";

const roomId = "a".repeat(43);
function harness(key = "test-key") {
  let room = { inviteToken: roomId, name: "Video night", queue: [{ queueItemId: "1".repeat(32), videoId: "dQw4w9WgXcQ" }], transition: null,
    timeline: { videoId: "dQw4w9WgXcQ", playing: false, positionSeconds: 42, anchoredAtUnixMs: Date.now(), version: 1, changedBy: null } } as NonNullable<YouTubeRoomViewState["room"]> | null;
  const rooms = { getState: () => ({ room, connection: "connected" } as YouTubeRoomViewState), addToQueue: vi.fn(async () => ({ room } as YouTubeRoomViewState)),
    action: vi.fn(async () => ({ room } as YouTubeRoomViewState)), advance: vi.fn(async () => ({ room } as YouTubeRoomViewState)), queueAction: vi.fn(async () => ({ room } as YouTubeRoomViewState)) };
  const request = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ items: [
    { id: { videoId: "dQw4w9WgXcQ" }, snippet: { title: "Video", channelTitle: "Channel" } },
  ], nextPageToken: "next-page" })));
  return { service: new CompanionYouTubeService(rooms, () => key, request), rooms, request, setRoom: (value: typeof room) => { room = value; } };
}

describe("Companion YouTube", () => {
  it("routes playback commands to the YouTube timeline and guards stale queue entries", async () => {
    const { service, rooms } = harness();
    const input = { type: "youtube-control" as const, roomId, queueItemId: "1".repeat(32) };
    await service.control({ ...input, action: "play" });
    expect(rooms.action).toHaveBeenLastCalledWith({ action: "play", positionSeconds: 42 });
    await service.control({ ...input, action: "pause" });
    expect(rooms.action).toHaveBeenLastCalledWith({ action: "pause", positionSeconds: 42 });
    await service.control({ ...input, action: "back" });
    expect(rooms.action).toHaveBeenLastCalledWith({ action: "seek", positionSeconds: 32 });
    await service.control({ ...input, action: "forward" });
    expect(rooms.action).toHaveBeenLastCalledWith({ action: "seek", positionSeconds: 72 });
    await service.control({ ...input, action: "restart" });
    expect(rooms.action).toHaveBeenLastCalledWith({ action: "seek", positionSeconds: 0 });
    await service.control({ ...input, action: "next" });
    expect(rooms.advance).toHaveBeenCalledExactlyOnceWith("dQw4w9WgXcQ");
    await expect(service.control({ ...input, queueItemId: "2".repeat(32), action: "next" })).rejects.toMatchObject({ code: "YOUTUBE_VIDEO_CHANGED" });
    expect(rooms.advance).toHaveBeenCalledTimes(1);
  });

  it("preserves playing content time when pausing and prevents seeks below zero", async () => {
    const { service, rooms } = harness();
    const room = rooms.getState().room!;
    room.timeline.playing = true; room.timeline.anchoredAtUnixMs = Date.now() - 10_000;
    await service.control({ type: "youtube-control", roomId, queueItemId: "1".repeat(32), action: "pause" });
    expect(rooms.action.mock.calls[0][0].positionSeconds).toBeGreaterThanOrEqual(52);
    room.timeline.playing = false; room.timeline.positionSeconds = 2;
    await service.control({ type: "youtube-control", roomId, queueItemId: "1".repeat(32), action: "back" });
    expect(rooms.action).toHaveBeenLastCalledWith({ action: "seek", positionSeconds: 0 });
  });

  it("supports play-now and queue editing while rejecting departed rooms and missing entries", async () => {
    const { service, rooms } = harness();
    await service.add("https://youtu.be/dQw4w9WgXcQ", roomId, true);
    expect(rooms.addToQueue).toHaveBeenCalledWith({ youtubeUrls: "https://youtu.be/dQw4w9WgXcQ", playNow: true });
    await service.queueAction({ type: "youtube-queue", roomId, queueItemId: "1".repeat(32), action: "play" });
    expect(rooms.queueAction).toHaveBeenCalledWith({ queueItemId: "1".repeat(32), action: "play" });
    await expect(service.queueAction({ type: "youtube-queue", roomId, queueItemId: "2".repeat(32), action: "remove" })).rejects.toMatchObject({ code: "YOUTUBE_VIDEO_CHANGED" });
    rooms.getState().room!.transition = {} as never;
    expect(service.getState().room?.controllable).toBe(false);
    await expect(service.control({ type: "youtube-control", roomId, queueItemId: "1".repeat(32), action: "play" })).rejects.toMatchObject({ code: "YOUTUBE_ROOM_TRANSITION" });
  });
  it("searches embeddable videos and reuses cached results across phones", async () => {
    const { service, request } = harness();
    const [page, duplicate] = await Promise.all([service.browse("cats & dogs", ""), service.browse("cats & dogs", "")]);
    expect(page).toEqual(duplicate);
    expect(page.items[0].videoId).toBe("dQw4w9WgXcQ");
    const url = request.mock.calls[0][0] as URL;
    expect(url.origin + url.pathname).toBe("https://www.googleapis.com/youtube/v3/search");
    expect(url.searchParams.get("q")).toBe("cats & dogs");
    expect(url.searchParams.get("videoEmbeddable")).toBe("true");
    page.items.length = 0;
    expect((await service.browse("cats & dogs", "")).items).toHaveLength(1);
    expect(request).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(service.getState())).not.toContain("test-key");
  });

  it("browses popular videos, filters embedding-disabled entries, and forwards pagination", async () => {
    const { service, request } = harness();
    request.mockResolvedValueOnce(new Response(JSON.stringify({ items: [
      { id: "dQw4w9WgXcQ", snippet: { title: "Video", channelTitle: "Channel" }, status: { embeddable: false } },
      { id: "9bZkp7q19f0", snippet: { title: "Other", channelTitle: "Channel" }, status: { embeddable: true } },
    ] })));
    expect((await service.browse("", "page-2")).items.map((item) => item.videoId)).toEqual(["9bZkp7q19f0"]);
    const url = request.mock.calls[0][0] as URL;
    expect(url.pathname).toBe("/youtube/v3/videos");
    expect(url.searchParams.get("chart")).toBe("mostPopular");
    expect(url.searchParams.get("pageToken")).toBe("page-2");
  });

  it("supports queue additions without a search key, using the existing room service", async () => {
    const { service, rooms, request } = harness("");
    expect(service.getState().searchConfigured).toBe(false);
    await expect(service.browse("cats", "")).rejects.toMatchObject({ code: "YOUTUBE_SEARCH_SETUP" });
    await service.add("https://youtu.be/dQw4w9WgXcQ", roomId);
    expect(rooms.addToQueue).toHaveBeenCalledWith({ youtubeUrls: "https://youtu.be/dQw4w9WgXcQ", playNow: false });
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects additions when the desktop left or changed rooms", async () => {
    const { service, rooms, setRoom } = harness();
    await expect(service.add("https://youtu.be/dQw4w9WgXcQ", "b".repeat(43))).rejects.toMatchObject({ code: "YOUTUBE_ROOM_CHANGED" });
    setRoom(null);
    await expect(service.add("https://youtu.be/dQw4w9WgXcQ", roomId)).rejects.toMatchObject({ code: "YOUTUBE_ROOM_CHANGED" });
    expect(rooms.addToQueue).not.toHaveBeenCalled();
  });

  it("redacts upstream failures and handles exhausted quota", async () => {
    const { service, request } = harness();
    request.mockRejectedValueOnce(new Error("https://www.googleapis.com/?key=test-key"));
    await expect(service.browse("cats", "")).rejects.toMatchObject({ code: "YOUTUBE_SEARCH_UNAVAILABLE", message: "YouTube could not be reached. Try again shortly." });
    request.mockResolvedValueOnce(new Response("secret upstream details", { status: 403 }));
    await expect(service.browse("cats", "")).rejects.toMatchObject({ code: "YOUTUBE_SEARCH_LIMIT" });
  });

  it("bounds search input and rejects malformed video IDs from upstream", async () => {
    const { service, request } = harness();
    await expect(service.browse("x".repeat(101), "")).rejects.toThrow();
    await expect(service.browse("cats", "../../evil")).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
    request.mockResolvedValueOnce(new Response(JSON.stringify({ items: [{ id: "../evil", snippet: { title: "Bad", channelTitle: "Bad" } }] })));
    await expect(service.browse("cats", "")).rejects.toMatchObject({ code: "YOUTUBE_SEARCH_UNAVAILABLE" });
  });

  it("requires a room target and a single bounded link in authenticated commands", () => {
    const envelope = { sessionEpoch: "a".repeat(32), sequence: 1, commandId: "6f084a65-2a40-41cb-a627-a4ef3ce40bbb", playbackId: null,
      command: { type: "youtube-add", videoUrl: "https://youtu.be/dQw4w9WgXcQ", roomId } };
    expect(companionCommandEnvelopeSchema.safeParse(envelope).success).toBe(true);
    expect(companionCommandEnvelopeSchema.safeParse({ ...envelope, command: { ...envelope.command, roomId: "bad" } }).success).toBe(false);
    expect(companionCommandEnvelopeSchema.safeParse({ ...envelope, command: { ...envelope.command, videoUrl: "https://youtu.be/dQw4w9WgXcQ\nhttps://youtu.be/9bZkp7q19f0" } }).success).toBe(false);
  });
});
