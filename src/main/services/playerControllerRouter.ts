import type { PlaybackStartResult, PlaybackState, PlaybackViewportInput } from "../../shared/contracts";
import type { PlayerAdapterMode } from "./playerPreferences";
import type { PlayerAdapterLaunchStatus } from "./playerAdapterSelection";
import { AppError } from "./errors";
import type {
  PlayerCommandContext,
  PlayerController,
  PlayerControllerEvent,
} from "./playerController";

export interface PlayerControllerRoute {
  mode: PlayerAdapterMode;
  controller: PlayerController;
  updateViewport?(viewport: PlaybackViewportInput): void;
  dispose?(): Promise<void> | void;
}

type RouteFactory = () => PlayerControllerRoute;

const LIBMPV_ENGINE_FAILURES = new Set([
  "LIBMPV_ABI_INCOMPATIBLE",
  "LIBMPV_HOST_DESTROYED",
  "LIBMPV_INITIALIZATION_FAILED",
  "LIBMPV_NATIVE_UNAVAILABLE",
  "LIBMPV_UNAVAILABLE",
]);

const EMBEDDED_ENGINE_FAILURES = new Set([
  "PLAYER_LAUNCH_FAILED",
  "VIDEO_OUTPUT_UNAVAILABLE",
]);

function isEngineFailure(error: unknown, mode: "libmpv" | "embedded"): boolean {
  if (!(error instanceof AppError)) return false;
  return (mode === "libmpv" ? LIBMPV_ENGINE_FAILURES : EMBEDDED_ENGINE_FAILURES).has(error.code);
}

/**
 * Launch-only router. It may move libmpv -> embedded -> legacy while a load is
 * still pre-reporting, but never switches engines for an established session.
 */
export class PlayerControllerRouter implements PlayerController {
  private route: PlayerControllerRoute;
  private removeStateListener: () => void = () => undefined;
  private removeEventListener: () => void = () => undefined;
  private readonly stateListeners = new Set<(state: PlaybackState) => void>();
  private readonly eventListeners = new Set<(event: PlayerControllerEvent) => void>();
  private automaticTransitionsEnabled = true;

  constructor(
    initial: PlayerControllerRoute,
    private readonly status: PlayerAdapterLaunchStatus,
    private readonly embeddedFactory: RouteFactory,
    private readonly legacyFactory: RouteFactory,
    private readonly onStatusChanged: (status: PlayerAdapterLaunchStatus) => void = () => undefined,
  ) {
    this.route = initial;
    this.attachRoute();
  }

