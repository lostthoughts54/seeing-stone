import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PlayerPreferencesService } from "../src/main/services/playerPreferences";

describe("PlayerPreferencesService", () => {
  it("defaults to maximized and remembers a restored window across restarts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "lf-player-preferences-"));
    const service = new PlayerPreferencesService(directory);
    expect(await service.get()).toEqual({ windowMaximized: true });

    await service.setWindowMaximized(false);
    expect(await new PlayerPreferencesService(directory).get()).toEqual({ windowMaximized: false });
    expect(JSON.parse(await readFile(join(directory, "player-preferences.json"), "utf8"))).toEqual({
      schemaVersion: 1,
      windowMaximized: false,
    });
  });

  it("recovers malformed preferences to the maximized default", async () => {
    const directory = await mkdtemp(join(tmpdir(), "lf-player-preferences-"));
    await writeFile(join(directory, "player-preferences.json"), "not-json");
    const service = new PlayerPreferencesService(directory);
    expect(await service.get()).toEqual({ windowMaximized: true });
    expect(JSON.parse(await readFile(join(directory, "player-preferences.json"), "utf8")).windowMaximized).toBe(true);
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
    expect(persisted).toEqual({ schemaVersion: 1, windowMaximized: false });
    await expect(readFile(join(directory, "player-preferences.json.tmp"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});
