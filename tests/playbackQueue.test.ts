import { describe, expect, it, vi } from "vitest";
import type { MediaItem } from "../src/shared/contracts";
import { DefaultPlaybackContinuationResolver } from "../src/main/services/playbackContinuationResolver";
import { PlaybackQueueStore } from "../src/main/services/playbackQueue";

function item(id: string, type: "Movie" | "Episode" | "Video" = "Movie"): MediaItem {
  return {
    id,
    name: `${type} ${id}`,
    type,
    overview: "",
    productionYear: 2026,
    premiereYear: null,
    officialRating: null,
    communityRating: null,
    runTimeTicks: 10_000_000,
    genres: [],
    primaryImageAspectRatio: null,
    imageTags: {},
    backdropImageTag: null,
    parentThumbItemId: null,
    parentThumbImageTag: null,
    seriesId: type === "Episode" ? "series-1" : null,
    seriesName: type === "Episode" ? "Series" : null,
    seasonId: type === "Episode" ? "season-1" : null,
    indexNumber: type === "Episode" ? 2 : null,
    parentIndexNumber: type === "Episode" ? 1 : null,
    userData: { played: false, playbackPositionTicks: 0, playedPercentage: 0 },
    hasTrailer: false,
    playable: true,
  };
}

describe("PlaybackQueueStore and continuation resolution", () => {
  it("advances duplicate media by exact queue entry ID", async () => {
    const queue = new PlaybackQueueStore();
    queue.reset(item("movie-1"));
    const first = queue.add(item("movie-2"));
    const second = queue.add(item("movie-2"));
    const resolver = new DefaultPlaybackContinuationResolver(queue, { getNextUpForSeries: vi.fn() });

    const next = await resolver.getNext({ itemId: "movie-1", itemType: "Movie", seriesId: null });
    expect(next).toMatchObject({ continuationId: first.queueEntryId, source: "explicit-queue" });
    resolver.reserve(first.queueEntryId, "playback-1");
    resolver.commit(first.queueEntryId, "playback-1");
    expect(queue.getSnapshot().entries.map((entry) => [entry.queueEntryId, entry.state])).toEqual([
      [queue.getSnapshot().entries[0].queueEntryId, "played"],
      [first.queueEntryId, "current"],
      [second.queueEntryId, "upcoming"],
    ]);

    const duplicate = await resolver.getNext({ itemId: "movie-2", itemType: "Movie", seriesId: null });
    expect(duplicate?.continuationId).toBe(second.queueEntryId);
  });

  it("releases cancellation without advancing and blocks removal of a reservation", async () => {
    const queue = new PlaybackQueueStore();
    queue.reset(item("video-1", "Video"));
    const next = queue.add(item("video-2", "Video"));
    const revision = queue.getSnapshot().revision;
    queue.reserve(next.queueEntryId, "playback-1");
    expect(() => queue.remove(next.queueEntryId, revision + 1)).toThrowError(/transitioning/);
    queue.release(next.queueEntryId);
    expect(queue.getSnapshot().entries.find((entry) => entry.queueEntryId === next.queueEntryId)?.state).toBe("upcoming");
  });

  it("checks explicit queue for movies and videos, and Jellyfin Next Up only for episodes", async () => {
    const queue = new PlaybackQueueStore();
    const getNextUpForSeries = vi.fn(async () => item("episode-2", "Episode"));
    const resolver = new DefaultPlaybackContinuationResolver(queue, { getNextUpForSeries });

    queue.reset(item("movie-1"));
    await expect(resolver.getNext({ itemId: "movie-1", itemType: "Movie", seriesId: null })).resolves.toBeNull();
    expect(getNextUpForSeries).not.toHaveBeenCalled();

    const queued = queue.add(item("video-2", "Video"));
    await expect(resolver.getNext({ itemId: "movie-1", itemType: "Movie", seriesId: null }))
      .resolves.toMatchObject({ continuationId: queued.queueEntryId });
    expect(getNextUpForSeries).not.toHaveBeenCalled();

    queue.reset(item("episode-1", "Episode"));
    await expect(resolver.getNext({ itemId: "episode-1", itemType: "Episode", seriesId: "series-1" }))
      .resolves.toMatchObject({ continuationId: null, source: "jellyfin-next-up", item: { id: "episode-2" } });
  });

  it("keeps same-item loop rejection only for Jellyfin Next Up", async () => {
    const queue = new PlaybackQueueStore();
    queue.reset(item("movie-1"));
    const duplicate = queue.add(item("movie-1"));
    const resolver = new DefaultPlaybackContinuationResolver(queue, { getNextUpForSeries: async () => item("episode-1", "Episode") });
    await expect(resolver.getNext({ itemId: "movie-1", itemType: "Movie", seriesId: null }))
      .resolves.toMatchObject({ continuationId: duplicate.queueEntryId, item: { id: "movie-1" } });

    queue.reset(item("episode-1", "Episode"));
    await expect(resolver.getNext({ itemId: "episode-1", itemType: "Episode", seriesId: "series-1" })).resolves.toBeNull();
  });
});
