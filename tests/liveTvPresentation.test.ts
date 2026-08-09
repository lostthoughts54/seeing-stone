import { describe, expect, it } from "vitest";
import {
  LIVE_TV_GUIDE_WINDOW_MS,
  currentTimeMarkerPercent,
  guideScrollLeftForTime,
  guideTimeOffsetPixels,
  isCurrentProgram,
  isLocalDateTransition,
  normalGuideWindow,
  placeProgramInWindow,
  timeAxisLabels,
  visibleChannelSlice,
} from "../src/renderer/liveTvPresentation";

const at = (minutes: number): string => new Date(Date.UTC(2026, 0, 1, 12, minutes)).toISOString();
const localAt = (day: number, hour: number, minute = 0): number => new Date(2026, 7, day, hour, minute).getTime();

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

  it("uses a fixed 200px half-hour time scale and places Now inside the timeline", () => {
    expect(guideTimeOffsetPixels(Date.parse(at(30)), Date.parse(at(0)))).toBe(200);
    expect(guideTimeOffsetPixels(Date.parse(at(90)), Date.parse(at(0)))).toBe(600);
    expect(guideScrollLeftForTime(Date.parse(at(60)), Date.parse(at(0)), 288, 1000)).toBe(368);
  });

  it("uses real half-hour boundaries and centers a bounded mini-guide channel slice", () => {
    expect(timeAxisLabels(Date.parse(at(7)), Date.parse(at(97))).map((value) => new Date(value).getUTCMinutes())).toEqual([30, 0, 30]);
    const channels = ["a", "b", "c", "d", "e", "f", "g"].map((id) => ({ id }));
    expect(visibleChannelSlice(channels, "d", 5).map((channel) => channel.id)).toEqual(["b", "c", "d", "e", "f"]);
    expect(visibleChannelSlice(channels, "a", 5).map((channel) => channel.id)).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("keeps the normal 12-hour guide open across midnight without using end-of-day bounds", () => {
    const window = normalGuideWindow(localAt(8, 19));
    expect(window.endMs - window.startMs).toBe(LIVE_TV_GUIDE_WINDOW_MS);
    expect(new Date(window.startMs).getHours()).toBe(19);
    expect(new Date(window.endMs).getDate()).toBe(9);
    expect(new Date(window.endMs).getHours()).toBe(7);
    const labels = timeAxisLabels(window.startMs, window.endMs);
    expect(labels).toHaveLength(24);
    expect(labels).toContain(localAt(9, 0));
    expect(labels.some((label, index) => index > 0 && isLocalDateTransition(labels[index - 1], label))).toBe(true);
    expect(labels.length * 200).toBe(4800);
    const daytimeWindow = normalGuideWindow(localAt(8, 10));
    expect(daytimeWindow.endMs - daytimeWindow.startMs).toBe(LIVE_TV_GUIDE_WINDOW_MS);
  });

  it("keeps a program spanning midnight continuous at its timestamp-based width", () => {
    const window = normalGuideWindow(localAt(8, 19));
    const placement = placeProgramInWindow({
      startUtc: new Date(localAt(8, 23, 30)).toISOString(),
      endUtc: new Date(localAt(9, 0, 30)).toISOString(),
    }, window.startMs, window.endMs);
    expect(placement?.leftPercent).toBe(37.5);
    expect(placement?.widthPercent).toBeCloseTo(100 / 12);
  });

  it("uses timestamp duration through a local daylight-saving date change", () => {
    const window = normalGuideWindow(new Date(2026, 10, 1, 0, 0).getTime());
    expect(window.endMs - window.startMs).toBe(12 * 60 * 60_000);
  });

  it("distinguishes a currently airing program without inferring a LIVE label", () => {
    expect(isCurrentProgram({ startUtc: at(0), endUtc: at(30) }, Date.parse(at(10)))).toBe(true);
    expect(isCurrentProgram({ startUtc: at(0), endUtc: at(30) }, Date.parse(at(30)))).toBe(false);
  });
});
