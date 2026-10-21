import { z } from "zod";
import { featureInputSchema, featureMediaSchema, featurePosition, featureRoomSchema, featureSummarySchema, type FeatureAction, type FeatureInput, type FeatureRoom, type FeatureState } from "../../shared/playerFeatures";
import type { JellyfinApi } from "./jellyfinApi";
import type { PlayerController } from "./playerController";
import type { DownloadManager } from "./downloadManager";
import { AppError } from "./errors";
import { youtubeVideoId } from "./trailerWindow";

const empty = (): FeatureState => ({ connection: "signed-out", room: null, rooms: [], error: null, local: { preparation: "", issue: null, delivery: null, subtitles: 0, delaySeconds: 0, downloads: "" } });
const remote = { origin: "remote-sync" as const };
const healthSchema = z.object({ protocolVersion: z.literal(1), features: z.array(z.string()).optional() });
const preflightSchema = z.object({ media: featureMediaSchema, subtitles: z.array(z.object({ index: z.number().int(), language: z.string().nullable(), codec: z.string().nullable(), isExternal: z.boolean() })).nullable(), delaySeconds: z.number().finite().min(-120).max(120) });
type Api = Pick<JellyfinApi, "playerFeaturesRequest" | "getAuthenticatedContext" | "getMediaSourceCapabilities" | "getMediaSegments">;

/** Serializes room requests and owns native playback; the renderer only reports its official YouTube iframe. */
export class PlayerFeaturesService {
  private state = empty();
  private listeners = new Set<(state: FeatureState) => void>();
  private epoch = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private playbackTimer: ReturnType<typeof setInterval> | null = null;
  private polling = false;
  private reconciling = false;
  private loadedGeneration = -1;
  private targetRevision = -1;
  private subtitleStream = "";
  private youtube: Extract<FeatureInput, { operation: "youtube-state" }> | null = null;
  private youtubeSeen = 0;
  private lastSeek = 0;
  private preparationRunning = false;
  private preparing = false;
  private ownedPlaybackId: string | null = null;
  private completed: { generation: number; positionTicks: number } | null = null;
  private supportsWatchNow: boolean | null = null;

