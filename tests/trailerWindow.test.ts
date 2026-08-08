import { describe, expect, it, vi } from "vitest";

const { openExternal } = vi.hoisted(() => ({ openExternal: vi.fn() }));
vi.mock("electron", () => ({ shell: { openExternal } }));

import { TrailerWindowService, youtubeEmbedUrl, youtubeVideoId } from "../src/main/services/trailerWindow";
import { isAllowedTrailerRequest } from "../src/main/electronSecurity";

describe("YouTube trailer normalization", () => {
  it("accepts supported YouTube link forms and emits one controlled embed origin", () => {
    for (const value of [
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      "https://youtu.be/dQw4w9WgXcQ?t=12",
      "https://m.youtube.com/shorts/dQw4w9WgXcQ",
      "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ",
    ]) expect(youtubeVideoId(value)).toBe("dQw4w9WgXcQ");

    expect(youtubeEmbedUrl("https://youtu.be/dQw4w9WgXcQ")).toBe(
      "https://www.youtube.com/embed/dQw4w9WgXcQ?autoplay=1&controls=1&playsinline=1&rel=0",
    );
  });

  it("rejects lookalike hosts, scripts, malformed IDs, and unrelated trailers", () => {
    for (const value of [
      "https://youtube.com.attacker.invalid/watch?v=dQw4w9WgXcQ",
      "javascript:alert(1)",
      "https://www.youtube.com/watch?v=too-short",
      "https://trailers.example/movie",
    ]) expect(youtubeEmbedUrl(value)).toBeNull();
  });

  it("returns the controlled embed URL without opening another window", async () => {
    const service = new TrailerWindowService();
    await expect(service.open("https://youtu.be/dQw4w9WgXcQ")).resolves.toEqual({
      mode: "embedded",
      embedUrl: "https://www.youtube.com/embed/dQw4w9WgXcQ?autoplay=1&controls=1&playsinline=1&rel=0",
    });
    expect(openExternal).not.toHaveBeenCalled();
  });

  it("allows only a controlled YouTube frame and its own runtime resources", () => {
    expect(isAllowedTrailerRequest({
      url: "https://www.youtube.com/embed/dQw4w9WgXcQ?autoplay=1",
      resourceType: "subFrame",
      initiator: "app://bundle",
    })).toBe(true);
    expect(isAllowedTrailerRequest({
      url: "https://i.ytimg.com/vi/dQw4w9WgXcQ/default.jpg",
      resourceType: "image",
      initiator: "https://www.youtube.com",
    })).toBe(true);
    expect(isAllowedTrailerRequest({
      url: "https://www.youtube.com/s/player/player.js",
      resourceType: "script",
    })).toBe(true);
    expect(isAllowedTrailerRequest({
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      resourceType: "subFrame",
      initiator: "app://bundle",
    })).toBe(false);
    expect(isAllowedTrailerRequest({
      url: "https://www.youtube.com/embed/dQw4w9WgXcQ",
      resourceType: "fetch",
      initiator: "app://bundle",
    })).toBe(false);
  });
});
