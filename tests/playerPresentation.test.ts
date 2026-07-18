import { describe, expect, it } from "vitest";
import type { PlaybackState, PlaybackTrack } from "../src/shared/contracts";
import {
  connectionStatePresentation,
  formatBitrate,
  formatBufferAhead,
  formatPlaybackTime,
  playbackPhasePresentation,
  safeTimelineValue,
  sourceKindLabel,
  timelineTicks,
  trackLabel,
} from "../src/renderer/playerPresentation";

describe("Seeing Stone player presentation", () => {
  it("formats playback time without inventing precision", () => {
    expect(formatPlaybackTime(0)).toBe("0:00");
    expect(formatPlaybackTime(65 * 10_000_000)).toBe("1:05");
    expect(formatPlaybackTime(3661 * 10_000_000)).toBe("1:01:01");
    expect(formatPlaybackTime(Number.NaN)).toBe("0:00");
  });

  it("labels every delivery kind explicitly", () => {
    expect(sourceKindLabel("matched-local")).toBe("Matched Local");
    expect(sourceKindLabel("downloaded")).toBe("Downloaded");
    expect(sourceKindLabel("direct-play")).toBe("Direct Play");
    expect(sourceKindLabel("direct-stream")).toBe("Direct Stream");
    expect(sourceKindLabel("transcode")).toBe("Transcode");
    expect(sourceKindLabel("offline-local")).toBe("Offline Local");
    expect(sourceKindLabel(null)).toBe("Resolving source");
  });

  it("presents only measured numeric diagnostics", () => {
    expect(formatBitrate(8_400_000)).toBe("8.4 Mbps");
    expect(formatBitrate(192_000)).toBe("192 kbps");
    expect(formatBitrate(null)).toBeNull();
    expect(formatBufferAhead(25_000_000)).toBe("2.5 s");
    expect(formatBufferAhead(null)).toBeNull();
  });

  it("clamps timeline conversion", () => {
    expect(safeTimelineValue(25, 100)).toBe(250);
    expect(safeTimelineValue(200, 100)).toBe(1000);
    expect(timelineTicks(250, 100)).toBe(25);
    expect(timelineTicks(2000, 100)).toBe(100);
  });

  it("builds track names from available metadata only", () => {
    const track: PlaybackTrack = {
      id: 2,
      type: "audio",
      title: "Director commentary",
      language: "eng",
      selected: true,
      codec: "aac",
      channels: 2,
      external: false,
    };
    expect(trackLabel(track)).toBe("Director commentary — eng · aac · 2 ch");
    expect(trackLabel({ ...track, title: null, language: null, codec: null, channels: null })).toBe("Audio 2");
  });

  it("uses distinct real-state treatments", () => {
    expect(connectionStatePresentation("offline")).toMatchObject({ label: "Offline", tone: "amber" });
    const playback = { phase: "buffering", error: null } as PlaybackState;
    expect(playbackPhasePresentation(playback)).toEqual({ label: "Buffering", tone: "amber", active: true });
    expect(playbackPhasePresentation({ ...playback, phase: "error", error: "Decoder stopped" })).toMatchObject({ label: "Decoder stopped", tone: "rose" });
  });
});
