import type { PlayerAdapterMode } from "./playerPreferences";

export function requestedPlayerAdapterMode(
  environmentMode: string | undefined,
  storedMode: PlayerAdapterMode | undefined,
): PlayerAdapterMode {
  if (environmentMode === "embedded" || environmentMode === "legacy") return environmentMode;
  return storedMode ?? "legacy";
}
