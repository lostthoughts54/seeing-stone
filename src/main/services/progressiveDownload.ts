import { open } from "node:fs/promises";
import type { MediaItem, PlaybackDiagnostics } from "../../shared/contracts";

const READ_CHUNK_BYTES = 256 * 1024;
const MAX_INITIAL_METADATA_BYTES = 16 * 1024 * 1024;

export type ProgressiveLeaseInvalidationReason =
  | "cancelled"
  | "deleted"
  | "session-changed"
  | "shutdown"
  | "probe-failed";

export type ProgressiveLeaseEvent =
  | { type: "bytes-available"; bytesAvailable: number }
  | { type: "completed" }
  | { type: "invalidated"; reason: ProgressiveLeaseInvalidationReason };

export interface ProgressiveDownloadDescriptor {
  item: MediaItem;
  itemId: string;
  itemType: "Movie" | "Episode" | "Video";
  seriesId: string | null;
  mediaSourceId: string;
  durationTicks: number;
  expectedSize: number;
  container: string | null;
  diagnostics: PlaybackDiagnostics;
}

export interface ProgressiveDownloadLease {
  readonly descriptor: ProgressiveDownloadDescriptor;
  handle(request: Request): Promise<Response>;
  endMetadataAllowance(): void;
  onEvent(listener: (event: ProgressiveLeaseEvent) => void): () => void;
  release(): void;
}

export interface ProgressiveDownloadProvider {
  acquireProgressive(itemId: string, preferredMediaSourceId?: string): Promise<ProgressiveDownloadLease | null>;
}

interface ProgressiveLeaseOptions {
  descriptor: ProgressiveDownloadDescriptor;
  initialPath: string;
  initialBytes: number;
  fetchMetadataRange(range: string, signal: AbortSignal): Promise<Response>;
  onRelease(): void;
}

interface ParsedRange {
  start: number;
  end: number;
  partial: boolean;
}

function parseRange(value: string | null, size: number): ParsedRange | null {
  if (!value) return { start: 0, end: size - 1, partial: false };
  if (value.includes(",")) return null;
  const match = /^bytes=(\d*)-(\d*)$/i.exec(value.trim());
  if (!match || (!match[1] && !match[2])) return null;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null;
    return { start: Math.max(0, size - suffix), end: size - 1, partial: true };
  }
  const start = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd)
    || start < 0 || start >= size || requestedEnd < start) return null;
  return { start, end: Math.min(size - 1, requestedEnd), partial: true };
}

function responseHeaders(range: ParsedRange, size: number): Headers {
  const headers = new Headers({
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-store",
    "Content-Length": String(range.end - range.start + 1),
    "X-Content-Type-Options": "nosniff",
  });
  if (range.partial) headers.set("Content-Range", `bytes ${range.start}-${range.end}/${size}`);
  return headers;
}

export class ActiveProgressiveDownloadLease implements ProgressiveDownloadLease {
  readonly descriptor: ProgressiveDownloadDescriptor;
  private currentPath: string;
  private bytesAvailable: number;
  private metadataRemaining = MAX_INITIAL_METADATA_BYTES;
  private metadataAllowed = true;
  private completed = false;
  private invalidated: ProgressiveLeaseInvalidationReason | null = null;
  private released = false;
  private finalizing = false;
  private activeReads = 0;
  private readonly listeners = new Set<(event: ProgressiveLeaseEvent) => void>();
  private readonly waiters = new Set<() => void>();

  constructor(private readonly options: ProgressiveLeaseOptions) {
    this.descriptor = options.descriptor;
    this.currentPath = options.initialPath;
    this.bytesAvailable = options.initialBytes;
  }

  publishBytes(bytesAvailable: number): void {
    if (this.invalidated || this.completed || bytesAvailable <= this.bytesAvailable) return;
    this.bytesAvailable = Math.min(this.descriptor.expectedSize, bytesAvailable);
    this.emit({ type: "bytes-available", bytesAvailable: this.bytesAvailable });
    this.wake();
  }

  publishCompleted(finalPath: string): void {
    if (this.invalidated || this.completed) return;
    this.currentPath = finalPath;
    this.finalizing = false;
    this.bytesAvailable = this.descriptor.expectedSize;
    this.completed = true;
    this.metadataAllowed = false;
    this.emit({ type: "completed" });
    this.wake();
  }

  async beginFinalization(): Promise<void> {
    this.finalizing = true;
    while (this.activeReads > 0 && !this.invalidated && !this.released) await this.wait(new AbortController().signal);
  }

  publishRenamed(finalPath: string): void {
    this.currentPath = finalPath;
    this.finalizing = false;
    this.wake();
  }

  endFinalization(): void {
    this.finalizing = false;
    this.wake();
  }

