import { randomUUID } from "node:crypto";
import type {
  ExternalSubtitleFormat,
  ExternalSubtitleTrack,
  PlaybackStartResult,
  PlaybackState,
} from "../../shared/contracts";
import { AppError } from "./errors";
import type { SqlitePersistenceService } from "./persistence";
interface PlaybackApi {
  getAuthenticatedContext?(): { serverId: string; userId: string };
  getDetails(itemId: string): Promise<import("../../shared/contracts").MediaItem>;
  getNextUpForSeries?(seriesId: string): Promise<import("../../shared/contracts").MediaItem | null>;
  getMediaSourceCapabilities(itemId: string, signal?: AbortSignal): Promise<import("../../shared/contracts").MediaSourceCapabilities>;
  getPlaybackSourceInfo?(itemId: string, signal?: AbortSignal): Promise<{
    capabilities: import("../../shared/contracts").MediaSourceCapabilities;
    playSessionId: string | null;
  }>;
  fetchStaticStream(itemId: string, mediaSourceId: string, range?: string, signal?: AbortSignal): Promise<Response>;
  fetchDirectStream?(itemId: string, mediaSourceId: string, playSessionId: string, startTimeTicks: number, signal?: AbortSignal): Promise<Response>;
  fetchTranscodedStream(itemId: string, mediaSourceId: string, playSessionId: string, startTimeTicks: number, signal?: AbortSignal): Promise<Response>;
  fetchExternalSubtitle(itemId: string, mediaSourceId: string, streamIndex: number, format: ExternalSubtitleFormat, signal?: AbortSignal): Promise<Response>;
}

interface PlaybackRecord {
  id: string;
  serverPlaySessionId: string;
  itemId: string;
  mediaSourceId: string;
  delivery: "direct" | "transcode" | "local";
  sourceKind: import("../../shared/contracts").PlaybackSourceKind;
  streamStartTimeTicks: number;
  localVersionId: string | null;
  externalSubtitles: ExternalSubtitleTrack[];
  requests: Set<AbortController>;
}

export interface ResolvedPlaybackSource extends PlaybackStartResult {
  serverPlaySessionId: string;
  itemId: string;
  itemType: "Movie" | "Episode" | "Video";
  seriesId: string | null;
  mediaSourceId: string;
  mediaUrl: string;
  delivery: "direct" | "transcode" | "local";
  sourceKind: import("../../shared/contracts").PlaybackSourceKind;
  usesServerTimelineOffset: boolean;
  localVersionId?: string;
  diagnostics?: import("../../shared/contracts").PlaybackDiagnostics;
  externalSubtitles: ExternalSubtitleTrack[];
  initialAction: "progress" | "start_over" | "replay";
}

export interface LocalSourceResolver {
  resolve(
    itemId: string,
    resumeMode: "resume" | "start-over",
    excludedLocalVersionIds?: ReadonlySet<string>,
  ): Promise<ResolvedPlaybackSource | null>;
}

type PlaybackCatalogPersistence = Pick<SqlitePersistenceService, "upsertMediaItem" | "upsertMediaSource" | "getPlaybackHead">;

function safePlaySessionId(value: string | null | undefined): string {
  return value && /^[A-Za-z0-9][A-Za-z0-9._~-]{0,255}$/.test(value) ? value : randomUUID();
}

export function selectAuthoritativeResume(
  serverPositionTicks: number,
  serverPlayed: boolean,
  head: Awaited<ReturnType<SqlitePersistenceService["getPlaybackHead"]>>,
): { positionTicks: number; played: boolean } {
  const server = {
    positionTicks: Math.max(0, Math.floor(serverPositionTicks)),
    played: serverPlayed,
  };
  if (!head || head.latestRevision <= head.lastSucceededRevision) return server;
  if (head.conflictPolicy === "explicit") {
    return { positionTicks: head.positionTicks, played: head.watched };
  }
  if (head.actionKind !== "progress") return { positionTicks: head.positionTicks, played: head.watched };
  if (server.played && !head.watched) return server;
  if (head.watched && !server.played) return { positionTicks: head.positionTicks, played: true };
  return head.positionTicks > server.positionTicks
    ? { positionTicks: head.positionTicks, played: head.watched }
    : server;
}

