import type {
  CleanMachineDiagnosticCheck,
  CleanMachineDiagnostics,
  PlaybackState,
  PlayerAdapterFallbackReason,
} from "../../shared/contracts";
import type { LibMpvRuntimeDetection } from "./libMpvRuntime";
import type { PlayerAdapterLaunchStatus } from "./playerAdapterSelection";

export type NativeRuntimeProbeResult =
  | { available: true }
  | {
    available: false;
    reason:
      | "native-addon-unavailable"
      | "native-runtime-load-failed"
      | "required-symbol-missing"
      | "client-abi-incompatible"
      | "native-runtime-initialization-failed";
  };

export interface CleanMachineDiagnosticsOptions {
  applicationVersion: string;
  packaged: boolean;
  internalLibMpvTestBuild: boolean;
  platform: NodeJS.Platform;
  architecture: string;
  electronVersion: string;
  runtime: LibMpvRuntimeDetection;
  adapterStatus: PlayerAdapterLaunchStatus;
  sharedTextureAvailable: boolean;
  getGpuFeatureStatus(): Record<string, string>;
  probeNativeRuntime(): Promise<NativeRuntimeProbeResult> | NativeRuntimeProbeResult;
  getPlaybackState(): PlaybackState;
  now?(): Date;
}

interface DiagnosticNativeAddon {
  probeLibMpvRuntime(options: {
    libraryPath: string;
    expectedClientApiVersion: string;
    iterations: number;
  }): {
    clientApiVersion: string;
    completedIterations: number;
  };
}

export function probeControlledLibMpvRuntime(
  runtime: LibMpvRuntimeDetection,
): NativeRuntimeProbeResult {
  if (!runtime.available || !runtime.artifacts || !runtime.clientApiVersion) {
    return { available: false, reason: "native-addon-unavailable" };
  }
  let addon: DiagnosticNativeAddon;
  try {
    // The path is manifest-controlled and hash-verified by detectLibMpvRuntime.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    addon = require(runtime.artifacts.nativeAddonPath) as DiagnosticNativeAddon;
  } catch {
    return { available: false, reason: "native-addon-unavailable" };
  }
  if (typeof addon.probeLibMpvRuntime !== "function") {
    return { available: false, reason: "native-addon-unavailable" };
  }
  try {
    const result = addon.probeLibMpvRuntime({
      libraryPath: runtime.artifacts.libraryPath,
      expectedClientApiVersion: runtime.clientApiVersion,
      iterations: 1,
    });
    if (result.clientApiVersion !== runtime.clientApiVersion) {
      return { available: false, reason: "client-abi-incompatible" };
    }
    if (result.completedIterations !== 1) {
      return { available: false, reason: "native-runtime-initialization-failed" };
    }
    return { available: true };
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    if (code.includes("LIBMPV_REQUIRED_SYMBOL_MISSING")) {
      return { available: false, reason: "required-symbol-missing" };
    }
    if (code.includes("LIBMPV_CLIENT_ABI_MISMATCH")) {
      return { available: false, reason: "client-abi-incompatible" };
    }
    if (code.includes("LIBMPV_SECURE_LOAD_FAILED")) {
      return { available: false, reason: "native-runtime-load-failed" };
    }
    return { available: false, reason: "native-runtime-initialization-failed" };
  }
}

const fallbackDetails: Record<PlayerAdapterFallbackReason, string> = {
  "manifest-invalid": "The controlled runtime manifest is invalid.",
  "library-not-configured": "A verified libmpv runtime is not configured.",
  "library-missing": "The manifest-named libmpv library is missing.",
  "library-hash-mismatch": "The libmpv library or native addon failed integrity verification.",
  "companion-missing": "A manifest-required runtime DLL is missing.",
  "companion-hash-mismatch": "A manifest-required runtime DLL failed integrity verification.",
  "client-abi-incompatible": "The bundled libmpv client ABI is incompatible with the native bridge.",
  "required-symbol-missing": "The bundled libmpv runtime is missing a required API symbol.",
  "native-addon-unavailable": "Windows could not load the bundled native bridge.",
  "graphics-capability-unavailable": "The required GPU composition path is unavailable.",
  "render-gate-not-passed": "This build has not passed the real-video rendering gate.",
  "controller-integration-unavailable": "This build has not passed the controller integration gate.",
  "initialization-failed": "Libmpv or first-frame presentation failed before playback reporting started.",
  "embedded-initialization-failed": "The embedded fallback also failed and Seeing Stone used the legacy player.",
};

