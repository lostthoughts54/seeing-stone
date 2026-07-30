import type { PlaybackStartResult, PlaybackState } from "../../shared/contracts";

export type PlayerActionOrigin = "local-user" | "remote-sync" | "system";

export type PlayerAction =
  | "state"
  | "load-item"
  | "ready"
  | "play"
  | "pause"
  | "seek"
  | "rate"
  | "volume"
  | "stop"
  | "buffering"
  | "stalled"
  | "disconnected"
  | "completed"
  | "item-transition"
  | "resync-request"
  | "error"
  | "tracks"
  | "fullscreen";

export interface PlaybackCommandContext {
  origin: PlayerActionOrigin;
  /** Monotonic revision owned by the caller's authentication/group session. */
  commandRevision?: number;
  /** Opaque validated identifier used only for duplicate/origin correlation. */
  commandId?: string;
}

/** @deprecated Use PlaybackCommandContext. */
export type PlayerCommandContext = PlaybackCommandContext;

export interface PlaybackEvent {
  action: PlayerAction;
  origin: PlayerActionOrigin;
  commandRevision: number | null;
  commandId: string | null;
  /** Monotonic revision owned by the player controller. */
  controllerRevision: number;
  monotonicTimestampMs: number;
  state: PlaybackState;
}

/** @deprecated Use PlaybackEvent. */
export type PlayerControllerEvent = PlaybackEvent;

export interface PlaybackAdapter {
  onState(listener: (state: PlaybackState) => void): () => void;
  onEvent(listener: (event: PlaybackEvent) => void): () => void;
  getState(): PlaybackState;
  getControllerRevision(): number;
  getPlaybackRate(): number;
  /** Enables solo Next Up transitions; a group coordinator may designate one participant. */
  setAutomaticTransitionsEnabled(enabled: boolean): void;
  load(itemId: string, resumeMode: "resume" | "start-over", context?: PlaybackCommandContext): Promise<PlaybackStartResult>;
  play(playbackId: string, context?: PlaybackCommandContext): Promise<PlaybackState>;
  pause(playbackId: string, context?: PlaybackCommandContext): Promise<PlaybackState>;
  setRate(playbackId: string, rate: number, context?: PlaybackCommandContext): Promise<PlaybackState>;
  setVolume(playbackId: string, volume: number, context?: PlaybackCommandContext): Promise<PlaybackState>;
  /** Compatibility name retained for existing SyncPlay code. */
  loadItem(itemId: string, resumeMode: "resume" | "start-over", context?: PlayerCommandContext): Promise<PlaybackStartResult>;
  setPaused(playbackId: string, paused: boolean, context?: PlayerCommandContext): Promise<PlaybackState>;
  seek(playbackId: string, positionTicks: number, context?: PlayerCommandContext): Promise<PlaybackState>;
  setPlaybackRate(playbackId: string, rate: number, context?: PlayerCommandContext): Promise<PlaybackState>;
  selectAudio(playbackId: string, trackId: number | null): Promise<PlaybackState>;
  selectSubtitle(playbackId: string, trackId: number | null): Promise<PlaybackState>;
  setFullscreen(playbackId: string, fullscreen: boolean, context?: PlayerCommandContext): Promise<PlaybackState>;
  continueNextEpisode(playbackId: string, context?: PlayerCommandContext): Promise<PlaybackState>;
  cancelNextEpisode(playbackId: string, context?: PlayerCommandContext): Promise<PlaybackState>;
  showMessage(playbackId: string, message: string, durationMilliseconds?: number): Promise<void>;
  stop(playbackId: string, phase?: "stopped" | "ended", context?: PlayerCommandContext): Promise<PlaybackState>;
  clear(): Promise<void>;
}

export type PlayerController = PlaybackAdapter;

export const localUserCommand = (): PlayerCommandContext => ({ origin: "local-user" });
export const systemCommand = (): PlayerCommandContext => ({ origin: "system" });
