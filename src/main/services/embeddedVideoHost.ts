import { BrowserWindow, screen, type Rectangle } from "electron";
import koffi from "koffi";
import { AppError } from "./errors";

export interface VideoViewport {
  x: number; y: number; width: number; height: number; visible: boolean; revision: number;
}

export interface MpvVideoHost {
  readonly embedded: true;
  attachWindow(title: string): Promise<void>;
  detachWindow(): void;
  updateViewport(viewport: VideoViewport): void;
  raise(): void;
  setFullscreen(fullscreen: boolean): void;
  hide(): void;
  destroy(): void;
}

export function windowsWindowHandle(handle: Buffer): bigint {
  if (handle.length < 4) throw new AppError("VIDEO_HOST_INVALID", "Windows returned an invalid video-window handle.", 500);
  const value = handle.length >= 8 ? handle.readBigUInt64LE(0) : BigInt(handle.readUInt32LE(0));
  if (value === 0n) throw new AppError("VIDEO_HOST_INVALID", "Windows returned an invalid video-window handle.", 500);
  return value;
}

export function windowsWindowId(handle: Buffer): string {
  return windowsWindowHandle(handle).toString(10);
}

export function videoHostBounds(content: Rectangle, viewport: VideoViewport): Rectangle {
  return {
    x: Math.round(content.x + viewport.x),
    y: Math.round(content.y + viewport.y),
    width: Math.max(1, Math.round(viewport.width)),
    height: Math.max(1, Math.round(viewport.height)),
  };
}

export function initializedVideoSurfaceBounds(bounds: Rectangle): Rectangle {
  return bounds;
}

const user32 = koffi.load("user32.dll");
const findWindow = user32.func("__stdcall", "FindWindowA", "void *", ["str", "str"]);
const getWindowLongPtr = user32.func("__stdcall", "GetWindowLongPtrA", "intptr_t", ["void *", "int"]);
const setWindowLongPtr = user32.func("__stdcall", "SetWindowLongPtrA", "intptr_t", ["void *", "int", "intptr_t"]);
const setWindowPos = user32.func("__stdcall", "SetWindowPos", "int", ["void *", "void *", "int", "int", "int", "int", "uint"]);
const showWindow = user32.func("__stdcall", "ShowWindow", "int", ["void *", "int"]);
const isWindow = user32.func("__stdcall", "IsWindow", "int", ["void *"]);
const enableWindow = user32.func("__stdcall", "EnableWindow", "int", ["void *", "int"]);
const setLayeredWindowAttributes = user32.func("__stdcall", "SetLayeredWindowAttributes", "int", ["void *", "uint", "uchar", "uint"]);
const kernel32 = koffi.load("kernel32.dll");
const getLastError = kernel32.func("__stdcall", "GetLastError", "uint", []);
const setLastError = kernel32.func("__stdcall", "SetLastError", "void", ["uint"]);

const GWLP_HWNDPARENT = -8;
const GWL_EXSTYLE = -20;
const WS_EX_TRANSPARENT = 0x00000020n;
const WS_EX_TOOLWINDOW = 0x00000080n;
const WS_EX_APPWINDOW = 0x00040000n;
const WS_EX_NOACTIVATE = 0x08000000n;
const WS_EX_LAYERED = 0x00080000n;
const SW_HIDE = 0;
const LWA_ALPHA = 0x00000002;
const SWP_NOSIZE = 0x0001;
const SWP_NOMOVE = 0x0002;
const SWP_NOZORDER = 0x0004;
const SWP_NOACTIVATE = 0x0010;
const SWP_FRAMECHANGED = 0x0020;
const SWP_SHOWWINDOW = 0x0040;

const delay = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function setWindowLongChecked(window: bigint, index: number, value: bigint): void {
  setLastError(0);
  const previous = BigInt(setWindowLongPtr(window, index, value));
  if (previous === 0n && getLastError() !== 0) {
    throw new AppError("VIDEO_OUTPUT_UNAVAILABLE", "The embedded video window could not be managed safely.", 503);
  }
}

/**
 * Owns mpv's borderless top-level Win32 window and keeps it aligned to the
 * renderer's video viewport. This deliberately avoids Electron child-window
 * embedding: Chromium creates a competing D3D child surface that can cover or
 * freeze an mpv --wid swapchain on Windows.
 */
