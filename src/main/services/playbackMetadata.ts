import type { PlaybackMediaSegment, PlaybackMediaSegmentsResult, PlaybackState } from "../../shared/contracts";
import { AppError } from "./errors";

interface MediaSegmentApi {
  getMediaSegments(itemId: string, signal?: AbortSignal): Promise<PlaybackMediaSegment[]>;
}

interface ActivePlayback {
  playbackId: string;
  itemId: string;
  epoch: number;
  controller: AbortController;
}

/** Optional item metadata bound to exactly one active playback identity. */
export class PlaybackMetadataService {
  private active: ActivePlayback | null = null;
  private epoch = 0;

  constructor(private readonly api: MediaSegmentApi) {}

  setPlaybackState(state: PlaybackState): void {
    const playbackId = state.playbackId;
    const itemId = state.itemId;
    const eligible = Boolean(playbackId && itemId && state.contentKind !== "live-tv");
    if (eligible && this.active?.playbackId === playbackId && this.active.itemId === itemId) return;
    this.clear();
    if (eligible && playbackId && itemId) {
      this.active = { playbackId, itemId, epoch: this.epoch, controller: new AbortController() };
    }
  }

  clear(): void {
    this.epoch += 1;
    this.active?.controller.abort();
    this.active = null;
  }

  async getMediaSegments(playbackId: string): Promise<PlaybackMediaSegmentsResult> {
    const active = this.active;
    if (!active || active.playbackId !== playbackId || active.controller.signal.aborted) {
      throw new AppError("INVALID_PLAYBACK", "That playback session is no longer active.", 409);
    }
    const segments = await this.api.getMediaSegments(active.itemId, active.controller.signal);
    if (!this.isCurrent(active)) throw new AppError("INVALID_PLAYBACK", "That playback session is no longer active.", 409);
    return { playbackId: active.playbackId, itemId: active.itemId, segments };
  }

  private isCurrent(active: ActivePlayback): boolean {
    return !active.controller.signal.aborted && active.epoch === this.epoch && this.active === active;
  }
}
