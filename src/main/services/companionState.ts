import { randomBytes } from "node:crypto";
import type { HomePayload, MediaItem, PlaybackState, WatchPartyViewState } from "../../shared/contracts";
import {
  COMPANION_PROTOCOL_VERSION,
  type CompanionBootstrap,
  type CompanionLibraryPage,
  type CompanionLibrarySort,
  type CompanionLibrarySummary,
  type CompanionLiveTvGuide,
  type CompanionMediaSummary,
  type CompanionPlayerState,
  type CompanionQueueState,
  type CompanionWatchPartyState,
} from "../../shared/companionContracts";
import { companionLibraryPageSchema, companionLibrarySummarySchema, companionLiveTvGuideSchema, companionPlayerStateSchema, companionQueueStateSchema, companionWatchPartyStateSchema } from "../../shared/companionSchemas";
import { activeMediaSegment, canSkipSegment, segmentLabel } from "../../shared/mediaSegments";
import { AppError } from "./errors";
import type { PlaybackQueueStore } from "./playbackQueue";
import type { PlayerController } from "./playerController";
import type { SoloSessionDiagnosticsService } from "./soloSessionDiagnostics";
import type { LiveTvContextService } from "./liveTvContext";
import type { PlaybackMetadataService } from "./playbackMetadata";

const CAPABILITY_TTL_MS = 30 * 60_000;
const CAPABILITY_LIMIT = 5_000;

interface Capability {
  itemId: string;
  lastUsedAt: number;
}

interface CompanionLibraryApi {
  getHome(): Promise<HomePayload>;
  getLibraries(): Promise<Array<{ id: string; name: string; collectionType: string | null }>>;
  getLibraryItems(libraryId: string, type: "Movie" | "Series", limit: number): Promise<MediaItem[]>;
  getLibraryItemsPage(
    libraryId: string,
    type: "Movie" | "Series",
    startIndex: number,
    limit: number,
    sort: CompanionLibrarySort,
  ): Promise<{ items: MediaItem[]; totalRecordCount: number }>;
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
  private readonly listeners = new Set<(topic: "player" | "queue" | "watchparty", payload: CompanionPlayerState | CompanionQueueState | CompanionWatchPartyState) => void>();

  constructor(
    private readonly player: PlayerController,
    private readonly queue: PlaybackQueueStore,
    private readonly diagnostics: SoloSessionDiagnosticsService,
    private readonly api: CompanionLibraryApi,
    private readonly isWatchPartyJoined: () => boolean,
    private readonly liveTv?: LiveTvContextService,
    private readonly getWatchPartyState?: () => WatchPartyViewState | null,
    private readonly playbackMetadata?: PlaybackMetadataService,
  ) {
    player.onState((state) => this.schedulePlayerPush(state));
    queue.onChanged(() => this.pushQueue());
  }

  onState(listener: (topic: "player" | "queue" | "watchparty", payload: CompanionPlayerState | CompanionQueueState | CompanionWatchPartyState) => void): () => void {
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
    this.pushWatchParty();
  }

