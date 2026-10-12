import { appendFile, mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { redactText, sanitizeLogValue } from "./logger";

export const LIBMPV_DIAGNOSTICS_FILENAME = "seeing-stone-live-tv-mpv.ndjson";

export type LibMpvDecoderTestMode = "current" | "software" | "auto-copy";
export type RequestedLibMpvDecoderTestMode = LibMpvDecoderTestMode | "nvdec-copy";
export type LibMpvPresentationMode = "shared-texture" | "cpu-readback";

export interface LibMpvDiagnosticSettings {
  enabled: boolean;
  decoderMode: LibMpvDecoderTestMode;
  requestedDecoderMode: RequestedLibMpvDecoderTestMode;
  hwdec: "auto-safe" | "no" | "auto-copy";
  presentationMode: LibMpvPresentationMode;
  logFilePath: string;
  unsupportedReason: string | null;
}

const diagnosticModes = new Set<RequestedLibMpvDecoderTestMode>([
  "current",
  "software",
  "auto-copy",
  "nvdec-copy",
]);

const presentationModes = new Set<LibMpvPresentationMode>([
  "shared-texture",
  "cpu-readback",
]);

export function resolveLibMpvDiagnosticSettings(
  environment: Readonly<Record<string, string | undefined>>,
  logDirectory: string,
): LibMpvDiagnosticSettings {
  const rawMode = environment.SEEING_STONE_MPV_DECODER_MODE?.trim().toLowerCase();
  const rawPresentationMode = environment.SEEING_STONE_MPV_PRESENTATION_MODE?.trim().toLowerCase();
  const requestedDecoderMode = diagnosticModes.has(rawMode as RequestedLibMpvDecoderTestMode)
    ? rawMode as RequestedLibMpvDecoderTestMode
    : "current";
  const unsupportedReason = requestedDecoderMode === "nvdec-copy"
    ? "The controlled mpv/FFmpeg runtime does not advertise an NVDEC decoder; the current auto-safe mode remains active."
    : rawMode && !diagnosticModes.has(rawMode as RequestedLibMpvDecoderTestMode)
      ? `Unknown decoder test mode: ${rawMode}`
      : null;
  const decoderMode: LibMpvDecoderTestMode = requestedDecoderMode === "nvdec-copy"
    ? "current"
    : requestedDecoderMode;
  const hwdec = decoderMode === "software" ? "no" : decoderMode === "auto-copy" ? "auto-copy" : "auto-safe";
  const presentationMode: LibMpvPresentationMode = presentationModes.has(rawPresentationMode as LibMpvPresentationMode)
    ? rawPresentationMode as LibMpvPresentationMode
    : "shared-texture";
  return {
    enabled: environment.SEEING_STONE_MPV_DIAGNOSTICS !== "0"
      && (environment.SEEING_STONE_MPV_DIAGNOSTICS === "1" || Boolean(rawMode) || Boolean(rawPresentationMode)),
    decoderMode,
    requestedDecoderMode,
    hwdec,
    presentationMode,
    logFilePath: join(logDirectory, LIBMPV_DIAGNOSTICS_FILENAME),
    unsupportedReason: unsupportedReason ?? (rawPresentationMode && !presentationModes.has(rawPresentationMode as LibMpvPresentationMode)
      ? `Unknown presentation test mode: ${rawPresentationMode}`
      : null),
  };
}

interface DiagnosticLogLimits {
  maxFileBytes: number;
  maxBufferedBytes: number;
  flushIntervalMilliseconds: number;
}

export class LibMpvDiagnosticLog {
  private pending: string[] = [];
  private bufferedBytes = 0;
  private droppedEvents = 0;
  private fileBytes: number | null = null;
  private writer: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly settings: LibMpvDiagnosticSettings,
    private readonly limits: DiagnosticLogLimits = {
      maxFileBytes: 8 * 1024 * 1024,
      maxBufferedBytes: 512 * 1024,
      flushIntervalMilliseconds: 250,
    },
  ) {}

  write(event: string, details: unknown): void {
    if (!this.settings.enabled) return;
    const line = this.line(event, details);
    const bytes = Buffer.byteLength(line);
    if (this.bufferedBytes + bytes > Math.min(this.limits.maxBufferedBytes, this.limits.maxFileBytes)) {
      // Diagnostics must never build an unbounded queue behind playback.
      this.droppedEvents += 1;
    } else {
      this.pending.push(line);
      this.bufferedBytes += bytes;
    }
    if (this.bufferedBytes >= 64 * 1024) this.startDrain();
    else this.scheduleDrain();
  }

  private line(event: string, details: unknown): string {
    return `${JSON.stringify({
      timestamp: new Date().toISOString(),
      event: redactText(event),
      details: sanitizeLogValue(details),
    })}\n`;
  }

  private scheduleDrain(): void {
    if (this.timer || this.writer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.startDrain();
    }, this.limits.flushIntervalMilliseconds);
    this.timer.unref();
  }

  private startDrain(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.writer || (!this.pending.length && !this.droppedEvents)) return;
    this.writer = this.drain().catch(() => {
      // Logging failure must not block playback; retry directory setup later.
      this.fileBytes = null;
      this.pending = [];
      this.bufferedBytes = 0;
      this.droppedEvents = 0;
    }).finally(() => {
      this.writer = null;
      if (this.pending.length || this.droppedEvents) this.scheduleDrain();
    });
  }

  private async drain(): Promise<void> {
    if (this.fileBytes === null) {
      await mkdir(dirname(this.settings.logFilePath), { recursive: true });
      this.fileBytes = await stat(this.settings.logFilePath).then((info) => info.size, (error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
        return 0;
      });
    }
    while (this.pending.length || this.droppedEvents) {
      let batch = this.pending.join("");
      this.pending = [];
      this.bufferedBytes = 0;
      if (this.droppedEvents) {
        const notice = this.line("diagnostic-events-dropped", { count: this.droppedEvents });
        if (Buffer.byteLength(batch + notice) <= this.limits.maxFileBytes) batch += notice;
        else {
          this.pending.push(notice);
          this.bufferedBytes = Buffer.byteLength(notice);
        }
        this.droppedEvents = 0;
      }
      const bytes = Buffer.byteLength(batch);
      if (this.fileBytes + bytes > this.limits.maxFileBytes) {
        const backup = `${this.settings.logFilePath}.1`;
        await rm(backup, { force: true });
        if (this.fileBytes > this.limits.maxFileBytes) {
          // Discard legacy oversized logs rather than retaining a huge backup.
          await rm(this.settings.logFilePath, { force: true });
        } else if (this.fileBytes > 0) await rename(this.settings.logFilePath, backup);
        this.fileBytes = 0;
      }
      await appendFile(this.settings.logFilePath, batch, "utf8");
      this.fileBytes += bytes;
    }
  }

  async flush(): Promise<void> {
    while (this.writer || this.pending.length || this.droppedEvents) {
      this.startDrain();
      await this.writer;
    }
  }
}
