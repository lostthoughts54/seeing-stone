import type { LiveTvProgram } from "../shared/contracts";

export const LIVE_TV_HALF_HOUR_MS = 30 * 60_000;
export const LIVE_TV_HALF_HOUR_PX = 200;

export type TimedProgram = Pick<LiveTvProgram, "startUtc" | "endUtc">;

export interface ProgramPlacement {
  leftPercent: number;
  widthPercent: number;
}

export function placeProgramInWindow(program: TimedProgram, windowStartMs: number, windowEndMs: number): ProgramPlacement | null {
  const start = Date.parse(program.startUtc);
  const end = Date.parse(program.endUtc);
  const duration = windowEndMs - windowStartMs;
  if (!Number.isFinite(start) || !Number.isFinite(end) || duration <= 0 || end <= start || end <= windowStartMs || start >= windowEndMs) return null;
  const clippedStart = Math.max(start, windowStartMs);
  const clippedEnd = Math.min(end, windowEndMs);
  return {
    leftPercent: (clippedStart - windowStartMs) / duration * 100,
    widthPercent: (clippedEnd - clippedStart) / duration * 100,
  };
}

export function currentTimeMarkerPercent(nowMs: number, windowStartMs: number, windowEndMs: number): number | null {
  if (!Number.isFinite(nowMs) || nowMs < windowStartMs || nowMs > windowEndMs || windowEndMs <= windowStartMs) return null;
  return (nowMs - windowStartMs) / (windowEndMs - windowStartMs) * 100;
}

export function guideTimeOffsetPixels(timeMs: number, windowStartMs: number): number {
  return (timeMs - windowStartMs) / LIVE_TV_HALF_HOUR_MS * LIVE_TV_HALF_HOUR_PX;
}

export function guideScrollLeftForTime(timeMs: number, windowStartMs: number, trackOffsetPx: number, viewportWidthPx: number, placement = 0.32): number {
  return Math.max(0, trackOffsetPx + guideTimeOffsetPixels(timeMs, windowStartMs) - viewportWidthPx * placement);
}

export function timeAxisLabels(windowStartMs: number, windowEndMs: number): number[] {
  const first = Math.ceil(windowStartMs / LIVE_TV_HALF_HOUR_MS) * LIVE_TV_HALF_HOUR_MS;
  const values: number[] = [];
  for (let value = first; value < windowEndMs; value += LIVE_TV_HALF_HOUR_MS) values.push(value);
  return values;
}

export function visibleChannelSlice<T extends { id: string }>(channels: T[], selectedChannelId: string, maximum = 5): T[] {
  if (channels.length <= maximum) return channels;
  const selected = Math.max(0, channels.findIndex((channel) => channel.id === selectedChannelId));
  const start = Math.max(0, Math.min(channels.length - maximum, selected - Math.floor(maximum / 2)));
  return channels.slice(start, start + maximum);
}

export function isCurrentProgram(program: TimedProgram, nowMs: number): boolean {
  return Date.parse(program.startUtc) <= nowMs && Date.parse(program.endUtc) > nowMs;
}
