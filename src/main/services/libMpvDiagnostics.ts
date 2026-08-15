import { appendFile, mkdir } from "node:fs/promises";
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
    enabled: environment.SEEING_STONE_MPV_DIAGNOSTICS === "1" || Boolean(rawMode) || Boolean(rawPresentationMode),
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

export class LibMpvDiagnosticLog {
  private writes = Promise.resolve();

  constructor(private readonly settings: LibMpvDiagnosticSettings) {}

  write(event: string, details: unknown): void {
    if (!this.settings.enabled) return;
    const line = `${JSON.stringify({
      timestamp: new Date().toISOString(),
      event: redactText(event),
      details: sanitizeLogValue(details),
    })}\n`;
    this.writes = this.writes
      .then(async () => {
        await mkdir(dirname(this.settings.logFilePath), { recursive: true });
        await appendFile(this.settings.logFilePath, line, "utf8");
      })
      .catch(() => undefined);
  }

  async flush(): Promise<void> {
    await this.writes;
  }
}
