import { describe, expect, it, vi } from "vitest";
import type { MediaItem } from "../src/shared/contracts";
import { PlaybackSessionService } from "../src/main/services/playbackSession";

const item: MediaItem = {
  id: "movie-1",
  name: "Movie",
  type: "Movie",
  overview: "",
  productionYear: 2026,
  runTimeTicks: 100000000,
  genres: [],
  primaryImageAspectRatio: null,
  imageTags: {},
  backdropImageTag: null,
  parentThumbItemId: null,
  parentThumbImageTag: null,
  seriesId: null,
  seriesName: null,
  seasonId: null,
  indexNumber: null,
  parentIndexNumber: null,
  userData: { played: false, playbackPositionTicks: 50000000, playedPercentage: 50 },
  hasTrailer: false,
  playable: true,
};

describe("PlaybackSessionService", () => {
  it("returns only an opaque application URL and resolves the authenticated stream internally", async () => {
    const fetchStaticStream = vi.fn(async () => new Response("video", { headers: { "Content-Type": "video/mp4" } }));
    const service = new PlaybackSessionService({
      async getDetails() { return item; },
      async getMediaSourceCapabilities() {
        return { itemId: item.id, sources: [{ id: "source-1", container: "mp4", size: 5, supportsDirectPlay: true, supportsDirectStream: true, supportsTranscoding: true }] };
      },
      fetchStaticStream,
    });
    const started = await service.start(item.id, "resume");
    expect(started.mediaUrl).toBe("jellyfin-media://stream/current");
    expect(JSON.stringify(started)).not.toContain("source-1");
    expect(JSON.stringify(started)).not.toContain("http");
    expect(started.resumePositionTicks).toBe(50000000);
    expect((await service.handle(new Request(started.mediaUrl))).status).toBe(200);
    expect(fetchStaticStream).toHaveBeenCalledWith("movie-1", "source-1", undefined);
  });
});
