import type { JellyfinApi } from "./jellyfinApi";
import type { AppLogger } from "./logger";
import type { OfflineSynchronizationService } from "./offlineSynchronization";
import type { DurablePlaybackReport, PlaybackActionKind, PlaybackRevisionRecord } from "./persistenceTypes";

export interface AuthoritativePlaybackEvent extends DurablePlaybackReport {
  itemId: string;
  positionTicks: number;
  actionKind: PlaybackActionKind;
  watched: boolean;
  contentKind?: "on-demand" | "live-tv";
  liveStreamId?: string | null;
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
    if (event.contentKind === "live-tv") {
      try {
        await this.api.reportAuthoritativePlayback({
          kind: event.kind,
          itemId: event.itemId,
          mediaSourceId: event.mediaSourceId,
          playMethod: event.playMethod,
          playSessionId: event.playSessionId,
          positionTicks: 0,
          paused: event.paused,
          canSeek: false,
          audioStreamIndex: event.audioStreamIndex,
          subtitleStreamIndex: event.subtitleStreamIndex,
          liveStreamId: event.liveStreamId,
        });
      } catch (error) {
        this.logger.warn("Live TV playback reporting was deferred.", { kind: event.kind, error });
      }
      return;
    }
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
          conflictPolicy: event.conflictPolicy,
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
        // Never bypass older durable rows when persistence itself is
        // unavailable; a direct send here could reorder lifecycle events.
        this.logger.warn("Authoritative playback reporting was not sent because durable capture was unavailable.", { kind: event.kind });
      }
    } catch (error) {
      this.logger.warn("Authoritative playback reporting was deferred.", { kind: event.kind, error });
    } finally {
      if (revision && event.kind === "stop") this.synchronization.setActive(revision, false);
    }
  }
}
