import type {
  JellyfinConnectionDiagnostics,
  MediaItem,
  PlaybackState,
  SoloSessionDiagnostics,
} from "../../shared/contracts";
import type { PlayerController } from "./playerController";

export interface SoloSessionApi {
  getConnectionDiagnostics(): JellyfinConnectionDiagnostics;
  getDetails(itemId: string): Promise<MediaItem>;
  getNextUpForSeries(seriesId: string): Promise<MediaItem | null>;
}

function samePlayback(left: PlaybackState, right: PlaybackState): boolean {
  return left.playbackId === right.playbackId && left.itemId === right.itemId;
}

export class SoloSessionDiagnosticsService {
  constructor(
    private readonly api: SoloSessionApi,
    private readonly playback: Pick<PlayerController, "getState">,
  ) {}

  async getSnapshot(): Promise<SoloSessionDiagnostics> {
    const initialPlayback = this.playback.getState();
    if (!initialPlayback.playbackId || !initialPlayback.itemId) {
      return {
        playback: initialPlayback,
        connection: this.api.getConnectionDiagnostics(),
        item: null,
        nextUp: null,
      };
    }

    let item: MediaItem | null = null;
    let nextUp: MediaItem | null = null;
    try {
      item = await this.api.getDetails(initialPlayback.itemId);
      if (item.type === "Episode" && item.seriesId) {
        nextUp = await this.api.getNextUpForSeries(item.seriesId).catch(() => null);
        if (nextUp?.id === initialPlayback.itemId) nextUp = null;
      }
    } catch {
      // The current sanitized player state remains useful while Jellyfin is offline.
    }

    const currentPlayback = this.playback.getState();
    if (!samePlayback(initialPlayback, currentPlayback)) {
      return {
        playback: currentPlayback,
        connection: this.api.getConnectionDiagnostics(),
        item: null,
        nextUp: null,
      };
    }
    return {
      playback: currentPlayback,
      connection: this.api.getConnectionDiagnostics(),
      item,
      nextUp,
    };
  }
}
