import type { JellyfinApi } from "./jellyfinApi";
import type { AppLogger } from "./logger";
import type { OfflineSynchronizationService } from "./offlineSynchronization";
import type { DurablePlaybackReport, PlaybackActionKind, PlaybackRevisionRecord } from "./persistenceTypes";

export interface AuthoritativePlaybackEvent extends DurablePlaybackReport {
  itemId: string;
  positionTicks: number;
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
    private readonly synchronization: Pick<OfflineSynchronizationService, "capture" | "setActive" | "flushCapture">,
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
        report: {
          kind: event.kind,
          mediaSourceId: event.mediaSourceId,
          playMethod: event.playMethod,
          playSessionId: event.playSessionId,
          paused: event.paused,
          canSeek: event.canSeek,
          audioStreamIndex: event.audioStreamIndex,
          subtitleStreamIndex: event.subtitleStreamIndex,
        },
      });
      if (event.kind === "start") this.synchronization.setActive(revision, true);
    } catch (error) {
      this.logger.warn("Authoritative playback progress could not be persisted.", { kind: event.kind, error });
    }
    try {
      if (revision) {
        const synchronized = await this.synchronization.flushCapture(revision);
        if (!synchronized) this.logger.warn("Authoritative playback reporting was deferred.", { kind: event.kind });
      } else {
        await this.api.reportAuthoritativePlayback(event);
      }
    } catch (error) {
      this.logger.warn("Authoritative playback reporting was deferred.", { kind: event.kind, error });
    } finally {
      if (revision && event.kind === "stop") this.synchronization.setActive(revision, false);
    }
  }
}
