import type { MediaItem, PlaybackStartResult, PlaybackState } from "../../shared/contracts";
import { AppError } from "./errors";
import type { PlayerActionOrigin, PlayerController } from "./playerController";
import type { PlaybackQueueStore } from "./playbackQueue";
import type { SyncPlayService } from "./syncPlay";
import type { LiveTvContextService } from "./liveTvContext";

interface CommandApi {
  getDetails(itemId: string): Promise<MediaItem>;
  getEpisodes(seriesId: string, seasonId: string): Promise<MediaItem[]>;
  getNextUpForSeries(seriesId: string): Promise<MediaItem | null>;
}

export class PlaybackCommandService {
  private features: import("./playerFeatures").PlayerFeaturesService | null = null;
  setPlayerFeatures(features: import("./playerFeatures").PlayerFeaturesService): void { this.features = features; }
  private syncPlay: SyncPlayService | null = null;
  private lastNonzeroVolume = 100;
  private liveTv: LiveTvContextService | null = null;

  constructor(
    private readonly player: PlayerController,
    private readonly api: CommandApi,
    private readonly queue: PlaybackQueueStore,
    private readonly getCachedItem: (itemId: string) => Promise<MediaItem | null> = async () => null,
  ) {}

  setSyncPlay(syncPlay: SyncPlayService): void {
    this.syncPlay = syncPlay;
  }

  setLiveTvContext(liveTv: LiveTvContextService): void {
    this.liveTv = liveTv;
  }

  isWatchPartyJoined(): boolean {
    return Boolean(this.features?.isJoined() || this.syncPlay?.isJoined());
  }

  setWatchPartySyncOffset(offsetMilliseconds: number): Promise<import("../../shared/contracts").WatchPartyViewState> {
    if (!this.syncPlay?.isJoined()) throw new AppError("SYNCPLAY_NOT_JOINED", "Join a watch party before adjusting its timing.", 409);
    return this.syncPlay.setLocalSyncOffset(offsetMilliseconds);
  }

  getState(): PlaybackState {
    return this.player.getState();
  }

  getDetails(itemId: string): Promise<MediaItem> {
    return this.api.getDetails(itemId);
  }

  async start(
    itemId: string,
    resumeMode: "resume" | "start-over",
    preserveQueue = false,
    origin: PlayerActionOrigin = "companion",
    requireProgressive = false,
    preferredMediaSourceId?: string,
  ): Promise<PlaybackStartResult> {
    if (this.features?.isJoined()) throw new AppError("FEATURE_ROOM_ACTIVE", "Add this video to your Seeing Stone room queue to play it together.", 409);
    if (requireProgressive && this.syncPlay?.isJoined()) {
      throw new AppError("PROGRESSIVE_SYNCPLAY_UNAVAILABLE", "Watch while downloading is unavailable in a watch party.", 409);
    }
    if (this.syncPlay?.isJoined()) {
      if (preferredMediaSourceId) {
        throw new AppError("MOVIE_VERSION_WATCH_PARTY_UNAVAILABLE", "Specific movie versions are unavailable in a watch party. Choose Auto / Best Available.", 409);
      }
      const result = await this.syncPlay.selectItem(itemId, resumeMode);
      await this.enterCompanionFullscreen(result, origin);
      return result;
    }
    const result = await this.player.loadItem(itemId, resumeMode, {
      origin,
      ...(requireProgressive ? { requireProgressive: true } : {}),
      ...(preferredMediaSourceId ? { preferredMediaSourceId } : {}),
    });
    if (!preserveQueue) {
      const item = await this.getCachedItem(itemId).catch(() => null)
        ?? (result.source === "server" ? await this.api.getDetails(itemId).catch(() => null) : null);
      if (this.player.getState().playbackId === result.playbackId) this.queue.reset(item ?? undefined);
    }
    await this.enterCompanionFullscreen(result, origin);
    return result;
  }

