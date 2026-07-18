import { BaseWindow, BrowserWindow, screen, type Rectangle } from "electron";
import { AppError } from "./errors";

export interface VideoViewport {
  x: number; y: number; width: number; height: number; visible: boolean; revision: number;
}

export interface MpvVideoHost {
  readonly embedded: true;
  getWindowId(): string;
  updateViewport(viewport: VideoViewport): void;
  raise(): void;
  setFullscreen(fullscreen: boolean): void;
  hide(): void;
  destroy(): void;
}

export function windowsWindowId(handle: Buffer): string {
  if (handle.length < 4) throw new AppError("VIDEO_HOST_INVALID", "Windows returned an invalid video-surface handle.", 500);
  const id = handle.readUInt32LE(0);
  if (id === 0) throw new AppError("VIDEO_HOST_INVALID", "Windows returned an invalid video-surface handle.", 500);
  return id.toString(10);
}

export function videoHostBounds(content: Rectangle, viewport: VideoViewport): Rectangle {
  return { x: Math.round(content.x + viewport.x), y: Math.round(content.y + viewport.y), width: Math.max(1, Math.round(viewport.width)), height: Math.max(1, Math.round(viewport.height)) };
}

export class EmbeddedVideoHost implements MpvVideoHost {
  readonly embedded = true as const;
  private readonly window: BaseWindow;
  private viewport: VideoViewport = { x: 0, y: 0, width: 0, height: 0, visible: false, revision: 0 };
  private lastBounds: Rectangle | null = null;
  private hostVisible = false;
  private reconcileTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly displayMetricsListener = () => this.scheduleReconcile();

  constructor(private readonly owner: BrowserWindow) {
    this.window = new BaseWindow({
      parent: owner, modal: false, frame: false, show: false, focusable: false,
      skipTaskbar: true, backgroundColor: "#020207", hasShadow: false,
      roundedCorners: false, thickFrame: false, resizable: false, movable: false,
      minimizable: false, maximizable: false, fullscreenable: false,
    });
    this.window.setIgnoreMouseEvents(true);
    owner.on("move", () => this.scheduleReconcile());
    owner.on("resize", () => this.scheduleReconcile());
    owner.on("restore", () => this.scheduleReconcile());
    owner.on("show", () => this.scheduleReconcile());
    owner.on("focus", () => this.scheduleReconcile());
    owner.on("enter-full-screen", () => this.scheduleReconcile());
    owner.on("leave-full-screen", () => this.scheduleReconcile());
    owner.on("minimize", () => this.hide());
    owner.on("hide", () => this.hide());
    owner.on("closed", () => this.destroy());
    screen.on("display-metrics-changed", this.displayMetricsListener);
  }

  getWindowId(): string {
    if (this.window.isDestroyed()) throw new AppError("VIDEO_HOST_UNAVAILABLE", "The embedded video surface is unavailable.", 409);
    const handle = this.window.getNativeWindowHandle();
    return windowsWindowId(handle);
  }

  updateViewport(viewport: VideoViewport): void {
    if (viewport.revision <= this.viewport.revision) return;
    this.viewport = { ...viewport };
    this.scheduleReconcile();
  }
  raise(): void {
    if (this.window.isDestroyed()) return;
    this.window.moveTop();
    this.scheduleReconcile();
  }
  setFullscreen(fullscreen: boolean): void {
    if (this.owner.isFullScreen() !== fullscreen) this.owner.setFullScreen(fullscreen);
    this.scheduleReconcile();
  }
  hide(): void {
    if (!this.window.isDestroyed() && this.hostVisible) this.window.hide();
    this.hostVisible = false;
  }
  destroy(): void {
    if (this.reconcileTimer) clearTimeout(this.reconcileTimer);
    this.reconcileTimer = null;
    screen.removeListener("display-metrics-changed", this.displayMetricsListener);
    if (!this.window.isDestroyed()) this.window.destroy();
    this.hostVisible = false;
  }

  private scheduleReconcile(): void {
    if (this.reconcileTimer) clearTimeout(this.reconcileTimer);
    this.applyBounds();
    this.reconcileTimer = setTimeout(() => { this.reconcileTimer = null; this.applyBounds(); }, 500);
  }

  private applyBounds(): void {
    if (this.window.isDestroyed() || this.owner.isDestroyed() || this.owner.isMinimized() || !this.owner.isVisible() || !this.viewport.visible) {
      this.hide(); return;
    }
    const content = this.owner.getContentBounds();
    const bounds = videoHostBounds(content, this.viewport);
    if (bounds.width < 16 || bounds.height < 16) { this.hide(); return; }
    if (!this.lastBounds || Object.keys(bounds).some((key) => bounds[key as keyof Rectangle] !== this.lastBounds![key as keyof Rectangle])) {
      this.window.setBounds(bounds, false);
      this.lastBounds = bounds;
    }
    if (!this.hostVisible) {
      this.window.showInactive();
      this.hostVisible = true;
    }
    this.window.moveTop();
  }
}
