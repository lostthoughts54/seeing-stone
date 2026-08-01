import { randomBytes } from "node:crypto";
import type { HomePayload, MediaItem, PlaybackState } from "../../shared/contracts";
import {
  COMPANION_PROTOCOL_VERSION,
  type CompanionBootstrap,
  type CompanionLibraryPage,
  type CompanionMediaSummary,
  type CompanionPlayerState,
  type CompanionQueueState,
} from "../../shared/companionContracts";
import { companionLibraryPageSchema, companionPlayerStateSchema, companionQueueStateSchema } from "../../shared/companionSchemas";
import { AppError } from "./errors";
import type { PlaybackQueueStore } from "./playbackQueue";
import type { PlayerController } from "./playerController";
import type { SoloSessionDiagnosticsService } from "./soloSessionDiagnostics";
import type { LiveTvContextService } from "./liveTvContext";

const CAPABILITY_TTL_MS = 30 * 60_000;
const CAPABILITY_LIMIT = 5_000;

interface Capability {
  itemId: string;
  lastUsedAt: number;
}

interface CompanionLibraryApi {
  getHome(): Promise<HomePayload>;
  getLibraries(): Promise<Array<{ id: string; name: string }>>;
  getLibraryItems(libraryId: string, type: "Movie" | "Series", limit: number): Promise<MediaItem[]>;
  search(query: string): Promise<MediaItem[]>;
  getDetails(itemId: string): Promise<MediaItem>;
  getSeasons(seriesId: string): Promise<MediaItem[]>;
  getEpisodes(seriesId: string, seasonId: string): Promise<MediaItem[]>;
}

function freezeDeep<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

export class CompanionCapabilityRegistry {
  private readonly itemRefs = new Map<string, Capability>();

  issue(itemId: string): string {
    this.sweep();
    for (const [reference, capability] of this.itemRefs) {
      if (capability.itemId === itemId) {
        capability.lastUsedAt = Date.now();
        return reference;
      }
    }
    if (this.itemRefs.size >= CAPABILITY_LIMIT) {
      const oldest = [...this.itemRefs.entries()].sort((left, right) => left[1].lastUsedAt - right[1].lastUsedAt)[0];
      if (oldest) this.itemRefs.delete(oldest[0]);
    }
    const reference = randomBytes(24).toString("base64url");
    this.itemRefs.set(reference, { itemId, lastUsedAt: Date.now() });
    return reference;
  }

  resolve(reference: string): string {
    this.sweep();
    const capability = this.itemRefs.get(reference);
    if (!capability) throw new AppError("ITEM_REFERENCE_EXPIRED", "That item reference has expired.", 409);
    capability.lastUsedAt = Date.now();
    return capability.itemId;
  }

  clear(): void {
    this.itemRefs.clear();
  }

  private sweep(): void {
    const cutoff = Date.now() - CAPABILITY_TTL_MS;
    for (const [reference, capability] of this.itemRefs) {
      if (capability.lastUsedAt < cutoff) this.itemRefs.delete(reference);
    }
  }
}

function phase(state: PlaybackState): CompanionPlayerState["phase"] {
  if (state.phase === "resolving" || state.phase === "ready") return "loading";
  if (state.phase === "stalled" || state.phase === "disconnected") return "buffering";
  return state.phase;
}

export class CompanionStateService {
  private playerRevision = 0;
  private lastPlayerPushAt = 0;
  private lastPlayerStructure = "";
  private pendingPlayerPush: NodeJS.Timeout | null = null;
  private readonly capabilities = new CompanionCapabilityRegistry();
  private readonly listeners = new Set<(topic: "player" | "queue", payload: CompanionPlayerState | CompanionQueueState) => void>();

  constructor(
    private readonly player: PlayerController,
    private readonly queue: PlaybackQueueStore,
    private readonly diagnostics: SoloSessionDiagnosticsService,
    private readonly api: CompanionLibraryApi,
    private readonly isWatchPartyJoined: () => boolean,
    private readonly liveTv?: LiveTvContextService,
  ) {
    player.onState((state) => this.schedulePlayerPush(state));
    queue.onChanged(() => this.pushQueue());
  }

