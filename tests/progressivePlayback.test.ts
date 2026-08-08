import { describe, expect, it } from "vitest";
import { confirmedProgressiveRangeEndTicks } from "../src/main/services/mpvPlayer";

const ticks = 10_000_000;

describe("progressive playback seek frontier", () => {
  it("requires mpv to confirm a beginning-of-file range", () => {
    expect(confirmedProgressiveRangeEndTicks(null)).toBeNull();
    expect(confirmedProgressiveRangeEndTicks({
      "bof-cached": false,
      "seekable-ranges": [{ start: 0, end: 12 }],
    })).toBeNull();
    expect(confirmedProgressiveRangeEndTicks({
      "bof-cached": true,
      "seekable-ranges": [{ start: 20, end: 30 }],
    })).toBeNull();
  });

  it("uses only the contiguous BOF range and ignores disconnected metadata ranges", () => {
    expect(confirmedProgressiveRangeEndTicks({
      "bof-cached": true,
      "seekable-ranges": [
        { start: 100, end: 110 },
        { start: 8, end: 12 },
        { start: 0, end: 8 },
        { start: 40, end: 50 },
      ],
    })).toBe(12 * ticks);
  });

  it("does not bridge a real gap between otherwise valid cache ranges", () => {
    expect(confirmedProgressiveRangeEndTicks({
      "bof-cached": true,
      "seekable-ranges": [{ start: 0, end: 5 }, { start: 5.01, end: 10 }],
    })).toBe(5 * ticks);
  });
});
