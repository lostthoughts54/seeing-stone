import { randomUUID } from "node:crypto";
import type { PlaybackStartResult, PlaybackState } from "../../shared/contracts";
import { AppError } from "./errors";
interface PlaybackApi {
  getDetails(itemId: string): Promise<import("../../shared/contracts").MediaItem>;
  getMediaSourceCapabilities(itemId: string): Promise<import("../../shared/contracts").MediaSourceCapabilities>;
  fetchStaticStream(itemId: string, mediaSourceId: string, range?: string, signal?: AbortSignal): Promise<Response>;
}

interface PlaybackRecord {
  id: string;
  itemId: string;
  mediaSourceId: string;
  requests: Set<AbortController>;
}

export class PlaybackSessionService {
  private current: PlaybackRecord | null = null;
  private revision = 0;
  private state: PlaybackState = { playbackId: null, itemId: null, phase: "idle", source: null, error: null };

  constructor(private readonly api: PlaybackApi) {}

  async start(itemId: string, resumeMode: "resume" | "start-over"): Promise<PlaybackStartResult> {
    const revision = ++this.revision;
    this.abortCurrent();
    this.state = { playbackId: null, itemId, phase: "resolving", source: "server", error: null };
    let details: Awaited<ReturnType<PlaybackApi["getDetails"]>>;
    let capabilities: Awaited<ReturnType<PlaybackApi["getMediaSourceCapabilities"]>>;
    try {
      [details, capabilities] = await Promise.all([
        this.api.getDetails(itemId),
        this.api.getMediaSourceCapabilities(itemId),
      ]);
    } catch (error) {
      if (revision === this.revision) {
        this.state = { playbackId: null, itemId, phase: "error", source: null, error: "Playback could not be resolved." };
      }
      throw error;
    }
    if (revision !== this.revision) throw new AppError("PLAYBACK_CANCELLED", "Playback was cancelled.");
    const source = capabilities.sources.find((entry) => entry.supportsDirectStream || entry.supportsDirectPlay) ?? capabilities.sources[0];
    if (!source) {
      this.state = { playbackId: null, itemId, phase: "error", source: null, error: "No playable media source is available." };
      throw new AppError("NO_MEDIA_SOURCE", "No playable media source is available.", 422);
    }
    const playbackId = randomUUID();
    this.current = { id: playbackId, itemId, mediaSourceId: source.id, requests: new Set() };
    this.state = { playbackId, itemId, phase: "ready", source: "server", error: null };
    return {
      playbackId,
      mediaUrl: `jellyfin-media://stream/${playbackId}`,
      resumePositionTicks: resumeMode === "resume" ? details.userData.playbackPositionTicks : 0,
      source: "server",
    };
  }

  stop(playbackId: string): PlaybackState {
    if (!this.current || this.current.id !== playbackId) throw new AppError("INVALID_PLAYBACK", "That playback session is no longer active.", 409);
    this.revision += 1;
    this.abortCurrent();
    this.current = null;
    this.state = { playbackId: null, itemId: null, phase: "stopped", source: null, error: null };
    return this.state;
  }

  getState(): PlaybackState {
    return { ...this.state };
  }

  clear(): void {
    this.revision += 1;
    this.abortCurrent();
    this.current = null;
    this.state = { playbackId: null, itemId: null, phase: "idle", source: null, error: null };
  }

  async handle(request: Request): Promise<Response> {
    if (request.method !== "GET") return new Response(null, { status: 405 });
    let url: URL;
    try { url = new URL(request.url); } catch { return new Response(null, { status: 400 }); }
    if (url.protocol !== "jellyfin-media:" || url.hostname !== "stream" || url.search || url.hash) return new Response(null, { status: 400 });
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length !== 1 || !this.current || parts[0] !== this.current.id) return new Response(null, { status: 404 });
    const playback = this.current;
    const requestController = new AbortController();
    playback.requests.add(requestController);
    let upstream: Response;
    try {
      upstream = await this.api.fetchStaticStream(
        playback.itemId,
        playback.mediaSourceId,
        request.headers.get("range") || undefined,
        requestController.signal,
      );
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
