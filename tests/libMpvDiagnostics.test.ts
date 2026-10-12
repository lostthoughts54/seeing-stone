import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
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

  it("allows transport overrides with diagnostic logging explicitly disabled", () => {
    expect(resolveLibMpvDiagnosticSettings({
      SEEING_STONE_MPV_DIAGNOSTICS: "0", SEEING_STONE_MPV_PRESENTATION_MODE: "cpu-readback",
    }, "logs")).toMatchObject({ enabled: false, presentationMode: "cpu-readback" });
  });

  it("bounds the queued events and reports dropped diagnostics", async () => {
    const directory = await mkdtemp(join(tmpdir(), "seeing-stone-mpv-diagnostics-"));
    temporaryDirectories.push(directory);
    const settings = resolveLibMpvDiagnosticSettings({ SEEING_STONE_MPV_DIAGNOSTICS: "1" }, directory);
    const log = new LibMpvDiagnosticLog(settings, {
      maxFileBytes: 4096, maxBufferedBytes: 1024, flushIntervalMilliseconds: 250,
    });
    for (let index = 0; index < 1000; index++) log.write("frame", { index });
    await log.flush();
    const contents = await readFile(settings.logFilePath, "utf8");
    const records = contents.trim().split("\n").map((line) => JSON.parse(line));
    expect(Buffer.byteLength(contents)).toBeLessThan(1400);
    expect(records.length).toBeLessThan(20);
    const dropped = records.find((record) => record.event === "diagnostic-events-dropped");
    expect(dropped.details.count + records.length - 1).toBe(1000);
  });

  it("keeps only bounded current and previous logs, including legacy oversized logs", async () => {
    const directory = await mkdtemp(join(tmpdir(), "seeing-stone-mpv-diagnostics-"));
    temporaryDirectories.push(directory);
    const settings = resolveLibMpvDiagnosticSettings({ SEEING_STONE_MPV_DIAGNOSTICS: "1" }, directory);
    await writeFile(settings.logFilePath, "x".repeat(8192));
    const log = new LibMpvDiagnosticLog(settings, {
      maxFileBytes: 1024, maxBufferedBytes: 1024, flushIntervalMilliseconds: 250,
    });
    for (let index = 0; index < 40; index++) {
      log.write("frame", { index, message: "x".repeat(100) });
      await log.flush();
    }
    expect((await stat(settings.logFilePath)).size).toBeLessThanOrEqual(1024);
    expect((await stat(`${settings.logFilePath}.1`)).size).toBeLessThanOrEqual(1024);
    const contents = await readFile(settings.logFilePath, "utf8");
    expect(contents).toContain('"index":39');
    contents.trim().split("\n").forEach((line) => expect(() => JSON.parse(line)).not.toThrow());
  });

  it("does not block flush when the diagnostic destination cannot be created", async () => {
    const directory = await mkdtemp(join(tmpdir(), "seeing-stone-mpv-diagnostics-"));
    temporaryDirectories.push(directory);
    const blocked = join(directory, "blocked");
    await writeFile(blocked, "file");
    const log = new LibMpvDiagnosticLog(resolveLibMpvDiagnosticSettings({ SEEING_STONE_MPV_DIAGNOSTICS: "1" }, blocked));
    log.write("frame", { sequence: 1 });
    await expect(log.flush()).resolves.toBeUndefined();
    log.write("frame", { sequence: 2 });
    await expect(log.flush()).resolves.toBeUndefined();
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
