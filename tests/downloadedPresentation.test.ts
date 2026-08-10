import { describe, expect, it } from "vitest";
import { groupDownloadedRecords } from "../src/renderer/downloadedPresentation";
import type { DownloadSummary } from "../src/shared/contracts";

function record(id: string, overrides: Partial<DownloadSummary> = {}): DownloadSummary {
  const item = { id, name: overrides.name ?? id, type: "Episode", overview: "", productionYear: 2024, premiereYear: 2024, officialRating: null, communityRating: null, runTimeTicks: 0, genres: [], primaryImageAspectRatio: null, imageTags: {}, backdropImageTag: null, parentThumbItemId: null, parentThumbImageTag: null, seriesId: "series-a", seriesName: "The Orville", seasonId: null, indexNumber: 1, parentIndexNumber: 1, userData: { played: false, playbackPositionTicks: 0, playedPercentage: 0 }, hasTrailer: false, playable: true } as DownloadSummary["item"];
  return { downloadId: id, itemId: id, mediaSourceId: `source-${id}`, versionLabel: "1080p", name: id, itemType: "Episode", item, resumePositionTicks: 0, localPlaybackAvailable: true, canWatchWhileDownloading: false, state: "downloaded", bytesDownloaded: 100, expectedSize: 100, progressPercent: 100, keepDownloaded: false, smartManaged: false, error: null, canPause: false, canResume: false, canRetry: false, canCancel: false, canDelete: true, ...overrides };
}

describe("downloaded episode grouping", () => {
  it("groups two or more episodes only by stable series identity", () => {
    const groups = groupDownloadedRecords([record("one"), record("two", { item: { ...record("two").item, indexNumber: 2 } }), record("other", { item: { ...record("other").item, seriesId: "series-b" } })], "all", "title-ascending");
    expect(groups.filter((group) => group.kind === "series")).toHaveLength(1);
    expect(groups.filter((group) => group.kind === "individual")).toHaveLength(1);
  });
  it("keeps movies, missing series IDs, and one episode individual", () => {
    const movie = record("movie", { itemType: "Movie", item: { ...record("movie").item, type: "Movie", seriesId: null } });
    const missing = record("missing", { item: { ...record("missing").item, seriesId: null } });
    expect(groupDownloadedRecords([movie, missing, record("one")], "all", "title-ascending").every((group) => group.kind === "individual")).toBe(true);
  });
  it("orders children deterministically and summarizes sizes and Smart state", () => {
    const first = record("late", { expectedSize: 200, item: { ...record("late").item, indexNumber: 10 }, smartManaged: true });
    const second = record("early", { expectedSize: 100, item: { ...record("early").item, indexNumber: 2 }, smartManaged: false });
    const group = groupDownloadedRecords([first, second], "all", "title-ascending")[0];
    expect(group).toMatchObject({ kind: "series", bytes: 300, smart: "mixed" });
    if (group.kind === "series") expect(group.downloads.map((download) => download.downloadId)).toEqual(["early", "late"]);
  });
  it("filters before grouping and preserves separate physical versions", () => {
    const watched = record("v1", { item: { ...record("v1").item, userData: { played: true, playbackPositionTicks: 0, playedPercentage: 100 } } });
    const unwatched = record("v2", { mediaSourceId: "4k", item: { ...record("v2").item, userData: { played: false, playbackPositionTicks: 0, playedPercentage: 0 } } });
    expect(groupDownloadedRecords([watched, unwatched], "watched", "title-ascending")[0]).toMatchObject({ kind: "individual", download: { downloadId: "v1" } });
    const all = groupDownloadedRecords([watched, unwatched], "all", "title-ascending")[0];
    if (all.kind === "series") expect(all.downloads.map((download) => download.mediaSourceId)).toEqual(["source-v1", "4k"]);
  });
});