  async startLive(channelId: string, origin: PlayerActionOrigin = "companion"): Promise<PlaybackStartResult> {
    if (this.features?.isJoined()) throw new AppError("FEATURE_ROOM_ACTIVE", "Leave your Seeing Stone room before starting live TV.", 409);
    if (this.syncPlay?.isJoined()) throw new AppError("LIVE_TV_WATCH_PARTY_UNAVAILABLE", "Live TV cannot be started in a watch party.", 409);
    const result = await this.player.loadItem(channelId, "start-over", { origin });
    this.queue.reset();
    await this.enterCompanionFullscreen(result, origin);
    return result;
  }

  async goLive(): Promise<PlaybackStartResult> {
    const state = this.player.getState();
    if (state.iptvIdentity) return this.startIptv(state.iptvIdentity);
    if (state.contentKind !== "live-tv" || !state.itemId) throw new AppError("LIVE_TV_COMMAND_UNAVAILABLE", "Live TV is not active.", 422);
    return this.startLive(state.itemId);
  }

  async navigateLive(direction: -1 | 1): Promise<PlaybackStartResult> {
    const state = this.player.getState();
    if (state.iptvIdentity) throw new AppError("IPTV_CHANNEL_SELECTION", "Choose another channel from the IPTV catalogue.", 422);
    if (state.contentKind !== "live-tv" || !state.itemId || !this.liveTv) throw new AppError("LIVE_TV_COMMAND_UNAVAILABLE", "Live TV is not active.", 422);
    const channelId = await this.liveTv.getNeighbor(state.itemId, direction);
    if (!channelId) throw new AppError("LIVE_TV_COMMAND_UNAVAILABLE", "No adjacent channel is available.", 422);
    return this.startLive(channelId);
  }

  async startIptv(identity: import("../../shared/iptv").IptvPlayableIdentity): Promise<PlaybackStartResult> {
    if (this.isWatchPartyJoined()) throw new AppError("IPTV_WATCH_PARTY_UNAVAILABLE", "Leave your watch party before starting IPTV.", 409);
    if (identity.contentType !== "live") throw new AppError("IPTV_PLAYBACK_UNAVAILABLE", "Movie and episode playback is coming in a later update.", 422);
    const result = await this.player.loadItem(`iptv:${identity.providerId}:${identity.contentType}:${identity.itemId}`, "start-over", { origin: "local-user", iptvIdentity: identity });
    this.queue.reset();
    return result;
  }

  async setPaused(playbackId: string, paused: boolean, origin: PlayerActionOrigin = "companion"): Promise<PlaybackState> {
    this.assertPlayback(playbackId);
    if (this.features?.isJoined()) return this.features.requestPaused(paused);
    if (this.syncPlay?.isJoined()) return this.syncPlay.requestPaused(paused);
    return this.player.setPaused(playbackId, paused, { origin });
  }

  async seek(playbackId: string, positionTicks: number, origin: PlayerActionOrigin = "companion"): Promise<PlaybackState> {
    const state = this.assertPlayback(playbackId);
    if (this.features?.isJoined()) return this.features.requestSeek(positionTicks);
    if (state.contentKind === "live-tv") {
      throw new AppError("LIVE_TV_SEEK_UNAVAILABLE", "Use Go Live to return to the current live edge.", 422);
    }
    if (this.syncPlay?.isJoined()) return this.syncPlay.requestSeek(positionTicks);
    return this.player.seek(playbackId, positionTicks, { origin });
  }

  async setVolume(playbackId: string, volume: number, origin: PlayerActionOrigin = "companion"): Promise<PlaybackState> {
    const previousVolume = this.assertPlayback(playbackId).volume;
    const state = await this.player.setVolume(playbackId, volume, { origin });
    if (state.volume > 0) this.lastNonzeroVolume = state.volume;
    else if (previousVolume > 0) this.lastNonzeroVolume = previousVolume;
    return state;
  }

  setRate(playbackId: string, rate: number, origin: PlayerActionOrigin = "companion"): Promise<PlaybackState> {
    if (this.features?.isJoined() && rate !== 1) throw new AppError("FEATURE_ROOM_RATE", "Shared playback uses normal speed.", 409);
    return this.player.setRate(playbackId, rate, { origin });
  }

