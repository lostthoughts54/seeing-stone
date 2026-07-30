import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  persistPlayerEngineDiagnostics,
  PLAYER_ENGINE_DIAGNOSTICS_FILENAME,
} from "../src/main/services/playerEngineDiagnostics";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true,
  })));
});

describe("player engine diagnostics", () => {
  it("persists only finite sanitized launch and fallback state", async () => {
    const directory = await mkdtemp(join(tmpdir(), "seeing-stone-engine-"));
    directories.push(directory);
    await persistPlayerEngineDiagnostics(directory, "0.4.3", true, {
      launchSelection: "libmpv",
      active: "embedded",
      embeddedAvailable: true,
      libmpvAvailable: false,
      fallbackActive: true,
      fallbackFrom: "libmpv",
      fallbackReason: "initialization-failed",
    });

    const value = JSON.parse(await readFile(join(directory, PLAYER_ENGINE_DIAGNOSTICS_FILENAME), "utf8"));
    expect(value).toMatchObject({
      schemaVersion: 1,
      applicationVersion: "0.4.3",
      internalLibMpvTestBuild: true,
      launchSelection: "libmpv",
      active: "embedded",
      fallbackActive: true,
      fallbackReason: "initialization-failed",
    });
    expect(JSON.stringify(value)).not.toMatch(/(?:path|url|token|header|exception|driver)/i);
  });
});
