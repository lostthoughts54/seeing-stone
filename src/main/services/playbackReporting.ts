import type { JellyfinApi } from "./jellyfinApi";
import type { AppLogger } from "./logger";
import type { OfflineSynchronizationService } from "./offlineSynchronization";
import type { PlaybackActionKind, PlaybackRevisionRecord } from "./persistenceTypes";

export interface AuthoritativePlaybackEvent {
  kind: "start" | "progress" | "stop";
  itemId: string;
  mediaSourceId: string;
  playMethod: "DirectPlay" | "DirectStream" | "Transcode";
  positionTicks: number;
  paused: boolean;
  actionKind: PlaybackActionKind;
  watched: boolean;
}

/**
 * Main-only reporting boundary fed by mpv's authoritative JSON IPC events;
 * renderer events are never accepted here.
 */
export class PlaybackReportingService {
  constructor(
    private readonly api: JellyfinApi,
    private readonly synchronization: Pick<OfflineSynchronizationService, "capture" | "setActive" | "markCaptureFailed">,
    private readonly logger: AppLogger,
  ) {}

  async acceptAuthoritativeEvent(event: AuthoritativePlaybackEvent): Promise<void> {
    let revision: PlaybackRevisionRecord | null = null;
    try {
      revision = await this.synchronization.capture({
        itemId: event.itemId,
        actionKind: event.actionKind,
        positionTicks: event.positionTicks,
        watched: event.watched,
      });
      if (event.kind === "start") this.synchronization.setActive(revision, true);
    } catch (error) {
      this.logger.warn("Authoritative playback progress could not be persisted.", { kind: event.kind, error });
    }
    try {
      await this.api.reportAuthoritativePlayback(event);
    } catch (error) {
      if (revision) await this.synchronization.markCaptureFailed(revision, error);
      this.logger.warn("Authoritative playback reporting was deferred.", { kind: event.kind, error });
    } finally {
      if (revision && event.kind === "stop") this.synchronization.setActive(revision, false);
    }
  }
}
