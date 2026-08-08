import { randomUUID } from "node:crypto";
import type { PlaybackState, TrickplayManifest } from "../../shared/contracts";
import { AppError } from "./errors";

const MAX_REFERENCES = 32;
const MAX_CACHE_ENTRIES = 8;
const MAX_CACHE_BYTES = 32 * 1024 * 1024;
const MAX_SPRITE_BYTES = 8 * 1024 * 1024;
const MAX_CONCURRENT_REQUESTS = 2;
const FAILURE_COOLDOWN_MS = 30_000;
const REQUEST_TIMEOUT_MS = 8_000;

interface TrickplayApi {
  getTrickplayMetadata(itemId: string, signal?: AbortSignal): Promise<unknown>;
  fetchTrickplayTile(itemId: string, mediaSourceId: string, width: number, index: number, signal?: AbortSignal): Promise<Response>;
}

interface ActiveResourceContext {
  itemId: string;
  mediaSourceId: string;
  contentKind: "on-demand" | "live-tv";
}

interface ActivePlayback {
  playbackId: string;
  itemId: string;
  durationTicks: number;
  epoch: number;
  controller: AbortController;
}

interface ActiveManifest {
  value: TrickplayManifest;
  mediaSourceId: string;
  epoch: number;
}

interface SpriteReference {
  manifestId: string;
  spriteIndex: number;
  epoch: number;
}

interface CachedSprite {
  body: Uint8Array;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function validInteger(value: unknown, minimum: number, maximum: number): number | null {
  return Number.isSafeInteger(value) && (value as number) >= minimum && (value as number) <= maximum ? value as number : null;
}

function imageMime(response: Response): string {
  return response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() || "";
}

/** Main-owned, playback-scoped trickplay capabilities and small sprite cache. */
export class TrickplayService {
  private active: ActivePlayback | null = null;
  private manifest: ActiveManifest | null = null;
  private readonly references = new Map<string, SpriteReference>();
  private readonly cache = new Map<string, CachedSprite>();
  private cacheBytes = 0;
  private readonly failures = new Map<string, number>();
  private readonly inflight = new Map<string, Promise<CachedSprite>>();
  private readonly requestControllers = new Set<AbortController>();
  private epoch = 0;

  constructor(
    private readonly api: TrickplayApi,
    private readonly getActiveResourceContext: (playbackId: string) => ActiveResourceContext | null,
  ) {}

  setPlaybackState(state: PlaybackState): void {
    const eligible = Boolean(state.playbackId && state.itemId && state.durationTicks > 0 && state.contentKind !== "live-tv");
    if (eligible && this.active?.playbackId === state.playbackId && this.active.itemId === state.itemId) return;
    this.clear();
    if (eligible && state.playbackId && state.itemId) {
      this.active = {
        playbackId: state.playbackId,
        itemId: state.itemId,
        durationTicks: state.durationTicks,
        epoch: this.epoch,
        controller: new AbortController(),
      };
    }
  }

  clear(): void {
    this.epoch += 1;
    this.active?.controller.abort();
    for (const controller of this.requestControllers) controller.abort();
    this.requestControllers.clear();
    this.active = null;
    this.manifest = null;
    this.references.clear();
    this.cache.clear();
    this.cacheBytes = 0;
    this.failures.clear();
  }

  async getManifest(playbackId: string): Promise<TrickplayManifest | null> {
    const active = this.requireActive(playbackId);
    if (this.manifest?.value.playbackId === playbackId && this.manifest.epoch === this.epoch) return this.manifest.value;
    const context = this.getActiveResourceContext(playbackId);
    if (!context || context.itemId !== active.itemId || context.contentKind !== "on-demand") return null;
    const signal = AbortSignal.any([active.controller.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]);
    const metadata = await this.api.getTrickplayMetadata(active.itemId, signal);
    if (!this.isCurrent(active)) return null;
    const after = this.getActiveResourceContext(playbackId);
    if (!after || after.itemId !== active.itemId || after.mediaSourceId !== context.mediaSourceId || after.contentKind !== "on-demand") return null;
    const manifest = this.normalizeManifest(metadata, active, after.mediaSourceId);
    if (!manifest) return null;
    this.manifest = { value: manifest, mediaSourceId: after.mediaSourceId, epoch: this.epoch };
    return manifest;
  }

