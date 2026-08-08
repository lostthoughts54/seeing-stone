import { describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { CompanionStateService } from "../src/main/services/companionState";

describe("Companion library browsing", () => {
  it("ships a searchable phone guide that can switch channels without leaving the view", async () => {
    const [html, app] = await Promise.all([
      readFile("src/companion/index.html", "utf8"),
      readFile("src/companion/app.ts", "utf8"),
    ]);
    for (const id of ["liveTvView", "liveTvSearch", "liveTvGuideStatus", "liveTvGuideList", "refreshLiveTv"]) {
      expect(html).toContain(`id="${id}"`);
    }
    expect(html).toContain('data-view="liveTv"');
    expect(app).toContain('command({ type: "start-live", channelRef: channel.channelRef })');
    expect(app).toContain("...channel.programs.map((program) => program.name)");
    expect(app).toContain("matches.slice(0, 200)");
  });

  it("keeps Jellyfin libraries separate and pages TV-style libraries as series with the selected sort", async () => {
    const libraries = [
      { id: "movies-id", name: "Movies", collectionType: "movies" },
      { id: "shows-id", name: "TV Shows", collectionType: "tvshows" },
      { id: "anime-id", name: "Anime", collectionType: "tvshows" },
      { id: "music-id", name: "Music", collectionType: "music" },
    ];
    const getLibraryItemsPage = vi.fn(async () => ({
      items: [{
        id: "anime-series-1",
        name: "Anime Series",
        type: "Series",
        seriesName: null,
        parentIndexNumber: null,
        indexNumber: null,
        productionYear: 2025,
        runTimeTicks: 0,
        playable: false,
        imageTags: { Primary: "tag" },
      }],
      totalRecordCount: 31,
    }));
    const api = {
      getLibraries: vi.fn(async () => libraries),
      getLibraryItemsPage,
    };
    const service = new CompanionStateService(
      { onState: vi.fn() } as never,
      { onChanged: vi.fn() } as never,
      {} as never,
      api as never,
      () => false,
    );

    const summaries = await service.getLibraries();
    expect(summaries.map((library) => library.name)).toEqual(["Movies", "TV Shows", "Anime"]);
    const anime = summaries.find((library) => library.name === "Anime")!;
    const page = await service.getLibraryPage(anime.itemRef, 0, 30, "release-date");

    expect(getLibraryItemsPage).toHaveBeenCalledWith("anime-id", "Series", 0, 30, "release-date");
    expect(page.items).toMatchObject([{ name: "Anime Series", type: "series" }]);
    expect(page.nextOffset).toBe(1);
    expect(anime.itemRef).not.toContain("anime-id");
  });

  it("exposes an opaque searchable Live TV guide without server channel identities", async () => {
    const now = Date.now();
    const player = {
      onState: vi.fn(),
      getState: vi.fn(() => ({ contentKind: "live-tv", itemId: "private-channel-1" })),
    };
    const liveTv = {
      getGuide: vi.fn(async () => ({
        status: { availability: "available", hasGuide: true, canManageRecordings: false, message: null },
        windowStartUtc: new Date(now - 60_000).toISOString(),
        windowEndUtc: new Date(now + 60 * 60_000).toISOString(),
        channels: [{ id: "private-channel-1", name: "News 12", number: "12", imageTag: null, isFavorite: false, currentProgramId: null }],
        programs: [{
          id: "private-program-1",
          channelId: "private-channel-1",
          name: "Evening News",
          overview: "",
          startUtc: new Date(now - 60_000).toISOString(),
          endUtc: new Date(now + 30 * 60_000).toISOString(),
          isSeries: false,
          isMovie: false,
          isSports: false,
          isNews: true,
          seriesId: null,
        }],
      })),
    };
    const service = new CompanionStateService(
      player as never,
      { onChanged: vi.fn() } as never,
      {} as never,
      {} as never,
      () => false,
      liveTv as never,
    );

    const guide = await service.getLiveTvGuide();
    expect(guide.channels).toMatchObject([{
      name: "News 12",
      number: "12",
      isPlaying: true,
      programs: [{ name: "Evening News", isLive: true }],
    }]);
    expect(guide.channels[0].channelRef).toMatch(/^[A-Za-z0-9_-]{16,256}$/);
    expect(service.resolveItemRef(guide.channels[0].channelRef)).toBe("private-channel-1");
    expect(JSON.stringify(guide)).not.toContain("private-channel-1");
    expect(JSON.stringify(guide)).not.toContain("private-program-1");
  });
});
