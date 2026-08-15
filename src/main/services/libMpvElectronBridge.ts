import { dirname } from "node:path";
import { BrowserWindow, type IpcMain, sharedTexture } from "electron";
import { AppError } from "./errors";
import { isStrictlyNewerFrameSequence } from "./libMpvFrameOrder";
import {
  LibMpvDiagnosticLog,
  type LibMpvDiagnosticSettings,
} from "./libMpvDiagnostics";
import {
  SharedTextureSlotLifecycle,
  type SharedTextureSlotLifecycleEvent,
} from "./libMpvSharedTextureLifecycle";
import type {
  LibMpvGeneration,
  LibMpvHostCommand,
  LibMpvHostSource,
  LibMpvHostViewport,
  LibMpvNativeBridge,
  LibMpvNativeSink,
} from "./libMpvHost";

export const LIBMPV_PRESENTER_IPC = Object.freeze({
  listenerReady: "seeing-stone:libmpv-presenter-listener-ready",
  start: "seeing-stone:libmpv-presenter-start",
  ready: "seeing-stone:libmpv-presenter-ready",
  stop: "seeing-stone:libmpv-presenter-stop",
  cpuFrame: "seeing-stone:libmpv-presenter-cpu-frame",
  presented: "seeing-stone:libmpv-presenter-presented",
  recover: "seeing-stone:libmpv-presenter-recover",
  textureLifecycle: "seeing-stone:libmpv-presenter-texture-lifecycle",
  error: "seeing-stone:libmpv-presenter-error",
});

interface NativeFrame {
  slot: number;
  sequence: number;
  width: number;
  height: number;
  timestampMicroseconds: number;
  ntHandle?: Buffer;
  pixels?: Buffer;
  pixelFormat?: "rgba";
  readbackMilliseconds?: number;
}

interface NativeStats {
  renderedFrames: number;
  droppedFrames: number;
  readbackFrames?: number;
  readbackFailures?: number;
  outstandingFrames: number;
  poolSize: number;
  unusable: boolean;
}

interface NativeDiagnosticEvent {
  kind: string;
  prefix?: string;
  level?: string;
  text?: string;
  error?: number;
}

interface NativeProducer {
  nextFrame(): NativeFrame | null;
  releaseFrame(slot: number, sequence: number): boolean;
  command(values: string[]): void;
  getProperty(name: string): unknown;
  drainDiagnostics(): NativeDiagnosticEvent[];
  setSuspended(suspended: boolean): void;
  getStats(): NativeStats;
  destroy(): void;
}

interface NativeAddon {
  probeLibMpvRuntime(options: { libraryPath: string; expectedClientApiVersion: string; iterations: number }): {
    clientApiVersion: string;
    completedIterations: number;
  };
  LibMpvVideoProducer: new (options: {
    libraryPath: string;
    angleDirectory: string;
    sourcePath: string;
    width: number;
    height: number;
    poolSize: number;
    loop: boolean;
    audioEnabled: boolean;
    hardwareDecodingMode: "current" | "software" | "auto-copy";
    diagnosticLogging: boolean;
    cpuReadback: boolean;
    startPositionSeconds: number;
  }) => NativeProducer;
}

interface PendingOpen {
  resolve(): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
  firstFramePresented: boolean;
}

const delay = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));
const PRESENTATION_ACK_TIMEOUT_MS = 5_000;
const PRESENTER_RECOVERY_DEBOUNCE_MS = 150;
const TEXTURE_RELEASE_TIMEOUT_MS = 5_000;
const DIAGNOSTIC_POLL_INTERVAL_MS = 1_000;
const DIAGNOSTIC_COUNTER_INTERVAL = 5;
const diagnosticProperties = [
  "video-codec", "video-codec-name", "video-format", "video-params", "video-dec-params", "video-out-params",
  "container-fps", "estimated-vf-fps", "display-fps", "deinterlace", "hwdec", "hwdec-current", "hwdec-codecs",
  "current-vo", "gpu-api", "gpu-context", "video-sync", "interpolation", "vd-lavc-threads", "vd-lavc-dr",
  "vd-lavc-framedrop", "decoder-frame-drop-count", "frame-drop-count", "vo-drop-frame-count", "mistimed-frame-count",
] as const;

function generationMatches(left: LibMpvGeneration | null, right: LibMpvGeneration): boolean {
  return Boolean(left && left.playback === right.playback && left.surface === right.surface);
}

/**
 * Main-process-only Electron/libmpv transport. Native handles and controlled
 * paths terminate here and are never reachable from contextBridge.
 */
