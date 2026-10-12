import { describe, expect, it, vi } from "vitest";
import type { MediaItem } from "../src/shared/contracts";
import { markSeasonEpisodesWatched, unwatchedSeasonEpisodes } from "../src/renderer/seasonWatched";

const episode = (id: string, overrides: Partial<MediaItem> = {}): MediaItem => ({
  id, type: "Episode", seriesId: "series", seasonId: "season", userData: { played: false, playbackPositionTicks: 0, playedPercentage: 0 }, ...overrides,
} as MediaItem);

describe("mark season watched", () => {
  it("targets only unwatched episodes in the selected season, once per item", () => {
    expect(unwatchedSeasonEpisodes([
      episode("one"), episode("one"), episode("two"),
      episode("watched", { userData: { played: true, playbackPositionTicks: 0, playedPercentage: 100 } }),
      episode("other-season", { seasonId: "other" }), episode("other-series", { seriesId: "other" }),
      episode("movie", { type: "Movie" }),
    ], "series", "season").map((item) => item.id)).toEqual(["one", "two"]);
  });

  it("reports partial failures and offline queues, updating only successful items", async () => {
    const onMarked = vi.fn();
    const onProgress = vi.fn();
    const result = await markSeasonEpisodesWatched([episode("one"), episode("two"), episode("three")], "series", "season", {
      setWatched: async (itemId) => {
        if (itemId === "two") throw new Error("storage error");
        return { itemId, watched: true, synchronization: itemId === "one" ? "queued" : "synchronized" };
      },
      isSessionCurrent: () => true, onMarked, onProgress,
    });
    expect(result).toEqual({ marked: 2, queued: 1, failed: 1, cancelled: false });
    expect(onMarked.mock.calls).toEqual([["one"], ["three"]]);
    expect(onProgress).toHaveBeenLastCalledWith(3, 3);
  });

  it("keeps the original season snapshot when the displayed episode list changes", async () => {
    const episodes = [episode("one"), episode("two")];
    const setWatched = vi.fn(async (itemId: string) => {
      episodes.splice(0, episodes.length, episode("other", { seasonId: "other" }));
      return { itemId, watched: true, synchronization: "synchronized" as const };
    });
    await markSeasonEpisodesWatched(episodes, "series", "season", { setWatched, isSessionCurrent: () => true, onMarked() {}, onProgress() {} });
    expect(setWatched.mock.calls).toEqual([["one"], ["two"]]);
  });

  it("stops subsequent mutations and UI updates when the signed-in session changes", async () => {
    let current = true;
    const onMarked = vi.fn();
    const setWatched = vi.fn(async (itemId: string) => {
      current = false;
      return { itemId, watched: true, synchronization: "queued" as const };
    });
    const result = await markSeasonEpisodesWatched([episode("one"), episode("two")], "series", "season", {
      setWatched, isSessionCurrent: () => current, onMarked, onProgress() {},
    });
    expect(result.cancelled).toBe(true);
    expect(setWatched).toHaveBeenCalledOnce();
    expect(onMarked).not.toHaveBeenCalled();
  });

  it("does not mark a mismatched response as a success or issue writes for an already watched season", async () => {
    const onMarked = vi.fn();
    const setWatched = vi.fn(async () => ({ itemId: "wrong", watched: true, synchronization: "synchronized" as const }));
    const options = { setWatched, isSessionCurrent: () => true, onMarked, onProgress() {} };
    expect((await markSeasonEpisodesWatched([episode("one")], "series", "season", options)).failed).toBe(1);
    expect(onMarked).not.toHaveBeenCalled();
    setWatched.mockClear();
    await markSeasonEpisodesWatched([episode("done", { userData: { played: true, playbackPositionTicks: 0, playedPercentage: 100 } })], "series", "season", options);
    expect(setWatched).not.toHaveBeenCalled();
  });
});