  async bootstrap(): Promise<CompanionBootstrap> {
    const [player, queue] = await Promise.all([this.getPlayerState(), Promise.resolve(this.getQueueState())]);
    return freezeDeep({
      protocolVersion: COMPANION_PROTOCOL_VERSION,
      player,
      queue,
      watchParty: this.getWatchPartyStateValue(),
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
    const skipSegment = await this.getSkipSegment(state);
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
      seekableUntilTicks: state.seekableUntilTicks,
      skipSegment,
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

  private async getSkipSegment(state: PlaybackState): Promise<CompanionPlayerState["skipSegment"]> {
    if (!this.playbackMetadata || !state.playbackId || state.contentKind === "live-tv") return null;
    const segments = await this.playbackMetadata.getActiveMediaSegments(state.playbackId).catch(() => null);
    if (!segments || this.player.getState().playbackId !== state.playbackId) return null;
    const segment = activeMediaSegment(segments, state.positionTicks);
    if (!segment || !["Intro", "Recap", "Outro"].includes(segment.type) || !Number.isSafeInteger(segment.endTicks) || segment.endTicks < 0) return null;
    return {
      type: segment.type,
      label: segmentLabel(segment.type),
      endTicks: segment.endTicks,
      enabled: state.seekable && canSkipSegment(segment, state.seekableUntilTicks),
    };
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

  private getWatchPartyStateValue(): CompanionWatchPartyState {
    const state = this.getWatchPartyState?.() ?? null;
    return freezeDeep(companionWatchPartyStateSchema.parse({
      joined: Boolean(state?.joinedGroup),
      phase: state?.preparation.phase ?? "idle",
      participantCount: state?.joinedGroup?.participantCount ?? 0,
      minimumParticipants: 2,
      localSyncOffsetMilliseconds: state?.preparation.localSyncOffsetMilliseconds ?? 0,
      scheduledStartAtUnixMs: state?.preparation.scheduledStartAtUnixMs ?? null,
    }) as CompanionWatchPartyState);
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

  async getLibraryPage(
    libraryRef: string,
    offset = 0,
    limit = 30,
    sort: CompanionLibrarySort = "recently-added",
  ): Promise<CompanionLibraryPage> {
    const libraryId = this.capabilities.resolve(libraryRef);
    const library = (await this.api.getLibraries()).find((entry) => entry.id === libraryId);
    if (!library) throw new AppError("LIBRARY_NOT_FOUND", "That library is no longer available.", 404);
    const safeOffset = Number.isFinite(offset) ? Math.max(0, Math.floor(offset)) : 0;
    const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(50, Math.floor(limit))) : 30;
    const type = library.collectionType === "tvshows" ? "Series" : "Movie";
    const page = await this.api.getLibraryItemsPage(libraryId, type, safeOffset, safeLimit, sort);
    return freezeDeep(companionLibraryPageSchema.parse({
      revision: `${Date.now()}-${safeOffset}`,
      items: page.items.map((item) => this.mapMedia(item)),
      nextOffset: safeOffset + page.items.length < page.totalRecordCount ? safeOffset + page.items.length : null,
    }) as CompanionLibraryPage);
  }

  async getLibraries(): Promise<CompanionLibrarySummary[]> {
    return (await this.api.getLibraries())
      .filter((library) => library.collectionType === null
        || library.collectionType === "movies"
        || library.collectionType === "tvshows")
      .map((library) => companionLibrarySummarySchema.parse({
        itemRef: this.capabilities.issue(library.id),
        name: library.name,
        collectionType: library.collectionType,
      }));
  }

  async getLiveTvGuide(): Promise<CompanionLiveTvGuide> {
    if (!this.liveTv) {
      return freezeDeep(companionLiveTvGuideSchema.parse({
        availability: "offline",
        message: "Live TV is unavailable.",
        generatedAtUnixMs: Date.now(),
        channels: [],
      }) as CompanionLiveTvGuide);
    }
    const guide = await this.liveTv.getGuide();
    const now = Date.now();
    const playerState = this.player.getState();
    const playingChannelId = playerState.contentKind === "live-tv" ? playerState.itemId : null;
    const programsByChannel = new Map<string, typeof guide.programs>();
    for (const program of guide.programs) {
      const programs = programsByChannel.get(program.channelId);
      if (programs) programs.push(program);
      else programsByChannel.set(program.channelId, [program]);
    }
    const value: CompanionLiveTvGuide = {
      availability: guide.status.availability,
      message: guide.status.message,
      generatedAtUnixMs: now,
      channels: guide.channels.slice(0, 5000).map((channel) => ({
        channelRef: this.capabilities.issue(channel.id),
        name: channel.name,
        number: channel.number,
        isPlaying: channel.id === playingChannelId,
        programs: (programsByChannel.get(channel.id) ?? [])
          .filter((program) => Date.parse(program.endUtc) > now)
          .sort((left, right) => Date.parse(left.startUtc) - Date.parse(right.startUtc))
          .slice(0, 24)
          .map((program) => ({
            name: program.name,
            startUtc: program.startUtc,
            endUtc: program.endUtc,
            isLive: Date.parse(program.startUtc) <= now && Date.parse(program.endUtc) > now,
          })),
      })),
    };
    return freezeDeep(companionLiveTvGuideSchema.parse(value) as CompanionLiveTvGuide);
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
      seekableUntilTicks: state.seekableUntilTicks,
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


  private pushWatchParty(): void {
    const value = this.getWatchPartyStateValue();
    for (const listener of this.listeners) listener("watchparty", value);
  }
}
