import { AppError } from "./errors";

export type LibMpvCapabilityReason =
  | "manifest-invalid"
  | "library-not-configured"
  | "library-missing"
  | "library-hash-mismatch"
  | "companion-missing"
  | "companion-hash-mismatch"
  | "client-abi-incompatible"
  | "required-symbol-missing"
  | "native-addon-unavailable"
  | "graphics-capability-unavailable"
  | "render-gate-not-passed"
  | "controller-integration-unavailable"
  | "initialization-failed";

export interface LibMpvHostCapability {
  available: boolean;
  reason: LibMpvCapabilityReason | null;
  clientApiVersion: string | null;
  renderApi: "opengl-angle" | null;
}

export interface LibMpvHostViewport {
  width: number;
  height: number;
  visible: boolean;
  deviceScaleFactor: number;
  revision: number;
}

export type LibMpvHostCommand =
  | { kind: "play" }
  | { kind: "pause" }
  | { kind: "seek"; positionTicks: number }
  | { kind: "rate"; rate: number }
  | { kind: "volume"; volume: number }
  | { kind: "select-audio"; trackId: number | null }
  | { kind: "select-subtitle"; trackId: number | null }
  | { kind: "add-subtitle"; location: string; select: boolean; title: string; language: string }
  | { kind: "load"; source: LibMpvHostSource }
  | { kind: "show-message"; message: string; durationMilliseconds: number };

export type LibMpvHostEvent =
  | { kind: "ready" }
  | { kind: "state"; property: string; value: string | number | boolean | null }
  | { kind: "end"; reason: "eof" | "stop" | "error" }
  | { kind: "error"; code: string };

export interface LibMpvHostFrame {
  sequence: number;
  width: number;
  height: number;
  timestampMicroseconds: number;
}

/** Main-process-only. This value must never be serialized to renderer IPC. */
export interface LibMpvHostSource {
  location: string;
  httpHeaders?: Readonly<Record<string, string>>;
}

export interface LibMpvGeneration {
  playback: number;
  surface: number;
}

export interface LibMpvNativeSink {
  event(generation: LibMpvGeneration, event: LibMpvHostEvent): void;
  frame(generation: LibMpvGeneration, frame: LibMpvHostFrame): void;
}

export interface LibMpvNativeBridge {
  initialize(sink: LibMpvNativeSink): Promise<void>;
  open(source: LibMpvHostSource, startPositionTicks: number, generation: LibMpvGeneration): Promise<void>;
  command(command: LibMpvHostCommand, generation: LibMpvGeneration): Promise<void>;
  query(property: string, generation: LibMpvGeneration): Promise<unknown>;
  updateViewport(viewport: LibMpvHostViewport, generation: LibMpvGeneration): void;
  stop(generation: LibMpvGeneration): Promise<void>;
  destroy(): Promise<void>;
}

export interface LibMpvSession {
  readonly generation: LibMpvGeneration;
  command(command: LibMpvHostCommand): Promise<void>;
  query(property: string): Promise<unknown>;
  updateViewport(viewport: LibMpvHostViewport): void;
  stop(): Promise<void>;
}

const copyGeneration = (generation: LibMpvGeneration): LibMpvGeneration => ({ ...generation });

/**
 * Owns the replaceable native boundary. It intentionally contains no Electron,
 * Jellyfin, reporting, or SyncPlay behavior.
 */
export class LibMpvHost {
  private playbackGeneration = 0;
  private surfaceGeneration = 0;
  private initializePromise: Promise<void> | null = null;
  private initialized = false;
  private destroyed = false;
  private eventListeners = new Set<(event: LibMpvHostEvent) => void>();
  private frameListeners = new Set<(frame: LibMpvHostFrame) => void>();

  constructor(
    readonly capability: LibMpvHostCapability,
    private readonly bridge?: LibMpvNativeBridge,
  ) {}

