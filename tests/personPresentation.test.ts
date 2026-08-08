import { describe, expect, it } from "vitest";
import type { MediaItem, MediaPerson } from "../src/shared/contracts";
import { groupPersonMediaResults, presentPeople } from "../src/shared/personPresentation";

const item = (id: string, type: MediaItem["type"], name = id, seriesId: string | null = null): MediaItem => ({ id, type, name, seriesId } as MediaItem);

describe("people presentation", () => {
  it("orders cast before crew and removes duplicate people while retaining roles", () => {
    const people: MediaPerson[] = [
      { id: "director", name: "Director", role: "", type: "Director", primaryImageTag: null },
      { id: "actor", name: "Actor", role: "Lead", type: "Actor", primaryImageTag: "portrait" },
      { id: "actor", name: "Actor duplicate", role: "", type: "Actor", primaryImageTag: null },
      { id: "writer", name: "Writer", role: "", type: "Writer", primaryImageTag: null },
    ];
    expect(presentPeople(people)).toEqual([people[1], people[0], people[3]]);
  });

  it("keeps movies and direct series, groups episodes by series identity, and counts unique guest episodes", () => {
    const movie = item("movie", "Movie", "Civil War");
    const directSeries = item("series-direct", "Series", "Devs");
    const guestSeries = item("series-guest", "Series", "Parks and Recreation");
    const episodes = [
      item("episode-1", "Episode", "Episode 1", "series-guest"),
      item("episode-2", "Episode", "Episode 2", "series-guest"),
      item("episode-2", "Episode", "Episode 2 duplicate", "series-guest"),
      item("episode-3", "Episode", "Episode 3", "series-direct"),
    ];
    const results = groupPersonMediaResults([movie], [directSeries], episodes, new Map([[guestSeries.id, guestSeries]]));
    expect(results).toEqual([
      { item: movie, source: "direct" },
      { item: directSeries, source: "direct" },
      { item: guestSeries, source: "episode-group", appearanceCount: 2 },
    ]);
  });

  it("does not merge different series with the same title and only falls back to episodes without a safe parent", () => {
    const first = item("series-a", "Series", "Same Title");
    const second = item("series-b", "Series", "Same Title");
    const orphan = item("orphan", "Episode", "Unlinked episode");
    const unresolved = item("unresolved", "Episode", "Unresolved episode", "missing-series");
    const results = groupPersonMediaResults([], [], [item("a1", "Episode", "A1", "series-a"), item("b1", "Episode", "B1", "series-b"), orphan, unresolved], new Map([[first.id, first], [second.id, second]]));
    expect(results.map((result) => result.item.id)).toEqual(["series-a", "series-b", "orphan", "unresolved"]);
  });
});
