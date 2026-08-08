import { describe, expect, it } from "vitest";
import type { TrickplayManifest } from "../src/shared/contracts";
import { clampedPreviewLeft, trickplayFrame } from "../src/renderer/trickplayPresentation";

const manifest: TrickplayManifest = {
  manifestId: "11111111-1111-4111-8111-111111111111",
  playbackId: "22222222-2222-4222-8222-222222222222",
  itemId: "movie",
  frameWidth: 100,
  frameHeight: 50,
  intervalTicks: 100,
  columns: 3,
  rows: 2,
  frameCount: 10,
  spriteCount: 2,
};

describe("trickplay presentation", () => {
  it("maps timestamps to a frame, sprite, and crop cell", () => {
    expect(trickplayFrame(manifest, 0, 1000)).toMatchObject({ frameIndex: 0, spriteIndex: 0, column: 0, row: 0, x: 0, y: 0 });
    expect(trickplayFrame(manifest, 450, 1000)).toMatchObject({ frameIndex: 4, spriteIndex: 0, column: 1, row: 1, x: -100, y: -50 });
    expect(trickplayFrame(manifest, 1000, 1000)).toMatchObject({ frameIndex: 9, spriteIndex: 1, column: 0, row: 1, x: 0, y: -50 });
  });

  it("clamps preview bubbles inside the timeline", () => {
    expect(clampedPreviewLeft(0, 500, 180)).toBe(98);
    expect(clampedPreviewLeft(500, 500, 180)).toBe(402);
    expect(clampedPreviewLeft(250, 500, 180)).toBe(250);
  });
});
