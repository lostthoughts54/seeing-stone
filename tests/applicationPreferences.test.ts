import { describe, expect, it, vi } from "vitest";
import { ApplicationPreferencesService } from "../src/main/services/applicationPreferences";
import type { ApplicationPreferenceKey, ApplicationPreferenceRecord } from "../src/main/services/persistenceTypes";

function store(initial: Partial<Record<ApplicationPreferenceKey, unknown>> = {}) {
  const records = new Map<ApplicationPreferenceKey, ApplicationPreferenceRecord>();
  for (const [key, value] of Object.entries(initial) as Array<[ApplicationPreferenceKey, unknown]>) {
    records.set(key, { key, valueJson: JSON.stringify(value), updatedAt: 1 });
  }
  return {
    records,
    getApplicationPreference: vi.fn(async (key: ApplicationPreferenceKey) => records.get(key) ?? null),
    setApplicationPreference: vi.fn(async (key: ApplicationPreferenceKey, value: unknown) => {
      const record = { key, valueJson: JSON.stringify(value), updatedAt: 2 };
      records.set(key, record);
      return record;
    }),
  };
}

describe("ApplicationPreferencesService", () => {
  it("defaults to the guarded adapter and wait-for-all buffering policy", async () => {
    const persistence = store();
    const preferences = new ApplicationPreferencesService(persistence as never);
    expect(await preferences.getAdapterMode()).toBeNull();
    expect(await preferences.getBufferingPolicy()).toBe("wait-for-all");
    expect(await preferences.getWatchPartySyncOffset()).toBe(0);
    expect(await preferences.getCachedDiagnostics()).toBeNull();
  });

  it("persists only validated adapter and buffering policy values", async () => {
    const persistence = store();
    const preferences = new ApplicationPreferencesService(persistence as never);
    await preferences.setAdapterMode("embedded");
    await preferences.setBufferingPolicy("continue");
    await preferences.setWatchPartySyncOffset(-300);

    expect(await preferences.getAdapterMode()).toBe("embedded");
    expect(await preferences.getBufferingPolicy()).toBe("continue");
    expect(await preferences.getWatchPartySyncOffset()).toBe(-300);
    expect(persistence.setApplicationPreference).toHaveBeenCalledWith("player.adapter-mode", { mode: "embedded" });
    expect(persistence.setApplicationPreference).toHaveBeenCalledWith("watchparty.buffering-policy", { mode: "continue" });
    expect(persistence.setApplicationPreference).toHaveBeenCalledWith("watchparty.sync-offset", { offsetMilliseconds: -300 });
  });

  it("rejects malformed cached diagnostics and round-trips sanitized values", async () => {
    const persistence = store({ "player.cached-diagnostics": { itemId: "episode", path: "C:\\private\\video.mkv" } });
    const preferences = new ApplicationPreferencesService(persistence as never);
    expect(await preferences.getCachedDiagnostics()).toBeNull();

    const safe = {
      itemId: "episode",
      diagnostics: {
        sourceKind: "offline-local" as const,
        playbackRate: 1,
        bufferAheadTicks: null,
        container: "mkv",
        videoCodec: "h264",
        audioCodec: "aac",
        audioChannels: "2.0",
        resolution: "1920x1080",
        bitrate: 8_000_000,
        videoRange: "SDR",
        transcodeReason: null,
      },
    };
    await preferences.setCachedDiagnostics(safe);
    expect(await preferences.getCachedDiagnostics()).toEqual(safe);
    expect(persistence.records.get("player.cached-diagnostics")?.valueJson).not.toMatch(/path|token|url/i);
  });

  it("fails closed to defaults when stored JSON is unknown or corrupt", async () => {
    const persistence = store({
      "player.adapter-mode": { mode: "future-engine" },
      "watchparty.buffering-policy": { mode: "invent-status" },
    });
    persistence.records.set("player.cached-diagnostics", {
      key: "player.cached-diagnostics",
      valueJson: "not-json",
      updatedAt: 1,
    });
    const preferences = new ApplicationPreferencesService(persistence as never);
    expect(await preferences.getAdapterMode()).toBeNull();
    expect(await preferences.getBufferingPolicy()).toBe("wait-for-all");
    expect(await preferences.getCachedDiagnostics()).toBeNull();
  });
});
