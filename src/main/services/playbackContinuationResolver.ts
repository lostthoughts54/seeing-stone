import type { MediaItem } from "../../shared/contracts";
import type { PlaybackQueueStore } from "./playbackQueue";

export interface PlaybackContinuationItem {
  itemId: string;
  itemType: "Movie" | "Episode" | "Video";
  seriesId: string | null;
}

export interface PlaybackContinuationResult {
  item: MediaItem;
  source: "explicit-queue" | "jellyfin-next-up";
  continuationId: string | null;
}

export interface PlaybackContinuationResolver {
  getNext(currentItem: PlaybackContinuationItem): Promise<PlaybackContinuationResult | null>;
}

export interface PlaybackContinuationTransactions {
  reserve(continuationId: string, completedPlaybackId: string): void;
  release(continuationId: string | null): void;
  commit(continuationId: string, completedPlaybackId: string): void;
  recoverAfterInvariant?(continuationId: string): void;
}

export interface JellyfinNextUpProvider {
  getNextUpForSeries(seriesId: string): Promise<MediaItem | null>;
}

export class DefaultPlaybackContinuationResolver
implements PlaybackContinuationResolver, PlaybackContinuationTransactions {
  constructor(
    private readonly queue: PlaybackQueueStore,
    private readonly jellyfin: JellyfinNextUpProvider,
  ) {}

  async getNext(currentItem: PlaybackContinuationItem): Promise<PlaybackContinuationResult | null> {
    const explicit = this.queue.peekNext();
    if (explicit) {
      return {
        item: explicit.item,
        source: "explicit-queue",
        continuationId: explicit.queueEntryId,
      };
    }
    if (currentItem.itemType !== "Episode" || !currentItem.seriesId) return null;
    const item = await this.jellyfin.getNextUpForSeries(currentItem.seriesId);
    if (!item || item.id === currentItem.itemId) return null;
    return { item, source: "jellyfin-next-up", continuationId: null };
  }

  reserve(continuationId: string, completedPlaybackId: string): void {
    this.queue.reserve(continuationId, completedPlaybackId);
  }

  release(continuationId: string | null): void {
    this.queue.release(continuationId);
  }

  commit(continuationId: string, completedPlaybackId: string): void {
    this.queue.commit(continuationId, completedPlaybackId);
  }

  recoverAfterInvariant(continuationId: string): void {
    this.queue.recoverAfterInvariant(continuationId);
  }
}