const nativeProbeDetails: Record<Exclude<NativeRuntimeProbeResult, { available: true }>["reason"], string> = {
  "native-addon-unavailable": "Windows could not load the bundled native bridge.",
  "native-runtime-load-failed": "Windows could not securely load libmpv and its required companion DLLs.",
  "required-symbol-missing": "The loaded libmpv runtime is missing a required client or render symbol.",
  "client-abi-incompatible": "The loaded libmpv client ABI does not match the packaged manifest.",
  "native-runtime-initialization-failed": "Libmpv loaded, but a headless client instance could not initialize.",
};

const check = (
  id: CleanMachineDiagnosticCheck["id"],
  label: string,
  status: CleanMachineDiagnosticCheck["status"],
  detail: string,
): CleanMachineDiagnosticCheck => ({ id, label, status, detail });

export class CleanMachineDiagnosticsService {
  constructor(private readonly options: CleanMachineDiagnosticsOptions) {}

  async getSnapshot(): Promise<CleanMachineDiagnostics> {
    const {
      adapterStatus,
      runtime,
    } = this.options;
    const checks: CleanMachineDiagnosticCheck[] = [];

    checks.push(this.options.platform === "win32"
      ? check("windows-platform", "Windows platform", "pass", "The Windows native playback target is in use.")
      : check("windows-platform", "Windows platform", "fail", "The libmpv shared-texture player currently requires Windows."));

    checks.push(this.options.architecture === "x64"
      ? check("x64-architecture", "64-bit architecture", "pass", "The process architecture matches the packaged x64 native runtime.")
      : check("x64-architecture", "64-bit architecture", "fail", "This test runtime requires an x64 Windows process."));

    checks.push(this.options.internalLibMpvTestBuild
      ? check("self-contained-package", "Self-contained test package", "pass", "This internal test build includes its controlled libmpv runtime.")
      : this.options.packaged
        ? check("self-contained-package", "Self-contained test package", "warning", "This is a packaged build, but it is not marked as the internal self-contained libmpv test build.")
        : check("self-contained-package", "Self-contained test package", "warning", "This is a development run rather than a clean-machine package."));

    checks.push(runtime.available
      ? check("runtime-integrity", "Runtime files and hashes", "pass", "The manifest, libmpv library, native addon, and companion DLL hashes are valid.")
      : check(
        "runtime-integrity",
        "Runtime files and hashes",
        "fail",
        fallbackDetails[runtime.reason ?? "initialization-failed"],
      ));

    let nativeProbe: NativeRuntimeProbeResult | null = null;
    if (runtime.available) {
      nativeProbe = await this.options.probeNativeRuntime();
      checks.push(nativeProbe.available
        ? check("native-runtime-load", "Native DLL loading and ABI", "pass", "The native bridge securely loaded libmpv and initialized a headless client.")
        : check("native-runtime-load", "Native DLL loading and ABI", "fail", nativeProbeDetails[nativeProbe.reason]));
    } else {
      checks.push(check("native-runtime-load", "Native DLL loading and ABI", "not-run", "The native probe was skipped because runtime integrity did not pass."));
    }

    checks.push(this.options.sharedTextureAvailable
      ? check("electron-shared-texture", "Electron shared textures", "pass", "This Electron build exposes the required shared-texture API.")
      : check("electron-shared-texture", "Electron shared textures", "fail", "This Electron build does not expose the required shared-texture API."));

    const gpu = this.options.getGpuFeatureStatus();
    const gpuCompositionEnabled = gpu.gpu_compositing === "enabled";
    const webglEnabled = gpu.webgl === "enabled";
    checks.push(gpuCompositionEnabled && webglEnabled
      ? check("gpu-compositing", "GPU composition", "pass", "Electron reports GPU compositing and WebGL as enabled.")
      : check("gpu-compositing", "GPU composition", "fail", "Electron reports GPU compositing or WebGL as unavailable or software-disabled."));

    checks.push(gpu.video_decode === "enabled"
      ? check("hardware-video-decode", "Hardware video decoding", "pass", "Electron reports hardware video decoding as enabled.")
      : check("hardware-video-decode", "Hardware video decoding", "warning", "Hardware video decoding is not enabled; software decoding may still work."));

    checks.push(adapterStatus.fallbackActive
      ? check(
        "engine-selection",
        "Player engine launch",
        "fail",
        fallbackDetails[adapterStatus.fallbackReason ?? "initialization-failed"],
      )
      : adapterStatus.active === "libmpv"
        ? check("engine-selection", "Player engine launch", "pass", "The experimental libmpv engine is active.")
        : check("engine-selection", "Player engine launch", "warning", "Libmpv is available for testing but was not selected when the application started."));

    const playback = this.options.getPlaybackState();
    if (playback.diagnostics?.videoOutput === "libmpv-opengl-angle") {
      checks.push(playback.diagnostics.videoOutputHealthy === false
        ? check("first-frame-presentation", "Real-video presentation", "fail", "The libmpv GPU presenter became unhealthy during playback.")
        : check("first-frame-presentation", "Real-video presentation", "pass", "A real libmpv video session reached the GPU-backed presentation path."));
    } else if (adapterStatus.fallbackActive && adapterStatus.fallbackFrom === "libmpv") {
      checks.push(check("first-frame-presentation", "Real-video presentation", "fail", "Libmpv did not reach a usable first-frame presentation in this process."));
    } else {
      checks.push(check("first-frame-presentation", "Real-video presentation", "not-run", "Play a video with libmpv to verify first-frame presentation on this machine."));
    }

    const overall = checks.some((entry) => entry.status === "fail")
      ? "blocked"
      : checks.some((entry) => entry.status === "warning")
        ? "warning"
        : "ready";

    return {
      schemaVersion: 1,
      generatedAtUtc: (this.options.now?.() ?? new Date()).toISOString(),
      overall,
      applicationVersion: this.options.applicationVersion,
      build: this.options.internalLibMpvTestBuild
        ? "internal-libmpv-test"
        : this.options.packaged ? "packaged" : "development",
      platform: this.options.platform === "win32" ? "windows" : "other",
      architecture: this.options.architecture === "x64" ? "x64" : "other",
      electronVersion: this.options.electronVersion,
      selectedEngine: adapterStatus.launchSelection,
      activeEngine: adapterStatus.active,
      fallbackReason: adapterStatus.fallbackReason,
      checks,
    };
  }
}

export function formatCleanMachineDiagnostics(snapshot: CleanMachineDiagnostics): string {
  const status = snapshot.overall.toUpperCase();
  const lines = [
    "Seeing Stone clean-machine diagnostics",
    `Report schema: ${snapshot.schemaVersion}`,
    `Generated (UTC): ${snapshot.generatedAtUtc}`,
    `Overall: ${status}`,
    `Application: ${snapshot.applicationVersion}`,
    `Build: ${snapshot.build}`,
    `Platform: ${snapshot.platform} ${snapshot.architecture}`,
    `Electron: ${snapshot.electronVersion}`,
    `Selected engine: ${snapshot.selectedEngine}`,
    `Active engine: ${snapshot.activeEngine}`,
    `Fallback reason: ${snapshot.fallbackReason ?? "none"}`,
    "",
    ...snapshot.checks.map((entry) =>
      `[${entry.status.toUpperCase()}] ${entry.label}: ${entry.detail}`),
    "",
    "This report intentionally omits paths, server addresses, account data, tokens, headers, native handles, and driver names.",
  ];
  return `${lines.join("\n")}\n`;
}