export class ElectronLibMpvBridge implements LibMpvNativeBridge {
  private readonly addon: NativeAddon;
  private sink: LibMpvNativeSink | null = null;
  private producer: NativeProducer | null = null;
  private generation: LibMpvGeneration | null = null;
  private viewport: LibMpvHostViewport = { width: 0, height: 0, visible: false, revision: 0, deviceScaleFactor: 1 };
  private pumpTimer: ReturnType<typeof setTimeout> | null = null;
  private pumping = false;
  private stopped = true;
  private destroyed = false;
  private listenerReady = false;
  private presenterReady = false;
  private awaitingPresentedSequence: number | null = null;
  private presentationTimer: ReturnType<typeof setTimeout> | null = null;
  private presenterRecoveryTimer: ReturnType<typeof setTimeout> | null = null;
  private surfaceEpoch = 0;
  private pendingOpen: PendingOpen | null = null;
  private lastTransferredSequence = 0;
  private awaitingCpuFrameRelease: { slot: number; sequence: number } | null = null;
  private diagnosticsTimer: ReturnType<typeof setInterval> | null = null;
  private diagnosticPollCount = 0;
  private lastDiagnosticSignature = "";
  private readonly diagnosticLog: LibMpvDiagnosticLog | null;
  private readonly sharedTextureSlots: SharedTextureSlotLifecycle;

  private readonly onListenerReady = (event: Electron.IpcMainEvent): void => {
    if (!this.authorized(event)) return;
    this.listenerReady = true;
    if (this.producer && !this.stopped) this.startPresenter();
  };

  private readonly onPresenterReady = (event: Electron.IpcMainEvent, input: unknown): void => {
    if (!this.authorized(event) || !this.matchesSurface(input)) return;
    this.presenterReady = true;
    this.schedulePump();
  };

  private readonly onPresented = (event: Electron.IpcMainEvent, input: unknown): void => {
    if (!this.authorized(event) || !this.matchesSurface(input)) return;
    const record = input as Record<string, unknown>;
    if (!Number.isSafeInteger(record.sequence)) return;
    if (record.sequence !== this.awaitingPresentedSequence) return;
    const presentationMode = this.diagnostics?.presentationMode ?? "shared-texture";
    if (presentationMode === "cpu-readback") this.releasePendingCpuFrame(Number(record.sequence));
    this.diagnosticLog?.write("presentation-complete", {
      presentationMode,
      sequence: Number(record.sequence),
      durationMilliseconds: Number.isFinite(record.durationMilliseconds) ? record.durationMilliseconds : null,
    });
    this.awaitingPresentedSequence = null;
    if (this.presentationTimer) clearTimeout(this.presentationTimer);
    this.presentationTimer = null;
    const firstPresentation = Boolean(this.pendingOpen && !this.pendingOpen.firstFramePresented);
    if (firstPresentation && !this.window.isDestroyed()) this.window.webContents.invalidate();
    if (this.pendingOpen && !this.pendingOpen.firstFramePresented) {
      this.pendingOpen.firstFramePresented = true;
      clearTimeout(this.pendingOpen.timer);
      const pending = this.pendingOpen;
      this.pendingOpen = null;
      pending.resolve();
      this.sink?.event(this.generation!, { kind: "ready" });
    }
    this.schedulePump();
  };

  private readonly onPresenterError = (event: Electron.IpcMainEvent, input: unknown): void => {
    if (!this.authorized(event) || !this.matchesSurface(input)) return;
    this.fail("PRESENTER_INITIALIZATION_FAILED");
  };

  private readonly onPresenterRecover = (event: Electron.IpcMainEvent, input: unknown): void => {
    if (!this.authorized(event) || !this.matchesSurface(input)) return;
    const record = input as Record<string, unknown>;
    this.requestPresenterRecovery(typeof record.reason === "string" ? record.reason : "renderer-request");
  };

  private readonly onTextureLifecycle = (event: Electron.IpcMainEvent, input: unknown): void => {
    if (!this.authorized(event) || !input || typeof input !== "object") return;
    const record = input as Record<string, unknown>;
    const sequence = Number(record.sequence);
    const surfaceGeneration = Number(record.surfaceGeneration);
    const phase = typeof record.phase === "string" ? record.phase : "";
    if (!Number.isSafeInteger(sequence) || !Number.isSafeInteger(surfaceGeneration)) return;
    if (!this.sharedTextureSlots.matches(sequence, surfaceGeneration)) {
      if (!this.stopped) this.textureLifecycleViolation("LIBMPV_TEXTURE_RELEASE_SIGNAL_WITHOUT_MATCHING_SLOT", {
        phase, sequence, surfaceGeneration,
      });
      return;
    }
    this.diagnosticLog?.write(`texture-${phase}`, {
      sequence,
      surfaceGeneration,
      textureId: typeof record.textureId === "string" ? record.textureId : null,
      reason: typeof record.reason === "string" ? record.reason : null,
    });
    if (phase !== "renderer-gpu-release-complete") return;
    try {
      this.sharedTextureSlots.markRendererGpuReleaseComplete(sequence);
    } catch (error) {
      this.textureLifecycleViolation(error instanceof Error ? error.message : String(error), { sequence, surfaceGeneration });
    }
  };

