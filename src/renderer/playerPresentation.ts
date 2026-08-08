import type {
  JellyfinConnectionState,
  PlaybackSourceKind,
  PlaybackState,
  PlaybackTrack,
} from "../shared/contracts";

export const PLAYBACK_TICKS_PER_SECOND = 10_000_000;

export type PlayerTone = "neutral" | "violet" | "blue" | "green" | "amber" | "rose";

export interface PhasePresentation {
  label: string;
  tone: PlayerTone;
  active: boolean;
}

export function formatPlaybackTime(ticks: number): string {
  const totalSeconds = Math.max(0, Math.floor((Number.isFinite(ticks) ? ticks : 0) / PLAYBACK_TICKS_PER_SECOND));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export function sourceKindLabel(kind: PlaybackSourceKind | null | undefined): string {
  switch (kind) {
    case "matched-local": return "Matched Local";
    case "downloaded": return "Downloaded";
    case "downloading": return "Downloading";
    case "direct-play": return "Direct Play";
    case "direct-stream": return "Direct Stream";
    case "transcode": return "Transcode";
    case "offline-local": return "Offline Local";
    default: return "Resolving source";
  }
}

export function connectionStatePresentation(state: JellyfinConnectionState): PhasePresentation {
  switch (state) {
    case "connected": return { label: "Connected", tone: "green", active: false };
    case "offline": return { label: "Offline", tone: "amber", active: false };
    case "reconnecting": return { label: "Reconnecting", tone: "blue", active: true };
    default: return { label: "Connection unknown", tone: "neutral", active: false };
  }
}

export function playbackPhasePresentation(playback: PlaybackState | null): PhasePresentation {
  switch (playback?.phase) {
    case "resolving": return { label: "Resolving playback source", tone: "violet", active: true };
    case "loading": return { label: "Loading media", tone: "violet", active: true };
    case "ready": return { label: "Ready", tone: "blue", active: false };
    case "playing": return { label: "Playing", tone: "green", active: false };
    case "paused": return { label: "Paused", tone: "blue", active: false };
    case "buffering": return { label: "Buffering", tone: "amber", active: true };
    case "stalled": return { label: "Playback stalled", tone: "rose", active: true };
    case "disconnected": return { label: "Player disconnected", tone: "rose", active: false };
    case "ended": return { label: "Playback ended", tone: "neutral", active: false };
    case "stopped": return { label: "Playback stopped", tone: "neutral", active: false };
    case "error": return { label: playback.error || "Playback error", tone: "rose", active: false };
    default: return { label: "Preparing playback", tone: "neutral", active: true };
  }
}

export function formatBitrate(bitsPerSecond: number | null | undefined): string | null {
  if (!Number.isFinite(bitsPerSecond) || (bitsPerSecond ?? 0) <= 0) return null;
  const value = bitsPerSecond as number;
  if (value >= 1_000_000) return `${stripTrailingZero((value / 1_000_000).toFixed(1))} Mbps`;
  return `${Math.round(value / 1_000)} kbps`;
}

export function formatBufferAhead(ticks: number | null | undefined): string | null {
  if (!Number.isFinite(ticks) || (ticks ?? -1) < 0) return null;
  return `${stripTrailingZero(((ticks as number) / PLAYBACK_TICKS_PER_SECOND).toFixed(1))} s`;
}

export function formatPlaybackRate(rate: number | null | undefined): string | null {
  if (!Number.isFinite(rate) || (rate ?? 0) <= 0) return null;
  return `${stripTrailingZero((rate as number).toFixed(2))}×`;
}

export function trackLabel(track: PlaybackTrack): string {
  const primary = track.title?.trim() || track.language?.trim() || `${track.type === "audio" ? "Audio" : "Subtitle"} ${track.id}`;
  const metadata = [
    track.title?.trim() ? track.language?.trim() : null,
    track.codec?.trim(),
    track.channels && track.channels > 0 ? `${track.channels} ch` : null,
    track.external ? "External" : null,
    track.isForced ? "Forced" : null,
  ].filter((value): value is string => Boolean(value));
  return metadata.length > 0 ? `${primary} — ${metadata.join(" · ")}` : primary;
}

export function safeTimelineValue(positionTicks: number, durationTicks: number, maximum = 1000): number {
  if (!Number.isFinite(positionTicks) || !Number.isFinite(durationTicks) || durationTicks <= 0) return 0;
  return Math.max(0, Math.min(maximum, Math.round((positionTicks / durationTicks) * maximum)));
}

export function timelineTicks(value: number, durationTicks: number, maximum = 1000): number {
  if (!Number.isFinite(value) || !Number.isFinite(durationTicks) || durationTicks <= 0 || maximum <= 0) return 0;
  return Math.max(0, Math.min(durationTicks, Math.round((value / maximum) * durationTicks)));
}

function stripTrailingZero(value: string): string {
  return value.endsWith(".0") ? value.slice(0, -2) : value;
}