export class EmbeddedVideoHost implements MpvVideoHost {
  readonly embedded = true as const;
  private overlay: bigint | null = null;
  private viewport: VideoViewport = { x: 0, y: 0, width: 0, height: 0, visible: false, revision: 0 };
  private lastBounds: Rectangle | null = null;
  private reconcileTimer: ReturnType<typeof setTimeout> | null = null;
  private surfaceInitializationTimer: ReturnType<typeof setTimeout> | null = null;
  private ownerResizeRestoreTimer: ReturnType<typeof setTimeout> | null = null;
  private videoSurfaceInitialized = false;
  private destroyed = false;
  private readonly displayMetricsListener = () => this.scheduleReconcile();

  constructor(private readonly owner: BrowserWindow) {
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

  async attachWindow(title: string): Promise<void> {
    this.detachWindow();
    const deadline = Date.now() + 3000;
    while (!this.destroyed && Date.now() < deadline) {
      const candidate = findWindow(null, title) as bigint | null;
      if (candidate !== null && isWindow(candidate) !== 0) {
        this.overlay = candidate;
        if (!this.applyManagedStyles(candidate)) {
          this.overlay = null;
          throw new AppError("VIDEO_OUTPUT_UNAVAILABLE", "The embedded video window could not be managed safely.", 503);
        }
        this.lastBounds = null;
        this.applyBounds();
        return;
      }
      await delay(25);
    }
    throw new AppError("VIDEO_OUTPUT_UNAVAILABLE", "The embedded video window could not be attached.", 503);
  }

  detachWindow(): void {
    if (this.surfaceInitializationTimer) clearTimeout(this.surfaceInitializationTimer);
    this.surfaceInitializationTimer = null;
    if (this.ownerResizeRestoreTimer) clearTimeout(this.ownerResizeRestoreTimer);
    this.ownerResizeRestoreTimer = null;
    this.hide();
    this.overlay = null;
    this.lastBounds = null;
    this.videoSurfaceInitialized = false;
  }

  updateViewport(viewport: VideoViewport): void {
    if (viewport.revision <= this.viewport.revision) return;
    this.viewport = { ...viewport };
    this.scheduleReconcile();
  }

  raise(): void {
    if (this.surfaceInitializationTimer) clearTimeout(this.surfaceInitializationTimer);
    this.surfaceInitializationTimer = setTimeout(() => {
      this.videoSurfaceInitialized = true;
      this.applyBounds();
      const ownerResizePulse = this.pulseOwnerResize();
      this.surfaceInitializationTimer = setTimeout(() => {
        this.surfaceInitializationTimer = null;
        const overlay = this.validOverlay();
        try {
          if (!ownerResizePulse) this.pulseOverlaySurface();
          if (overlay === null || !this.reapplyManagedStyles(overlay)) this.hide();
          else this.scheduleReconcile();
        } catch {
          this.hide();
        }
      }, ownerResizePulse ? 180 : 100);
    }, 250);
  }

  setFullscreen(fullscreen: boolean): void {
    if (this.owner.isFullScreen() !== fullscreen) this.owner.setFullScreen(fullscreen);
    this.scheduleReconcile();
  }

  hide(): void {
    const overlay = this.validOverlay();
    if (overlay !== null) showWindow(overlay, SW_HIDE);
    if (!this.owner.isDestroyed()) this.owner.webContents.invalidate();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.reconcileTimer) clearTimeout(this.reconcileTimer);
    this.reconcileTimer = null;
    if (this.surfaceInitializationTimer) clearTimeout(this.surfaceInitializationTimer);
    this.surfaceInitializationTimer = null;
    if (this.ownerResizeRestoreTimer) clearTimeout(this.ownerResizeRestoreTimer);
    this.ownerResizeRestoreTimer = null;
    screen.removeListener("display-metrics-changed", this.displayMetricsListener);
    this.detachWindow();
  }

  private validOverlay(): bigint | null {
    return this.overlay !== null && isWindow(this.overlay) !== 0 ? this.overlay : null;
  }

  private applyManagedStyles(overlay: bigint): boolean {
    if (!this.applyManagedStyleBits(overlay)) return false;
    return setWindowPos(overlay, null, 0, 0, 0, 0,
      SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED) !== 0;
  }