  getSpriteUrl(playbackId: string, manifestId: string, spriteIndex: number): string {
    const manifest = this.requireManifest(playbackId, manifestId);
    if (!Number.isSafeInteger(spriteIndex) || spriteIndex < 0 || spriteIndex >= manifest.value.spriteCount) {
      throw new AppError("INVALID_TRICKPLAY_SPRITE", "That preview image is unavailable.", 400);
    }
    const key = `${manifestId}:${spriteIndex}`;
    for (const [id, reference] of this.references) {
      if (`${reference.manifestId}:${reference.spriteIndex}` === key && reference.epoch === this.epoch) {
        this.references.delete(id);
        this.references.set(id, reference);
        return `jellyfin-trickplay://asset/${id}`;
      }
    }
    while (this.references.size >= MAX_REFERENCES) this.references.delete(this.references.keys().next().value as string);
    const referenceId = randomUUID();
    this.references.set(referenceId, { manifestId, spriteIndex, epoch: this.epoch });
    return `jellyfin-trickplay://asset/${referenceId}`;
  }

  async handle(request: Request): Promise<Response> {
    if (request.method !== "GET") return new Response(null, { status: 405 });
    let url: URL;
    try { url = new URL(request.url); } catch { return new Response(null, { status: 400 }); }
    if (url.protocol !== "jellyfin-trickplay:" || url.hostname !== "asset" || url.search || url.hash) return new Response(null, { status: 400 });
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length !== 1) return new Response(null, { status: 404 });
    const reference = this.references.get(parts[0]);
    if (!reference || reference.epoch !== this.epoch) return new Response(null, { status: 404 });
    const manifest = this.manifest;
    if (!manifest || manifest.epoch !== this.epoch || manifest.value.manifestId !== reference.manifestId) return new Response(null, { status: 404 });
    const cacheKey = `${manifest.value.manifestId}:${reference.spriteIndex}`;
    const sprite = await this.loadSprite(manifest, reference.spriteIndex, cacheKey);
    return new Response(sprite.body as unknown as BodyInit, {
      status: 200,
      headers: {
        "Content-Type": "image/jpeg",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  }

  private normalizeManifest(metadata: unknown, active: ActivePlayback, mediaSourceId: string): TrickplayManifest | null {
    const source = asRecord(asRecord(metadata)[mediaSourceId]);
    const candidates: Array<{ width: number; height: number; intervalMs: number; frameCount: number; columns: number; rows: number }> = [];
    for (const [widthKey, value] of Object.entries(source)) {
      const width = validInteger(Number(widthKey), 1, 4096);
      const info = asRecord(value);
      const frameWidth = validInteger(info.Width, 1, 4096);
      const height = validInteger(info.Height, 1, 4096);
      const intervalMs = validInteger(info.Interval, 250, 3_600_000);
      const frameCount = validInteger(info.ThumbnailCount, 1, 1_000_000);
      const columns = validInteger(info.TileWidth, 1, 100);
      const rows = validInteger(info.TileHeight, 1, 100);
      if (!width || !frameWidth || width !== frameWidth || !height || !intervalMs || !frameCount || !columns || !rows) continue;
      if (width * columns > 16_384 || height * rows > 16_384) continue;
      const intervalTicks = intervalMs * 10_000;
      const capacity = columns * rows;
      const plausibleCount = Math.ceil(active.durationTicks / intervalTicks) + capacity;
      if (frameCount > plausibleCount) continue;
      candidates.push({ width, height, intervalMs, frameCount, columns, rows });
    }
    if (!candidates.length) return null;
    const below = candidates.filter((candidate) => candidate.width <= 320).sort((a, b) => b.width - a.width);
    const selected = below[0] ?? candidates.sort((a, b) => a.width - b.width)[0];
    const framesPerSprite = selected.columns * selected.rows;
    return {
      manifestId: randomUUID(),
      playbackId: active.playbackId,
      itemId: active.itemId,
      frameWidth: selected.width,
      frameHeight: selected.height,
      intervalTicks: selected.intervalMs * 10_000,
      columns: selected.columns,
      rows: selected.rows,
      frameCount: selected.frameCount,
      spriteCount: Math.ceil(selected.frameCount / framesPerSprite),
    };
  }

  private async loadSprite(manifest: ActiveManifest, spriteIndex: number, cacheKey: string): Promise<CachedSprite> {
    const cached = this.cache.get(cacheKey);
    if (cached) {
      this.cache.delete(cacheKey);
      this.cache.set(cacheKey, cached);
      return cached;
    }
    const failureAt = this.failures.get(cacheKey);
    if (failureAt && Date.now() - failureAt < FAILURE_COOLDOWN_MS) throw new AppError("TRICKPLAY_UNAVAILABLE", "That preview image is temporarily unavailable.", 503);
    const existing = this.inflight.get(cacheKey);
    if (existing) return existing;
    if (this.inflight.size >= MAX_CONCURRENT_REQUESTS) throw new AppError("TRICKPLAY_BUSY", "Preview images are loading.", 429);
    const controller = new AbortController();
    this.requestControllers.add(controller);
    const task = (async () => {
      try {
        const upstream = await this.api.fetchTrickplayTile(
          manifest.value.itemId,
          manifest.mediaSourceId,
          manifest.value.frameWidth,
          spriteIndex,
          AbortSignal.any([controller.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
        );
        if (!this.isCurrentManifest(manifest)) {
          void upstream.body?.cancel().catch(() => undefined);
          throw new AppError("TRICKPLAY_REVOKED", "That preview image is no longer available.", 404);
        }
        if (imageMime(upstream) !== "image/jpeg") {
          void upstream.body?.cancel().catch(() => undefined);
          throw new AppError("INVALID_TRICKPLAY", "Jellyfin returned an unsupported preview image.", 502);
        }
        const body = await this.readBody(upstream, controller.signal);
        if (!this.isCurrentManifest(manifest)) throw new AppError("TRICKPLAY_REVOKED", "That preview image is no longer available.", 404);
        const sprite = { body };
        this.store(cacheKey, sprite);
        this.failures.delete(cacheKey);
        return sprite;
      } catch (error) {
        if (!controller.signal.aborted && this.isCurrentManifest(manifest)) this.failures.set(cacheKey, Date.now());
        throw error;
      } finally {
        this.inflight.delete(cacheKey);
        this.requestControllers.delete(controller);
      }
    })();
    this.inflight.set(cacheKey, task);
    return task;
  }

  private async readBody(response: Response, signal: AbortSignal): Promise<Uint8Array> {
    const declared = response.headers.get("content-length");
    if (declared && (!/^\d+$/.test(declared) || Number(declared) > MAX_SPRITE_BYTES)) {
      throw new AppError("TRICKPLAY_TOO_LARGE", "Jellyfin returned an oversized preview image.", 502);
    }
    if (!response.body) return new Uint8Array();
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        if (signal.aborted) throw new AppError("TRICKPLAY_REVOKED", "That preview image is no longer available.", 404);
        const result = await reader.read();
        if (result.done) break;
        total += result.value.byteLength;
        if (total > MAX_SPRITE_BYTES) throw new AppError("TRICKPLAY_TOO_LARGE", "Jellyfin returned an oversized preview image.", 502);
        chunks.push(result.value);
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    const body = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
    return body;
  }

  private store(cacheKey: string, sprite: CachedSprite): void {
    while (this.cache.size >= MAX_CACHE_ENTRIES || this.cacheBytes + sprite.body.byteLength > MAX_CACHE_BYTES) {
      const oldest = this.cache.keys().next().value as string | undefined;
      if (!oldest) break;
      const removed = this.cache.get(oldest);
      this.cache.delete(oldest);
      this.cacheBytes -= removed?.body.byteLength ?? 0;
    }
    if (sprite.body.byteLength > MAX_CACHE_BYTES) return;
    this.cache.set(cacheKey, sprite);
    this.cacheBytes += sprite.body.byteLength;
  }

  private requireActive(playbackId: string): ActivePlayback {
    const active = this.active;
    if (!active || active.playbackId !== playbackId || !this.isCurrent(active)) throw new AppError("INVALID_PLAYBACK", "That playback session is no longer active.", 409);
    return active;
  }

  private requireManifest(playbackId: string, manifestId: string): ActiveManifest {
    this.requireActive(playbackId);
    const manifest = this.manifest;
    if (!manifest || manifest.epoch !== this.epoch || manifest.value.playbackId !== playbackId || manifest.value.manifestId !== manifestId) {
      throw new AppError("INVALID_TRICKPLAY_MANIFEST", "That preview image is no longer available.", 409);
    }
    return manifest;
  }

  private isCurrent(active: ActivePlayback): boolean {
    return !active.controller.signal.aborted && active.epoch === this.epoch && this.active === active;
  }

  private isCurrentManifest(manifest: ActiveManifest): boolean {
    return manifest.epoch === this.epoch && this.manifest === manifest && this.active?.playbackId === manifest.value.playbackId;
  }
}
