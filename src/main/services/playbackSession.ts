import { randomUUID } from "node:crypto";
import type { PlaybackStartResult, PlaybackState } from "../../shared/contracts";
import { AppError } from "./errors";
interface PlaybackApi {
  getDetails(itemId: string): Promise<import("../../shared/contracts").MediaItem>;
  getMediaSourceCapabilities(itemId: string): Promise<import("../../shared/contracts").MediaSourceCapabilities>;
  fetchStaticStream(itemId: string, mediaSourceId: string, range?: string): Promise<Response>;
}

interface PlaybackRecord {
  id: string;
  itemId: string;
  mediaSourceId: string;
}

export class PlaybackSessionService {
  private current: PlaybackRecord | null = null;
  private state: PlaybackState = { playbackId: null, itemId: null, phase: "idle", source: null, error: null };

  constructor(private readonly api: PlaybackApi) {}

  async start(itemId: string, resumeMode: "resume" | "start-over"): Promise<PlaybackStartResult> {
    this.state = { playbackId: null, itemId, phase: "resolving", source: "server", error: null };
    const [details, capabilities] = await Promise.all([
      this.api.getDetails(itemId),
      this.api.getMediaSourceCapabilities(itemId),
    ]);
    const source = capabilities.sources.find((entry) => entry.supportsDirectStream || entry.supportsDirectPlay) ?? capabilities.sources[0];
    if (!source) {
      this.state = { playbackId: null, itemId, phase: "error", source: null, error: "No playable media source is available." };
      throw new AppError("NO_MEDIA_SOURCE", "No playable media source is available.");
    }
    const playbackId = randomUUID();
    this.current = { id: playbackId, itemId, mediaSourceId: source.id };
    this.state = { playbackId, itemId, phase: "ready", source: "server", error: null };
    return {
      playbackId,
      mediaUrl: "jellyfin-media://stream/current",
      resumePositionTicks: resumeMode === "resume" ? details.userData.playbackPositionTicks : 0,
      source: "server",
    };
  }

  stop(playbackId: string): PlaybackState {
    if (!this.current || this.current.id !== playbackId) throw new AppError("INVALID_PLAYBACK", "That playback session is no longer active.");
    this.current = null;
    this.state = { playbackId: null, itemId: null, phase: "stopped", source: null, error: null };
    return this.state;
  }

  getState(): PlaybackState {
    return { ...this.state };
  }

  clear(): void {
    this.current = null;
    this.state = { playbackId: null, itemId: null, phase: "idle", source: null, error: null };
  }

  async handle(request: Request): Promise<Response> {
    if (request.method !== "GET") return new Response(null, { status: 405 });
    let url: URL;
    try { url = new URL(request.url); } catch { return new Response(null, { status: 400 }); }
    if (url.protocol !== "jellyfin-media:" || url.hostname !== "stream" || url.search || url.hash) return new Response(null, { status: 400 });
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length !== 1 || parts[0] !== "current" || !this.current) return new Response(null, { status: 404 });
    const upstream = await this.api.fetchStaticStream(this.current.itemId, this.current.mediaSourceId, request.headers.get("range") || undefined);
    const headers = new Headers({ "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store" });
    for (const name of ["content-type", "content-length", "content-range", "accept-ranges"]) {
      const value = upstream.headers.get(name);
      if (value) headers.set(name, value);
    }
    return new Response(upstream.body, { status: upstream.status, headers });
  }
}
