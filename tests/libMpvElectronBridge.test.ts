import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { sharedTexture, type BrowserWindow, type IpcMain } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ElectronLibMpvBridge, LIBMPV_PRESENTER_IPC } from "../src/main/services/libMpvElectronBridge";

vi.mock("electron", () => ({ BrowserWindow: class {}, sharedTexture: {} }));
vi.mock("../src/main/services/logger", () => ({ logger: { warn: vi.fn() } }));

const nativePath = resolve("tests/fixtures/libmpvNativePresenter.cjs");
const native = createRequire(import.meta.url)(nativePath) as { instances: Array<{
  options: { sourcePath: string };
  suspensions: boolean[];
  outstandingFrames: number;
  destroyCalls: number;
}> };
const visibleViewport = { visible: true, width: 1280, height: 720, revision: 1, deviceScaleFactor: 1 };
const generation = (number: number) => ({ playback: number, surface: number });
const bridges: ElectronLibMpvBridge[] = [];

async function fixture(presentationMode: "shared-texture" | "cpu-readback" = "cpu-readback") {
  let minimized = false;
  let autoPresent = true;
  const ipc = new EventEmitter();
  const contents = Object.assign(new EventEmitter(), { mainFrame: {}, invalidate: vi.fn(), send: vi.fn() });
  const event = { sender: contents, senderFrame: contents.mainFrame };
  sharedTexture.importSharedTexture = vi.fn(() => ({
    textureId: "fixture-texture", release: vi.fn(),
  } as unknown as ReturnType<typeof sharedTexture.importSharedTexture>));
  sharedTexture.sendSharedTexture = vi.fn(async (_options, input: unknown) => {
    if (autoPresent) ipc.emit(LIBMPV_PRESENTER_IPC.presented, event, input);
  });
  contents.send.mockImplementation((channel, payload) => {
    if (channel === LIBMPV_PRESENTER_IPC.start) ipc.emit(LIBMPV_PRESENTER_IPC.ready, event, payload);
    if (channel === LIBMPV_PRESENTER_IPC.cpuFrame && autoPresent) ipc.emit(LIBMPV_PRESENTER_IPC.presented, event, payload);
  });
  const window = Object.assign(new EventEmitter(), {
    webContents: contents,
    isDestroyed: () => false,
    isMinimized: () => minimized,
    isFullScreen: () => false,
    isMaximized: () => false,
  });
  const bridge = new ElectronLibMpvBridge(window as unknown as BrowserWindow, ipc as unknown as IpcMain, "fixture.dll", nativePath, "2.3", {
    enabled: false, decoderMode: "current", requestedDecoderMode: "current", hwdec: "auto-safe",
    presentationMode, logFilePath: "unused", unsupportedReason: null,
  });
  bridges.push(bridge);
  const sink = { event: vi.fn(), frame: vi.fn() };
  await bridge.initialize(sink);
  ipc.emit(LIBMPV_PRESENTER_IPC.listenerReady, event);
  return {
    bridge,
    contents,
    sink,
    minimize: () => { minimized = true; window.emit("minimize"); },
    restore: () => { minimized = false; window.emit("restore"); },
    setAutoPresent: (value: boolean) => { autoPresent = value; },
  };
}

beforeEach(() => { vi.useFakeTimers(); native.instances.length = 0; });
afterEach(async () => {
  for (const producer of native.instances) producer.outstandingFrames = 0;
  for (const bridge of bridges.splice(0)) await bridge.destroy();
  vi.useRealTimers();
});

