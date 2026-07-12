import { describe, expect, it, vi } from "vitest";
import type { MediaItem } from "../src/shared/contracts";
import { PlaybackCompletionCoordinator } from "../src/main/services/playbackCompletion";

const episode = (id: string, seasonId: string): MediaItem => ({
  id,
  name: id,
  type: "Episode",
  overview: "",
  productionYear: 2026,
  premiereYear: null,
  officialRating: null,
  communityRating: null,
  runTimeTicks: 100,
  genres: [],
  primaryImageAspectRatio: null,
  imageTags: {},
  backdropImageTag: null,
  parentThumbItemId: null,
  parentThumbImageTag: null,
  seriesId: "series-1",
  seriesName: "Series",
  seasonId,
  indexNumber: 1,
  parentIndexNumber: seasonId === "season-1" ? 1 : 2,
  userData: { played: false, playbackPositionTicks: 0, playedPercentage: 0 },
  hasTrailer: false,
  playable: true,
});

describe("PlaybackCompletionCoordinator", () => {
  it("retries a stale current item and accepts Jellyfin's cross-season Next Up result", async () => {
    const wait = vi.fn(async () => undefined);
    const query = vi.fn()
      .mockResolvedValueOnce(episode("episode-1", "season-1"))
      .mockResolvedValueOnce(episode("episode-2", "season-2"));
    const coordinator = new PlaybackCompletionCoordinator(10, 3, wait);

    await expect(coordinator.findNextEpisode("episode-1", query, () => true))
      .resolves.toMatchObject({ id: "episode-2", seasonId: "season-2" });
    expect(query).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledWith(250);
  });

  it("cancels stale lookups and treats lookup failures or no result as no autoplay", async () => {
    const coordinator = new PlaybackCompletionCoordinator(10, 3, async () => undefined);
    await expect(coordinator.findNextEpisode("episode-1", async () => null, () => true)).resolves.toBeNull();
    await expect(coordinator.findNextEpisode("episode-1", async () => { throw new Error("offline"); }, () => true)).resolves.toBeNull();
    await expect(coordinator.findNextEpisode("episode-1", async () => episode("episode-2", "season-2"), () => false)).resolves.toBeNull();
  });

  it("shows every countdown second and cancels when the playback revision changes", async () => {
    let current = true;
    const show = vi.fn(async (remaining: number) => { if (remaining === 8) current = false; });
    const coordinator = new PlaybackCompletionCoordinator(10, 3, async () => undefined);
    await expect(coordinator.countdown({ isCurrent: () => current, show })).resolves.toBe(false);
    expect(show.mock.calls.map(([remaining]) => remaining)).toEqual([10, 9, 8]);
  });

  it("completes a full countdown when the playback revision stays current", async () => {
    const show = vi.fn(async () => undefined);
    const coordinator = new PlaybackCompletionCoordinator(3, 3, async () => undefined);
    await expect(coordinator.countdown({ isCurrent: () => true, show })).resolves.toBe(true);
    expect(show.mock.calls.map(([remaining]) => remaining)).toEqual([3, 2, 1]);
  });
});