  constructor(
    private readonly window: BrowserWindow,
    private readonly ipcMain: IpcMain,
    private readonly libraryPath: string,
    nativeAddonPath: string,
    expectedClientApiVersion: string,
    private readonly diagnostics?: LibMpvDiagnosticSettings,
  ) {
    this.diagnosticLog = diagnostics?.enabled ? new LibMpvDiagnosticLog(diagnostics) : null;
    this.sharedTextureSlots = new SharedTextureSlotLifecycle((event, state) => {
      this.logSharedTextureSlotLifecycle(event, state);
    });
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    this.addon = require(nativeAddonPath) as NativeAddon;
    if (typeof this.addon.LibMpvVideoProducer !== "function" || typeof this.addon.probeLibMpvRuntime !== "function"
      || ((diagnostics?.presentationMode ?? "shared-texture") === "shared-texture" && !sharedTexture)) {
      throw new AppError("LIBMPV_NATIVE_UNAVAILABLE", "The experimental playback bridge is unavailable.", 503);
    }
    const probe = this.addon.probeLibMpvRuntime({
      libraryPath,
      expectedClientApiVersion,
      iterations: 1,
    });
    if (probe.clientApiVersion !== expectedClientApiVersion || probe.completedIterations !== 1) {
      throw new AppError("LIBMPV_ABI_INCOMPATIBLE", "The experimental playback runtime is incompatible.", 503);
    }
    ipcMain.on(LIBMPV_PRESENTER_IPC.listenerReady, this.onListenerReady);
    ipcMain.on(LIBMPV_PRESENTER_IPC.ready, this.onPresenterReady);
    ipcMain.on(LIBMPV_PRESENTER_IPC.presented, this.onPresented);
    ipcMain.on(LIBMPV_PRESENTER_IPC.recover, this.onPresenterRecover);
    ipcMain.on(LIBMPV_PRESENTER_IPC.textureLifecycle, this.onTextureLifecycle);
    ipcMain.on(LIBMPV_PRESENTER_IPC.error, this.onPresenterError);
    window.webContents.on("did-start-loading", () => {
      this.listenerReady = false;
      this.presenterReady = false;
    });
    window.webContents.on("did-finish-load", () => {
      if (this.producer && !this.stopped && this.listenerReady) this.startPresenter();
    });
    window.on("minimize", () => {
      this.viewport = { ...this.viewport, visible: false };
      this.producer?.setSuspended(true);
    });
    window.on("restore", () => this.requestPresenterRecovery("window-restore"));
    window.on("maximize", () => this.requestPresenterRecovery("window-maximize"));
    window.on("unmaximize", () => this.requestPresenterRecovery("window-unmaximize"));
    window.on("enter-full-screen", () => this.requestPresenterRecovery("window-enter-full-screen"));
    window.on("leave-full-screen", () => this.requestPresenterRecovery("window-leave-full-screen"));
  }

  async initialize(sink: LibMpvNativeSink): Promise<void> {
    if (this.destroyed) throw new AppError("LIBMPV_HOST_DESTROYED", "The experimental player host was closed.", 409);
    this.sink = sink;
  }

