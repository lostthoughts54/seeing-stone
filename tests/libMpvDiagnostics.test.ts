import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  LibMpvDiagnosticLog,
  resolveLibMpvDiagnosticSettings,
} from "../src/main/services/libMpvDiagnostics";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe("libmpv diagnostic modes", () => {
  it("keeps the production decoder default unless an opt-in mode is requested", () => {
    expect(resolveLibMpvDiagnosticSettings({}, "logs")).toMatchObject({
      enabled: false,
      decoderMode: "current",
      requestedDecoderMode: "current",
      hwdec: "auto-safe",
      presentationMode: "shared-texture",
      unsupportedReason: null,
    });
    expect(resolveLibMpvDiagnosticSettings({ SEEING_STONE_MPV_DECODER_MODE: "software" }, "logs")).toMatchObject({
      enabled: true,
      decoderMode: "software",
      hwdec: "no",
    });
    expect(resolveLibMpvDiagnosticSettings({ SEEING_STONE_MPV_DECODER_MODE: "auto-copy" }, "logs")).toMatchObject({
      enabled: true,
      decoderMode: "auto-copy",
      hwdec: "auto-copy",
    });
  });

  it("adds opt-in presentation test modes without changing the default transport", () => {
    expect(resolveLibMpvDiagnosticSettings({ SEEING_STONE_MPV_PRESENTATION_MODE: "shared-texture" }, "logs")).toMatchObject({
      enabled: true,
      presentationMode: "shared-texture",
      decoderMode: "current",
      hwdec: "auto-safe",
      unsupportedReason: null,
    });
    expect(resolveLibMpvDiagnosticSettings({ SEEING_STONE_MPV_PRESENTATION_MODE: "cpu-readback" }, "logs")).toMatchObject({
      enabled: true,
      presentationMode: "cpu-readback",
      decoderMode: "current",
      hwdec: "auto-safe",
      unsupportedReason: null,
    });
    expect(resolveLibMpvDiagnosticSettings({ SEEING_STONE_MPV_PRESENTATION_MODE: "unknown" }, "logs")).toMatchObject({
      enabled: true,
      presentationMode: "shared-texture",
      unsupportedReason: expect.stringContaining("Unknown presentation test mode"),
    });
  });

  it("reports unavailable NVDEC without silently attempting an unsupported backend", () => {
    expect(resolveLibMpvDiagnosticSettings({ SEEING_STONE_MPV_DECODER_MODE: "nvdec-copy" }, "logs")).toMatchObject({
      enabled: true,
      decoderMode: "current",
      requestedDecoderMode: "nvdec-copy",
      hwdec: "auto-safe",
      unsupportedReason: expect.stringContaining("does not advertise an NVDEC decoder"),
    });
  });

  it("writes opt-in diagnostics as sanitized NDJSON", async () => {
    const directory = await mkdtemp(join(tmpdir(), "seeing-stone-mpv-diagnostics-"));
    temporaryDirectories.push(directory);
    const settings = resolveLibMpvDiagnosticSettings({ SEEING_STONE_MPV_DIAGNOSTICS: "1" }, directory);
    const log = new LibMpvDiagnosticLog(settings);
    log.write("decoder-log", { message: "Authorization: secret-value", videoCodec: "h264" });
    await log.flush();
    const contents = await readFile(settings.logFilePath, "utf8");
    expect(contents).toContain('"videoCodec":"h264"');
    expect(contents).toContain("[REDACTED]");
    expect(contents).not.toContain("secret-value");
  });
});
