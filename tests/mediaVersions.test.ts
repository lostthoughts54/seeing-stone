import { describe, expect, it, vi } from "vitest";
import type { BrowsePage, BrowseQuery, MediaItem, MediaVersion } from "../src/shared/contracts";
import { sanitizeMediaItem } from "../src/main/services/jellyfinApi";
import { PlaybackSessionService } from "../src/main/services/playbackSession";
import { selectDownloadSource } from "../src/main/services/downloadManager";
import { loadAllBrowseItems } from "../src/renderer/browsePagination";
import { groupMovieVersions } from "../src/shared/mediaVersions";

function movie(id: string, overrides: Partial<MediaItem> = {}): MediaItem {
  return {
    id,
    name: "Movie",
    type: "Movie",
    overview: "",
    productionYear: 2026,
    premiereYear: 2026,
    officialRating: null,
    communityRating: null,
    runTimeTicks: 100_000_000,
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
    userData: { played: false, playbackPositionTicks: 0, playedPercentage: 0 },
    hasTrailer: false,
    playable: true,
    ...overrides,
  };
}

function version(itemId: string, mediaSourceId: string): MediaVersion {
  return {
    itemId,
    mediaSourceId,
    name: null,
    label: mediaSourceId,
    container: "mkv",
    width: 1920,
    height: 1080,
    videoCodec: "h264",
    audioCodec: "aac",
    audioChannels: "5.1",
    bitrate: 8_000_000,
    size: 100,
    videoRange: "SDR",
    runtimeTicks: 100_000_000,
    supportsDirectPlay: true,
    supportsDirectStream: true,
    supportsTranscoding: true,
  };
}

describe("movie version grouping", () => {
  it("sanitizes one Jellyfin item with three MediaSources into one card with three selectable versions", () => {
    const item = sanitizeMediaItem({
      Id: "movie-1", Name: "Blade Runner", Type: "Movie", RunTimeTicks: 100,
      ProviderIds: { Imdb: "tt0083658" },
      MediaSources: [
        { Id: "source-1", Name: "Theatrical Cut", Container: "mkv", SupportsDirectPlay: true, MediaStreams: [{ Type: "Video", Width: 1920, Height: 1080, Codec: "h264" }] },
        { Id: "source-2", Name: "Final Cut", Container: "mkv", SupportsDirectStream: true, MediaStreams: [{ Type: "Video", Width: 3840, Height: 2160, Codec: "hevc", VideoRange: "HDR10" }] },
        { Id: "source-3", Name: "D:\\Movies\\Blade Runner.mkv", Container: "mkv", SupportsTranscoding: true, TranscodingUrl: "/Videos/x?api_key=secret" },
      ],
    });
    expect(groupMovieVersions([item])).toHaveLength(1);
    expect(item.mediaVersions).toHaveLength(3);
    expect(item.mediaVersions?.[0].label).toContain("Theatrical Cut");
    expect(JSON.stringify(item)).not.toContain("D:\\Movies");
    expect(JSON.stringify(item)).not.toContain("api_key");
  });

  it("condenses multiple item IDs only with authoritative shared identity", () => {
    const grouped = groupMovieVersions([
      movie("br-1080", { name: "Blade Runner", providerIds: { Imdb: "tt0083658" }, mediaVersions: [version("br-1080", "source-1080")] }),
      movie("br-4k", { name: "Blade Runner", providerIds: { Tmdb: "78", Imdb: "tt0083658" }, mediaVersions: [version("br-4k", "source-4k")] }),
    ]);
    expect(grouped).toHaveLength(1);
    expect(grouped[0].mediaVersions?.map((entry) => entry.itemId)).toEqual(["br-1080", "br-4k"]);
  });

  it("does not merge same-title unrelated movies or remakes", () => {
    expect(groupMovieVersions([
      movie("thing-1982", { name: "The Thing", productionYear: 1982, providerIds: { Tmdb: "1091" } }),
      movie("thing-2011", { name: "The Thing", productionYear: 2011, providerIds: { Tmdb: "60935" } }),
      movie("crash-a", { name: "Crash" }),
      movie("crash-b", { name: "Crash" }),
    ])).toHaveLength(4);
  });

  it("uses one conservative identity precedence and avoids transitive provider collisions", () => {
    expect(groupMovieVersions([
      movie("a", { providerIds: { Imdb: "tt-a", Tmdb: "shared" } }),
      movie("b", { providerIds: { Imdb: "tt-b", Tmdb: "shared" } }),
    ])).toHaveLength(2);
    expect(groupMovieVersions([
      movie("primary", { presentationUniqueKey: "primary", providerIds: { Imdb: "tt-a" } }),
      movie("alternate", { presentationUniqueKey: "primary", providerIds: { Imdb: "tt-b" } }),
    ])).toHaveLength(1);
  });

  it("preserves logical sort order and merges versions across browse page boundaries", async () => {
    const alien4k = movie("alien-4k", { name: "Alien", providerIds: { Imdb: "tt0078748" }, mediaVersions: [version("alien-4k", "4k")] });
    const alien1080 = movie("alien-1080", { name: "Alien", providerIds: { Imdb: "tt0078748" }, mediaVersions: [version("alien-1080", "1080")] });
    const aliens = movie("aliens", { name: "Aliens", providerIds: { Imdb: "tt0090605" } });
    const query: BrowseQuery = { type: "Movie", sort: "title-ascending", startIndex: 0, limit: 2 };
    const getPage = vi.fn(async (input: BrowseQuery): Promise<BrowsePage> => ({
      items: input.startIndex === 0 ? [alien4k, alien1080] : [aliens],
      totalRecordCount: 3,
    }));
    const result = await loadAllBrowseItems(query, getPage, () => true);
    expect(result?.map((entry) => entry.name)).toEqual(["Alien", "Aliens"]);
    expect(result?.[0].mediaVersions).toHaveLength(2);
    expect(getPage.mock.calls.map(([input]) => input.startIndex)).toEqual([0, 2]);
  });

  it("derives logical display progress without copying state between item IDs", () => {
    const first = movie("a", { providerIds: { Tmdb: "1" }, userData: { played: true, playbackPositionTicks: 0, playedPercentage: 100 } });
    const second = movie("b", { providerIds: { Tmdb: "1" }, userData: { played: false, playbackPositionTicks: 40, playedPercentage: 40 } });
    const grouped = groupMovieVersions([first, second])[0];
    expect(grouped.userData).toEqual(second.userData);
    expect(first.userData.played).toBe(true);
  });
});

