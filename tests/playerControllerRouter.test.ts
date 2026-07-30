import { describe, expect, it } from "vitest";
import type { PlaybackStartResult, PlaybackState } from "../src/shared/contracts";
import type { PlayerController, PlayerControllerEvent } from "../src/main/services/playerController";
import { PlayerControllerRouter, type PlayerControllerRoute } from "../src/main/services/playerControllerRouter";
import type { PlayerAdapterLaunchStatus } from "../src/main/services/playerAdapterSelection";
import { AppError } from "../src/main/services/errors";

const state = (): PlaybackState => ({
  playbackId: null, itemId: null, phase: "idle", source: null, positionTicks: 0, durationTicks: 0,
  paused: false, buffering: false, seekable: false, volume: 100, fullscreen: false,
  audioTracks: [], subtitleTracks: [], error: null,
});

function fakeController(load: () => Promise<PlaybackStartResult>): PlayerController {
  return {
    onState: () => () => undefined,
    onEvent: (_listener: (event: PlayerControllerEvent) => void) => () => undefined,
    getState: state,
    getControllerRevision: () => 0,
    getPlaybackRate: () => 1,
    setAutomaticTransitionsEnabled: () => undefined,
    load,
    loadItem: load,
    play: async () => state(), pause: async () => state(), setRate: async () => state(), setVolume: async () => state(),
    setPaused: async () => state(), seek: async () => state(), setPlaybackRate: async () => state(),
    selectAudio: async () => state(), selectSubtitle: async () => state(), setFullscreen: async () => state(),
    showMessage: async () => undefined, stop: async () => state(), clear: async () => undefined,
  };
}

const success: PlaybackStartResult = {
  playbackId: "playback", resumePositionTicks: 0, durationTicks: 100, source: "local", sourceKind: "matched-local",
};

function status(active: "libmpv" | "embedded"): PlayerAdapterLaunchStatus {
  return {
    launchSelection: "libmpv", active, embeddedAvailable: true, libmpvAvailable: true,
    fallbackActive: false, fallbackFrom: null, fallbackReason: null,
  };
}

describe("PlayerControllerRouter", () => {
  it("falls back libmpv -> embedded only while the initial load is pre-reporting", async () => {
    const launch = status("libmpv");
    const initial: PlayerControllerRoute = {
      mode: "libmpv",
      controller: fakeController(async () => {
        throw new AppError("LIBMPV_INITIALIZATION_FAILED", "first frame");
      }),
    };
    const embedded = () => ({ mode: "embedded", controller: fakeController(async () => success) } satisfies PlayerControllerRoute);
    const legacy = () => ({ mode: "legacy", controller: fakeController(async () => success) } satisfies PlayerControllerRoute);
    const updates: PlayerAdapterLaunchStatus[] = [];
    const router = new PlayerControllerRouter(initial, launch, embedded, legacy, (value) => {
      updates.push({ ...value });
    });

    await expect(router.loadItem("item", "resume")).resolves.toEqual(success);
    expect(launch).toMatchObject({
      active: "embedded", fallbackActive: true, fallbackFrom: "libmpv", fallbackReason: "initialization-failed",
    });
    expect(updates).toEqual([expect.objectContaining({
      active: "embedded",
      fallbackReason: "initialization-failed",
    })]);
  });

  it("falls back from the embedded recovery engine to legacy without changing the saved selection", async () => {
    const launch = status("embedded");
    launch.fallbackActive = true;
    launch.fallbackFrom = "libmpv";
    launch.fallbackReason = "library-missing";
    const initial: PlayerControllerRoute = {
      mode: "embedded",
      controller: fakeController(async () => {
        throw new AppError("VIDEO_OUTPUT_UNAVAILABLE", "embedded");
      }),
    };
    const embedded = () => initial;
    const legacy = () => ({ mode: "legacy", controller: fakeController(async () => success) } satisfies PlayerControllerRoute);
    const router = new PlayerControllerRouter(initial, launch, embedded, legacy);

    await expect(router.loadItem("item", "resume")).resolves.toEqual(success);
    expect(launch).toMatchObject({
      launchSelection: "libmpv", active: "legacy", fallbackActive: true,
      fallbackFrom: "libmpv", fallbackReason: "embedded-initialization-failed",
    });
  });

  it("does not permanently disable libmpv for a bad media source or server failure", async () => {
    const launch = status("libmpv");
    const sourceError = new AppError("JELLYFIN_REQUEST_FAILED", "The recording stream failed.", 502);
    const initial: PlayerControllerRoute = {
      mode: "libmpv",
      controller: fakeController(async () => { throw sourceError; }),
    };
    const embedded = () => ({ mode: "embedded", controller: fakeController(async () => success) } satisfies PlayerControllerRoute);
    const legacy = () => ({ mode: "legacy", controller: fakeController(async () => success) } satisfies PlayerControllerRoute);
    const router = new PlayerControllerRouter(initial, launch, embedded, legacy);

    await expect(router.loadItem("broken-recording", "resume")).rejects.toBe(sourceError);
    expect(launch).toMatchObject({
      active: "libmpv",
      fallbackActive: false,
      fallbackReason: null,
    });
  });
});
