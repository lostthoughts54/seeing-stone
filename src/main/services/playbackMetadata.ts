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
  segments: PlaybackMediaSegment[] | null;
  pendingSegments: Promise<PlaybackMediaSegment[]> | null;
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
      this.active = {
        playbackId,
        itemId,
        epoch: this.epoch,
        controller: new AbortController(),
        segments: null,
        pendingSegments: null,
      };
    }
  }

  clear(): void {
    this.epoch += 1;
    this.active?.controller.abort();
    this.active = null;
  }

  async getMediaSegments(playbackId: string): Promise<PlaybackMediaSegmentsResult> {
    const active = this.requireActive(playbackId);
    const segments = await this.getActiveMediaSegments(playbackId);
    return { playbackId: active.playbackId, itemId: active.itemId, segments };
  }

  /** Returns optional metadata only for the specified currently active playback. */
  async getActiveMediaSegments(playbackId: string): Promise<PlaybackMediaSegment[]> {
    const active = this.requireActive(playbackId);
    if (active.segments) return active.segments;
    if (!active.pendingSegments) {
      active.pendingSegments = this.api.getMediaSegments(active.itemId, active.controller.signal).then((segments) => {
        if (!this.isCurrent(active)) throw new AppError("INVALID_PLAYBACK", "That playback session is no longer active.", 409);
        active.segments = segments;
        return segments;
      }).finally(() => {
        if (this.isCurrent(active)) active.pendingSegments = null;
      });
    }
    return active.pendingSegments;
  }

  private requireActive(playbackId: string): ActivePlayback {
    const active = this.active;
    if (!active || active.playbackId !== playbackId || active.controller.signal.aborted) {
      throw new AppError("INVALID_PLAYBACK", "That playback session is no longer active.", 409);
    }
    return active;
  }

  private isCurrent(active: ActivePlayback): boolean {
    return !active.controller.signal.aborted && active.epoch === this.epoch && this.active === active;
  }
}
