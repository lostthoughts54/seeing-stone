import { describe, expect, it } from "vitest";
import {
  currentTimeMarkerPercent,
  isCurrentProgram,
  placeProgramInWindow,
  timeAxisLabels,
  visibleChannelSlice,
} from "../src/renderer/liveTvPresentation";

const at = (minutes: number): string => new Date(Date.UTC(2026, 0, 1, 12, minutes)).toISOString();

describe("Live TV guide presentation", () => {
  it("positions program cells proportionally and clips them to the guide window", () => {
    expect(placeProgramInWindow({ startUtc: at(15), endUtc: at(45) }, Date.parse(at(0)), Date.parse(at(60)))).toEqual({ leftPercent: 25, widthPercent: 50 });
    expect(placeProgramInWindow({ startUtc: at(-30), endUtc: at(15) }, Date.parse(at(0)), Date.parse(at(60)))).toEqual({ leftPercent: 0, widthPercent: 25 });
    expect(placeProgramInWindow({ startUtc: at(60), endUtc: at(90) }, Date.parse(at(0)), Date.parse(at(60)))).toBeNull();
  });

  it("keeps the current-time marker inside the visible window", () => {
    expect(currentTimeMarkerPercent(Date.parse(at(30)), Date.parse(at(0)), Date.parse(at(60)))).toBe(50);
    expect(currentTimeMarkerPercent(Date.parse(at(-1)), Date.parse(at(0)), Date.parse(at(60)))).toBeNull();
    expect(currentTimeMarkerPercent(Date.parse(at(61)), Date.parse(at(0)), Date.parse(at(60)))).toBeNull();
  });

  it("uses real half-hour boundaries and centers a bounded mini-guide channel slice", () => {
    expect(timeAxisLabels(Date.parse(at(7)), Date.parse(at(97))).map((value) => new Date(value).getUTCMinutes())).toEqual([30, 0, 30]);
    const channels = ["a", "b", "c", "d", "e", "f", "g"].map((id) => ({ id }));
    expect(visibleChannelSlice(channels, "d", 5).map((channel) => channel.id)).toEqual(["b", "c", "d", "e", "f"]);
    expect(visibleChannelSlice(channels, "a", 5).map((channel) => channel.id)).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("distinguishes a currently airing program without inferring a LIVE label", () => {
    expect(isCurrentProgram({ startUtc: at(0), endUtc: at(30) }, Date.parse(at(10)))).toBe(true);
    expect(isCurrentProgram({ startUtc: at(0), endUtc: at(30) }, Date.parse(at(30)))).toBe(false);
  });
});
