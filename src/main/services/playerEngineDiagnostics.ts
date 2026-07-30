import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { PlayerAdapterLaunchStatus } from "./playerAdapterSelection";

export const PLAYER_ENGINE_DIAGNOSTICS_FILENAME = "player-engine-status.json";

export interface PlayerEngineDiagnostics {
  schemaVersion: 1;
  applicationVersion: string;
  internalLibMpvTestBuild: boolean;
  launchSelection: PlayerAdapterLaunchStatus["launchSelection"];
  active: PlayerAdapterLaunchStatus["active"];
  embeddedAvailable: boolean;
  libmpvAvailable: boolean;
  fallbackActive: boolean;
  fallbackFrom: PlayerAdapterLaunchStatus["fallbackFrom"];
  fallbackReason: PlayerAdapterLaunchStatus["fallbackReason"];
  recordedAtUtc: string;
}

/**
 * Persists only finite, sanitized engine status. The file deliberately contains
 * no paths, URLs, headers, tokens, exception text, driver names, or native data.
 */
export async function persistPlayerEngineDiagnostics(
  userDataDirectory: string,
  applicationVersion: string,
  internalLibMpvTestBuild: boolean,
  status: PlayerAdapterLaunchStatus,
): Promise<void> {
  const path = join(userDataDirectory, PLAYER_ENGINE_DIAGNOSTICS_FILENAME);
  const temporaryPath = `${path}.tmp`;
  const value: PlayerEngineDiagnostics = {
    schemaVersion: 1,
    applicationVersion,
    internalLibMpvTestBuild,
    launchSelection: status.launchSelection,
    active: status.active,
    embeddedAvailable: status.embeddedAvailable,
    libmpvAvailable: status.libmpvAvailable,
    fallbackActive: status.fallbackActive,
    fallbackFrom: status.fallbackFrom,
    fallbackReason: status.fallbackReason,
    recordedAtUtc: new Date().toISOString(),
  };
  await mkdir(dirname(path), { recursive: true });
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporaryPath, path);
}