describe("Electron libmpv viewport readiness and lifecycle", () => {
  it.each(["resolve", "reject"])("ignores an old texture send that %ss after a channel change", async (outcome) => {
    const h = await fixture("shared-texture");
    h.bridge.updateViewport(visibleViewport);
    let finish!: () => void;
    vi.mocked(sharedTexture.sendSharedTexture).mockImplementationOnce(() => new Promise<void>((resolveSend, rejectSend) => {
      finish = () => outcome === "resolve" ? resolveSend() : rejectSend(new Error("old transfer failed"));
    }));
    const old = expect(h.bridge.open({ location: "old-channel" }, 0, generation(1))).rejects.toMatchObject({ code: "PLAYBACK_CANCELLED" });
    await vi.advanceTimersByTimeAsync(50);
    const current = h.bridge.open({ location: "current-channel" }, 0, generation(2));
    await vi.advanceTimersByTimeAsync(50);
    await old;
    await current;
    expect(h.sink.frame).toHaveBeenCalledTimes(1);
    finish();
    await vi.advanceTimersByTimeAsync(50);
    expect(h.sink.frame).toHaveBeenCalledTimes(1);
    expect(h.sink.event.mock.calls.some(([, event]) => event.kind === "error")).toBe(false);
    expect(native.instances.map((producer) => producer.destroyCalls)).toEqual([1, 0]);
    await expect(h.bridge.query("path", generation(2))).resolves.toBe("current-channel");
  });

  it("recovers a full texture pool even after the last frame was acknowledged, then reports a persistent stall", async () => {
    const h = await fixture("shared-texture");
    h.bridge.updateViewport(visibleViewport);
    const opening = h.bridge.open({ location: "channel" }, 0, generation(1));
    await vi.advanceTimersByTimeAsync(50);
    await opening;
    native.instances[0].outstandingFrames = 3;
    await vi.advanceTimersByTimeAsync(1800);
    expect(h.contents.send.mock.calls.filter(([channel]) => channel === LIBMPV_PRESENTER_IPC.start)).toHaveLength(2);
    expect(native.instances).toHaveLength(1);
    expect(native.instances[0].destroyCalls).toBe(0);
    await vi.advanceTimersByTimeAsync(3500);
    expect(h.sink.event).toHaveBeenCalledWith(generation(1), { kind: "error", code: "LIBMPV_TEXTURE_POOL_STALLED" });
    expect(h.contents.send.mock.calls.filter(([channel]) => channel === LIBMPV_PRESENTER_IPC.start)).toHaveLength(3);
  });

  it("does not recreate the presenter when a paused video only holds its two displayed textures", async () => {
    const h = await fixture("shared-texture");
    h.bridge.updateViewport(visibleViewport);
    const opening = h.bridge.open({ location: "channel" }, 0, generation(1));
    await vi.advanceTimersByTimeAsync(50);
    await opening;
    native.instances[0].outstandingFrames = 2;
    await vi.advanceTimersByTimeAsync(6000);
    expect(h.contents.send.mock.calls.filter(([channel]) => channel === LIBMPV_PRESENTER_IPC.start)).toHaveLength(1);
    expect(h.sink.event).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ kind: "error" }));
  });

  it("resumes a known visible viewport after minimize/restore without requiring another renderer resize", async () => {
    const h = await fixture();
    h.bridge.updateViewport(visibleViewport);
    h.minimize();
    const opening = h.bridge.open({ location: "channel" }, 0, generation(1));
    await vi.advanceTimersByTimeAsync(50);
    expect(native.instances).toHaveLength(0);
    h.restore();
    await vi.advanceTimersByTimeAsync(50);
    await opening;
    expect(native.instances).toHaveLength(1);
    h.minimize();
    expect(native.instances[0].suspensions.at(-1)).toBe(true);
    h.restore();
    expect(native.instances[0].suspensions.at(-1)).toBe(false);
  });

  it("keeps renderer-hidden layouts hidden when the window is restored", async () => {
    const h = await fixture();
    h.bridge.updateViewport(visibleViewport);
    h.minimize();
    h.bridge.updateViewport({ ...visibleViewport, visible: false, revision: 2 });
    h.restore();
    const opening = h.bridge.open({ location: "channel" }, 0, generation(1));
    await vi.advanceTimersByTimeAsync(50);
    expect(native.instances).toHaveLength(0);
    h.bridge.updateViewport({ ...visibleViewport, revision: 3 });
    await vi.advanceTimersByTimeAsync(50);
    await opening;
  });

  it("cancels an open stopped before its viewport arrives and never starts its producer", async () => {
    const h = await fixture();
    const opening = expect(h.bridge.open({ location: "cancelled-channel" }, 0, generation(1))).rejects.toMatchObject({ code: "PLAYBACK_CANCELLED" });
    await h.bridge.stop(generation(1));
    h.bridge.updateViewport(visibleViewport);
    await vi.advanceTimersByTimeAsync(50);
    await opening;
    expect(native.instances).toHaveLength(0);
  });

  it("allows only the latest channel waiting for the viewport to start", async () => {
    const h = await fixture();
    const old = expect(h.bridge.open({ location: "old-channel" }, 0, generation(1))).rejects.toMatchObject({ code: "PLAYBACK_CANCELLED" });
    await vi.advanceTimersByTimeAsync(25);
    const current = h.bridge.open({ location: "current-channel" }, 0, generation(2));
    h.bridge.updateViewport(visibleViewport);
    await vi.advanceTimersByTimeAsync(50);
    await old;
    await current;
    expect(native.instances.map((producer) => producer.options.sourcePath)).toEqual(["current-channel"]);
  });

  it("does not let a rejected first-frame waiter tear down its replacement", async () => {
    const h = await fixture();
    h.bridge.updateViewport(visibleViewport);
    h.setAutoPresent(false);
    const old = expect(h.bridge.open({ location: "old-channel" }, 0, generation(1))).rejects.toMatchObject({ code: "PLAYBACK_CANCELLED" });
    await vi.advanceTimersByTimeAsync(50);
    h.setAutoPresent(true);
    const current = h.bridge.open({ location: "current-channel" }, 0, generation(2));
    await vi.advanceTimersByTimeAsync(50);
    await old;
    await current;
    expect(native.instances.map((producer) => producer.destroyCalls)).toEqual([1, 0]);
    await expect(h.bridge.query("path", generation(2))).resolves.toBe("current-channel");
  });

  it("waits for shared stop cleanup before opening a replacement producer", async () => {
    const h = await fixture();
    h.bridge.updateViewport(visibleViewport);
    const first = h.bridge.open({ location: "old-channel" }, 0, generation(1));
    await vi.advanceTimersByTimeAsync(50);
    await first;
    native.instances[0].outstandingFrames = 1;
    const stopped = h.bridge.stop(generation(1));
    const current = h.bridge.open({ location: "current-channel" }, 0, generation(2));
    await vi.advanceTimersByTimeAsync(50);
    expect(native.instances).toHaveLength(1);
    native.instances[0].outstandingFrames = 0;
    await vi.advanceTimersByTimeAsync(50);
    await stopped;
    await current;
    expect(native.instances.map((producer) => producer.destroyCalls)).toEqual([1, 0]);
    await expect(h.bridge.query("path", generation(2))).resolves.toBe("current-channel");
  });

  it("reports a bounded playback-specific readiness error without mentioning watch parties", async () => {
    const h = await fixture();
    const opening = h.bridge.open({ location: "channel" }, 0, generation(1));
    const rejected = expect(opening).rejects.toMatchObject({
      code: "LIBMPV_VIEWPORT_NOT_READY",
      message: "The player screen did not become ready for video. Restore the app window and try playback again.",
    });
    await vi.advanceTimersByTimeAsync(5_001);
    await rejected;
    expect(native.instances).toHaveLength(0);
  });
});