function initialAction(
  resumeMode: "resume" | "start-over",
  played: boolean,
  previousPositionTicks: number,
): ResolvedPlaybackSource["initialAction"] {
  if (resumeMode !== "start-over") return "progress";
  if (played) return "replay";
  return previousPositionTicks > 0 ? "start_over" : "progress";
}

function state(overrides: Partial<PlaybackState> = {}): PlaybackState {
  return {
    playbackId: null,
    itemId: null,
    phase: "idle",
    source: null,
    positionTicks: 0,
    durationTicks: 0,
    paused: false,
    buffering: false,
    seekable: false,
    volume: 100,
    fullscreen: false,
    audioTracks: [],
    subtitleTracks: [],
    error: null,
    ...overrides,
  };
}

export class PlaybackSessionService {
  private current: PlaybackRecord | null = null;
  private revision = 0;
  private state: PlaybackState = state();
  private readonly excludedLocalVersionIds = new Set<string>();

  constructor(
    private readonly api: PlaybackApi,
    private readonly localResolver?: LocalSourceResolver,
    private readonly persistence?: PlaybackCatalogPersistence,
  ) {}

  async start(
    itemId: string,
    resumeMode: "resume" | "start-over",
    options: { skipLocal?: boolean; preserveLocalExclusions?: boolean } = {},
  ): Promise<ResolvedPlaybackSource> {
    const revision = ++this.revision;
    this.abortCurrent();
    if (!options.preserveLocalExclusions) this.excludedLocalVersionIds.clear();
    this.state = state({ itemId, phase: "resolving" });
    const local = options.skipLocal
      ? null
      : await this.localResolver?.resolve(itemId, resumeMode, this.excludedLocalVersionIds).catch(() => null) ?? null;
    if (revision !== this.revision) throw new AppError("PLAYBACK_CANCELLED", "Playback was cancelled.");
    if (local) {
      let externalSubtitleTracks: ExternalSubtitleTrack[] = [];
      try {
        const capabilities = await this.api.getMediaSourceCapabilities(itemId, AbortSignal.timeout(1500));
        externalSubtitleTracks = capabilities.sources.find((source) => source.id === local.mediaSourceId)?.externalSubtitles ?? [];
      } catch {
        // A verified local video remains playable when Jellyfin is offline or subtitle metadata is unavailable.
      }
      if (revision !== this.revision) throw new AppError("PLAYBACK_CANCELLED", "Playback was cancelled.");
      const resolvedLocal = {
        ...local,
        sourceKind: local.sourceKind ?? "downloaded",
        usesServerTimelineOffset: false,
        serverPlaySessionId: local.serverPlaySessionId ?? local.playbackId,
        externalSubtitles: structuredClone(externalSubtitleTracks),
      };
      this.current = {
        id: resolvedLocal.playbackId,
        serverPlaySessionId: resolvedLocal.serverPlaySessionId,
        itemId,
        mediaSourceId: resolvedLocal.mediaSourceId,
        delivery: "local",
        sourceKind: resolvedLocal.sourceKind,
        streamStartTimeTicks: 0,
        localVersionId: resolvedLocal.localVersionId ?? null,
        externalSubtitles: resolvedLocal.externalSubtitles,
        requests: new Set(),
      };
      this.state = state({
        playbackId: resolvedLocal.playbackId,
        itemId,
        phase: "loading",
        source: "local",
        diagnostics: resolvedLocal.diagnostics,
        durationTicks: resolvedLocal.durationTicks,
      });
      return resolvedLocal;
    }
    let details: Awaited<ReturnType<PlaybackApi["getDetails"]>>;
    let sourceInfo: {
      capabilities: Awaited<ReturnType<PlaybackApi["getMediaSourceCapabilities"]>>;
      playSessionId: string | null;
    };
    const identity = this.persistence ? this.api.getAuthenticatedContext?.() : undefined;
    if (this.persistence && !identity) throw new AppError("PLAYBACK_IDENTITY_UNAVAILABLE", "Playback identity is unavailable.", 409);
    const playbackHeadPromise = this.persistence && identity
      ? this.persistence.getPlaybackHead(identity.serverId, identity.userId, itemId).catch(() => null)
      : Promise.resolve(null);
    try {
      [details, sourceInfo] = await Promise.all([
        this.api.getDetails(itemId),
        this.api.getPlaybackSourceInfo
          ? this.api.getPlaybackSourceInfo(itemId)
          : this.api.getMediaSourceCapabilities(itemId).then((capabilities) => ({ capabilities, playSessionId: null })),
      ]);
    } catch (error) {
      if (revision === this.revision) {
        this.state = state({ itemId, phase: "error", error: "Playback could not be resolved." });
      }
      throw error;
    }
    if (revision !== this.revision) throw new AppError("PLAYBACK_CANCELLED", "Playback was cancelled.");
    if (details.id !== itemId || sourceInfo.capabilities.itemId !== itemId) {
      throw new AppError("MEDIA_IDENTITY_MISMATCH", "Jellyfin returned a different media item.", 502);
    }
    const capabilities = sourceInfo.capabilities;
    const directPlaySource = capabilities.sources.find((entry) => entry.supportsDirectPlay);
    const directStreamSource = this.api.fetchDirectStream
      ? capabilities.sources.find((entry) => entry.supportsDirectStream)
      : undefined;
    const directSource = directPlaySource ?? directStreamSource;
    const source = directSource
      ?? capabilities.sources.find((entry) => entry.supportsTranscoding)
      ?? capabilities.sources[0];
    if (!source) {
      this.state = state({ itemId, phase: "error", error: "No playable media source is available." });
      throw new AppError("NO_MEDIA_SOURCE", "No playable media source is available.", 422);
    }
    const delivery = source === directSource ? "direct" : "transcode";
    const sourceKind = source === directPlaySource
      ? "direct-play"
      : source === directStreamSource ? "direct-stream" : "transcode";
    if (delivery === "transcode" && !source.supportsTranscoding) {
      this.state = state({ itemId, phase: "error", error: "This media requires server transcoding, but transcoding is unavailable." });
      throw new AppError("TRANSCODING_UNAVAILABLE", "This media requires server transcoding, but transcoding is unavailable.", 422);
    }
    const itemType = details.type === "Episode" ? "Episode" : details.type === "Movie" ? "Movie" : "Video";
    if (this.persistence) {
      await this.persistence.upsertMediaItem({
        serverId: identity!.serverId,
        userId: identity!.userId,
        itemId: details.id,
        itemType,
        name: details.name,
        seriesId: details.seriesId,
        seasonId: details.seasonId,
        runTimeTicks: Math.max(0, Math.floor(details.runTimeTicks)),
      });
      await this.persistence.upsertMediaSource({
        serverId: identity!.serverId,
        userId: identity!.userId,
        itemId: details.id,
        mediaSourceId: source.id,
        container: source.container,
        expectedSize: source.size,
      });
    }
    const head = await playbackHeadPromise;
    const previous = selectAuthoritativeResume(
      details.userData.playbackPositionTicks,
      details.userData.played,
      head,
    );
    const durationTicks = Math.max(0, Math.floor(details.runTimeTicks));
    const resumePositionTicks = resumeMode === "resume"
      ? Math.max(0, Math.min(durationTicks || Number.MAX_SAFE_INTEGER, previous.positionTicks))
      : 0;
    const playbackId = randomUUID();
    const serverPlaySessionId = safePlaySessionId(sourceInfo.playSessionId);
    const externalSubtitleTracks = structuredClone(source.externalSubtitles ?? []);
    this.current = {
      id: playbackId,
      serverPlaySessionId,
      itemId,
      mediaSourceId: source.id,
      delivery,
      sourceKind,
      streamStartTimeTicks: sourceKind === "direct-stream" || sourceKind === "transcode"
        ? resumePositionTicks
        : 0,
      localVersionId: null,
      externalSubtitles: externalSubtitleTracks,
      requests: new Set(),
    };
    this.state = state({ playbackId, itemId, phase: "loading", source: "server", durationTicks });
    return {
      playbackId,
      serverPlaySessionId,
      itemId,
      itemType,
      seriesId: details.seriesId,
      mediaSourceId: source.id,
      mediaUrl: `jellyfin-media://stream/${playbackId}`,
      resumePositionTicks,
      durationTicks,
      source: "server",
      sourceKind,
      delivery,
      usesServerTimelineOffset: sourceKind === "direct-stream" || sourceKind === "transcode",
      diagnostics: {
        sourceKind,
        playbackRate: 1,
        bufferAheadTicks: null,
        container: source.container,
        videoCodec: source.videoCodec ?? null,
        audioCodec: source.audioCodec ?? null,
        audioChannels: source.audioChannels ?? null,
        resolution: source.width && source.height ? `${source.width}×${source.height}` : null,
        bitrate: source.bitrate ?? null,
        videoRange: source.videoRange ?? null,
        transcodeReason: sourceKind === "transcode" ? source.transcodeReason ?? null : null,
      },
      externalSubtitles: externalSubtitleTracks,
      initialAction: initialAction(resumeMode, previous.played, previous.positionTicks),
    };
  }

