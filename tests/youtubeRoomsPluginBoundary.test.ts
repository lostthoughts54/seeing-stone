import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const pluginRoot = resolve(process.cwd(), "plugins", "SeeingStone.YouTubeRooms");

describe("YouTube Rooms plugin security boundary", () => {
  it("requires Jellyfin authentication and derives the user from the request principal", () => {
    const controller = readFileSync(resolve(pluginRoot, "YouTubeRoomsController.cs"), "utf8");
    expect(controller).toContain("[Authorize]");
    expect(controller).toContain("IAuthorizationContext");
    expect(controller).toContain("authorization.UserId");
    expect(controller).not.toMatch(/UserId\s*\)/);
  });

  it("uses random 32-byte tokens, temporary rooms, and direct membership checks", () => {
    const store = readFileSync(resolve(pluginRoot, "YouTubeRoomStore.cs"), "utf8");
    expect(store).toContain("RandomNumberGenerator.GetBytes(32)");
    expect(store).toContain("TimeSpan.FromHours(6)");
    expect(store).toContain("Join this room before changing it.");
    expect(store).not.toContain("HttpClient");
  });
});
