import type { MediaItem, WatchedStateResult } from "../shared/contracts";

export function unwatchedSeasonEpisodes(episodes: MediaItem[], seriesId: string, seasonId: string): MediaItem[] {
  const seen = new Set<string>();
  return episodes.filter((episode) => {
    if (episode.type !== "Episode" || episode.userData.played || !episode.id || seen.has(episode.id)
      || episode.seriesId !== seriesId || episode.seasonId !== seasonId) return false;
    seen.add(episode.id);
    return true;
  });
}

export interface SeasonWatchedResult {
  marked: number;
  queued: number;
  failed: number;
  cancelled: boolean;
}

/** Snapshot the target season; navigation must never redirect the remaining actions. */
export async function markSeasonEpisodesWatched(
  episodes: MediaItem[],
  seriesId: string,
  seasonId: string,
  options: {
    setWatched(itemId: string): Promise<WatchedStateResult>;
    isSessionCurrent(): boolean;
    onMarked(itemId: string): void;
    onProgress(completed: number, total: number): void;
  },
): Promise<SeasonWatchedResult> {
  const targets = unwatchedSeasonEpisodes(episodes, seriesId, seasonId).map((episode) => episode.id);
  const result: SeasonWatchedResult = { marked: 0, queued: 0, failed: 0, cancelled: false };
  for (const itemId of targets) {
    if (!options.isSessionCurrent()) return { ...result, cancelled: true };
    try {
      const updated = await options.setWatched(itemId);
      if (!options.isSessionCurrent()) return { ...result, cancelled: true };
      if (updated.itemId !== itemId || !updated.watched) throw new Error("Watched state was not applied.");
      result.marked += 1;
      if (updated.synchronization === "queued") result.queued += 1;
      options.onMarked(itemId);
    } catch {
      if (!options.isSessionCurrent()) return { ...result, cancelled: true };
      result.failed += 1;
    }
    options.onProgress(result.marked + result.failed, targets.length);
  }
  return result;
}
