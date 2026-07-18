import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PlayerPreferencesService } from "../src/main/services/playerPreferences";

describe("PlayerPreferencesService", () => {
  it("defaults to maximized and remembers a restored window across restarts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "lf-player-preferences-"));
    const service = new PlayerPreferencesService(directory);
    expect(await service.get()).toEqual({ windowMaximized: true, adapterMode: "legacy" });

    await service.setWindowMaximized(false);
    expect(await new PlayerPreferencesService(directory).get()).toEqual({ windowMaximized: false, adapterMode: "legacy" });
    expect(JSON.parse(await readFile(join(directory, "player-preferences.json"), "utf8"))).toEqual({
      schemaVersion: 3,
      windowMaximized: false,
      adapterMode: "legacy",
      adapterModeExplicit: false,
    });
  });

  it("recovers malformed preferences to the maximized default", async () => {
    const directory = await mkdtemp(join(tmpdir(), "lf-player-preferences-"));
    await writeFile(join(directory, "player-preferences.json"), "not-json");
    const service = new PlayerPreferencesService(directory);
    expect(await service.get()).toEqual({ windowMaximized: true, adapterMode: "legacy" });
    expect(JSON.parse(await readFile(join(directory, "player-preferences.json"), "utf8")).windowMaximized).toBe(true);
  });

  it("allows validated development builds to default to embedded without changing the packaged default", async () => {
    const directory = await mkdtemp(join(tmpdir(), "seeing-stone-player-preferences-development-default-"));
    const service = new PlayerPreferencesService(directory, undefined, "embedded");

    await expect(service.get()).resolves.toEqual({ windowMaximized: true, adapterMode: "embedded" });
    expect(JSON.parse(await readFile(join(directory, "player-preferences.json"), "utf8"))).toEqual({
      schemaVersion: 3,
      windowMaximized: true,
      adapterMode: "embedded",
      adapterModeExplicit: false,
    });

    const legacyDirectory = await mkdtemp(join(tmpdir(), "seeing-stone-player-preferences-development-legacy-"));
    await writeFile(join(legacyDirectory, "player-preferences.json"), JSON.stringify({ schemaVersion: 1, windowMaximized: false }));
    await expect(new PlayerPreferencesService(legacyDirectory, undefined, "embedded").get()).resolves.toEqual({
      windowMaximized: false,
      adapterMode: "embedded",
    });
  });

  it("serializes concurrent updates without leaving a temporary file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "lf-player-preferences-"));
    const service = new PlayerPreferencesService(directory);
    await Promise.all([
      service.setWindowMaximized(false),
      service.setWindowMaximized(true),
      service.setWindowMaximized(false),
    ]);
    const persisted = JSON.parse(await readFile(join(directory, "player-preferences.json"), "utf8"));
    expect(persisted).toEqual({ schemaVersion: 3, windowMaximized: false, adapterMode: "legacy", adapterModeExplicit: false });
    await expect(readFile(join(directory, "player-preferences.json.tmp"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("migrates the legacy preference and persists an embedded developer selection", async () => {
    const directory = await mkdtemp(join(tmpdir(), "lf-player-preferences-"));
    await writeFile(join(directory, "player-preferences.json"), JSON.stringify({ schemaVersion: 1, windowMaximized: false }));
    const service = new PlayerPreferencesService(directory);
    expect(await service.get()).toEqual({ windowMaximized: false, adapterMode: "legacy" });
    await service.setAdapterMode("embedded");
    expect(await new PlayerPreferencesService(directory).get()).toEqual({ windowMaximized: false, adapterMode: "embedded" });
  });

  it("uses SQLite-backed adapter selection as the durable source of truth", async () => {
    const directory = await mkdtemp(join(tmpdir(), "lf-player-preferences-"));
    await writeFile(join(directory, "player-preferences.json"), JSON.stringify({
      schemaVersion: 3,
      windowMaximized: false,
      adapterMode: "legacy",
      adapterModeExplicit: true,
    }));
    let durable: "legacy" | "embedded" | null = "embedded";
    const store = {
      getAdapterMode: async () => durable,
      setAdapterMode: async (mode: "legacy" | "embedded") => { durable = mode; },
    };
    const service = new PlayerPreferencesService(directory, store);
    expect(await service.get()).toEqual({ windowMaximized: false, adapterMode: "embedded" });
    await service.setAdapterMode("legacy");
    expect(durable).toBe("legacy");
  });

  it("migrates the hidden schema-2 default to the current launch default", async () => {
    const directory = await mkdtemp(join(tmpdir(), "seeing-stone-player-preferences-hidden-default-"));
    await writeFile(join(directory, "player-preferences.json"), JSON.stringify({
      schemaVersion: 2,
      windowMaximized: false,
      adapterMode: "legacy",
    }));
    let durable: "legacy" | "embedded" | null = "legacy";
    const store = {
      getAdapterMode: async () => durable,
      setAdapterMode: async (mode: "legacy" | "embedded") => { durable = mode; },
    };

    const service = new PlayerPreferencesService(directory, store, "embedded");
    await expect(service.get()).resolves.toEqual({ windowMaximized: false, adapterMode: "embedded" });
    expect(durable).toBe("legacy");
    expect(JSON.parse(await readFile(join(directory, "player-preferences.json"), "utf8"))).toEqual({
      schemaVersion: 3,
      windowMaximized: false,
      adapterMode: "embedded",
      adapterModeExplicit: false,
    });

    await service.setAdapterMode("legacy");
    expect(durable).toBe("legacy");
    expect(JSON.parse(await readFile(join(directory, "player-preferences.json"), "utf8")).adapterModeExplicit).toBe(true);
  });
});
