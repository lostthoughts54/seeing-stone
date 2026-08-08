import type { PlayerAdapterMode } from "./playerPreferences";
import type { LibMpvCapabilityReason, LibMpvHostCapability } from "./libMpvHost";

export type PlayerAdapterFallbackReason = LibMpvCapabilityReason | "embedded-initialization-failed";

export interface PlayerAdapterLaunchStatus {
  launchSelection: PlayerAdapterMode;
  active: PlayerAdapterMode;
  embeddedAvailable: boolean;
  libmpvAvailable: boolean;
  fallbackActive: boolean;
  fallbackFrom: PlayerAdapterMode | null;
  fallbackReason: PlayerAdapterFallbackReason | null;
}

export function requestedPlayerAdapterMode(
  environmentMode: string | undefined,
  storedMode: PlayerAdapterMode | undefined,
  packagedProduction = false,
): PlayerAdapterMode {
  if (packagedProduction) return "libmpv";
  if (environmentMode === "embedded" || environmentMode === "legacy" || environmentMode === "libmpv") return environmentMode;
  return storedMode ?? "legacy";
}

export function resolvePlayerAdapterLaunch(
  requested: PlayerAdapterMode,
  libmpv: LibMpvHostCapability,
  allowFallback = true,
): PlayerAdapterLaunchStatus {
  if (requested !== "libmpv") {
    return {
      launchSelection: requested,
      active: requested,
      embeddedAvailable: true,
      libmpvAvailable: libmpv.available,
      fallbackActive: false,
      fallbackFrom: null,
      fallbackReason: null,
    };
  }
  if (libmpv.available) {
    return {
      launchSelection: requested,
      active: "libmpv",
      embeddedAvailable: true,
      libmpvAvailable: true,
      fallbackActive: false,
      fallbackFrom: null,
      fallbackReason: null,
    };
  }
  if (!allowFallback) {
    return {
      launchSelection: "libmpv",
      active: "libmpv",
      embeddedAvailable: false,
      libmpvAvailable: false,
      fallbackActive: false,
      fallbackFrom: null,
      fallbackReason: libmpv.reason ?? "initialization-failed",
    };
  }
  return {
    launchSelection: requested,
    active: "embedded",
    embeddedAvailable: true,
    libmpvAvailable: false,
    fallbackActive: true,
    fallbackFrom: "libmpv",
    fallbackReason: libmpv.reason ?? "initialization-failed",
  };
}
