import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { subtitleBytes } from "./downloadSubtitles";
import { AppError } from "./errors";
import type { ExternalSubtitleTrack } from "../../shared/contracts";
import type { PlaybackSessionService, ResolvedPlaybackSource } from "./playbackSession";

export interface PlaybackTargets {
  media: string;
  subtitles: Array<{
    url: string;
    title: string | null;
    language: string | null;
    isDefault: boolean;
    streamIndex: number;
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
  private subtitleAbort: AbortController | null = null;
  private subtitleFiles: Promise<{ directory: string; targets: PlaybackTargets["subtitles"] }> | null = null;

  constructor(private readonly playback: PlaybackSessionService) {}

  async open(source: ResolvedPlaybackSource, options: { materializeSubtitles?: boolean } = {}): Promise<PlaybackTargets> {
    await this.close();
    this.source = source;
    const externalSubtitles = source.externalSubtitles ?? [];
    let staged: PlaybackTargets["subtitles"] | null = null;
    if (options.materializeSubtitles && externalSubtitles.length) {
      // libmpv's synchronous sub-add waits for the file to load. A loopback
      // request here would wait on this same blocked main process forever.
      this.subtitleAbort = new AbortController();
      this.subtitleFiles = this.materializeSubtitles(source, this.subtitleAbort.signal);
      staged = (await this.subtitleFiles).targets;
      if (this.source !== source) throw new AppError("PLAYBACK_CANCELLED", "Playback was cancelled.", 409);
    }
    if (source.source === "local" && !source.progressiveLease && externalSubtitles.length === 0) {
      return { media: source.mediaUrl, subtitles: [] };
    }
    this.mediaCapabilityPath = source.source === "server" || source.progressiveLease ? `/${randomUUID()}` : null;
    for (const subtitle of externalSubtitles) {
      if (staged) break;
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
      subtitles: staged ?? [...this.subtitleCapabilities].map(([path, subtitle]) => ({
        url: `${origin}${path}`,
        title: subtitle.title,
        language: subtitle.language,
        isDefault: subtitle.isDefault,
        streamIndex: subtitle.streamIndex,
      })),
    };
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.mediaCapabilityPath = null;
    this.subtitleCapabilities.clear();
    this.source = null;
    this.subtitleAbort?.abort(); this.subtitleAbort = null;
    const subtitleFiles = this.subtitleFiles; this.subtitleFiles = null;
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    const files = await subtitleFiles?.catch(() => null);
    if (files) await rm(files.directory, { recursive: true, force: true });
  }

  private async materializeSubtitles(source: ResolvedPlaybackSource, signal: AbortSignal): Promise<{ directory: string; targets: PlaybackTargets["subtitles"] }> {
    const directory = await mkdtemp(join(tmpdir(), "seeing-stone-subtitles-"));
    const targets: PlaybackTargets["subtitles"] = [];
    try {
      for (const subtitle of source.externalSubtitles ?? []) {
        signal.throwIfAborted();
        if (!["srt", "ass", "ssa", "vtt"].includes(subtitle.format)) continue;
        try {
          const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
          const response = await this.playback.fetchExternalSubtitle(source.playbackId, subtitle, requestSignal);
          const bytes = await subtitleBytes(response, requestSignal);
          signal.throwIfAborted();
          const path = join(directory, `${randomUUID()}.${subtitle.format}`);
          await writeFile(path, bytes, { flag: "wx", signal });
          targets.push({ url: path, title: subtitle.title, language: subtitle.language, isDefault: subtitle.isDefault, streamIndex: subtitle.streamIndex });
        } catch {
          // An unavailable optional subtitle must not prevent video playback.
          signal.throwIfAborted();
        }
      }
      return { directory, targets };
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  }

  private async handle(request: import("node:http").IncomingMessage, response: import("node:http").ServerResponse): Promise<void> {
    const source = this.source;
    const method = request.method;
    const mediaRequest = Boolean(source && (source.source === "server" || source.progressiveLease) && request.url === this.mediaCapabilityPath);
    const subtitle = request.url ? this.subtitleCapabilities.get(request.url) : undefined;
    const iptvResource = Boolean(source?.iptvStream && request.url && source.iptvStream.has(request.url));
    if (!source || (method !== "GET" && method !== "HEAD") || (!mediaRequest && !subtitle && !iptvResource)) {
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
      upstream = source.iptvStream && (mediaRequest || iptvResource)
        ? await source.iptvStream.fetch(mediaRequest ? "root" : request.url!, controller.signal, request.headers.range)
        : mediaRequest
        ? source.progressiveLease
          ? await source.progressiveLease.handle(new Request(source.mediaUrl, { method, headers, signal: controller.signal }))
          : await this.playback.handle(new Request(source.mediaUrl, { headers, signal: controller.signal }))
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
        if (!response.write(Buffer.from(chunk.value))) await once(response, "drain", { signal: controller.signal });
      }
    } catch {
      // Closing or seeking aborts an in-flight range request by design.
    } finally {
      await reader.cancel().catch(() => undefined);
      response.end();
    }
  }
}