  async retryAfterLocalFailure(
    playbackId: string,
    resumeMode: "resume" | "start-over",
  ): Promise<ResolvedPlaybackSource> {
    const playback = this.current;
    if (!playback || playback.id !== playbackId || playback.delivery !== "local") {
      throw new AppError("INVALID_LOCAL_PLAYBACK", "That local playback attempt is no longer active.", 409);
    }
    if (playback.localVersionId) this.excludedLocalVersionIds.add(playback.localVersionId);
    return this.start(playback.itemId, resumeMode, {
      skipLocal: playback.localVersionId === null,
      preserveLocalExclusions: true,
    });
  }

  setStreamStart(playbackId: string, positionTicks: number): void {
    const playback = this.current;
    if (!playback || playback.id !== playbackId) throw new AppError("INVALID_PLAYBACK", "That playback session is no longer active.", 409);
    if (playback.sourceKind !== "direct-stream" && playback.sourceKind !== "transcode") {
      throw new AppError("SEEK_UNAVAILABLE", "Server-side seeking is unavailable for this source.", 422);
    }
    if (!Number.isSafeInteger(positionTicks) || positionTicks < 0) {
      throw new AppError("INVALID_PLAYBACK_POSITION", "Playback position is invalid.", 422);
    }
    for (const request of playback.requests) request.abort();
    playback.requests.clear();
    playback.streamStartTimeTicks = positionTicks;
  }