  publishInvalidated(reason: ProgressiveLeaseInvalidationReason): void {
    if (this.invalidated) return;
    this.invalidated = reason;
    this.metadataAllowed = false;
    this.emit({ type: "invalidated", reason });
    this.wake();
  }

  async drainReads(): Promise<void> {
    while (this.activeReads > 0) await this.wait(new AbortController().signal);
  }

  endMetadataAllowance(): void {
    this.metadataAllowed = false;
  }

  onEvent(listener: (event: ProgressiveLeaseEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    this.listeners.clear();
    this.wake();
    this.options.onRelease();
  }

  async handle(request: Request): Promise<Response> {
    if (request.method !== "GET" && request.method !== "HEAD") return new Response(null, { status: 405 });
    if (this.invalidated || this.released) return new Response(null, { status: 410 });
    const range = parseRange(request.headers.get("range"), this.descriptor.expectedSize);
    if (!range) {
      return new Response(null, {
        status: 416,
        headers: { "Content-Range": `bytes */${this.descriptor.expectedSize}`, "Cache-Control": "no-store" },
      });
    }
    if (range.start > this.bytesAvailable) return this.handleMetadataRange(request, range);
    const headers = responseHeaders(range, this.descriptor.expectedSize);
    if (request.method === "HEAD") return new Response(null, { status: range.partial ? 206 : 200, headers });

    let offset = range.start;
    const body = new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        try {
          while (offset <= range.end) {
            if (this.invalidated || this.released) {
              controller.error(new Error("Progressive download lease ended."));
              return;
            }
            const readableEnd = Math.min(range.end + 1, this.bytesAvailable);
            if (this.finalizing || offset >= readableEnd) {
              await this.wait(request.signal);
              continue;
            }
            const length = Math.min(READ_CHUNK_BYTES, readableEnd - offset);
            const buffer = Buffer.allocUnsafe(length);
            this.activeReads += 1;
            let handle: Awaited<ReturnType<typeof open>> | null = null;
            let bytesRead = 0;
            try {
              handle = await open(this.currentPath, "r");
              ({ bytesRead } = await handle.read(buffer, 0, length, offset));
            } finally {
              await handle?.close().catch(() => undefined);
              this.activeReads -= 1;
              if (this.activeReads === 0) this.wake();
            }
            if (bytesRead <= 0) {
              await this.wait(request.signal);
              continue;
            }
            offset += bytesRead;
            controller.enqueue(buffer.subarray(0, bytesRead));
            return;
          }
          controller.close();
        } catch (error) {
          controller.error(error);
        }
      },
    });
    return new Response(body, { status: range.partial ? 206 : 200, headers });
  }

  private async handleMetadataRange(request: Request, range: ParsedRange): Promise<Response> {
    const requestedBytes = range.end - range.start + 1;
    if (request.method === "HEAD" || !this.metadataAllowed || requestedBytes > this.metadataRemaining) {
      return new Response(null, {
        status: 416,
        headers: { "Content-Range": `bytes */${this.descriptor.expectedSize}`, "Cache-Control": "no-store" },
      });
    }
    const upstream = await this.options.fetchMetadataRange(
      `bytes=${range.start}-${range.end}`,
      request.signal,
    );
    const contentRange = upstream.headers.get("content-range");
    const expectedContentRange = `bytes ${range.start}-${range.end}/${this.descriptor.expectedSize}`;
    const contentLength = Number(upstream.headers.get("content-length"));
    if (upstream.status !== 206 || contentRange?.toLocaleLowerCase("en-US") !== expectedContentRange
      || contentLength !== requestedBytes) {
      await upstream.body?.cancel().catch(() => undefined);
      return new Response(null, { status: 502, headers: { "Cache-Control": "no-store" } });
    }
    this.metadataRemaining -= requestedBytes;
    const headers = new Headers({ "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    for (const name of ["content-type", "content-length", "content-range", "accept-ranges"]) {
      const value = upstream.headers.get(name);
      if (value) headers.set(name, value);
    }
    return new Response(upstream.body, { status: upstream.status, headers });
  }

  private emit(event: ProgressiveLeaseEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  private wake(): void {
    for (const waiter of this.waiters) waiter();
    this.waiters.clear();
  }

  private wait(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(signal.reason ?? new Error("Progressive request aborted."));
    return new Promise<void>((resolve, reject) => {
      const finish = () => {
        signal.removeEventListener("abort", abort);
        this.waiters.delete(finish);
        resolve();
      };
      const abort = () => {
        this.waiters.delete(finish);
        reject(signal.reason ?? new Error("Progressive request aborted."));
      };
      this.waiters.add(finish);
      signal.addEventListener("abort", abort, { once: true });
    });
  }
}
