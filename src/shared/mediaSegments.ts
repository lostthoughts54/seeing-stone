import type { PlaybackMediaSegment, PlaybackMediaSegmentType } from "./contracts";

const TYPE_PRIORITY: Record<PlaybackMediaSegmentType, number> = { Intro: 0, Recap: 1, Outro: 2 };

export function segmentLabel(type: PlaybackMediaSegmentType): "Skip Intro" | "Skip Recap" | "Skip Credits" {
  switch (type) {
    case "Intro": return "Skip Intro";
    case "Recap": return "Skip Recap";
    case "Outro": return "Skip Credits";
  }
}

/** Selects the desktop's deterministic active segment using a half-open interval. */
export function activeMediaSegment(segments: PlaybackMediaSegment[], positionTicks: number): PlaybackMediaSegment | null {
  const active = segments.filter((segment) => positionTicks >= segment.startTicks && positionTicks < segment.endTicks);
  active.sort((left, right) => (
    left.endTicks - right.endTicks || right.startTicks - left.startTicks || TYPE_PRIORITY[left.type] - TYPE_PRIORITY[right.type]
  ));
  return active[0] ?? null;
}

export function canSkipSegment(segment: PlaybackMediaSegment, seekableUntilTicks: number | null): boolean {
  return seekableUntilTicks === null || segment.endTicks <= seekableUntilTicks;
}
