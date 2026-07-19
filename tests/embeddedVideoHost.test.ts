import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import {
  initializedVideoSurfaceBounds,
  videoHostBounds,
  windowsWindowHandle,
  windowsWindowId,
} from "../src/main/services/embeddedVideoHost";

describe("EmbeddedVideoHost platform boundary", () => {
  it("preserves the complete unsigned Win32 HWND value", () => {
    const handle = Buffer.alloc(8);
    handle.writeUInt32LE(0xfedcba98, 0);
    handle.writeUInt32LE(0x12345678, 4);
    expect(windowsWindowHandle(handle)).toBe(0x12345678fedcba98n);
    expect(windowsWindowId(handle)).toBe("1311768469143599768");
    expect(() => windowsWindowId(Buffer.alloc(8))).toThrow(/invalid video-window handle/i);
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

  it("returns the initialized D3D surface to the exact renderer viewport", () => {
    expect(initializedVideoSurfaceBounds({ x: 10, y: 20, width: 1280, height: 720 }))
      .toEqual({ x: 10, y: 20, width: 1280, height: 720 });
    expect(initializedVideoSurfaceBounds({ x: 10, y: 20, width: 16, height: 16 }))
      .toEqual({ x: 10, y: 20, width: 16, height: 16 });
  });

  it("owns a non-activating click-through mpv overlay and never creates an Electron child surface", async () => {
    const source = await readFile("src/main/services/embeddedVideoHost.ts", "utf8");
    expect(source).not.toContain("new BaseWindow");
    expect(source).toContain('findWindow(null, title)');
    expect(source).toContain("GWLP_HWNDPARENT");
    expect(source).toContain("WS_EX_TOOLWINDOW");
    expect(source).toContain("WS_EX_NOACTIVATE");
    expect(source).toContain("WS_EX_TRANSPARENT");
    expect(source).toContain("WS_EX_LAYERED");
    expect(source).toContain("setLayeredWindowAttributes(overlay, 0, 255, LWA_ALPHA)");
    expect(source).toContain("setWindowLongChecked(overlay, GWLP_HWNDPARENT, ownerHandle)");
    expect(source).toContain("enableWindow(overlay, 0)");
    expect(source).toContain("if (!this.applyManagedStyles(candidate))");
    expect(source).toContain("!this.applyManagedStyleBits(overlay)");
    expect(source).toContain("pulseOwnerResize()");
    expect(source).toContain("pulseOverlaySurface()");
    expect(source).toContain("SWP_FRAMECHANGED");
    expect(source).toContain("SWP_NOACTIVATE | SWP_SHOWWINDOW");
    expect(source).toContain("raise(): void");
    expect(source).toContain('owner.on("focus", () => this.scheduleReconcile())');
    expect(source).toContain("showWindow(overlay, SW_HIDE)");
    expect(source).toContain("this.owner.webContents.invalidate()");
  });
});
