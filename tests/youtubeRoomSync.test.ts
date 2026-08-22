import { describe, expect, it } from "vitest";
import { authoritativeYouTubePosition, shouldCorrectYouTubePosition } from "../src/renderer/youtubeRoomSync";

const timeline = {
  videoId: "dQw4w9WgXcQ",
  positionSeconds: 30,
  playing: true,
  anchoredAtUnixMs: 10_000,
  version: 4,
  changedBy: "Kayla",
};

describe("YouTube room content-clock synchronization", () => {
  it("advances a playing server anchor and freezes a paused anchor", () => {
    expect(authoritativeYouTubePosition(timeline, 12_500)).toBe(32.5);
    expect(authoritativeYouTubePosition({ ...timeline, playing: false }, 99_000)).toBe(30);
  });

  it("corrects meaningful drift only while the content identity and duration are stable", () => {
    expect(shouldCorrectYouTubePosition({
      timeline,
      localPositionSeconds: 29,
      playerReady: true,
      contentIdentityMatches: true,
      durationStable: true,
      nowUnixMs: 12_000,
    })).toBe(true);
    expect(shouldCorrectYouTubePosition({
      timeline,
      localPositionSeconds: 31.2,
      playerReady: true,
      contentIdentityMatches: true,
      durationStable: true,
      nowUnixMs: 12_000,
    })).toBe(false);
  });

  it("does not issue timeline corrections while an ad or player transition is suspected", () => {
    for (const blocked of [
      { playerReady: false, contentIdentityMatches: true, durationStable: true },
      { playerReady: true, contentIdentityMatches: false, durationStable: true },
      { playerReady: true, contentIdentityMatches: true, durationStable: false },
    ]) expect(shouldCorrectYouTubePosition({
      timeline,
      localPositionSeconds: 0,
      nowUnixMs: 20_000,
      ...blocked,
    })).toBe(false);
  });
});