  onState(listener: (topic: "player" | "queue", payload: CompanionPlayerState | CompanionQueueState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  resolveItemRef(itemRef: string): string {
    return this.capabilities.resolve(itemRef);
  }

  clear(): void {
    this.capabilities.clear();
    this.liveTv?.clear();
    if (this.pendingPlayerPush) clearTimeout(this.pendingPlayerPush);
    this.pendingPlayerPush = null;
  }

  notifyWatchPartyChange(): void {
    this.pushQueue();
  }

  async bootstrap(): Promise<CompanionBootstrap> {
    const [player, queue] = await Promise.all([this.getPlayerState(), Promise.resolve(this.getQueueState())]);
    return freezeDeep({
      protocolVersion: COMPANION_PROTOCOL_VERSION,
      player,
      queue,
      server: { online: (await this.diagnostics.getSnapshot()).connection.state === "connected" },
    });
  }

  async getPlayerState(): Promise<CompanionPlayerState> {
    const snapshot = await this.diagnostics.getSnapshot();
    const state = snapshot.playback;
    const media = snapshot.item ? this.mapMedia(snapshot.item) : null;
    const live = state.contentKind === "live-tv" && state.itemId
      ? await this.liveTv?.getContext(state.itemId).catch(() => null) ?? null
      : null;
    const value: CompanionPlayerState = {
      protocolVersion: COMPANION_PROTOCOL_VERSION,
      revision: ++this.playerRevision,
      sentAtUnixMs: Date.now(),
      playbackId: state.playbackId,
      phase: phase(state),
      media,
      live,
      positionTicks: Math.max(0, Math.floor(state.positionTicks)),
      durationTicks: Math.max(0, Math.floor(state.durationTicks)),
      playbackRate: state.diagnostics?.playbackRate ?? 1,
      paused: state.paused,
      buffering: state.buffering,
      seekable: state.contentKind !== "live-tv" && state.seekable,
      volume: Math.max(0, Math.min(100, Math.round(state.volume))),
      muted: state.volume === 0,
      audioTracks: state.audioTracks.map((track) => ({
        id: track.id,
        type: "audio",
        label: track.title || track.language || `Audio ${track.id}`,
        language: track.language,
        selected: track.selected,
      })),
      subtitleTracks: state.subtitleTracks.map((track) => ({
        id: track.id,
        type: "subtitle",
        label: track.title || track.language || `Subtitle ${track.id}`,
        language: track.language,
        selected: track.selected,
      })),
      controls: {
        canPlayPause: Boolean(state.playbackId),
        canStop: Boolean(state.playbackId),
        canSeek: state.contentKind !== "live-tv" && state.seekable,
        canPrevious: this.queue.getPrevious() !== null,
        canNext: this.queue.peekNext() !== null || Boolean(snapshot.nextUp),
        canGoLive: state.contentKind === "live-tv",
        canPreviousChannel: state.contentKind === "live-tv",
        canNextChannel: state.contentKind === "live-tv",
      },
    };
    return freezeDeep(companionPlayerStateSchema.parse(value) as CompanionPlayerState);
  }

  getQueueState(): CompanionQueueState {
    const queue = this.queue.getSnapshot();
    const blocked = this.isWatchPartyJoined();
    const value: CompanionQueueState = {
      revision: queue.revision,
      editable: !blocked,
      blockedReason: blocked ? "watchparty" : null,
      entries: queue.entries.map((entry) => ({
        queueEntryId: entry.queueEntryId,
        state: entry.state,
        media: this.mapMedia(entry.item),
        reserved: entry.reserved,
      })),
    };
    return freezeDeep(companionQueueStateSchema.parse(value) as CompanionQueueState);
  }

  async getHomePage(offset = 0, limit = 30): Promise<CompanionLibraryPage> {
    const home = await this.api.getHome();
    const items = [...home.resumeItems, ...home.nextUpItems, ...home.latestRows.flatMap((row) => row.items)];
    const unique = [...new Map(items.map((item) => [item.id, item])).values()];
    return this.page(unique, offset, limit);
  }

  async searchPage(query: string, offset = 0, limit = 30): Promise<CompanionLibraryPage> {
    const normalized = query.normalize("NFC").trim().slice(0, 100);
    if (!normalized) return this.page([], 0, limit);
    return this.page(await this.api.search(normalized), offset, limit);
  }

  async getLibraryPage(libraryRef: string, offset = 0, limit = 30): Promise<CompanionLibraryPage> {
    const libraryId = this.capabilities.resolve(libraryRef);
    const items = await this.api.getLibraryItems(libraryId, "Movie", 50);
    return this.page(items, offset, limit);
  }

  async getLibraries(): Promise<Array<{ itemRef: string; name: string }>> {
    return (await this.api.getLibraries()).map((library) => ({ itemRef: this.capabilities.issue(library.id), name: library.name }));
  }

  async getSeriesPage(seriesRef: string, offset = 0, limit = 30): Promise<CompanionLibraryPage> {
    const seriesId = this.capabilities.resolve(seriesRef);
    const seasons = await this.api.getSeasons(seriesId);
    const rows = await Promise.all(seasons.map((season) => this.api.getEpisodes(seriesId, season.id)));
    return this.page(rows.flat(), offset, limit);
  }

  async getEpisodeNeighbors(episodeRef: string): Promise<{ previous: CompanionMediaSummary | null; next: CompanionMediaSummary | null }> {
    const item = await this.api.getDetails(this.capabilities.resolve(episodeRef));
    if (item.type !== "Episode" || !item.seriesId || !item.seasonId) return { previous: null, next: null };
    const episodes = await this.api.getEpisodes(item.seriesId, item.seasonId);
    const index = episodes.findIndex((episode) => episode.id === item.id);
    return freezeDeep({
      previous: index > 0 ? this.mapMedia(episodes[index - 1]) : null,
      next: index >= 0 && index + 1 < episodes.length ? this.mapMedia(episodes[index + 1]) : null,
    });
  }

  private mapMedia(item: MediaItem): CompanionMediaSummary {
    const type = item.type === "Movie" ? "movie"
      : item.type === "Series" ? "series"
      : item.type === "Season" ? "season"
      : item.type === "Episode" ? "episode"
      : item.type === "TvChannel" ? "channel"
      : item.type === "Program" ? "program"
      : "video";
    return {
      itemRef: this.capabilities.issue(item.id),
      name: item.name,
      type,
      seriesName: item.seriesName,
      seasonNumber: item.parentIndexNumber,
      episodeNumber: item.indexNumber,
      productionYear: item.productionYear,
      runtimeTicks: Math.max(0, Math.floor(item.runTimeTicks)),
      playable: item.playable,
      artworkRef: item.imageTags.Primary ? this.capabilities.issue(item.id) : null,
    };
  }

  private page(items: MediaItem[], offset: number, limit: number): CompanionLibraryPage {
    const safeOffset = Number.isFinite(offset) ? Math.max(0, Math.floor(offset)) : 0;
    const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(50, Math.floor(limit))) : 30;
    const selected = items.slice(safeOffset, safeOffset + safeLimit);
    return freezeDeep(companionLibraryPageSchema.parse({
      revision: `${Date.now()}-${safeOffset}`,
      items: selected.map((item) => this.mapMedia(item)),
      nextOffset: safeOffset + selected.length < items.length ? safeOffset + selected.length : null,
    }) as CompanionLibraryPage);
  }

  private async pushPlayer(): Promise<void> {
    this.pendingPlayerPush = null;
    this.lastPlayerPushAt = Date.now();
    const value = await this.getPlayerState().catch(() => null);
    if (value) for (const listener of this.listeners) listener("player", value);
  }

  private schedulePlayerPush(state: PlaybackState): void {
    const structure = JSON.stringify({
      playbackId: state.playbackId,
      itemId: state.itemId,
      phase: state.phase,
      paused: state.paused,
      buffering: state.buffering,
      seekable: state.seekable,
      volume: state.volume,
      audio: state.audioTracks.map((track) => [track.id, track.selected]),
      subtitles: state.subtitleTracks.map((track) => [track.id, track.selected]),
      countdown: state.nextEpisodeCountdown?.nextItemId ?? null,
    });
    if (structure !== this.lastPlayerStructure) {
      this.lastPlayerStructure = structure;
      if (this.pendingPlayerPush) clearTimeout(this.pendingPlayerPush);
      this.pendingPlayerPush = null;
      void this.pushPlayer();
      return;
    }
    if (this.pendingPlayerPush) return;
    const delay = Math.max(0, 250 - (Date.now() - this.lastPlayerPushAt));
    this.pendingPlayerPush = setTimeout(() => void this.pushPlayer(), delay);
  }

  private pushQueue(): void {
    const value = this.getQueueState();
    for (const listener of this.listeners) listener("queue", value);
  }
}
