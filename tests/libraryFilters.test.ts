import { describe, expect, it } from "vitest";
import type { MediaItem } from "../src/shared/contracts";
import {
  activeLibraryFilterCount,
  createLibraryFilterState,
  libraryFiltersToBrowseQuery,
  matchesLibraryFilters,
} from "../src/renderer/libraryFilters";

function item(overrides: Partial<MediaItem> = {}): MediaItem {
  return {
    id: "movie-1", name: "Example", type: "Movie", overview: "", productionYear: 2022,
    premiereYear: 2022, dateCreated: "2026-08-01T00:00:00.000Z", officialRating: "PG-13",
    communityRating: 8.2, runTimeTicks: 7_200_000_000, genres: ["Comedy", "Action"],
    people: [{ id: "person-1", name: "Ada Actor", role: "Lead", type: "Actor", primaryImageTag: null }],
    primaryImageAspectRatio: null, imageTags: {}, backdropImageTag: null, parentThumbItemId: null,
    parentThumbImageTag: null, seriesId: null, seriesName: null, seasonId: null, indexNumber: null,
    parentIndexNumber: null, userData: { played: false, favorite: true, playbackPositionTicks: 10, playedPercentage: 20 },
    hasTrailer: false, playable: true, mediaVersions: [{ itemId: "movie-1", mediaSourceId: "source-1", name: null,
      label: "4K HEVC HDR10", container: "mkv", width: 3840, height: 2160, videoCodec: "hevc",
      audioCodec: "eac3", audioChannels: "7.1", bitrate: null, size: null, videoRange: "HDR10",
      runtimeTicks: 7_200_000_000, supportsDirectPlay: true, supportsDirectStream: true, supportsTranscoding: true }],
    ...overrides,
  };
}

describe("advanced library filters", () => {
  it("uses Any within a group and AND between groups", () => {
    const filters = createLibraryFilterState();
    filters.genres.included = ["Drama", "Comedy"];
    filters.premiereYear.min = 2020;
    filters.technical.included = ["4k"];
    expect(matchesLibraryFilters(item(), filters)).toBe(true);
    filters.premiereYear.min = 2024;
    expect(matchesLibraryFilters(item(), filters)).toBe(false);
  });

  it("requires every selected value in All mode", () => {
    const filters = createLibraryFilterState();
    filters.genres = { included: ["Comedy", "Action"], excluded: [], match: "all" };
    expect(matchesLibraryFilters(item(), filters)).toBe(true);
    filters.genres.included.push("Drama");
    expect(matchesLibraryFilters(item(), filters)).toBe(false);
  });

  it("keeps future exclusions exact without exposing an exclusion UI", () => {
    const filters = createLibraryFilterState();
    filters.genres.excluded = ["Horror"];
    expect(matchesLibraryFilters(item(), filters)).toBe(true);
    filters.genres.excluded = ["Action"];
    expect(matchesLibraryFilters(item(), filters)).toBe(false);
  });

  it("counts selections and range boundaries", () => {
    const filters = createLibraryFilterState();
    filters.genres.included = ["Comedy", "Action"];
    filters.runtimeMinutes.min = 60;
    expect(activeLibraryFilterCount(filters)).toBe(3);
  });

  it("keeps the Jellyfin request translation separate from filter state", () => {
    expect(libraryFiltersToBrowseQuery("library-1", "Movie", "rating-descending", createLibraryFilterState(), 120, 60)).toEqual({
      query: { libraryId: "library-1", type: "Movie", sort: "rating-descending", startIndex: 120, limit: 60 },
      unsupported: [],
      alwaysEmpty: false,
    });
  });

  it("translates supported filters onto the paginated Jellyfin query", () => {
    const filters = createLibraryFilterState();
    filters.genres.included = ["Comedy", "Action"];
    filters.quick.included = ["favorite"];
    filters.premiereYear.min = 2020;
    filters.communityRating.min = 7;
    const translated = libraryFiltersToBrowseQuery("library-1", "Series", "title-ascending", filters, 60, 60);
    expect(translated.unsupported).toEqual([]);
    expect(translated.query).toMatchObject({
      genres: ["Comedy", "Action"], favorite: true, minCommunityRating: 7, startIndex: 60, limit: 60,
    });
    expect(translated.query.minPremiereDate).toBe("2020-01-01T00:00:00.000Z");
  });

  it("does not silently downgrade unsupported All-selected genre semantics", () => {
    const filters = createLibraryFilterState();
    filters.genres = { included: ["Comedy", "Action"], excluded: [], match: "all" };
    const translated = libraryFiltersToBrowseQuery("library-1", "Movie", "title-ascending", filters, 0, 60);
    expect(translated.unsupported).toContain("All-selected Genres");
    expect(translated.query.genres).toBeUndefined();
  });
});