  async open(source: LibMpvHostSource, startPositionTicks: number, generation: LibMpvGeneration): Promise<void> {
    if (this.destroyed || !this.sink) throw new AppError("LIBMPV_UNAVAILABLE", "The experimental player is unavailable.", 503);
    await this.stopCurrent();
    this.generation = { ...generation };
    this.stopped = false;
    this.presenterReady = false;
    this.lastTransferredSequence = 0;
    try {
      this.producer = new this.addon.LibMpvVideoProducer({
        libraryPath: this.libraryPath,
        angleDirectory: dirname(process.execPath),
        sourcePath: source.location,
        width: 1920,
        height: 1080,
        poolSize: 3,
        loop: false,
        audioEnabled: true,
        hardwareDecodingMode: this.diagnostics?.decoderMode ?? "current",
        diagnosticLogging: this.diagnostics?.enabled ?? false,
        cpuReadback: this.diagnostics?.presentationMode === "cpu-readback",
        startPositionSeconds: Math.max(0, startPositionTicks / 10_000_000),
      });
    } catch {
      this.stopped = true;
      throw new AppError("LIBMPV_INITIALIZATION_FAILED", "The experimental player could not initialize.", 503);
    }
    this.startDiagnostics();
    const firstFrame = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pendingOpen?.timer !== timer) return;
        this.pendingOpen = null;
        reject(new AppError("LIBMPV_FIRST_FRAME_TIMEOUT", "The experimental player did not present its first frame.", 503));
      }, Math.max(1_000, Math.min(30_000, source.startupTimeoutMilliseconds ?? 10_000)));
      this.pendingOpen = { resolve, reject, timer, firstFramePresented: false };
    });
    if (this.listenerReady) this.startPresenter();
    await firstFrame.catch(async (error) => {
      await this.stopCurrent();
      throw error;
    });
  }

  async command(command: LibMpvHostCommand, generation: LibMpvGeneration): Promise<void> {
    const producer = this.currentProducer(generation);
    const values = (() => {
      switch (command.kind) {
        case "play": return ["set", "pause", "no"];
        case "pause": return ["set", "pause", "yes"];
        case "seek": return ["seek", String(command.positionTicks / 10_000_000), "absolute+exact"];
        case "rate": return ["set", "speed", String(command.rate)];
        case "volume": return ["set", "volume", String(command.volume)];
        case "select-audio": return ["set", "aid", command.trackId === null ? "no" : String(command.trackId)];
        case "select-subtitle": return ["set", "sid", command.trackId === null ? "no" : String(command.trackId)];
        case "add-subtitle": return ["sub-add", command.location, command.select ? "select" : "auto", command.title, command.language];
        case "load": return ["loadfile", command.source.location, "replace"];
        case "show-message": return ["show-text", command.message, String(command.durationMilliseconds)];
      }
    })();
    producer.command(values);
  }

  async query(property: string, generation: LibMpvGeneration): Promise<unknown> {
    if (!/^[a-z0-9-]{1,128}$/.test(property)) return null;
    if (property === "fullscreen") return this.window.isFullScreen();
    if (property === "window-maximized") return this.window.isMaximized();
    if (property === "seeing-stone-frame-stats") return this.currentProducer(generation).getStats();
    return this.currentProducer(generation).getProperty(property);
  }

  updateViewport(viewport: LibMpvHostViewport, generation?: LibMpvGeneration): void {
    if (generation && !generationMatches(this.generation, generation)) return;
    this.viewport = {
      ...viewport,
      width: Math.max(0, viewport.width),
      height: Math.max(0, viewport.height),
      deviceScaleFactor: Math.max(0.5, Math.min(4, viewport.deviceScaleFactor)),
    };
    this.producer?.setSuspended(!this.viewport.visible);
    if (this.viewport.visible) this.schedulePump();
  }

  async stop(generation: LibMpvGeneration): Promise<void> {
    if (!generationMatches(this.generation, generation)) return;
    await this.stopCurrent();
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    await this.stopCurrent();
    this.sink = null;
    this.ipcMain.removeListener(LIBMPV_PRESENTER_IPC.listenerReady, this.onListenerReady);
    this.ipcMain.removeListener(LIBMPV_PRESENTER_IPC.ready, this.onPresenterReady);
    this.ipcMain.removeListener(LIBMPV_PRESENTER_IPC.presented, this.onPresented);
    this.ipcMain.removeListener(LIBMPV_PRESENTER_IPC.recover, this.onPresenterRecover);
    this.ipcMain.removeListener(LIBMPV_PRESENTER_IPC.textureLifecycle, this.onTextureLifecycle);
    this.ipcMain.removeListener(LIBMPV_PRESENTER_IPC.error, this.onPresenterError);
  }

  private authorized(event: Electron.IpcMainEvent): boolean {
    return !this.window.isDestroyed() && event.sender === this.window.webContents && event.senderFrame === event.sender.mainFrame;
  }

  private matchesSurface(input: unknown): boolean {
    if (!input || typeof input !== "object") return false;
    return (input as Record<string, unknown>).surfaceGeneration === this.surfaceEpoch;
  }

  private currentProducer(generation: LibMpvGeneration): NativeProducer {
    if (this.stopped || !generationMatches(this.generation, generation) || !this.producer) {
      throw new AppError("PLAYBACK_CANCELLED", "Playback was cancelled.", 409);
    }
    return this.producer;
  }

  private startPresenter(): void {
    if (!this.producer || this.stopped || this.window.isDestroyed()) return;
    this.presenterReady = false;
    this.awaitingPresentedSequence = null;
    if (this.presentationTimer) clearTimeout(this.presentationTimer);
    this.presentationTimer = null;
    this.surfaceEpoch += 1;
    this.window.webContents.send(LIBMPV_PRESENTER_IPC.start, {
      surfaceGeneration: this.surfaceEpoch,
      mechanism: this.diagnostics?.presentationMode === "cpu-readback" ? "cpu-readback-canvas" : "image-bitmap-renderer",
      textureLifecycleLogging: Boolean(this.diagnosticLog),
    });
  }

  private requestPresenterRecovery(reason: string): void {
    if (!this.producer || this.stopped || this.destroyed || this.window.isDestroyed() || !this.listenerReady) return;
    // Stop feeding the stale surface immediately. The producer (and therefore
    // audio) remains alive while preload releases the old canvas textures and
    // acknowledges a fresh pair of presentation canvases.
    this.presenterReady = false;
    if (this.presenterRecoveryTimer) clearTimeout(this.presenterRecoveryTimer);
    this.presenterRecoveryTimer = setTimeout(() => {
      this.presenterRecoveryTimer = null;
      if (!this.producer || this.stopped || this.destroyed || this.window.isDestroyed() || !this.listenerReady) return;
      this.diagnosticLog?.write("presenter-recovery", { reason, surfaceGeneration: this.surfaceEpoch });
      this.releasePendingCpuFrame(this.awaitingPresentedSequence ?? -1);
      this.startPresenter();
      this.window.webContents.invalidate();
    }, PRESENTER_RECOVERY_DEBOUNCE_MS);
  }

  private schedulePump(): void {
    if (this.stopped || this.destroyed || !this.presenterReady || !this.viewport.visible
      || this.awaitingPresentedSequence !== null || this.pumpTimer) return;
    this.pumpTimer = setTimeout(() => {
      this.pumpTimer = null;
      void this.pumpOne();
    }, 16);
  }

  private async pumpOne(): Promise<void> {
    if (this.pumping || this.stopped || !this.presenterReady || !this.viewport.visible || !this.producer || this.window.isDestroyed()) {
      this.schedulePump();
      return;
    }
    const producer = this.producer;
    const surfaceGeneration = this.surfaceEpoch;
    let frame: NativeFrame | null = null;
    try {
      frame = producer.nextFrame();
    } catch {
      this.fail("LIBMPV_RENDER_FAILED");
      return;
    }
    if (!frame) {
      this.schedulePump();
      return;
    }
    if (!isStrictlyNewerFrameSequence(this.lastTransferredSequence, frame.sequence)) {
      producer.releaseFrame(frame.slot, frame.sequence);
      this.schedulePump();
      return;
    }
    this.lastTransferredSequence = frame.sequence;
    this.pumping = true;
    this.awaitingPresentedSequence = frame.sequence;
    this.presentationTimer = setTimeout(() => {
      if (this.awaitingPresentedSequence !== frame!.sequence) return;
      this.releasePendingCpuFrame(frame!.sequence);
      this.awaitingPresentedSequence = null;
      this.presentationTimer = null;
      this.requestPresenterRecovery("presentation-ack-timeout");
    }, PRESENTATION_ACK_TIMEOUT_MS);
    this.diagnosticLog?.write("frame-render-complete", {
      presentationMode: this.diagnostics?.presentationMode ?? "shared-texture",
      sequence: frame.sequence,
      slot: frame.slot,
      width: frame.width,
      height: frame.height,
      timestampMicroseconds: frame.timestampMicroseconds,
    });
    if (this.diagnostics?.presentationMode === "cpu-readback") {
      await this.sendCpuReadbackFrame(producer, frame);
      return;
    }
    let imported: ReturnType<typeof sharedTexture.importSharedTexture> | null = null;
    try {
      if (!frame.ntHandle) throw new Error("LIBMPV_SHARED_TEXTURE_HANDLE_MISSING");
      this.sharedTextureSlots.claim({
        slot: frame.slot,
        sequence: frame.sequence,
        surfaceGeneration,
        releaseNative: () => producer.releaseFrame(frame!.slot, frame!.sequence),
      });
      imported = sharedTexture.importSharedTexture({
        textureInfo: {
          pixelFormat: "bgra",
          codedSize: { width: frame.width, height: frame.height },
          visibleRect: { x: 0, y: 0, width: frame.width, height: frame.height },
          timestamp: frame.timestampMicroseconds,
          handle: { ntHandle: frame.ntHandle },
        },
        allReferencesReleased: () => {
          this.diagnosticLog?.write("texture-electron-all-references-released", {
            sequence: frame!.sequence,
            slot: frame!.slot,
          });
          try {
            if (!this.sharedTextureSlots.has(frame!.sequence)) return;
            this.sharedTextureSlots.markAllReferencesReleased(frame!.sequence);
          } catch (error) {
            this.textureLifecycleViolation(error instanceof Error ? error.message : String(error), {
              sequence: frame!.sequence,
              slot: frame!.slot,
            });
          }
        },
      });
      this.diagnosticLog?.write("texture-import", {
        sequence: frame.sequence,
        slot: frame.slot,
        textureId: imported.textureId,
        pixelFormat: "bgra",
      });
      this.diagnosticLog?.write("texture-send-start", {
        sequence: frame.sequence,
        slot: frame.slot,
        textureId: imported.textureId,
      });
      await sharedTexture.sendSharedTexture({
        frame: this.window.webContents.mainFrame,
        importedSharedTexture: imported,
      }, { sequence: frame.sequence, surfaceGeneration });
      this.diagnosticLog?.write("texture-send-complete", {
        sequence: frame.sequence,
        slot: frame.slot,
        textureId: imported.textureId,
      });
      this.diagnosticLog?.write("ipc-delivery", {
        presentationMode: "shared-texture",
        sequence: frame.sequence,
        transport: "Electron sharedTexture",
      });
      if (this.generation) {
        this.sink?.frame(this.generation, {
          sequence: frame.sequence,
          width: frame.width,
          height: frame.height,
          timestampMicroseconds: frame.timestampMicroseconds,
        });
      }
    } catch (error) {
      if (!imported && frame && this.sharedTextureSlots.has(frame.sequence)) {
        try { this.sharedTextureSlots.abandonUnimported(frame.sequence); } catch (releaseError) {
          this.textureLifecycleViolation(releaseError instanceof Error ? releaseError.message : String(releaseError), {
            sequence: frame.sequence,
            slot: frame.slot,
          });
        }
      }
      this.diagnosticLog?.write("texture-transfer-failed", {
        sequence: frame?.sequence ?? null,
        slot: frame?.slot ?? null,
        error: error instanceof Error ? error.message : String(error),
      });
      this.awaitingPresentedSequence = null;
      if (this.presentationTimer) clearTimeout(this.presentationTimer);
      this.presentationTimer = null;
      this.fail("LIBMPV_TEXTURE_TRANSFER_FAILED");
    } finally {
      imported?.release();
      this.pumping = false;
      this.schedulePump();
    }
  }

  private async sendCpuReadbackFrame(producer: NativeProducer, frame: NativeFrame): Promise<void> {
    this.awaitingCpuFrameRelease = { slot: frame.slot, sequence: frame.sequence };
    try {
      if (!frame.pixels || frame.pixelFormat !== "rgba") throw new Error("LIBMPV_CPU_READBACK_FRAME_INVALID");
      this.diagnosticLog?.write("readback-complete", {
        sequence: frame.sequence,
        slot: frame.slot,
        pixelFormat: "rgba",
        bytes: frame.pixels.byteLength,
        readbackMilliseconds: frame.readbackMilliseconds ?? null,
      });
      this.window.webContents.send(LIBMPV_PRESENTER_IPC.cpuFrame, {
        surfaceGeneration: this.surfaceEpoch,
        sequence: frame.sequence,
        width: frame.width,
        height: frame.height,
        timestampMicroseconds: frame.timestampMicroseconds,
        pixelFormat: "rgba",
        pixels: frame.pixels,
      });
      this.diagnosticLog?.write("ipc-delivery", {
        presentationMode: "cpu-readback",
        sequence: frame.sequence,
        bytes: frame.pixels.byteLength,
        transport: "ipcRenderer event",
      });
      if (this.generation) {
        this.sink?.frame(this.generation, {
          sequence: frame.sequence,
          width: frame.width,
          height: frame.height,
          timestampMicroseconds: frame.timestampMicroseconds,
        });
      }
    } catch {
      this.releasePendingCpuFrame(frame.sequence);
      this.awaitingPresentedSequence = null;
      if (this.presentationTimer) clearTimeout(this.presentationTimer);
      this.presentationTimer = null;
      this.fail("LIBMPV_CPU_FRAME_TRANSFER_FAILED");
    } finally {
      this.pumping = false;
      this.schedulePump();
    }
  }

  private startDiagnostics(): void {
    this.stopDiagnostics();
    if (!this.diagnosticLog || !this.diagnostics || !this.producer) return;
    this.diagnosticPollCount = 0;
    this.lastDiagnosticSignature = "";
    this.diagnosticLog.write("session-config", {
      requestedDecoderMode: this.diagnostics.requestedDecoderMode,
      activeDecoderTestMode: this.diagnostics.decoderMode,
      configuredHwdec: this.diagnostics.hwdec,
      presentationMode: this.diagnostics.presentationMode,
      unsupportedReason: this.diagnostics.unsupportedReason,
      playbackEngine: "libmpv",
      videoOutput: "libmpv render API",
      renderApi: "OpenGL",
      gpuApi: "OpenGL ES 2",
      gpuContext: "ANGLE D3D11",
      frameTransport: this.diagnostics.presentationMode === "cpu-readback"
        ? "fixed 1920x1080 GL_RGBA/GL_UNSIGNED_BYTE CPU readback over IPC"
        : "fixed 1920x1080 BGRA shared textures",
      texturePoolSize: 3,
      presenter: this.diagnostics.presentationMode === "cpu-readback"
        ? "IPC Uint8Array to ImageData on a 2D canvas"
        : "Electron sharedTexture to ImageBitmapRenderingContext",
      videoSync: "audio",
      interpolation: false,
      deinterlace: false,
      hwdecCodecs: "h264,vc1,hevc,vp8,vp9,av1,prores,prores_raw,ffv1,dpx",
      vdLavc: { threads: 0, directRendering: "auto", framedrop: "nonref" },
      mpvD3d11VideoOutputOptions: "not active; vo=libmpv uses the external ANGLE/OpenGL render context",
      vulkan: "disabled in the controlled mpv build",
      nvdec: "not advertised by the controlled mpv/FFmpeg build",
    });
    this.collectDiagnostics();
    this.diagnosticsTimer = setInterval(() => this.collectDiagnostics(), DIAGNOSTIC_POLL_INTERVAL_MS);
  }

  private stopDiagnostics(): void {
    if (this.diagnosticsTimer) clearInterval(this.diagnosticsTimer);
    this.diagnosticsTimer = null;
    this.diagnosticPollCount = 0;
    this.lastDiagnosticSignature = "";
  }

  private collectDiagnostics(): void {
    const producer = this.producer;
    if (!producer || !this.diagnosticLog) return;
    const properties = Object.fromEntries(diagnosticProperties.map((name) => {
      try { return [name, producer.getProperty(name)]; } catch { return [name, null]; }
    }));
    let events: NativeDiagnosticEvent[] = [];
    try { events = producer.drainDiagnostics(); } catch { /* Diagnostic collection must not disturb playback. */ }
    for (const event of events) this.diagnosticLog.write(event.kind, event);
    let stats: NativeStats | null = null;
    try { stats = producer.getStats(); } catch { /* The next poll will retry. */ }
    const configuration = {
      videoCodec: properties["video-codec"],
      videoCodecName: properties["video-codec-name"],
      videoFormat: properties["video-format"],
      videoParams: properties["video-params"],
      decoderParams: properties["video-dec-params"],
      outputParams: properties["video-out-params"],
      containerFps: properties["container-fps"],
      estimatedFps: properties["estimated-vf-fps"],
      displayFps: properties["display-fps"],
      deinterlace: properties.deinterlace,
      configuredHwdec: properties.hwdec,
      activeHwdec: properties["hwdec-current"],
      hwdecCodecs: properties["hwdec-codecs"],
      activeVo: properties["current-vo"],
      gpuApi: properties["gpu-api"],
      gpuContext: properties["gpu-context"],
      videoSync: properties["video-sync"],
      interpolation: properties.interpolation,
      vdLavcThreads: properties["vd-lavc-threads"],
      vdLavcDirectRendering: properties["vd-lavc-dr"],
      vdLavcFramedrop: properties["vd-lavc-framedrop"],
    };
    const signature = JSON.stringify(configuration);
    if (signature !== this.lastDiagnosticSignature) {
      this.lastDiagnosticSignature = signature;
      this.diagnosticLog.write("video-state-change", configuration);
    }
    this.diagnosticPollCount += 1;
    if (this.diagnosticPollCount % DIAGNOSTIC_COUNTER_INTERVAL === 0) {
      this.diagnosticLog.write("frame-counters", {
        decoderDroppedFrames: properties["decoder-frame-drop-count"],
        frameDropCount: properties["frame-drop-count"],
        videoOutputDroppedFrames: properties["vo-drop-frame-count"],
        mistimedFrames: properties["mistimed-frame-count"],
        sharedTextureTransport: stats,
      });
    }
  }

  private releasePendingCpuFrame(sequence: number): void {
    const pending = this.awaitingCpuFrameRelease;
    if (!pending || pending.sequence !== sequence) return;
    this.awaitingCpuFrameRelease = null;
    try { this.producer?.releaseFrame(pending.slot, pending.sequence); } catch { /* Release is best-effort during shutdown. */ }
  }

  private logSharedTextureSlotLifecycle(
    event: SharedTextureSlotLifecycleEvent,
    state: { slot: number; sequence: number; surfaceGeneration: number; allReferencesReleased: boolean; rendererGpuReleaseComplete: boolean },
  ): void {
    this.diagnosticLog?.write(`texture-${event}`, {
      slot: state.slot,
      sequence: state.sequence,
      surfaceGeneration: state.surfaceGeneration,
      allReferencesReleased: state.allReferencesReleased,
      rendererGpuReleaseComplete: state.rendererGpuReleaseComplete,
    });
  }

  private textureLifecycleViolation(code: string, details: Record<string, unknown>): void {
    this.diagnosticLog?.write("texture-lifecycle-violation", { code, ...details });
    console.error(`[Seeing Stone] ${code}`, details);
    this.fail("LIBMPV_TEXTURE_LIFETIME_VIOLATION");
  }

  private fail(code: string): void {
    const generation = this.generation;
    if (!generation || this.stopped) return;
    if (this.pendingOpen) {
      clearTimeout(this.pendingOpen.timer);
      const pending = this.pendingOpen;
      this.pendingOpen = null;
      pending.reject(new AppError(code, "The experimental player could not present video.", 503));
    } else {
      this.sink?.event(generation, { kind: "error", code });
    }
  }

  private async stopCurrent(): Promise<void> {
    this.stopped = true;
    const producer = this.producer;
    if (producer && this.diagnosticLog) {
      this.collectDiagnostics();
      let finalStats: NativeStats | null = null;
      try { finalStats = producer.getStats(); } catch { /* Best-effort final diagnostic snapshot. */ }
      this.diagnosticLog.write("session-stop", { sharedTextureTransport: finalStats });
    }
    this.stopDiagnostics();
    if (producer) {
      // Audio must stop independently of renderer responsiveness or shared-
      // texture reference release. Texture cleanup may remain bounded and
      // conservative without allowing orphaned playback to continue.
      try { producer.command(["set", "pause", "yes"]); } catch { /* Best effort before the stronger stop command. */ }
      try { producer.command(["stop"]); } catch { /* Producer destruction remains the final fallback. */ }
      producer.setSuspended(true);
    }
    this.presenterReady = false;
    if (this.presenterRecoveryTimer) clearTimeout(this.presenterRecoveryTimer);
    this.presenterRecoveryTimer = null;
    if (this.awaitingCpuFrameRelease) this.releasePendingCpuFrame(this.awaitingCpuFrameRelease.sequence);
    this.awaitingPresentedSequence = null;
    if (this.presentationTimer) clearTimeout(this.presentationTimer);
    this.presentationTimer = null;
    if (this.pumpTimer) clearTimeout(this.pumpTimer);
    this.pumpTimer = null;
    if (this.pendingOpen) {
      clearTimeout(this.pendingOpen.timer);
      const pending = this.pendingOpen;
      this.pendingOpen = null;
      pending.reject(new AppError("PLAYBACK_CANCELLED", "Playback was cancelled.", 409));
    }
    if (!this.window.isDestroyed()) this.window.webContents.send(LIBMPV_PRESENTER_IPC.stop);
    this.producer = null;
    if (producer) {
      const deadline = Date.now() + TEXTURE_RELEASE_TIMEOUT_MS;
      while (producer.getStats().outstandingFrames > 0 && Date.now() < deadline) await delay(25);
      const outstandingFrames = producer.getStats().outstandingFrames;
      if (outstandingFrames > 0 || this.sharedTextureSlots.pendingCount > 0) {
        this.diagnosticLog?.write("texture-release-timeout", {
          outstandingFrames,
          trackedSlots: this.sharedTextureSlots.pendingCount,
        });
      }
      producer.destroy();
    }
    this.sharedTextureSlots.discardAll();
    this.generation = null;
    this.lastTransferredSequence = 0;
    await this.diagnosticLog?.flush();
  }
}