describe("explicit playback source selection", () => {
  const sources = [
    { id: "transcode", name: "4K", container: "mkv", size: 10, supportsDirectPlay: false, supportsDirectStream: false, supportsTranscoding: true },
    { id: "direct", name: "1080p", container: "mp4", size: 5, supportsDirectPlay: true, supportsDirectStream: true, supportsTranscoding: true },
  ];
  const harness = () => new PlaybackSessionService({
    getDetails: vi.fn(async () => movie("movie-1")),
    getMediaSourceCapabilities: vi.fn(async () => ({ itemId: "movie-1", sources })),
    fetchStaticStream: vi.fn(),
    fetchTranscodedStream: vi.fn(),
  });

  it("keeps Auto negotiation ordering and selects an explicit source exactly", async () => {
    const automatic = await harness().start("movie-1", "start-over");
    expect(automatic.mediaSourceId).toBe("direct");
    expect(automatic.sourceKind).toBe("direct-play");
    const explicit = await harness().start("movie-1", "start-over", { preferredMediaSourceId: "transcode" });
    expect(explicit.mediaSourceId).toBe("transcode");
    expect(explicit.sourceKind).toBe("transcode");
    expect(explicit.diagnostics?.versionLabel).toContain("4K");
  });

  it("fails safely when an explicit source disappears", async () => {
    await expect(harness().start("movie-1", "start-over", { preferredMediaSourceId: "gone" }))
      .rejects.toMatchObject({ code: "MEDIA_SOURCE_STALE" });
  });

  it("passes the explicit source constraint to local resolution", async () => {
    const local = { resolve: vi.fn(async () => null) };
    const service = new PlaybackSessionService({
      getDetails: vi.fn(async () => movie("movie-1")),
      getMediaSourceCapabilities: vi.fn(async () => ({ itemId: "movie-1", sources })),
      fetchStaticStream: vi.fn(), fetchTranscodedStream: vi.fn(),
    }, local);
    await service.start("movie-1", "start-over", { preferredMediaSourceId: "direct" });
    expect(local.resolve).toHaveBeenCalledWith("movie-1", "start-over", expect.any(Set), "direct");
  });
});

describe("explicit download source selection", () => {
  const capabilities = {
    itemId: "movie-1",
    sources: [
      { id: "large", container: "mkv", size: 100, supportsDirectPlay: false, supportsDirectStream: true, supportsTranscoding: true },
      { id: "small", container: "mp4", size: 50, supportsDirectPlay: true, supportsDirectStream: true, supportsTranscoding: true },
    ],
  };

  it("keeps Auto behavior and downloads the explicitly selected source exactly", () => {
    expect(selectDownloadSource(capabilities).id).toBe("small");
    expect(selectDownloadSource(capabilities, "large").id).toBe("large");
  });

  it("does not silently fall back when the selected download source disappears", () => {
    expect(() => selectDownloadSource(capabilities, "gone"))
      .toThrowError(expect.objectContaining({ code: "DOWNLOAD_SOURCE_STALE" }));
  });

  it("rejects an explicit source that is present but no longer playable", () => {
    expect(() => selectDownloadSource({
      itemId: "movie-1",
      sources: [{ id: "offline", container: null, size: null, supportsDirectPlay: false, supportsDirectStream: false, supportsTranscoding: false }],
    }, "offline")).toThrowError(expect.objectContaining({ code: "DOWNLOAD_SOURCE_UNAVAILABLE" }));
  });
});
