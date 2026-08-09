import { describe, expect, it } from "vitest";
import { searchLiveTvGuide } from "../src/shared/liveTvSearch";
import type { LiveTvChannel, LiveTvProgram } from "../src/shared/contracts";

const channels: LiveTvChannel[] = [
  { id: "one", number: "5930", name: "Island One", imageTag: "one", isFavorite: false, currentProgramId: "now" },
  { id: "two", number: "101", name: "Sunset TV", imageTag: null, isFavorite: false, currentProgramId: null },
];
const program = (id: string, channelId: string, name: string, startUtc: string, episodeTitle: string | null = null): LiveTvProgram => ({
  id, channelId, name, startUtc, endUtc: new Date(Date.parse(startUtc) + 30 * 60_000).toISOString(), episodeTitle,
  overview: "Island arrivals and recaps", seasonNumber: null, episodeNumber: null, isLive: false, isSeries: true,
  isMovie: false, isNews: false, isKids: false, isSports: false, timerId: null, seriesTimerId: null,
});
const programs = [
  program("later", "two", "Love Island", "2026-08-10T20:00:00.000Z"),
  program("now", "one", "Love Island", "2026-08-09T18:00:00.000Z", "Episode 14"),
  program("repeat", "one", "Love Island", "2026-08-11T20:00:00.000Z"),
];

describe("Live TV guide search", () => {
  it("matches channel names and numbers case-insensitively", () => {
    expect(searchLiveTvGuide("ISLAND ONE", channels, programs).channels.map((channel) => channel.id)).toEqual(["one"]);
    expect(searchLiveTvGuide("5930", channels, programs).channels.map((channel) => channel.id)).toEqual(["one"]);
  });

  it("matches program and episode titles, retaining each airing chronologically", () => {
    const matches = searchLiveTvGuide("love island", channels, programs).programs;
    expect(matches.map((entry) => entry.program.id)).toEqual(["now", "later", "repeat"]);
    expect(searchLiveTvGuide("episode 14", channels, programs).programs.map((entry) => entry.program.id)).toEqual(["now"]);
    expect(matches[0].channel.id).toBe("one");
  });

  it("does not depend on the currently visible guide window", () => {
    expect(searchLiveTvGuide("love island", channels, programs).programs).toContainEqual(expect.objectContaining({ program: expect.objectContaining({ id: "repeat" }) }));
  });
});
