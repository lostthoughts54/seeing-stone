import { describe, expect, it } from "vitest";
import { activeMediaSegment, canSkipSegment, segmentLabel } from "../src/renderer/playerSegments";

describe("player media segments", () => {
  it("uses the required labels and half-open intervals", () => {
    expect(segmentLabel("Intro")).toBe("Skip Intro");
    expect(segmentLabel("Recap")).toBe("Skip Recap");
    expect(segmentLabel("Outro")).toBe("Skip Credits");
    const segment = { type: "Intro" as const, startTicks: 10, endTicks: 20 };
    expect(activeMediaSegment([segment], 9)).toBeNull();
    expect(activeMediaSegment([segment], 10)).toEqual(segment);
    expect(activeMediaSegment([segment], 19)).toEqual(segment);
    expect(activeMediaSegment([segment], 20)).toBeNull();
  });

  it("selects overlaps deterministically and respects progressive availability", () => {
    const segments = [
      { type: "Outro" as const, startTicks: 5, endTicks: 30 },
      { type: "Recap" as const, startTicks: 10, endTicks: 20 },
      { type: "Intro" as const, startTicks: 10, endTicks: 20 },
    ];
    expect(activeMediaSegment(segments, 12)).toEqual(segments[2]);
    expect(canSkipSegment(segments[0], null)).toBe(true);
    expect(canSkipSegment(segments[0], 29)).toBe(false);
    expect(canSkipSegment(segments[0], 30)).toBe(true);
  });
});
