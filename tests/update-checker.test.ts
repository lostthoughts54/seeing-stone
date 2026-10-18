import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UpdateChecker, UPDATE_INTERVAL, UPDATE_STARTUP_DELAY, updateChannel, updateUnavailableReason, type Updater } from "../src/main/services/updateChecker";
import { getUpdateSessionActivity } from "../src/main/services/updateSessionActivity";
import { updateProgressText, updateStatusText } from "../src/renderer/updates";
import type { PlaybackState, UpdateSessionActivity } from "../src/shared/contracts";

const idle = (): UpdateSessionActivity => ({ playback: false, watchParty: false, key: "idle" });
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function deferred<T>() { let resolve!: (v: T) => void; let reject!: (e: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function harness(unavailableReason: string | null = null, version = "0.7.3") {
  const emitter = new EventEmitter();
  const updater = Object.assign(emitter, { checkForUpdates: vi.fn(async (): Promise<any> => {
    emitter.emit("update-not-available", { version }); return { downloadPromise: null };
  }), quitAndInstall: vi.fn() }) as unknown as Updater & { checkForUpdates: ReturnType<typeof vi.fn>; quitAndInstall: ReturnType<typeof vi.fn> };
  let activity = idle();
  const shutdown = vi.fn(async () => {});
  const confirmRestart = vi.fn(async () => false);
  const service = new UpdateChecker({ appName: "Seeing Stone", currentVersion: version, unavailableReason, updater,
    logger: { info() {}, warn() {}, error() {} }, activity: () => ({ ...activity }), shutdown, confirmRestart });
  return { service, emitter, updater, shutdown, confirmRestart, setActivity: (value: UpdateSessionActivity) => { activity = value; service.activityChanged(); } };
}

afterEach(() => vi.useRealTimers());
describe("real updater lifecycle adapter", () => {
  it("checks manually, downloads automatically, reports progress, retains ready state and Later", async () => {
    const h = harness(); const download = deferred<string[]>();
    h.updater.checkForUpdates.mockImplementation(async () => { h.emitter.emit("update-available", { version: "0.7.4" }); return { downloadPromise: download.promise }; });
    expect(h.updater.autoDownload).toBe(true);
    expect(h.updater.autoInstallOnAppQuit).toBe(false);
    expect((await h.service.check()).status).toBe("checking"); await flush();
    expect(h.service.getState()).toMatchObject({ status: "downloading", latestVersion: "0.7.4" });
    h.emitter.emit("download-progress", { total: 200, transferred: 50, percent: 25 });
    expect(h.service.getState().progress).toEqual({ total: 200, transferred: 50, percent: 25 });
    await h.service.check(); expect(h.updater.checkForUpdates).toHaveBeenCalledOnce();
    h.emitter.emit("update-downloaded", { version: "0.7.4" }); download.resolve([]); await flush();
    expect(h.service.getState()).toMatchObject({ status: "ready", promptVisible: true });
    h.service.defer(); await h.service.check();
    expect(h.service.getState()).toMatchObject({ status: "ready", latestVersion: "0.7.4", promptVisible: false });
    expect(h.updater.checkForUpdates).toHaveBeenCalledOnce();
    const reopened = vi.fn(); const unsubscribe = h.service.onState(reopened);
    expect(reopened).toHaveBeenLastCalledWith(h.service.getState()); unsubscribe();
    const snapshot = h.service.getState(); snapshot.status = "idle";
    expect(h.service.getState().status).toBe("ready");
    expect(h.shutdown).not.toHaveBeenCalled(); expect(h.updater.quitAndInstall).not.toHaveBeenCalled();
  });
  it("serializes automatic/manual checks until download promises settle, including errors", async () => {
    const h = harness(); const request = deferred<any>(); h.updater.checkForUpdates.mockReturnValue(request.promise);
    await Promise.all([h.service.check(), h.service.check(), h.service.check()]);
    expect(h.updater.checkForUpdates).toHaveBeenCalledOnce();
    h.emitter.emit("error", new Error("offline")); await h.service.check();
    expect(h.updater.checkForUpdates).toHaveBeenCalledOnce();
    request.reject(new Error("offline")); await flush();
    expect(h.service.getState()).toMatchObject({ status: "error", message: expect.stringMatching(/internet/) });
    h.updater.checkForUpdates.mockImplementation(async () => { h.emitter.emit("update-not-available", {}); return {}; });
    await h.service.check(); await flush(); expect(h.service.getState().status).toBe("current");
  });
  it.each([['404 channel file', /metadata/], ['sha512 checksum failed', /verified/], ['ENOSPC', /disk space/], ['403', /denied/]])("sanitizes %s errors", async (detail, expected) => {
    const h = harness(); h.updater.checkForUpdates.mockRejectedValue(new Error(`${detail} token=private-secret`));
    await h.service.check(); await flush(); expect(h.service.getState().message).toMatch(expected);
    expect(JSON.stringify(h.service.getState())).not.toContain("private-secret");
  });
  it("handles rejected downloads and cancellation without unhandled promises", async () => {
    const h = harness(); h.updater.checkForUpdates.mockImplementation(async () => { h.emitter.emit("update-available", { version: "0.7.4" }); return { downloadPromise: Promise.reject(new Error("network")) }; });
    await h.service.check(); await flush(); expect(h.service.getState().status).toBe("error");
    h.emitter.emit("update-cancelled"); expect(h.service.getState().status).toBe("error");
  });
  it("handles unknown and malformed progress totals without NaN", () => {
    const h = harness();
    h.emitter.emit("download-progress", { total: 0, transferred: 512, percent: NaN });
    expect(h.service.getState().progress).toEqual({ total: null, transferred: 512, percent: null });
    expect(updateProgressText(h.service.getState())).toMatch(/total size unknown/);
    h.emitter.emit("download-progress", { total: Infinity, transferred: NaN, percent: Infinity });
    expect(h.service.getState().progress).toEqual({ total: null, transferred: 0, percent: null });
  });
  it("runs the startup and periodic checks once, and disposes timers/listeners", async () => {
    vi.useFakeTimers(); const h = harness(); h.service.start(); h.service.start();
    await vi.advanceTimersByTimeAsync(UPDATE_STARTUP_DELAY); expect(h.updater.checkForUpdates).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(UPDATE_INTERVAL); expect(h.updater.checkForUpdates).toHaveBeenCalledTimes(2);
    h.service.dispose(); expect(h.emitter.listenerCount("update-downloaded")).toBe(0);
    await vi.advanceTimersByTimeAsync(UPDATE_INTERVAL * 2); expect(h.updater.checkForUpdates).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("keeps checks/downloads quiet during playback and rooms, then defers prompts correctly", async () => {
    const h = harness(); h.setActivity({ playback: true, watchParty: true, key: "session" });
    await h.service.check(); await flush(); h.emitter.emit("update-downloaded", { version: "0.7.4" });
    expect(h.service.getState()).toMatchObject({ status: "ready", promptVisible: false, sessionActive: true });
    expect(h.shutdown).not.toHaveBeenCalled(); expect(h.confirmRestart).not.toHaveBeenCalled();
    h.setActivity(idle()); expect(h.service.getState().promptVisible).toBe(true);
    h.setActivity({ playback: false, watchParty: true, key: "room" }); expect(h.service.getState().promptVisible).toBe(false);
    h.service.defer(); h.setActivity(idle()); expect(h.service.getState().promptVisible).toBe(false);
  });
  it("cancellation retains the session and downloaded update", async () => {
    const h = harness(); h.emitter.emit("update-downloaded", { version: "0.7.4" });
    h.setActivity({ playback: true, watchParty: true, key: "session" });
    await h.service.install(); expect(h.confirmRestart).toHaveBeenCalledOnce();
    expect(h.service.getState().status).toBe("ready"); expect(h.shutdown).not.toHaveBeenCalled(); expect(h.updater.quitAndInstall).not.toHaveBeenCalled();
  });
  it("rechecks activity after confirmation and prevents concurrent restart requests", async () => {
    const h = harness(); h.emitter.emit("update-downloaded", { version: "0.7.4" });
    h.setActivity({ playback: true, watchParty: false, key: "first" });
    const confirmation = deferred<boolean>(); h.confirmRestart.mockReturnValueOnce(confirmation.promise);
    const pending = h.service.install(); await h.service.install(); expect(h.confirmRestart).toHaveBeenCalledOnce();
    h.setActivity({ playback: true, watchParty: true, key: "new-session" }); confirmation.resolve(true);
    await pending; expect(h.confirmRestart).toHaveBeenCalledTimes(2); expect(h.shutdown).not.toHaveBeenCalled();
  });
  it("awaits cleanup before explicit installation and never installs again", async () => {
    const h = harness(); h.emitter.emit("update-downloaded", { version: "0.7.4" });
    h.setActivity({ playback: true, watchParty: true, key: "active" }); h.confirmRestart.mockResolvedValue(true);
    const cleanup = deferred<void>(); h.shutdown.mockReturnValue(cleanup.promise);
    const pending = h.service.install(); await flush(); expect(h.shutdown).toHaveBeenCalledOnce(); expect(h.updater.quitAndInstall).not.toHaveBeenCalled();
    cleanup.resolve(); await pending; expect(h.updater.quitAndInstall).toHaveBeenCalledWith(true, true);
    await h.service.install(); expect(h.updater.quitAndInstall).toHaveBeenCalledOnce();
  });
  it("never checks unavailable builds or interprets an inactive updater as current", async () => {
    vi.useFakeTimers(); const h = harness("Development build"); h.service.start(); await h.service.check();
    await vi.advanceTimersByTimeAsync(UPDATE_INTERVAL); expect(h.updater.checkForUpdates).not.toHaveBeenCalled();
    expect(h.service.getState().status).toBe("unavailable");
    const inactive = harness(); inactive.updater.checkForUpdates.mockResolvedValue(null);
    await inactive.service.check(); await flush(); expect(inactive.service.getState().status).toBe("unavailable");
  });
  it("configures stable/beta channels without downgrades", () => {
    expect(updateChannel("1.0.0")).toBe("latest"); expect(updateChannel("1.1.0-beta.2")).toBe("beta");
    expect(harness().updater.allowPrerelease).toBe(false);
    const beta = harness(null, "1.1.0-beta.2"); expect(beta.updater.channel).toBe("beta"); expect(beta.updater.allowPrerelease).toBe(true); expect(beta.updater.allowDowngrade).toBe(false);
  });
  it("identifies unsupported installations", () => {
    const supported = { packaged: true, platform: "win32", arch: "x64", internal: false, installed: true, feed: true };
    expect(updateUnavailableReason(supported)).toBeNull();
    for (const patch of [{ packaged: false }, { internal: true }, { installed: false }, { feed: false }, { platform: "linux" }, { arch: "arm64" }]) expect(updateUnavailableReason({ ...supported, ...patch })).toBeTruthy();
  });
  it("maps the actual player and all three room systems to restart protection", () => {
    for (const phase of ["resolving", "loading", "ready", "playing", "paused", "buffering", "stalled", "disconnected"] as const) expect(getUpdateSessionActivity({ phase, playbackId: "p" } as PlaybackState).playback).toBe(true);
    const player = { phase: "idle", playbackId: null } as PlaybackState;
    expect(getUpdateSessionActivity(player).playback).toBe(false);
    expect(getUpdateSessionActivity({ ...player, nextEpisodeCountdown: {} } as PlaybackState).playback).toBe(true);
    expect(getUpdateSessionActivity(player, { joinedGroup: { groupId: "s" } } as never).watchParty).toBe(true);
    expect(getUpdateSessionActivity(player, undefined, { room: { inviteToken: "y" } } as never).watchParty).toBe(true);
    expect(getUpdateSessionActivity(player, undefined, undefined, { room: { id: "f" } } as never).watchParty).toBe(true);
  });
  it("presents distinct unavailable/current/downloading/ready states", () => {
    const state = harness().service.getState();
    expect(updateStatusText({ ...state, status: "current" })).toMatch(/latest/);
    expect(updateStatusText({ ...state, status: "unavailable" })).toMatch(/unavailable/);
    expect(updateStatusText({ ...state, status: "ready", latestVersion: "0.7.4" })).toMatch(/0.7.4.*ready/);
    expect(updateProgressText({ ...state, progress: { percent: 50, transferred: 1024 ** 2, total: 2 * 1024 ** 2 } })).toBe("50% · 1.0 MB / 2.0 MB");
  });
});
