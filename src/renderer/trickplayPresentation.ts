import type { TrickplayManifest } from "../shared/contracts";

export interface TrickplayFrame {
  targetTicks: number;
  frameIndex: number;
  spriteIndex: number;
  column: number;
  row: number;
  x: number;
  y: number;
}

export function trickplayFrame(manifest: TrickplayManifest, targetTicks: number, durationTicks: number): TrickplayFrame {
  const clamped = Math.max(0, Math.min(durationTicks, Number.isFinite(targetTicks) ? targetTicks : 0));
  const frameIndex = Math.min(Math.floor(clamped / manifest.intervalTicks), manifest.frameCount - 1);
  const framesPerSprite = manifest.columns * manifest.rows;
  const spriteIndex = Math.floor(frameIndex / framesPerSprite);
  const cellIndex = frameIndex % framesPerSprite;
  const column = cellIndex % manifest.columns;
  const row = Math.floor(cellIndex / manifest.columns);
  return {
    targetTicks: clamped,
    frameIndex,
    spriteIndex,
    column,
    row,
    x: column === 0 ? 0 : -(column * manifest.frameWidth),
    y: row === 0 ? 0 : -(row * manifest.frameHeight),
  };
}

export function clampedPreviewLeft(pointerX: number, viewportWidth: number, bubbleWidth: number, inset = 8): number {
  const half = bubbleWidth / 2;
  return Math.max(half + inset, Math.min(viewportWidth - half - inset, pointerX));
}
