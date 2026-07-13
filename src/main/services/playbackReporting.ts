import type { JellyfinApi } from "./jellyfinApi";
import type { AppLogger } from "./logger";

export interface AuthoritativePlaybackEvent {
  kind: "start" | "progress" | "stop";
  itemId: string;
  mediaSourceId: string;
  playMethod: "DirectPlay" | "DirectStream" | "Transcode";
  positionTicks: number;
  paused: boolean;
}

/**
 * Main-only reporting boundary fed by mpv's authoritative JSON IPC events;
 * renderer events are never accepted here.
 */
export class PlaybackReportingService {
  constructor(private readonly api: JellyfinApi, private readonly logger: AppLogger) {}

  async acceptAuthoritativeEvent(event: AuthoritativePlaybackEvent): Promise<void> {
    try {
      await this.api.reportAuthoritativePlayback(event);
    } catch (error) {
      this.logger.warn("Authoritative playback reporting was deferred.", { kind: event.kind, error });
    }
  }
}