  onState(listener: (state: PlaybackState) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  onEvent(listener: (event: PlayerControllerEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  getState(): PlaybackState { return this.route.controller.getState(); }
  getControllerRevision(): number { return this.route.controller.getControllerRevision(); }
  getPlaybackRate(): number { return this.route.controller.getPlaybackRate(); }

  setAutomaticTransitionsEnabled(enabled: boolean): void {
    this.automaticTransitionsEnabled = enabled;
    this.route.controller.setAutomaticTransitionsEnabled(enabled);
  }

  load(itemId: string, resumeMode: "resume" | "start-over", context?: PlayerCommandContext): Promise<PlaybackStartResult> {
    return this.loadItem(itemId, resumeMode, context);
  }

  async loadItem(
    itemId: string,
    resumeMode: "resume" | "start-over",
    context?: PlayerCommandContext,
  ): Promise<PlaybackStartResult> {
    try {
      return await this.route.controller.loadItem(itemId, resumeMode, context);
    } catch (libmpvError) {
      if (this.status.launchSelection !== "libmpv") throw libmpvError;
      if (this.route.mode === "embedded") {
        if (!isEngineFailure(libmpvError, "embedded")) throw libmpvError;
        await this.switchRoute(this.legacyFactory, "legacy", "embedded-initialization-failed");
        return this.route.controller.loadItem(itemId, resumeMode, context);
      }
      if (this.route.mode !== "libmpv") throw libmpvError;
      // A server response, an invalid media file, or a cancelled load is not
      // evidence that the libmpv runtime is broken. Preserve the selected
      // engine so the next valid item can still use it.
      if (!isEngineFailure(libmpvError, "libmpv")) throw libmpvError;
      await this.switchRoute(this.embeddedFactory, "embedded", "initialization-failed");
      try {
        return await this.route.controller.loadItem(itemId, resumeMode, context);
      } catch {
        await this.switchRoute(this.legacyFactory, "legacy", "embedded-initialization-failed");
        return this.route.controller.loadItem(itemId, resumeMode, context);
      }
    }
  }

  play(playbackId: string, context?: PlayerCommandContext): Promise<PlaybackState> { return this.route.controller.play(playbackId, context); }
  pause(playbackId: string, context?: PlayerCommandContext): Promise<PlaybackState> { return this.route.controller.pause(playbackId, context); }
  setRate(playbackId: string, rate: number, context?: PlayerCommandContext): Promise<PlaybackState> { return this.route.controller.setRate(playbackId, rate, context); }
  setVolume(playbackId: string, volume: number, context?: PlayerCommandContext): Promise<PlaybackState> { return this.route.controller.setVolume(playbackId, volume, context); }
  setPaused(playbackId: string, paused: boolean, context?: PlayerCommandContext): Promise<PlaybackState> { return this.route.controller.setPaused(playbackId, paused, context); }
  seek(playbackId: string, positionTicks: number, context?: PlayerCommandContext): Promise<PlaybackState> { return this.route.controller.seek(playbackId, positionTicks, context); }
  setPlaybackRate(playbackId: string, rate: number, context?: PlayerCommandContext): Promise<PlaybackState> { return this.route.controller.setPlaybackRate(playbackId, rate, context); }
  selectAudio(playbackId: string, trackId: number | null): Promise<PlaybackState> { return this.route.controller.selectAudio(playbackId, trackId); }
  selectSubtitle(playbackId: string, trackId: number | null): Promise<PlaybackState> { return this.route.controller.selectSubtitle(playbackId, trackId); }
  setFullscreen(playbackId: string, fullscreen: boolean, context?: PlayerCommandContext): Promise<PlaybackState> { return this.route.controller.setFullscreen(playbackId, fullscreen, context); }
  continueNextEpisode(playbackId: string, context?: PlayerCommandContext): Promise<PlaybackState> { return this.route.controller.continueNextEpisode(playbackId, context); }
  cancelNextEpisode(playbackId: string, context?: PlayerCommandContext): Promise<PlaybackState> { return this.route.controller.cancelNextEpisode(playbackId, context); }
  showMessage(playbackId: string, message: string, durationMilliseconds?: number): Promise<void> { return this.route.controller.showMessage(playbackId, message, durationMilliseconds); }
  stop(playbackId: string, phase?: "stopped" | "ended", context?: PlayerCommandContext): Promise<PlaybackState> { return this.route.controller.stop(playbackId, phase, context); }
  clear(): Promise<void> { return this.route.controller.clear(); }

  updateViewport(viewport: PlaybackViewportInput): void {
    this.route.updateViewport?.(viewport);
  }

  private attachRoute(): void {
    this.route.controller.setAutomaticTransitionsEnabled(this.automaticTransitionsEnabled);
    this.removeStateListener = this.route.controller.onState((state) => {
      for (const listener of this.stateListeners) listener(state);
    });
    this.removeEventListener = this.route.controller.onEvent((event) => {
      for (const listener of this.eventListeners) listener(event);
    });
  }

  private async switchRoute(
    factory: RouteFactory,
    mode: "embedded" | "legacy",
    reason: "initialization-failed" | "embedded-initialization-failed",
  ): Promise<void> {
    const previous = this.route;
    this.removeStateListener();
    this.removeEventListener();
    await previous.controller.clear().catch(() => undefined);
    await previous.dispose?.();
    this.route = factory();
    this.status.active = mode;
    this.status.fallbackActive = true;
    this.status.fallbackFrom = "libmpv";
    this.status.fallbackReason = reason;
    this.onStatusChanged(this.status);
    this.attachRoute();
  }
}
