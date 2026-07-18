import type {
  JellyfinConnectionDiagnostics,
  MediaItem,
  PlaybackState,
  SoloSessionDiagnostics,
} from "../../shared/contracts";
import { materializeCachedMediaItem, materializeCachedNextUp } from "./cachedMedia";
import type { PlayerController } from "./playerController";
import type { SqlitePersistenceService } from "./persistence";

export interface SoloSessionApi {
  getConnectionDiagnostics(): JellyfinConnectionDiagnostics;
  getAuthenticatedContext?(): { serverId: string; userId: string };
  onConnectionDiagnostics?(listener: (diagnostics: JellyfinConnectionDiagnostics) => void): () => void;
  getDetails(itemId: string): Promise<MediaItem>;
  getNextUpForSeries(seriesId: string): Promise<MediaItem | null>;
}

type SoloPersistence = Pick<SqlitePersistenceService,
  "getMediaItem" | "getPlaybackHead" | "setMediaItemNextUp" | "upsertMediaItem"
>;

function samePlayback(left: PlaybackState, right: PlaybackState): boolean {
  return left.playbackId === right.playbackId && left.itemId === right.itemId;
}

function cacheInput(identity: { serverId: string; userId: string }, item: MediaItem) {
  return {
    serverId: identity.serverId,
    userId: identity.userId,
    itemId: item.id,
    itemType: item.type === "Episode" ? "Episode" as const : item.type === "Movie" ? "Movie" as const : "Video" as const,
    name: item.name,
    seriesId: item.seriesId,
    seasonId: item.seasonId,
    runTimeTicks: Math.max(0, Math.floor(item.runTimeTicks)),
    metadata: item,
  };
}

export class SoloSessionDiagnosticsService {
  private readonly listeners = new Set<(snapshot: SoloSessionDiagnostics) => void>();
  private readonly unsubscribeConnection: (() => void) | null;
  private refreshInFlight: Promise<void> | null = null;
  private lastConnectionState: JellyfinConnectionDiagnostics["state"];

  constructor(
    private readonly api: SoloSessionApi,
    private readonly playback: Pick<PlayerController, "getState">,
    private readonly persistence?: SoloPersistence,
  ) {
    this.lastConnectionState = api.getConnectionDiagnostics().state;
    this.unsubscribeConnection = api.onConnectionDiagnostics?.((diagnostics) => {
      const previous = this.lastConnectionState;
      this.lastConnectionState = diagnostics.state;
      if (diagnostics.state === "connected" && previous !== "connected") {
        void this.refreshCachedPlayback();
      } else {
        void this.emitCachedSnapshot();
      }
    }) ?? null;
  }

  onState(listener: (snapshot: SoloSessionDiagnostics) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    this.unsubscribeConnection?.();
    this.listeners.clear();
  }

  async getSnapshot(): Promise<SoloSessionDiagnostics> {
    if (!this.persistence || !this.api.getAuthenticatedContext) return this.getLegacySnapshot();
    const snapshot = await this.getCachedSnapshot();
    const connection = snapshot.connection.state;
    if (snapshot.playback.playbackId && (connection === "connected" || connection === "unknown")) {
      void this.refreshCachedPlayback();
    }
    return snapshot;
  }

  private async getLegacySnapshot(): Promise<SoloSessionDiagnostics> {
    const initialPlayback = this.playback.getState();
    if (!initialPlayback.playbackId || !initialPlayback.itemId) {
      return { playback: initialPlayback, connection: this.api.getConnectionDiagnostics(), item: null, nextUp: null };
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
      return { playback: currentPlayback, connection: this.api.getConnectionDiagnostics(), item: null, nextUp: null };
    }
    return { playback: currentPlayback, connection: this.api.getConnectionDiagnostics(), item, nextUp };
  }

  private async getCachedSnapshot(): Promise<SoloSessionDiagnostics> {
    const initialPlayback = this.playback.getState();
    if (!initialPlayback.playbackId || !initialPlayback.itemId || !this.persistence || !this.api.getAuthenticatedContext) {
      return { playback: initialPlayback, connection: this.api.getConnectionDiagnostics(), item: null, nextUp: null };
    }
    let identity: { serverId: string; userId: string };
    try { identity = this.api.getAuthenticatedContext(); } catch {
      return { playback: initialPlayback, connection: this.api.getConnectionDiagnostics(), item: null, nextUp: null };
    }
    const [record, head] = await Promise.all([
      this.persistence.getMediaItem(identity.serverId, identity.userId, initialPlayback.itemId).catch(() => null),
      this.persistence.getPlaybackHead(identity.serverId, identity.userId, initialPlayback.itemId).catch(() => null),
    ]);
    const currentPlayback = this.playback.getState();
    if (!samePlayback(initialPlayback, currentPlayback) || !record) {
      return { playback: currentPlayback, connection: this.api.getConnectionDiagnostics(), item: null, nextUp: null };
    }
    return {
      playback: currentPlayback,
      connection: this.api.getConnectionDiagnostics(),
      item: materializeCachedMediaItem(record, head),
      nextUp: materializeCachedNextUp(record),
    };
  }

  private async refreshCachedPlayback(): Promise<void> {
    if (this.refreshInFlight) return this.refreshInFlight;
    const operation = this.performRefresh().finally(() => {
      if (this.refreshInFlight === operation) this.refreshInFlight = null;
    });
    this.refreshInFlight = operation;
    return this.refreshInFlight;
  }

  private async performRefresh(): Promise<void> {
    if (!this.persistence || !this.api.getAuthenticatedContext) return;
    const initialPlayback = this.playback.getState();
    if (!initialPlayback.playbackId || !initialPlayback.itemId) return;
    let identity: { serverId: string; userId: string };
    try { identity = this.api.getAuthenticatedContext(); } catch { return; }
    try {
      const item = await this.api.getDetails(initialPlayback.itemId);
      if (item.id !== initialPlayback.itemId || !item.playable) return;
      let nextUp: MediaItem | null = null;
      let nextUpResolved = item.type !== "Episode" || !item.seriesId;
      if (item.type === "Episode" && item.seriesId) {
        try {
          nextUp = await this.api.getNextUpForSeries(item.seriesId);
          nextUpResolved = true;
          if (nextUp?.id === item.id || !nextUp?.playable) nextUp = null;
        } catch {
          // A partial reconnect must not erase a previously verified Next Up entry.
          nextUpResolved = false;
        }
      }
      if (!samePlayback(initialPlayback, this.playback.getState())) return;
      await this.persistence.upsertMediaItem(cacheInput(identity, item));
      if (nextUpResolved) {
        if (nextUp) await this.persistence.upsertMediaItem(cacheInput(identity, nextUp));
        await this.persistence.setMediaItemNextUp(identity.serverId, identity.userId, item.id, nextUp);
      }
    } catch {
      // Cache refresh is advisory and never interrupts active local playback.
    }
    await this.emitCachedSnapshot();
  }

  private async emitCachedSnapshot(): Promise<void> {
    if (!this.listeners.size) return;
    const snapshot = this.persistence ? await this.getCachedSnapshot() : await this.getLegacySnapshot();
    for (const listener of this.listeners) listener(snapshot);
  }
}