  onEvent(listener: (event: LibMpvHostEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  onFrame(listener: (frame: LibMpvHostFrame) => void): () => void {
    this.frameListeners.add(listener);
    return () => this.frameListeners.delete(listener);
  }

  async initialize(): Promise<void> {
    if (this.destroyed) throw new AppError("LIBMPV_HOST_DESTROYED", "The experimental player host is unavailable.", 409);
    if (!this.capability.available || !this.bridge) {
      throw new AppError("LIBMPV_UNAVAILABLE", "The experimental player is unavailable on this installation.", 503);
    }
    if (this.initialized) return;
    if (!this.initializePromise) {
      const sink: LibMpvNativeSink = {
        event: (generation, event) => this.acceptEvent(generation, event),
        frame: (generation, frame) => this.acceptFrame(generation, frame),
      };
      this.initializePromise = this.bridge.initialize(sink).then(() => {
        if (this.destroyed) throw new AppError("LIBMPV_HOST_DESTROYED", "The experimental player host was closed.", 409);
        this.initialized = true;
      }).finally(() => { this.initializePromise = null; });
    }
    await this.initializePromise;
  }

  async open(source: LibMpvHostSource, startPositionTicks: number): Promise<LibMpvSession> {
    await this.initialize();
    if (!this.bridge || this.destroyed) throw new AppError("LIBMPV_UNAVAILABLE", "The experimental player is unavailable.", 503);
    const generation = this.nextPlaybackGeneration();
    await this.bridge.open(source, startPositionTicks, generation);
    if (!this.isCurrent(generation)) {
      throw new AppError("PLAYBACK_CANCELLED", "Playback was cancelled.", 409);
    }
    let stopped = false;
    return {
      generation: copyGeneration(generation),
      command: async (command) => {
        if (stopped || !this.isCurrent(generation)) throw new AppError("PLAYBACK_CANCELLED", "Playback was cancelled.", 409);
        await this.bridge!.command(command, generation);
      },
      query: async (property) => {
        if (stopped || !this.isCurrent(generation)) throw new AppError("PLAYBACK_CANCELLED", "Playback was cancelled.", 409);
        return this.bridge!.query(property, generation);
      },
      updateViewport: (viewport) => {
        if (stopped || !this.isCurrent(generation)) return;
        this.surfaceGeneration += 1;
        generation.surface = this.surfaceGeneration;
        this.bridge!.updateViewport(viewport, copyGeneration(generation));
      },
      stop: async () => {
        if (stopped) return;
        stopped = true;
        if (!this.isCurrent(generation)) return;
        const staleGeneration = copyGeneration(generation);
        this.invalidateSession();
        await this.bridge!.stop(staleGeneration);
      },
    };
  }

  async stop(): Promise<void> {
    if (!this.initialized || !this.bridge || this.destroyed) {
      this.invalidateSession();
      return;
    }
    const generation = this.currentGeneration();
    this.invalidateSession();
    await this.bridge.stop(generation);
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    this.invalidateSession();
    this.eventListeners.clear();
    this.frameListeners.clear();
    try { await this.initializePromise; } catch { /* Initialization failure is already surfaced to its caller. */ }
    if (this.bridge) await this.bridge.destroy();
    this.initialized = false;
  }

  private nextPlaybackGeneration(): LibMpvGeneration {
    this.playbackGeneration += 1;
    this.surfaceGeneration += 1;
    return this.currentGeneration();
  }

  private invalidateSession(): void {
    this.playbackGeneration += 1;
    this.surfaceGeneration += 1;
  }

  private currentGeneration(): LibMpvGeneration {
    return { playback: this.playbackGeneration, surface: this.surfaceGeneration };
  }

  private isCurrent(generation: LibMpvGeneration): boolean {
    return !this.destroyed
      && generation.playback === this.playbackGeneration
      && generation.surface === this.surfaceGeneration;
  }

  private acceptEvent(generation: LibMpvGeneration, event: LibMpvHostEvent): void {
    if (!this.isCurrent(generation)) return;
    for (const listener of this.eventListeners) listener(structuredClone(event));
  }

  private acceptFrame(generation: LibMpvGeneration, frame: LibMpvHostFrame): void {
    if (!this.isCurrent(generation)) return;
    for (const listener of this.frameListeners) listener({ ...frame });
  }
}
