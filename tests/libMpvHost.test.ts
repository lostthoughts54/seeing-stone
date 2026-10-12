import { describe, expect, it, vi } from "vitest";
import {
  LibMpvHost,
  type LibMpvGeneration,
  type LibMpvNativeBridge,
  type LibMpvNativeSink,
} from "../src/main/services/libMpvHost";

function bridgeHarness() {
  let sink: LibMpvNativeSink | null = null;
  const bridge: LibMpvNativeBridge = {
    initialize: vi.fn(async (nextSink) => { sink = nextSink; }),
    open: vi.fn(async () => undefined),
    command: vi.fn(async () => undefined),
    updateViewport: vi.fn(),
    stop: vi.fn(async () => undefined),
    destroy: vi.fn(async () => undefined),
  };
  const host = new LibMpvHost({
    available: true,
    reason: null,
    clientApiVersion: "2.3",
    renderApi: "opengl-angle",
  }, bridge);
  return { host, bridge, sink: () => sink as LibMpvNativeSink };
}

describe("LibMpvHost scaffold", () => {
  it("initializes and destroys idempotently", async () => {
    const h = bridgeHarness();
    await Promise.all([h.host.initialize(), h.host.initialize()]);
    await h.host.destroy();
    await h.host.destroy();
    expect(h.bridge.initialize).toHaveBeenCalledTimes(1);
    expect(h.bridge.destroy).toHaveBeenCalledTimes(1);
  });

  it("rejects stale events and frames from a stopped session", async () => {
    const h = bridgeHarness();
    const events = vi.fn();
    const frames = vi.fn();
    h.host.onEvent(events);
    h.host.onFrame(frames);
    const session = await h.host.open({ location: "fixture" }, 0);
    const generation: LibMpvGeneration = { ...session.generation };
    h.sink().event(generation, { kind: "ready" });
    h.sink().frame(generation, { sequence: 1, width: 16, height: 9, timestampMicroseconds: 1 });
    await session.stop();
    h.sink().event(generation, { kind: "ready" });
    h.sink().frame(generation, { sequence: 2, width: 16, height: 9, timestampMicroseconds: 2 });
    expect(events).toHaveBeenCalledTimes(1);
    expect(frames).toHaveBeenCalledTimes(1);
  });

  it("does not initialize an unavailable bridge", async () => {
    const host = new LibMpvHost({
      available: false,
      reason: "library-not-configured",
      clientApiVersion: null,
      renderApi: null,
    });
    await expect(host.initialize()).rejects.toMatchObject({ code: "LIBMPV_UNAVAILABLE" });
    await host.destroy();
  });

  it("does not open media when stopped during native initialization", async () => {
    const h = bridgeHarness();
    let finishInitialization!: () => void;
    vi.mocked(h.bridge.initialize).mockImplementationOnce(() => new Promise<void>((resolve) => { finishInitialization = resolve; }));
    const opening = h.host.open({ location: "cancelled" }, 0);
    const cancelled = expect(opening).rejects.toMatchObject({ code: "PLAYBACK_CANCELLED" });
    await h.host.stop();
    finishInitialization();
    await cancelled;
    expect(h.bridge.open).not.toHaveBeenCalled();
    await h.host.open({ location: "next" }, 0);
    expect(h.bridge.open).toHaveBeenCalledOnce();
    expect(h.bridge.open).toHaveBeenCalledWith({ location: "next" }, 0, expect.any(Object));
  });

  it("opens only the latest requested source after shared initialization", async () => {
    const h = bridgeHarness();
    let finishInitialization!: () => void;
    vi.mocked(h.bridge.initialize).mockImplementationOnce(() => new Promise<void>((resolve) => { finishInitialization = resolve; }));
    const first = h.host.open({ location: "first" }, 0);
    const cancelled = expect(first).rejects.toMatchObject({ code: "PLAYBACK_CANCELLED" });
    const second = h.host.open({ location: "second" }, 0);
    finishInitialization();
    await cancelled;
    await second;
    expect(h.bridge.open).toHaveBeenCalledOnce();
    expect(h.bridge.open).toHaveBeenCalledWith({ location: "second" }, 0, expect.any(Object));
  });
});