  constructor(private readonly api: Api, private readonly player: PlayerController, private readonly downloads: Pick<DownloadManager, "start">, private readonly otherRoomJoined: () => boolean = () => false) {
    player.onEvent((event) => {
      const room = this.state.room;
      if (!room || room.media?.kind !== "jellyfin") return;
      if (event.action === "completed" && event.state.playbackId === this.ownedPlaybackId && event.state.itemId === room.media.itemId) this.completed = { generation: room.timeline.generation, positionTicks: event.state.positionTicks };
      if (event.origin !== "local-user") return;
      if (event.action === "play" || event.action === "pause") void this.command({ operation: "action", action: { action: event.action } }).catch(() => undefined);
      if (event.action === "seek") void this.command({ operation: "action", action: { action: "seek", positionTicks: event.state.positionTicks } }).catch(() => undefined);
    });
  }
  onState(listener: (state: FeatureState) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  getState(): FeatureState { return structuredClone(this.state); }
  isJoined(): boolean { return this.state.room !== null; }
  deactivate(): void {
    this.epoch++; if (this.pollTimer) clearInterval(this.pollTimer); if (this.playbackTimer) clearInterval(this.playbackTimer);
    this.pollTimer = null; this.playbackTimer = null; this.loadedGeneration = -1; this.targetRevision = -1; this.youtube = null; this.completed = null;
    if (this.isJoined()) this.player.setAutomaticTransitionsEnabled(true);
    this.supportsWatchNow = null;
    this.state = empty(); this.emit();
  }
  async activate(): Promise<FeatureState> {
    const revision = this.epoch;
    try { return await this.command({ operation: "refresh" }); }
    catch { if (revision === this.epoch) { this.state.connection = "unavailable"; this.emit(); } return this.getState(); }
  }
  command(raw: FeatureInput): Promise<FeatureState> {
    const input = featureInputSchema.parse(raw);
    if (input.operation === "youtube-state") {
      if (this.state.room?.media?.kind === "youtube" && input.videoId === this.state.room.media.itemId && input.generation === this.state.room.timeline.generation) { this.youtube = input; this.youtubeSeen = Date.now(); }
      return Promise.resolve(this.getState());
    }
    // Immediately invalidate old network/load work when leaving, even if a load is still pending.
    if (input.operation === "leave" || input.operation === "delete") this.epoch++;
    const revision = this.epoch;
    const run = this.queue.catch(() => undefined).then(async () => {
      if (revision !== this.epoch) return this.getState();
      try { await this.execute(input, revision); }
      catch (error) {
        if (revision === this.epoch) { this.state.error = this.safeError(error); this.emit(); }
        throw error;
      }
      return this.getState();
    });
    this.queue = run; return run;
  }
  async requestPaused(paused: boolean) { await this.command({ operation: "action", action: { action: paused ? "pause" : "play" } }); return this.player.getState(); }
  async requestSeek(positionTicks: number) { await this.command({ operation: "action", action: { action: "seek", positionTicks } }); return this.player.getState(); }
  async requestStop() { await this.command({ operation: "leave" }); const s = this.player.getState(); return s.playbackId ? this.player.stop(s.playbackId, "stopped", remote) : s; }

  private async execute(input: FeatureInput, revision: number): Promise<void> {
    this.api.getAuthenticatedContext();
    if (input.operation === "refresh") {
      const health = healthSchema.parse(await this.api.playerFeaturesRequest());
      if (revision !== this.epoch || !health) return;
      this.supportsWatchNow = health.features?.includes("watch-now") ?? false;
      const rooms = z.array(featureSummarySchema).max(64).parse(await this.api.playerFeaturesRequest({ operation: "list" }));
      if (revision !== this.epoch) return;
      this.state.rooms = rooms; this.state.connection = "connected"; this.state.error = null; this.emit(); return;
    }
    if (input.operation === "create" || input.operation === "join") {
      if (this.otherRoomJoined()) throw new AppError("FEATURE_ROOM_CONFLICT", "Leave your current YouTube room or Jellyfin watch party first.", 409);
      if (this.isJoined()) throw new AppError("FEATURE_ROOM_CONFLICT", "Leave your current room first.", 409);
      await this.exchange(input, revision);
      if (revision !== this.epoch || !this.state.room) return;
      this.player.setAutomaticTransitionsEnabled(false); this.startTimers(); return;
    }
    const room = this.state.room;
    if (!room) throw new AppError("FEATURE_ROOM_REQUIRED", "Join a Seeing Stone room first.", 409);
    if (input.operation === "watch-now" || input.operation === "action" && input.action.action === "watch-item") {
      // Check older servers before mutating the queue; they do not support source switching.
      if (this.supportsWatchNow !== true) {
        const health = healthSchema.parse(await this.api.playerFeaturesRequest());
        if (revision !== this.epoch) return;
        this.supportsWatchNow = health.features?.includes("watch-now") ?? false;
      }
      if (!this.supportsWatchNow) throw new AppError("FEATURE_PLUGIN_UPDATE_REQUIRED", "Update the Seeing Stone Player Features plugin on your Jellyfin server to use Watch now.", 409);
    }
    if (input.operation === "leave" || input.operation === "delete") {
      try { await this.api.playerFeaturesRequest({ ...input, roomId: room.id }); }
      finally { if (revision === this.epoch) { const s = this.player.getState(); if (s.playbackId && room.media?.kind === "jellyfin") await this.player.setPaused(s.playbackId, true, remote).catch(() => undefined); this.deactivate(); this.state.connection = "connected"; this.emit(); } }
      return;
    }
    if (input.operation === "prepare") { void this.prepareDownloads(revision); return; }
    if (input.operation === "retry") { this.loadedGeneration = -1; this.state.local.issue = null; await this.reconcile(revision); return; }
    if (input.operation === "timing") { await this.timing(input.delaySeconds, revision); return; }
    if (input.operation === "skip") {
      if (room.media?.kind !== "jellyfin") throw new AppError("FEATURE_SKIP_UNAVAILABLE", "Segment skips are available for Jellyfin videos.", 409);
      const segments = await this.api.getMediaSegments(room.media.itemId);
      if (revision !== this.epoch) return;
      const position = featurePosition(room);
      const segment = segments.find(s => s.type !== "Outro" && position >= s.startTicks && position < s.endTicks);
      if (!segment) throw new AppError("FEATURE_SKIP_UNAVAILABLE", "No intro or recap is available at this position.", 409);
      await this.action({ action: "seek", positionTicks: segment.endTicks }, revision); return;
    }
    if (input.operation === "action") { await this.action(input.action, revision); return; }
    if (input.operation === "add" || input.operation === "watch-now") {
      let itemId = input.itemId;
      if (input.kind === "youtube") { itemId = youtubeVideoId(input.itemId) || (/^[A-Za-z0-9_-]{11}$/.test(input.itemId) ? input.itemId : ""); }
      if (!itemId) throw new AppError("INVALID_VIDEO", "Choose a library item or paste a YouTube video link.", 400);
      await this.exchange({ ...input, itemId, roomId: room.id,
        ...(input.operation === "watch-now" ? { expectedGeneration: room.timeline.generation } : {}),
      }, revision); return;
    }
    if (input.operation === "message") await this.exchange({ ...input, roomId: room.id, positionTicks: input.kind === "comment" ? featurePosition(room) : undefined }, revision);
  }
  private async action(action: FeatureAction, revision: number): Promise<void> {
    const room = this.state.room!;
    await this.exchange({ operation: "action", roomId: room.id, action: { ...action, expectedGeneration: room.timeline.generation } }, revision);
  }
  private async exchange(body: unknown, revision: number): Promise<void> {
    const sent = Date.now(); const value = await this.api.playerFeaturesRequest(body); const received = Date.now();
    if (revision !== this.epoch) return;
    const room = featureRoomSchema.parse(value);
    if (this.state.room?.id === room.id && room.timeline.version < this.state.room.timeline.version) return;
    // Midpoint estimate avoids treating a whole round trip as server clock skew.
    const offset = (sent + received) / 2 - room.serverNow;
    room.timeline.anchoredAt += offset;
    if (room.timeline.startAt !== null) room.timeline.startAt += offset;
    if (room.timeline.nextAt !== null) room.timeline.nextAt += offset;
    for (const message of room.messages) message.createdAt += offset;
    room.serverNow = received;
    this.state.room = room; this.state.connection = "connected"; this.state.error = null; this.emit();
  }
  private startTimers(): void {
    if (!this.pollTimer) this.pollTimer = setInterval(() => { void this.poll(); }, 1000);
    if (!this.playbackTimer) this.playbackTimer = setInterval(() => { void this.reconcile(this.epoch); }, 100);
    void this.poll();
  }
  private async poll(): Promise<void> {
    if (this.polling || !this.state.room) return;
    this.polling = true;
    const revision = this.epoch;
    const task = this.queue.catch(() => undefined).then(async () => {
      if (revision !== this.epoch || !this.state.room) return;
      try {
        await this.exchange({ operation: "report", roomId: this.state.room.id, report: this.report() }, revision);
      } catch (error) {
        if (revision !== this.epoch) return;
        if (error instanceof AppError && error.status === 403) {
          await this.exchange({ operation: "join", roomId: this.state.room.id }, revision); return;
        }
        if (error instanceof AppError && error.status === 404) { this.deactivate(); this.state.connection = "connected"; this.state.error = "That room was deleted."; this.emit(); return; }
        this.state.connection = "reconnecting"; this.state.error = this.safeError(error); this.emit();
        const s = this.player.getState(); if (s.playbackId && this.state.room.media?.kind === "jellyfin" && !s.paused) await this.player.setPaused(s.playbackId, true, remote).catch(() => undefined);
      }
    });
    this.queue = task; try { await task; } catch { /* Retry on the next heartbeat. */ } finally { this.polling = false; }
  }
  private report() {
    const room = this.state.room!; const s = this.player.getState();
    const yt = room.media?.kind === "youtube" && this.youtube?.generation === room.timeline.generation && Date.now() - this.youtubeSeen < 4000 ? this.youtube : null;
    const native = room.media?.kind === "jellyfin" && s.itemId?.replaceAll("-", "") === room.media.itemId.replaceAll("-", "") && this.loadedGeneration === room.timeline.generation;
    const completed = this.completed?.generation === room.timeline.generation ? this.completed : null;
    const ready = native && !this.preparing && !s.buffering && !s.seeking && ["ready", "playing", "paused"].includes(s.phase) && !this.state.local.issue;
    const youtubeAligned = Boolean(yt && Math.abs(yt.positionTicks - featurePosition(room)) < 15_000_000);
    const status = yt?.state ?? (completed ? "ended" : native ? s.phase === "ended" ? "ended" : s.buffering || s.seeking ? "buffering" : ready ? s.paused ? "paused" : "playing" : s.phase === "error" ? "error" : "loading" : "loading");
    return { generation: room.timeline.generation, state: status, ready: yt ? youtubeAligned && ["ready", "paused", "playing"].includes(yt.state) : ready,
      positionTicks: yt?.positionTicks ?? completed?.positionTicks ?? (native ? s.positionTicks : 0), bufferTicks: native ? s.diagnostics?.bufferAheadTicks ?? null : null, source: yt ? "YouTube" : this.state.local.delivery,
      version: room.media?.version, issue: this.state.local.issue, preparation: this.state.local.preparation,
      targetRevision: yt && youtubeAligned ? room.timeline.targetRevision : this.targetRevision };
  }
  private async reconcile(revision: number): Promise<void> {
    if (this.reconciling || !this.state.room || this.state.connection !== "connected") return;
    if (!this.state.room.media || this.state.room.media.kind === "youtube") {
      const s = this.player.getState();
      if (s.playbackId && s.playbackId === this.ownedPlaybackId && !s.paused) {
        this.reconciling = true;
        try { await this.player.setPaused(s.playbackId, true, remote); } catch { /* Surface engine failure through its own state. */ } finally { this.reconciling = false; }
      }
      if (this.state.room?.media?.kind === "youtube") this.state.local = { ...this.state.local, delivery: "Official YouTube player", preparation: "Waiting for the selected YouTube video", issue: null, subtitles: 0 };
      return;
    }
    const room = this.state.room; const media = room.media!;
    this.reconciling = true;
    try {
      if (this.loadedGeneration !== room.timeline.generation || this.completed && this.targetRevision !== room.timeline.targetRevision) {
        this.completed = null;
        this.preparing = true;
        this.loadedGeneration = room.timeline.generation; this.targetRevision = -1; this.subtitleStream = "";
        this.state.local = { ...this.state.local, issue: null, preparation: "Checking access, version and subtitles…", delivery: null, subtitles: 0, delaySeconds: 0 }; this.emit();
        const check = preflightSchema.parse(await this.api.playerFeaturesRequest({ operation: "preflight", ...media }));
        if (revision !== this.epoch || this.state.room?.timeline.generation !== room.timeline.generation) return;
        if (check.media.version !== media.version) throw new AppError("MEDIA_VERSION_CHANGED", "This media version changed. Remove it and add it to the queue again.", 409);
        const capabilities = await this.api.getMediaSourceCapabilities(media.itemId);
        if (revision !== this.epoch || this.state.room?.timeline.generation !== room.timeline.generation) return;
        const source = capabilities.sources.find(s => s.id === media.mediaSourceId);
        if (!source) throw new AppError("MEDIA_VERSION_UNAVAILABLE", "The selected media version is unavailable.", 409);
        this.state.local.delivery = source.supportsDirectPlay ? "Direct play" : source.supportsDirectStream ? "Direct stream" : source.supportsTranscoding ? "Transcode" : "Checking delivery";
        this.state.local.subtitles = check.subtitles?.length ?? 0;
        this.state.local.preparation = "Loading video and subtitle tracks…"; this.emit();
        const result = await this.player.loadItem(media.itemId, "start-over", { ...remote, preferredMediaSourceId: media.mediaSourceId ?? undefined });
        this.ownedPlaybackId = result.playbackId;
        if (revision !== this.epoch || this.state.room?.timeline.generation !== room.timeline.generation) { await this.player.setPaused(result.playbackId, true, remote).catch(() => undefined); return; }
        this.state.local.preparation = "Video and subtitle tracks loaded";
        if (result.source === "local") this.state.local.delivery = "Downloaded copy";
        else if (result.sourceKind === "transcode") this.state.local.delivery = "Transcode";
        else if (result.sourceKind === "direct-stream") this.state.local.delivery = "Direct stream";
        else if (result.sourceKind === "direct-play") this.state.local.delivery = "Direct play";
        await this.player.setRate(result.playbackId, 1, remote);
        this.preparing = false;
      }
      if (this.state.local.issue || revision !== this.epoch) return;
      const s = this.player.getState(); if (!s.playbackId || s.phase === "ended") return;
      const current = this.state.room!;
      if (current.timeline.generation !== room.timeline.generation) return;
      const target = featurePosition(current);
      const changedTarget = this.targetRevision !== current.timeline.targetRevision;
      if (!s.seeking && !s.buffering && (changedTarget || (Math.abs(s.positionTicks - target) > 15_000_000 && Date.now() - this.lastSeek > 4000))) {
        await this.player.seek(s.playbackId, target, remote); this.lastSeek = Date.now(); this.targetRevision = current.timeline.targetRevision;
      }
      if (revision !== this.epoch || current.timeline.generation !== this.state.room?.timeline.generation) return;
      const shouldPlay = current.timeline.playing && (current.timeline.startAt === null || Date.now() >= current.timeline.startAt);
      if (s.paused === shouldPlay) await this.player.setPaused(s.playbackId, !shouldPlay, remote);
      const stream = this.streamKey();
      if (stream !== this.subtitleStream) { await this.timing(undefined, revision); this.subtitleStream = stream; }
    } catch (error) { if (revision === this.epoch && this.state.room?.timeline.generation === room.timeline.generation) { this.state.local.issue = this.safeError(error); this.state.local.preparation = "Needs attention — Retry when ready"; this.emit(); } }
    finally { this.preparing = false; this.reconciling = false; }
  }
  private streamKey(): string { const track = this.player.getState().subtitleTracks.find(t => t.selected); return track ? String(track.streamIndex ?? track.id) : "off"; }
  private async timing(delaySeconds: number | undefined, revision: number): Promise<void> {
    const media = this.state.room?.media; const s = this.player.getState();
    if (media?.kind !== "jellyfin" || !s.playbackId) throw new AppError("SUBTITLE_TIMING_UNAVAILABLE", "Load a Jellyfin video first.", 409);
    if (delaySeconds !== undefined && this.streamKey() === "off") throw new AppError("SUBTITLE_TIMING_UNAVAILABLE", "Select a subtitle track in the player before saving its timing.", 409);
    const stream = this.streamKey();
    const value = z.object({ delaySeconds: z.number().finite().min(-120).max(120) }).parse(await this.api.playerFeaturesRequest({ operation: "timing", ...media, stream, delaySeconds }));
    if (revision !== this.epoch || this.player.getState().playbackId !== s.playbackId || this.streamKey() !== stream) return;
    if (!this.player.setSubtitleDelay) throw new AppError("SUBTITLE_TIMING_UNAVAILABLE", "This player cannot adjust subtitle timing.", 422);
    await this.player.setSubtitleDelay(s.playbackId, value.delaySeconds); this.state.local.delaySeconds = value.delaySeconds; this.emit();
  }
  private async prepareDownloads(revision: number): Promise<void> {
    if (this.preparationRunning) return;
    this.preparationRunning = true;
    const items = this.state.room!.queue.filter(q => q.media.kind === "jellyfin"); let started = 0; let failed = 0;
    try {
      for (const { media } of items) {
        if (revision !== this.epoch) return;
        try { await this.downloads.start(media.itemId, media.mediaSourceId ?? undefined); started++; } catch { failed++; }
        if (revision !== this.epoch) return;
        this.state.local.downloads = `${started} download(s) queued${failed ? `; ${failed} could not start` : ""}. Progress is in Downloads. Subtitles are included when available.`; this.emit();
      }
      if (items.length === 0) { this.state.local.downloads = "No Jellyfin videos in this queue. YouTube videos stay in the official player."; this.emit(); }
    } finally { this.preparationRunning = false; }
  }
  private safeError(error: unknown): string {
    if (error instanceof AppError) return error.status === 404 ? "Update the server to the Seeing Stone Player Features plugin." : error.message;
    return "The room could not complete that request. Check the connection and try again.";
  }
  private emit(): void { const state = this.getState(); for (const listener of this.listeners) listener(state); }
}
