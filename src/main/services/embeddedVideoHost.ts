import { BrowserWindow, type Rectangle } from "electron";
import { AppError } from "./errors";

export interface VideoViewport {
  x: number; y: number; width: number; height: number; visible: boolean;
}

export interface MpvVideoHost {
  readonly embedded: true;
  getWindowId(): number;
  updateViewport(viewport: VideoViewport): void;
  setFullscreen(fullscreen: boolean): void;
  hide(): void;
  destroy(): void;
}

export function windowsWindowId(handle: Buffer): number {
  if (handle.length < 4) throw new AppError("VIDEO_HOST_INVALID", "Windows returned an invalid video-surface handle.", 500);
  const id = handle.readUInt32LE(0);
  if (id === 0) throw new AppError("VIDEO_HOST_INVALID", "Windows returned an invalid video-surface handle.", 500);
  return id;
}

export function videoHostBounds(content: Rectangle, viewport: VideoViewport, fullscreen: boolean): Rectangle {
  return fullscreen
    ? { x: content.x, y: content.y, width: content.width, height: content.height }
    : { x: Math.round(content.x + viewport.x), y: Math.round(content.y + viewport.y), width: Math.max(1, Math.round(viewport.width)), height: Math.max(1, Math.round(viewport.height)) };
}

export class EmbeddedVideoHost implements MpvVideoHost {
  readonly embedded = true as const;
  private readonly window: BrowserWindow;
  private viewport: VideoViewport = { x: 0, y: 0, width: 0, height: 0, visible: false };
  private fullscreen = false;

  constructor(private readonly owner: BrowserWindow) {
    this.window = new BrowserWindow({
      parent: owner, modal: false, frame: false, show: false, focusable: false,
      skipTaskbar: true, backgroundColor: "#020207",
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, devTools: false },
    });
    this.window.setMenu(null);
    this.window.setIgnoreMouseEvents(true);
    owner.on("move", () => this.applyBounds());
    owner.on("resize", () => this.applyBounds());
    owner.on("restore", () => this.applyBounds());
    owner.on("show", () => this.applyBounds());
    owner.on("minimize", () => this.window.hide());
    owner.on("hide", () => this.window.hide());
    owner.on("closed", () => this.destroy());
  }

  getWindowId(): number {
    if (this.window.isDestroyed()) throw new AppError("VIDEO_HOST_UNAVAILABLE", "The embedded video surface is unavailable.", 409);
    const handle = this.window.getNativeWindowHandle();
    return windowsWindowId(handle);
  }

  updateViewport(viewport: VideoViewport): void { this.viewport = { ...viewport }; this.applyBounds(); }
  setFullscreen(fullscreen: boolean): void { this.fullscreen = fullscreen; this.owner.setFullScreen(fullscreen); this.applyBounds(); }
  hide(): void { if (!this.window.isDestroyed()) this.window.hide(); }
  destroy(): void { if (!this.window.isDestroyed()) this.window.destroy(); }

  private applyBounds(): void {
    if (this.window.isDestroyed() || this.owner.isDestroyed() || this.owner.isMinimized() || !this.owner.isVisible() || !this.viewport.visible) {
      this.hide(); return;
    }
    const content = this.owner.getContentBounds();
    const bounds = videoHostBounds(content, this.viewport, this.fullscreen);
    if (bounds.width < 16 || bounds.height < 16) { this.hide(); return; }
    this.window.setBounds(bounds, false);
    this.window.showInactive();
    this.window.moveTop();
  }
}
