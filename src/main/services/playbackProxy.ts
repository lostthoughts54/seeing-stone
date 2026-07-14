import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import type { ExternalSubtitleTrack } from "../../shared/contracts";
import type { PlaybackSessionService, ResolvedPlaybackSource } from "./playbackSession";

export interface PlaybackTargets {
  media: string;
  subtitles: Array<{
    url: string;
    title: string | null;
    language: string | null;
    isDefault: boolean;
  }>;
}

/**
 * Main-owned loopback capability used only by the spawned mpv process.
 * It contains no Jellyfin credential or item/source identity and is never
 * returned through renderer IPC.
 */
export class PlaybackProxy {
  private server: Server | null = null;
  private mediaCapabilityPath: string | null = null;
  private readonly subtitleCapabilities = new Map<string, ExternalSubtitleTrack>();
  private source: ResolvedPlaybackSource | null = null;

  constructor(private readonly playback: PlaybackSessionService) {}

  async open(source: ResolvedPlaybackSource): Promise<PlaybackTargets> {
    await this.close();
    this.source = source;
    const externalSubtitles = source.externalSubtitles ?? [];
    if (source.source === "local" && externalSubtitles.length === 0) {
      return { media: source.mediaUrl, subtitles: [] };
    }
    this.mediaCapabilityPath = source.source === "server" ? `/${randomUUID()}` : null;
    for (const subtitle of externalSubtitles) {
      this.subtitleCapabilities.set(`/${randomUUID()}.${subtitle.format}`, subtitle);
    }
    this.server = createServer((request, response) => { void this.handle(request, response); });
    this.server.on("clientError", (_error, socket) => socket.destroy());
    await new Promise<void>((resolve, reject) => {
      this.server?.once("error", reject);
      this.server?.listen(0, "127.0.0.1", () => resolve());
    });
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("Playback proxy did not bind to loopback.");
    const origin = `http://127.0.0.1:${address.port}`;
    return {
      media: this.mediaCapabilityPath ? `${origin}${this.mediaCapabilityPath}` : source.mediaUrl,
      subtitles: [...this.subtitleCapabilities].map(([path, subtitle]) => ({
        url: `${origin}${path}`,
        title: subtitle.title,
        language: subtitle.language,
        isDefault: subtitle.isDefault,
      })),
    };
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.mediaCapabilityPath = null;
    this.subtitleCapabilities.clear();
    this.source = null;
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private async handle(request: import("node:http").IncomingMessage, response: import("node:http").ServerResponse): Promise<void> {
    const source = this.source;
    const method = request.method;
    const mediaRequest = Boolean(source && source.source === "server" && request.url === this.mediaCapabilityPath);
    const subtitle = request.url ? this.subtitleCapabilities.get(request.url) : undefined;
    if (!source || (method !== "GET" && method !== "HEAD") || (!mediaRequest && !subtitle)) {
      response.writeHead(method === "GET" || method === "HEAD" ? 404 : 405, { "Cache-Control": "no-store" });
      response.end();
      return;
    }
    const controller = new AbortController();
    request.once("aborted", () => controller.abort());
    response.once("close", () => { if (!response.writableEnded) controller.abort(); });
    const headers = new Headers();
    if (request.headers.range) headers.set("Range", request.headers.range);
    let upstream: Response;
    try {
      upstream = mediaRequest
        ? await this.playback.handle(new Request(source.mediaUrl, { headers, signal: controller.signal }))
        : await this.playback.fetchExternalSubtitle(source.playbackId, subtitle!, controller.signal);
    } catch {
      if (!response.headersSent) response.writeHead(502, { "Cache-Control": "no-store" });
      response.end();
      return;
    }
    const outgoing: Record<string, string> = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
    for (const name of ["content-type", "content-length", "content-range", "accept-ranges"]) {
      const value = upstream.headers.get(name);
      if (value) outgoing[name] = value;
    }
    response.writeHead(upstream.status, outgoing);
    if (method === "HEAD") {
      await upstream.body?.cancel().catch(() => undefined);
      response.end();
      return;
    }
    if (!upstream.body) {
      response.end();
      return;
    }
    const reader = upstream.body.getReader();
    try {
      while (!controller.signal.aborted) {
        const chunk = await reader.read();
        if (chunk.done) break;
        if (!response.write(Buffer.from(chunk.value))) await once(response, "drain");
      }
    } catch {
      // Closing or seeking aborts an in-flight range request by design.
    } finally {
      await reader.cancel().catch(() => undefined);
      response.end();
    }
  }
}
