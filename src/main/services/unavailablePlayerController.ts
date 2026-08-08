import type { PlaybackStartResult, PlaybackState } from "../../shared/contracts";
import { AppError } from "./errors";
import type { PlaybackCommandContext, PlaybackEvent, PlayerController } from "./playerController";

const message = "Playback is unavailable because the controlled libmpv runtime could not be initialized.";

const unavailableState = (): PlaybackState => ({
  playbackId: null,
  itemId: null,
  phase: "error",
  source: null,
  positionTicks: 0,
  durationTicks: 0,
  paused: false,
  buffering: false,
  seekable: false,
  seekableUntilTicks: null,
  volume: 100,
  fullscreen: false,
  audioTracks: [],
  subtitleTracks: [],
  error: message,
});

export class UnavailablePlayerController implements PlayerController {
  onState(): () => void { return () => undefined; }
  onEvent(_listener: (event: PlaybackEvent) => void): () => void { return () => undefined; }
  getState(): PlaybackState { return unavailableState(); }
  getControllerRevision(): number { return 0; }
  getPlaybackRate(): number { return 1; }
  setAutomaticTransitionsEnabled(): void {}
  load(itemId: string, resumeMode: "resume" | "start-over", context?: PlaybackCommandContext): Promise<PlaybackStartResult> {
    return this.loadItem(itemId, resumeMode, context);
  }
  async loadItem(_itemId?: string, _resumeMode?: "resume" | "start-over", _context?: PlaybackCommandContext): Promise<PlaybackStartResult> { throw this.error(); }
  async play(): Promise<PlaybackState> { throw this.error(); }
  async pause(): Promise<PlaybackState> { throw this.error(); }
  async setRate(): Promise<PlaybackState> { throw this.error(); }
  async setVolume(): Promise<PlaybackState> { throw this.error(); }
  async setPaused(): Promise<PlaybackState> { throw this.error(); }
  async seek(): Promise<PlaybackState> { throw this.error(); }
  async setPlaybackRate(): Promise<PlaybackState> { throw this.error(); }
  async selectAudio(): Promise<PlaybackState> { throw this.error(); }
  async selectSubtitle(): Promise<PlaybackState> { throw this.error(); }
  async setFullscreen(): Promise<PlaybackState> { throw this.error(); }
  async continueNextEpisode(): Promise<PlaybackState> { throw this.error(); }
  async cancelNextEpisode(): Promise<PlaybackState> { throw this.error(); }
  async showMessage(): Promise<void> { throw this.error(); }
  async stop(): Promise<PlaybackState> { return unavailableState(); }
  async clear(): Promise<void> {}

  private error(): AppError {
    return new AppError("PLAYER_RUNTIME_UNAVAILABLE", message, 503);
  }
}
