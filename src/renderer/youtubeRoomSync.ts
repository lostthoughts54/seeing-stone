import type { YouTubeRoomTimeline } from "../shared/contracts";

export const YOUTUBE_ROOM_DRIFT_TOLERANCE_SECONDS = 1.5;

export function authoritativeYouTubePosition(timeline: YouTubeRoomTimeline, nowUnixMs = Date.now()): number {
  const elapsed = timeline.playing ? Math.max(0, nowUnixMs - timeline.anchoredAtUnixMs) / 1000 : 0;
  return Math.max(0, timeline.positionSeconds + elapsed);
}

export function shouldCorrectYouTubePosition(input: {
  timeline: YouTubeRoomTimeline;
  localPositionSeconds: number;
  playerReady: boolean;
  contentIdentityMatches: boolean;
  durationStable: boolean;
  nowUnixMs?: number;
}): boolean {
  if (!input.playerReady || !input.contentIdentityMatches || !input.durationStable) return false;
  return Math.abs(authoritativeYouTubePosition(input.timeline, input.nowUnixMs) - input.localPositionSeconds)
    > YOUTUBE_ROOM_DRIFT_TOLERANCE_SECONDS;
}
