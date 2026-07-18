import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { videoHostBounds, windowsWindowId } from "../src/main/services/embeddedVideoHost";

describe("EmbeddedVideoHost platform boundary", () => {
  it("passes mpv the low unsigned 32 bits of a Win32 HWND", () => {
    const handle = Buffer.alloc(8);
    handle.writeUInt32LE(0xfedcba98, 0);
    handle.writeUInt32LE(0x12345678, 4);
    expect(windowsWindowId(handle)).toBe("4275878552");
    expect(() => windowsWindowId(Buffer.alloc(8))).toThrow(/invalid video-surface handle/i);
  });

  it("maps renderer CSS-pixel bounds into Electron screen DIP bounds", () => {
    expect(videoHostBounds(
      { x: -1600, y: 120, width: 1500, height: 900 },
      { x: 212.4, y: 86.6, width: 984.4, height: 553.6, visible: true, revision: 1 },
    )).toEqual({ x: -1388, y: 207, width: 984, height: 554 });
  });

  it("keeps the renderer-defined control-safe viewport in application fullscreen", () => {
    const content = { x: 0, y: 0, width: 1920, height: 1080 };
    expect(videoHostBounds(content, { x: 0, y: 0, width: 1920, height: 1024, visible: true, revision: 1 }))
      .toEqual({ x: 0, y: 0, width: 1920, height: 1024 });
    expect(videoHostBounds(content, { x: 0, y: 0, width: 1920, height: 1077, visible: true, revision: 2 }))
      .toEqual({ x: 0, y: 0, width: 1920, height: 1077 });
  });

  it("reasserts the owned native surface above renderer repaints", async () => {
    const source = await readFile("src/main/services/embeddedVideoHost.ts", "utf8");
    expect(source).toContain("this.window.showInactive()");
    expect(source).toContain("this.window.moveTop()");
    expect(source).toContain("raise(): void");
    expect(source).toContain('owner.on("focus", () => this.scheduleReconcile())');
    expect(source.match(/this\.window\.moveTop\(\)/g)?.length).toBeGreaterThanOrEqual(2);
  });
});
