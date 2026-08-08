import { dirname } from "node:path";
import { BrowserWindow, type IpcMain, sharedTexture } from "electron";
import { AppError } from "./errors";
import { isStrictlyNewerFrameSequence } from "./libMpvFrameOrder";
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
  presented: "seeing-stone:libmpv-presenter-presented",
  error: "seeing-stone:libmpv-presenter-error",
});

interface NativeFrame {
  slot: number;
  sequence: number;
  width: number;
  height: number;
  timestampMicroseconds: number;
  ntHandle: Buffer;
}

interface NativeStats {
  renderedFrames: number;
  droppedFrames: number;
  outstandingFrames: number;
  poolSize: number;
  unusable: boolean;
}

interface NativeProducer {
  nextFrame(): NativeFrame | null;
  releaseFrame(slot: number, sequence: number): boolean;
  command(values: string[]): void;
  getProperty(name: string): unknown;
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
    hardwareDecoding: boolean;
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
const TEXTURE_RELEASE_TIMEOUT_MS = 5_000;

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
  private surfaceEpoch = 0;
  private pendingOpen: PendingOpen | null = null;
  private lastTransferredSequence = 0;

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

  constructor(
    private readonly window: BrowserWindow,
    private readonly ipcMain: IpcMain,
    private readonly libraryPath: string,
    nativeAddonPath: string,
    expectedClientApiVersion: string,
  ) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    this.addon = require(nativeAddonPath) as NativeAddon;
    if (typeof this.addon.LibMpvVideoProducer !== "function" || typeof this.addon.probeLibMpvRuntime !== "function" || !sharedTexture) {
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
    window.on("restore", () => { this.schedulePump(); });
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
        hardwareDecoding: true,
        startPositionSeconds: Math.max(0, startPositionTicks / 10_000_000),
      });
    } catch {
      this.stopped = true;
      throw new AppError("LIBMPV_INITIALIZATION_FAILED", "The experimental player could not initialize.", 503);
    }
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
      mechanism: "image-bitmap-renderer",
    });
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
      this.awaitingPresentedSequence = null;
      this.presentationTimer = null;
      this.fail("LIBMPV_PRESENTATION_TIMEOUT");
    }, PRESENTATION_ACK_TIMEOUT_MS);
    let imported: ReturnType<typeof sharedTexture.importSharedTexture> | null = null;
    try {
      imported = sharedTexture.importSharedTexture({
        textureInfo: {
          pixelFormat: "bgra",
          codedSize: { width: frame.width, height: frame.height },
          visibleRect: { x: 0, y: 0, width: frame.width, height: frame.height },
          timestamp: frame.timestampMicroseconds,
          handle: { ntHandle: frame.ntHandle },
        },
        allReferencesReleased: () => { producer.releaseFrame(frame!.slot, frame!.sequence); },
      });
      await sharedTexture.sendSharedTexture({
        frame: this.window.webContents.mainFrame,
        importedSharedTexture: imported,
      }, { sequence: frame.sequence, surfaceGeneration: this.surfaceEpoch });
      if (this.generation) {
        this.sink?.frame(this.generation, {
          sequence: frame.sequence,
          width: frame.width,
          height: frame.height,
          timestampMicroseconds: frame.timestampMicroseconds,
        });
      }
    } catch {
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
    if (producer) {
      // Audio must stop independently of renderer responsiveness or shared-
      // texture reference release. Texture cleanup may remain bounded and
      // conservative without allowing orphaned playback to continue.
      try { producer.command(["set", "pause", "yes"]); } catch { /* Best effort before the stronger stop command. */ }
      try { producer.command(["stop"]); } catch { /* Producer destruction remains the final fallback. */ }
      producer.setSuspended(true);
    }
    this.presenterReady = false;
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
      producer.destroy();
    }
    this.generation = null;
    this.lastTransferredSequence = 0;
  }
}