  private reapplyManagedStyles(overlay: bigint): boolean {
    if (!this.applyManagedStyleBits(overlay)) return false;
    return setWindowPos(overlay, null, 0, 0, 0, 0,
      SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED) !== 0;
  }

  private applyManagedStyleBits(overlay: bigint): boolean {
    const ownerHandle = windowsWindowHandle(this.owner.getNativeWindowHandle());
    setWindowLongChecked(overlay, GWLP_HWNDPARENT, ownerHandle);
    const existingStyle = BigInt(getWindowLongPtr(overlay, GWL_EXSTYLE));
    const managedStyle = (existingStyle | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE | WS_EX_TRANSPARENT | WS_EX_LAYERED)
      & ~WS_EX_APPWINDOW;
    setWindowLongChecked(overlay, GWL_EXSTYLE, managedStyle);
    enableWindow(overlay, 0);
    return setLayeredWindowAttributes(overlay, 0, 255, LWA_ALPHA) !== 0;
  }

  private scheduleReconcile(): void {
    if (this.reconcileTimer) clearTimeout(this.reconcileTimer);
    this.applyBounds();
    this.reconcileTimer = setTimeout(() => {
      this.reconcileTimer = null;
      this.applyBounds();
    }, 500);
  }

  private pulseOwnerResize(): boolean {
    if (this.owner.isDestroyed() || this.owner.isMinimized() || this.owner.isMaximized() || this.owner.isFullScreen()) {
      return false;
    }
    const bounds = this.owner.getBounds();
    if (bounds.width < 32 || bounds.height < 32) return false;
    try {
      this.owner.setBounds({ ...bounds, width: bounds.width + 1 }, false);
      if (this.ownerResizeRestoreTimer) clearTimeout(this.ownerResizeRestoreTimer);
      this.ownerResizeRestoreTimer = setTimeout(() => {
        this.ownerResizeRestoreTimer = null;
        if (this.destroyed || this.owner.isDestroyed() || this.owner.isMinimized()
          || this.owner.isMaximized() || this.owner.isFullScreen()) return;
        this.owner.setBounds(bounds, false);
        this.scheduleReconcile();
      }, 80);
      return true;
    } catch {
      return false;
    }
  }

  private pulseOverlaySurface(): void {
    const overlay = this.validOverlay();
    if (overlay === null || this.destroyed || this.owner.isDestroyed() || this.owner.isMinimized()
      || !this.owner.isVisible() || !this.viewport.visible) return;
    const bounds = videoHostBounds(this.owner.getContentBounds(), this.viewport);
    if (bounds.width < 32 || bounds.height < 16) return;
    setWindowPos(overlay, null, bounds.x, bounds.y, bounds.width - 1, bounds.height, SWP_NOACTIVATE | SWP_SHOWWINDOW);
    setTimeout(() => {
      if (this.validOverlay() !== overlay || this.destroyed || this.owner.isDestroyed()) return;
      setWindowPos(overlay, null, bounds.x, bounds.y, bounds.width, bounds.height, SWP_NOACTIVATE | SWP_SHOWWINDOW);
      this.lastBounds = bounds;
    }, 60);
  }

  private applyBounds(): void {
    const overlay = this.validOverlay();
    if (overlay === null || this.destroyed || this.owner.isDestroyed()
      || this.owner.isMinimized() || !this.owner.isVisible() || !this.viewport.visible) {
      this.hide();
      return;
    }
    const viewportBounds = videoHostBounds(this.owner.getContentBounds(), this.viewport);
    const bounds = this.videoSurfaceInitialized ? initializedVideoSurfaceBounds(viewportBounds) : viewportBounds;
    if (bounds.width < 16 || bounds.height < 16) {
      this.hide();
      return;
    }
    const boundsChanged = !this.lastBounds || Object.keys(bounds).some(
      (key) => bounds[key as keyof Rectangle] !== this.lastBounds![key as keyof Rectangle],
    );
    if (boundsChanged) this.lastBounds = bounds;
    setWindowPos(
      overlay,
      null,
      bounds.x,
      bounds.y,
      bounds.width,
      bounds.height,
      SWP_NOACTIVATE | SWP_SHOWWINDOW,
    );
  }
}
