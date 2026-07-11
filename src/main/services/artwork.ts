import { randomUUID } from "node:crypto";
import type { ArtworkInput } from "../../shared/contracts";
import { AppError } from "./errors";
interface ArtworkApi {
  fetchArtwork(itemId: string, kind: string, options: Record<string, string>, signal?: AbortSignal): Promise<Response>;
}

interface ArtworkReference {
  input: ArtworkInput;
  epoch: number;
}

interface ActiveArtworkRequest {
  controller: AbortController;
  reader: ReadableStreamDefaultReader<Uint8Array> | null;
}

const ALLOWED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/avif", "image/gif"]);

export class ArtworkService {
  private readonly references = new Map<string, ArtworkReference>();
  private readonly activeRequests = new Set<ActiveArtworkRequest>();
  private epoch = 0;

  constructor(private readonly api: ArtworkApi) {}

  getUrl(input: ArtworkInput): string {
    if (this.references.size >= 5000) this.references.delete(this.references.keys().next().value as string);
    const reference = randomUUID();
    this.references.set(reference, { input, epoch: this.epoch });
    return `jellyfin-artwork://asset/${reference}`;
  }

  clear(): void {
    this.epoch += 1;
    this.references.clear();
    for (const request of this.activeRequests) this.revoke(request);
    this.activeRequests.clear();
  }

  async handle(request: Request): Promise<Response> {
    if (request.method !== "GET") return new Response(null, { status: 405 });
    let url: URL;
    try { url = new URL(request.url); } catch { return new Response(null, { status: 400 }); }
    if (url.protocol !== "jellyfin-artwork:" || url.hostname !== "asset" || url.search || url.hash) return new Response(null, { status: 400 });
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length !== 1) return new Response(null, { status: 404 });
    const referenceId = parts[0];
    const reference = this.references.get(referenceId);
    if (!reference || reference.epoch !== this.epoch) return new Response(null, { status: 404 });

    const activeRequest: ActiveArtworkRequest = {
      controller: new AbortController(),
      reader: null,
    };
    this.activeRequests.add(activeRequest);

    const options: Record<string, string> = { quality: "90" };
    if (reference.input.tag) options.tag = reference.input.tag;
    if (reference.input.width) options.maxWidth = String(reference.input.width);
    if (reference.input.height) options.maxHeight = String(reference.input.height);
    let upstream: Response;
    try {
      upstream = await this.api.fetchArtwork(
        reference.input.itemId,
        reference.input.kind,
        options,
        activeRequest.controller.signal,
      );
    } catch (error) {
      this.activeRequests.delete(activeRequest);
      if (!this.isCurrent(referenceId, reference, activeRequest)) return new Response(null, { status: 404 });
      throw error;
    }
    if (!this.isCurrent(referenceId, reference, activeRequest)) {
      this.revoke(activeRequest);
      void upstream.body?.cancel().catch(() => undefined);
      return new Response(null, { status: 404 });
    }
    const contentType = upstream.headers.get("content-type")?.split(";", 1)[0].toLowerCase() || "";
    if (!ALLOWED_IMAGE_TYPES.has(contentType)) {
      this.revoke(activeRequest);
      void upstream.body?.cancel().catch(() => undefined);
      throw new AppError("INVALID_ARTWORK", "Jellyfin returned unsupported artwork.", 502);
    }
    const headers = new Headers({
      "Content-Type": contentType,
      // Session-scoped artwork references must be re-authorized on every load.
      // Chromium caching would otherwise keep a prior account's image usable
      // after the in-memory reference table is cleared on logout.
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    const length = upstream.headers.get("content-length");
    if (length) headers.set("Content-Length", length);
    const body = upstream.body
      ? this.trackBody(upstream.body, referenceId, reference, activeRequest)
      : null;
    if (!body) this.activeRequests.delete(activeRequest);
    return new Response(body, { status: 200, headers });
  }

  private isCurrent(
    referenceId: string,
    reference: ArtworkReference,
    request: ActiveArtworkRequest,
  ): boolean {
    return !request.controller.signal.aborted
      && reference.epoch === this.epoch
      && this.references.get(referenceId) === reference;
  }

  private revoke(request: ActiveArtworkRequest): void {
    request.controller.abort();
    if (request.reader) void request.reader.cancel().catch(() => undefined);
    this.activeRequests.delete(request);
  }

  private trackBody(
    body: ReadableStream<Uint8Array>,
    referenceId: string,
    reference: ArtworkReference,
    request: ActiveArtworkRequest,
  ): ReadableStream<Uint8Array> {
    const reader = body.getReader();
    request.reader = reader;
    const settle = () => this.activeRequests.delete(request);
    const revoked = () => !this.isCurrent(referenceId, reference, request);
    return new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        if (revoked()) {
          this.revoke(request);
          controller.error(new DOMException("Artwork authorization was revoked.", "AbortError"));
          return;
        }
        try {
          const result = await reader.read();
          if (revoked()) {
            this.revoke(request);
            controller.error(new DOMException("Artwork authorization was revoked.", "AbortError"));
          } else if (result.done) {
            settle();
            controller.close();
          } else {
            controller.enqueue(result.value);
          }
        } catch (error) {
          settle();
          controller.error(revoked()
            ? new DOMException("Artwork authorization was revoked.", "AbortError")
            : error);
        }
      },
      cancel: async (reason) => {
        request.controller.abort();
        settle();
        await reader.cancel(reason).catch(() => undefined);
      },
    });
  }
}
