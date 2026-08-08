import type { MediaItem, MediaPerson, PersonMediaResult } from "./contracts";

const personRank = (person: MediaPerson): number => {
  const type = person.type.toLowerCase();
  if (type === "actor" || type === "actress" || type === "cast") return 0;
  if (type === "director") return 1;
  if (type === "writer" || type === "screenwriter") return 2;
  return 3;
};

export function presentPeople(people: MediaPerson[], limit = 24): MediaPerson[] {
  const unique = new Map<string, MediaPerson>();
  for (const person of people) if (!unique.has(person.id)) unique.set(person.id, person);
  return [...unique.values()]
    .map((person, index) => ({ person, index }))
    .sort((left, right) => personRank(left.person) - personRank(right.person) || left.index - right.index)
    .slice(0, limit)
    .map(({ person }) => person);
}

export function groupPersonMediaResults(
  movies: MediaItem[],
  series: MediaItem[],
  episodes: MediaItem[],
  resolvedSeries: ReadonlyMap<string, MediaItem>,
): PersonMediaResult[] {
  const results = new Map<string, PersonMediaResult>();
  const directSeriesIds = new Set<string>();
  for (const item of movies) if (item.type === "Movie" && !results.has(item.id)) results.set(item.id, { item, source: "direct" });
  for (const item of series) {
    if (item.type !== "Series" || results.has(item.id)) continue;
    directSeriesIds.add(item.id);
    results.set(item.id, { item, source: "direct" });
  }

  const seenEpisodes = new Set<string>();
  const episodeGroups = new Map<string, number>();
  const ungroupedEpisodes: MediaItem[] = [];
  for (const episode of episodes) {
    if (episode.type !== "Episode" || seenEpisodes.has(episode.id)) continue;
    seenEpisodes.add(episode.id);
    if (episode.seriesId) episodeGroups.set(episode.seriesId, (episodeGroups.get(episode.seriesId) ?? 0) + 1);
    else ungroupedEpisodes.push(episode);
  }
  for (const [seriesId, appearanceCount] of episodeGroups) {
    if (directSeriesIds.has(seriesId)) continue;
    const item = resolvedSeries.get(seriesId);
    if (item?.type === "Series" && !results.has(item.id)) {
      results.set(item.id, { item, appearanceCount, source: "episode-group" });
    } else {
      for (const episode of episodes) if (episode.seriesId === seriesId && !results.has(episode.id)) results.set(episode.id, { item: episode, source: "direct" });
    }
  }
  for (const episode of ungroupedEpisodes) if (!results.has(episode.id)) results.set(episode.id, { item: episode, source: "direct" });
  return [...results.values()].sort((left, right) => left.item.name.localeCompare(right.item.name, undefined, { sensitivity: "base" }));
}