  async getNextUpForSeries(seriesId: string): Promise<import("../../shared/contracts").MediaItem | null> {
    return this.api.getNextUpForSeries?.(seriesId) ?? null;
  }

  stop(playbackId: string): PlaybackState {
    if (!this.current || this.current.id !== playbackId) throw new AppError("INVALID_PLAYBACK", "That playback session is no longer active.", 409);
    this.revision += 1;
    this.abortCurrent();
    this.current = null;
    this.state = state({ phase: "stopped" });
    return this.state;
  }

  getState(): PlaybackState {
    return { ...this.state };
  }

  clear(): void {
    this.revision += 1;
    this.abortCurrent();
    this.current = null;
    this.state = state();
  }

  async handle(request: Request): Promise<Response> {
    if (request.method !== "GET") return new Response(null, { status: 405 });
    let url: URL;
    try { url = new URL(request.url); } catch { return new Response(null, { status: 400 }); }
    if (url.protocol !== "jellyfin-media:" || url.hostname !== "stream" || url.search || url.hash) return new Response(null, { status: 400 });
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length !== 1 || !this.current || parts[0] !== this.current.id) return new Response(null, { status: 404 });
    const playback = this.current;
    if (playback.delivery === "local") return new Response(null, { status: 404 });
    const requestController = new AbortController();
    playback.requests.add(requestController);
    let upstream: Response;
    try {
      if (playback.delivery === "transcode") {
        upstream = await this.api.fetchTranscodedStream(
          playback.itemId,
          playback.mediaSourceId,
          playback.serverPlaySessionId,
          playback.streamStartTimeTicks,
          requestController.signal,
        );
      } else if (playback.sourceKind === "direct-stream") {
        const fetchDirectStream = this.api.fetchDirectStream;
        if (!fetchDirectStream) throw new AppError("DIRECT_STREAM_UNAVAILABLE", "Direct streaming is unavailable.", 422);
        upstream = await fetchDirectStream.call(
          this.api,
          playback.itemId,
          playback.mediaSourceId,
          playback.serverPlaySessionId,
          playback.streamStartTimeTicks,
          requestController.signal,
        );
      } else {
        upstream = await this.api.fetchStaticStream(
          playback.itemId,
          playback.mediaSourceId,
          request.headers.get("range") || undefined,
          requestController.signal,
        );
      }
    } catch (error) {
      playback.requests.delete(requestController);
      if (requestController.signal.aborted) return new Response(null, { status: 404 });
      throw error;
    }
    if (this.current !== playback) {
      requestController.abort();
      playback.requests.delete(requestController);
      void upstream.body?.cancel().catch(() => undefined);
      return new Response(null, { status: 404 });
    }
    const headers = new Headers({ "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store" });
    for (const name of ["content-type", "content-length", "content-range", "accept-ranges"]) {
      const value = upstream.headers.get(name);
      if (value) headers.set(name, value);
    }
    if (playback.delivery === "transcode") {
      headers.set("Content-Type", "video/mp4");
      headers.delete("Content-Range");
      headers.delete("Accept-Ranges");
    } else if (playback.sourceKind === "direct-stream") {
      headers.set("Content-Type", "video/mp4");
      headers.delete("Content-Range");
      headers.delete("Accept-Ranges");
    } else {
      headers.set("Accept-Ranges", "bytes");
    }
    const body = upstream.body
      ? this.trackBody(upstream.body, requestController, playback)
      : null;
    if (!body) playback.requests.delete(requestController);
    return new Response(body, { status: upstream.status, headers });
  }

  async fetchExternalSubtitle(
    playbackId: string,
    subtitle: ExternalSubtitleTrack,
    signal?: AbortSignal,
  ): Promise<Response> {
    const playback = this.current;
    if (!playback || playback.id !== playbackId) return new Response(null, { status: 404 });
    const authorized = playback.externalSubtitles.find((candidate) => candidate.streamIndex === subtitle.streamIndex
      && candidate.format === subtitle.format);
    if (!authorized) return new Response(null, { status: 404 });
    const requestController = new AbortController();
    playback.requests.add(requestController);
    const requestSignal = signal
      ? AbortSignal.any([signal, requestController.signal])
      : requestController.signal;
    let upstream: Response;
    try {
      upstream = await this.api.fetchExternalSubtitle(
        playback.itemId,
        playback.mediaSourceId,
        authorized.streamIndex,
        authorized.format,
        requestSignal,
      );
    } catch (error) {
      playback.requests.delete(requestController);
      if (requestController.signal.aborted || signal?.aborted) return new Response(null, { status: 404 });
      throw error;
    }
    if (this.current !== playback) {
      requestController.abort();
      playback.requests.delete(requestController);
      void upstream.body?.cancel().catch(() => undefined);
      return new Response(null, { status: 404 });
    }
    const headers = new Headers({ "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store" });
    for (const name of ["content-type", "content-length"]) {
      const value = upstream.headers.get(name);
      if (value) headers.set(name, value);
    }
    const body = upstream.body
      ? this.trackBody(upstream.body, requestController, playback)
      : null;
    if (!body) playback.requests.delete(requestController);
    return new Response(body, { status: upstream.status, headers });
  }

  private abortCurrent(): void {
    if (!this.current) return;
    for (const request of this.current.requests) request.abort();
    this.current.requests.clear();
    this.current = null;
  }

  private trackBody(
    body: ReadableStream<Uint8Array>,
    requestController: AbortController,
    playback: PlaybackRecord,
  ): ReadableStream<Uint8Array> {
    const reader = body.getReader();
    const settle = () => playback.requests.delete(requestController);
    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const result = await reader.read();
          if (result.done) {
            settle();
            controller.close();
          } else {
            controller.enqueue(result.value);
          }
        } catch (error) {
          settle();
          controller.error(error);
        }
      },
      async cancel(reason) {
        requestController.abort();
        settle();
        await reader.cancel(reason).catch(() => undefined);
      },
    });
  }
}
