import { randomUUID } from "node:crypto";
import type { ArtworkInput } from "../../shared/contracts";
import { AppError } from "./errors";
interface ArtworkApi {
  fetchArtwork(itemId: string, kind: string, options: Record<string, string>): Promise<Response>;
}

interface ArtworkReference {
  input: ArtworkInput;
  epoch: number;
}

const ALLOWED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/avif", "image/gif"]);

export class ArtworkService {
  private readonly references = new Map<string, ArtworkReference>();
  private epoch = 0;

  constructor(private readonly api: ArtworkApi) {}

  getUrl(input: ArtworkInput): string {
    if (this.references.size > 5000) this.references.delete(this.references.keys().next().value as string);
    const reference = randomUUID();
    this.references.set(reference, { input, epoch: this.epoch });
    return `jellyfin-artwork://asset/${reference}`;
  }

  clear(): void {
    this.epoch += 1;
    this.references.clear();
  }

  async handle(request: Request): Promise<Response> {
    if (request.method !== "GET") return new Response(null, { status: 405 });
    let url: URL;
    try { url = new URL(request.url); } catch { return new Response(null, { status: 400 }); }
    if (url.protocol !== "jellyfin-artwork:" || url.hostname !== "asset" || url.search || url.hash) return new Response(null, { status: 400 });
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length !== 1) return new Response(null, { status: 404 });
    const reference = this.references.get(parts[0]);
    if (!reference || reference.epoch !== this.epoch) return new Response(null, { status: 404 });

    const options: Record<string, string> = { quality: "90" };
    if (reference.input.tag) options.tag = reference.input.tag;
    if (reference.input.width) options.maxWidth = String(reference.input.width);
    if (reference.input.height) options.maxHeight = String(reference.input.height);
    const upstream = await this.api.fetchArtwork(reference.input.itemId, reference.input.kind, options);
    const contentType = upstream.headers.get("content-type")?.split(";", 1)[0].toLowerCase() || "";
    if (!ALLOWED_IMAGE_TYPES.has(contentType)) throw new AppError("INVALID_ARTWORK", "Jellyfin returned unsupported artwork.");
    const headers = new Headers({
      "Content-Type": contentType,
      "Cache-Control": "private, max-age=3600",
      "X-Content-Type-Options": "nosniff",
    });
    const length = upstream.headers.get("content-length");
    if (length) headers.set("Content-Length", length);
    return new Response(upstream.body, { status: 200, headers });
  }
}