  setFullscreen(playbackId: string, fullscreen: boolean, origin: PlayerActionOrigin = "companion"): Promise<PlaybackState> {
    return this.player.setFullscreen(playbackId, fullscreen, { origin });
  }

  async setMuted(playbackId: string, muted: boolean): Promise<PlaybackState> {
    const state = this.assertPlayback(playbackId);
    if (!muted && state.volume > 0) return state;
    return this.setVolume(playbackId, muted ? 0 : this.lastNonzeroVolume);
  }

  async stop(playbackId: string, origin: PlayerActionOrigin = "companion"): Promise<PlaybackState> {
    this.assertPlayback(playbackId);
    if (this.features?.isJoined()) return this.features.requestStop();
    if (this.syncPlay?.isJoined()) return this.syncPlay.requestStop();
    return this.player.stop(playbackId, "stopped", { origin });
  }

  async selectAudio(playbackId: string, trackId: number | null): Promise<PlaybackState> {
    if (trackId !== null && !this.player.getState().audioTracks.some((track) => track.id === trackId)) {
      throw new AppError("TRACK_STALE", "That audio track is no longer available.", 409);
    }
    return this.player.selectAudio(playbackId, trackId);
  }

  async selectSubtitle(playbackId: string, trackId: number | null): Promise<PlaybackState> {
    if (trackId !== null && !this.player.getState().subtitleTracks.some((track) => track.id === trackId)) {
      throw new AppError("TRACK_STALE", "That subtitle track is no longer available.", 409);
    }
    return this.player.selectSubtitle(playbackId, trackId);
  }

  async playQueueEntry(queueEntryId: string): Promise<PlaybackStartResult> {
    if (this.isWatchPartyJoined()) throw new AppError("QUEUE_WATCH_PARTY_BLOCKED", "Queue editing is unavailable during a watch party.", 409);
    const entry = this.queue.getSnapshot().entries.find((candidate) => candidate.queueEntryId === queueEntryId);
    if (!entry) throw new AppError("QUEUE_ENTRY_NOT_FOUND", "That queue item is no longer available.", 409);
    const completedPlaybackId = this.player.getState().playbackId ?? "manual";
    await this.queue.reserve(queueEntryId, completedPlaybackId);
    try {
      const result = await this.player.loadItem(entry.item.id, "start-over", { origin: "companion" });
      const adopted = this.player.getState();
      if (adopted.playbackId !== result.playbackId || adopted.itemId !== entry.item.id) throw new AppError("PLAYBACK_ADOPTION_FAILED", "The selected item was not adopted.", 409);
      try {
        this.queue.commit(queueEntryId, completedPlaybackId);
      } catch (error) {
        this.queue.recoverAfterInvariant(queueEntryId);
        throw error;
      }
      await this.enterCompanionFullscreen(result, "companion");
      return result;
    } catch (error) {
      this.queue.release(queueEntryId);
      throw error;
    }
  }

  async navigateAdjacentEpisode(direction: -1 | 1): Promise<PlaybackStartResult | null> {
    const state = this.player.getState();
    if (!state.itemId || state.contentKind === "live-tv") return null;
    const current = await this.api.getDetails(state.itemId);
    if (current.type !== "Episode" || !current.seriesId || !current.seasonId) return null;
    const episodes = await this.api.getEpisodes(current.seriesId, current.seasonId);
    const index = episodes.findIndex((episode) => episode.id === current.id);
    let target = index >= 0 ? episodes[index + direction] ?? null : null;
    if (!target && direction === 1) target = await this.api.getNextUpForSeries(current.seriesId);
    if (!target || target.id === current.id) return null;
    return this.start(target.id, "start-over", false);
  }

  private async enterCompanionFullscreen(result: PlaybackStartResult, origin: PlayerActionOrigin): Promise<void> {
    if (origin !== "companion") return;
    await this.player.setFullscreen(result.playbackId, true, { origin }).catch(() => undefined);
  }

  private assertPlayback(playbackId: string): PlaybackState {
    const state = this.player.getState();
    if (state.playbackId !== playbackId) {
      throw new AppError("INVALID_PLAYBACK", "That playback session is no longer active.", 409);
    }
    return state;
  }
}
