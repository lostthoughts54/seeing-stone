import { describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { CompanionStateService } from "../src/main/services/companionState";
import type { PlaybackState } from "../src/shared/contracts";

const playbackState = (overrides: Partial<PlaybackState> = {}): PlaybackState => ({
  playbackId: "11111111-1111-4111-8111-111111111111", itemId: "item-a", phase: "playing", source: "server",
  positionTicks: 10, durationTicks: 100, paused: false, buffering: false, seekable: true, seekableUntilTicks: null,
  volume: 100, fullscreen: false, audioTracks: [], subtitleTracks: [], error: null, contentKind: "on-demand", ...overrides,
});

function companionStateFor(state: PlaybackState, segments: unknown) {
  const player = { onState: vi.fn(), getState: vi.fn(() => state) };
  const service = new CompanionStateService(
    player as never,
    { onChanged: vi.fn(), getPrevious: vi.fn(() => null), peekNext: vi.fn(() => null) } as never,
    { getSnapshot: vi.fn(async () => ({ playback: state, item: null, nextUp: null })) } as never,
    {} as never,
    () => false,
    undefined,
    undefined,
    { getActiveMediaSegments: vi.fn(async () => segments) } as never,
  );
  return { service, player };
}

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

  it("shows only a sanitized active segment with desktop timing semantics", async () => {
    const segments = [
      { type: "Outro" as const, startTicks: 5, endTicks: 30 },
      { type: "Recap" as const, startTicks: 10, endTicks: 20 },
      { type: "Intro" as const, startTicks: 10, endTicks: 20 },
    ];
    const { service } = companionStateFor(playbackState({ positionTicks: 10 }), segments);
    await expect(service.getPlayerState()).resolves.toMatchObject({
      skipSegment: { type: "Intro", label: "Skip Intro", endTicks: 20, enabled: true },
    });

    const recap = companionStateFor(playbackState({ positionTicks: 11 }), [{ type: "Recap" as const, startTicks: 10, endTicks: 20 }]);
    await expect(recap.service.getPlayerState()).resolves.toMatchObject({ skipSegment: { label: "Skip Recap" } });
    const outro = companionStateFor(playbackState({ positionTicks: 11 }), [{ type: "Outro" as const, startTicks: 10, endTicks: 20 }]);
    await expect(outro.service.getPlayerState()).resolves.toMatchObject({ skipSegment: { label: "Skip Credits" } });
    const boundary = companionStateFor(playbackState({ positionTicks: 20 }), [{ type: "Intro" as const, startTicks: 10, endTicks: 20 }]);
    await expect(boundary.service.getPlayerState()).resolves.toMatchObject({ skipSegment: null });
    const malformed = companionStateFor(playbackState({ positionTicks: 10 }), [{ type: "Unknown", startTicks: 10, endTicks: 20 }]);
    await expect(malformed.service.getPlayerState()).resolves.toMatchObject({ skipSegment: null });
  });

  it("keeps optional segment state safe across progressive, Live TV, and playback replacement", async () => {
    const segment = [{ type: "Intro" as const, startTicks: 10, endTicks: 20 }];
    const progressive = companionStateFor(playbackState({ seekableUntilTicks: 19 }), segment);
    await expect(progressive.service.getPlayerState()).resolves.toMatchObject({ skipSegment: { enabled: false } });
    const available = companionStateFor(playbackState({ seekableUntilTicks: 20 }), segment);
    await expect(available.service.getPlayerState()).resolves.toMatchObject({ skipSegment: { enabled: true } });
    const live = companionStateFor(playbackState({ contentKind: "live-tv" }), segment);
    await expect(live.service.getPlayerState()).resolves.toMatchObject({ skipSegment: null });

    const replacement = companionStateFor(playbackState(), segment);
    replacement.player.getState.mockReturnValue(playbackState({ playbackId: "22222222-2222-4222-8222-222222222222", itemId: "item-b" }));
    await expect(replacement.service.getPlayerState()).resolves.toMatchObject({ skipSegment: null });
  });

  it("uses the existing typed seek command for the phone segment button", async () => {
    const [html, app, api] = await Promise.all([
      readFile("src/companion/index.html", "utf8"),
      readFile("src/companion/app.ts", "utf8"),
      readFile("src/companion/api.ts", "utf8"),
    ]);
    expect(html).toContain('id="skipSegment"');
    expect(app).toContain('command({ type: "seek", positionTicks: skipSegment.endTicks })');
    expect(api).toContain("playbackId: session.bootstrap.player.playbackId");
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
