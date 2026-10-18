import type { AppUpdater } from "electron-updater";
import type { UpdateCheckStatus, UpdateSessionActivity } from "../../shared/contracts";
import type { AppLogger } from "./logger";

export type Updater = Pick<AppUpdater, "on" | "removeListener" | "checkForUpdates" | "quitAndInstall" | "autoDownload" | "autoInstallOnAppQuit" | "autoRunAppAfterInstall" | "allowPrerelease" | "allowDowngrade" | "channel" | "disableWebInstaller" | "logger">;
export const UPDATE_STARTUP_DELAY = 1500;
export const UPDATE_INTERVAL = 6 * 60 * 60 * 1000;

export function updateChannel(version: string): string {
  return /-([0-9A-Za-z-]+)/.exec(version)?.[1] ?? "latest";
}

export function updateUnavailableReason(build: { packaged: boolean; platform: string; arch: string; internal: boolean; installed: boolean; feed: boolean }): string | null {
  if (!build.packaged) return "Updates are unavailable in a development build. Install the Windows release to receive updates.";
  if (build.internal) return "Updates are unavailable in the internal player test build.";
  if (build.platform !== "win32" || build.arch !== "x64") return "Automatic updates currently support Windows x64 installations only.";
  if (!build.installed) return "Updates require an installed Seeing Stone release. Portable and unpacked builds must be replaced manually.";
  if (!build.feed) return "This installation is missing its update configuration. Reinstall Seeing Stone from an official installer.";
  return null;
}

function updateError(error: unknown): string {
  const detail = error instanceof Error ? `${(error as Error & { code?: string }).code ?? ""} ${error.message}` : "";
  if (/ENOSPC|disk.*space/i.test(detail)) return "There isn't enough disk space to download the update. Free some space and retry.";
  if (/sha512|checksum|signature|invalid.*(version|info)|ERR_UPDATER_INVALID|ERR_UPDATER_NO_FILES|ERR_UPDATER_NO_ASSET/i.test(detail)) return "The update could not be verified. Retry later; the release may need to be repaired.";
  if (/404|channel.*file|ERR_UPDATER_NO_PUBLISHED|ERR_UPDATER_LATEST_VERSION|ENOENT|yaml/i.test(detail)) return "The release feed or update metadata is missing or invalid. Retry later; the publisher may still be preparing the release.";
  if (/401|403/i.test(detail)) return "The release server denied access or reached its request limit. Retry later. Private releases require a distribution service.";
  return "Couldn't complete the update. Check your internet connection and retry.";
}

function hasSession(activity: UpdateSessionActivity): boolean { return activity.playback || activity.watchParty; }

/** Main-owned lifecycle; event handlers never mutate playback or open windows. */
export class UpdateChecker {
  private state: UpdateCheckStatus;
  private operation: Promise<void> | null = null;
  private installing = false;
  private disposed = false;
  private dismissed = false;
  private startupTimer: ReturnType<typeof setTimeout> | null = null;
  private periodicTimer: ReturnType<typeof setInterval> | null = null;
  private listeners = new Set<(state: UpdateCheckStatus) => void>();
  private unsubscribe: Array<() => void> = [];

  constructor(private readonly options: {
    appName: string; currentVersion: string; unavailableReason: string | null; updater: Updater | null;
    logger: AppLogger; activity: () => UpdateSessionActivity;
    confirmRestart: (activity: UpdateSessionActivity) => Promise<boolean>;
    shutdown: () => Promise<void>;
  }) {
    this.state = {
      revision: 0, appName: options.appName, currentVersion: options.currentVersion, channel: updateChannel(options.currentVersion),
      status: options.unavailableReason ? "unavailable" : "idle", latestVersion: null, progress: null,
      lastCheckedAt: null, message: options.unavailableReason, promptVisible: false, sessionActive: false,
    };
    const updater = options.updater;
    if (!updater || options.unavailableReason) return;
    updater.autoDownload = true;
    updater.autoInstallOnAppQuit = false;
    updater.autoRunAppAfterInstall = true;
    updater.channel = this.state.channel;
    updater.allowPrerelease = this.state.channel !== "latest";
    updater.allowDowngrade = false; // Setting channel enables downgrades by default.
    updater.disableWebInstaller = true;
    updater.logger = null; // Never log raw response bodies, paths, or URLs.
    const listen = <K extends keyof import("electron-updater/out/AppUpdater").AppUpdaterEvents>(event: K, handler: import("electron-updater/out/AppUpdater").AppUpdaterEvents[K]) => {
      updater.on(event, handler);
      this.unsubscribe.push(() => updater.removeListener(event, handler));
    };
    listen("checking-for-update", () => this.patch({ status: "checking", message: null }));
    listen("update-not-available", () => this.patch({ status: "current", lastCheckedAt: Date.now(), message: null }));
    listen("update-available", (info) => this.patch({ status: "downloading", latestVersion: info.version, lastCheckedAt: Date.now(), progress: null }));
    listen("download-progress", (info) => {
      const total = Number.isFinite(info.total) && info.total > 0 ? info.total : null;
      const transferred = Number.isFinite(info.transferred) && info.transferred >= 0 ? info.transferred : 0;
      this.patch({ status: "downloading", progress: { total, transferred, percent: total ? Math.min(100, Math.max(0, transferred / total * 100)) : null } });
    });
    listen("update-downloaded", (info) => {
      this.dismissed = false;
      this.patch({ status: "ready", latestVersion: info.version, message: null });
    });
    listen("error", (error) => this.fail(error));
    listen("update-cancelled", () => this.fail(new Error("Download cancelled")));
  }

  getState(): UpdateCheckStatus { return structuredClone(this.state); }
  onState(listener: (state: UpdateCheckStatus) => void): () => void {
    this.listeners.add(listener);
    listener(this.getState());
    return () => this.listeners.delete(listener);
  }

  start(): void {
    if (this.disposed || this.state.status === "unavailable" || this.periodicTimer) return;
    this.startupTimer = setTimeout(() => { this.startupTimer = null; void this.check(); }, UPDATE_STARTUP_DELAY);
    this.periodicTimer = setInterval(() => { void this.check(); }, UPDATE_INTERVAL);
    this.startupTimer.unref?.();
    this.periodicTimer.unref?.();
  }

  /** Return immediately; events carry check/download completion. */
  async check(): Promise<UpdateCheckStatus> {
    if (this.disposed || !this.options.updater || this.operation || this.installing || ["ready", "installing", "unavailable"].includes(this.state.status)) return this.getState();
    this.patch({ status: "checking", progress: null, latestVersion: null, message: null });
    this.operation = Promise.resolve().then(async () => {
      const result = await this.options.updater!.checkForUpdates();
      if (!result) { this.patch({ status: "unavailable", message: "Updates are disabled for this installation." }); return; }
      if (result.downloadPromise) await result.downloadPromise;
    }).catch((error: unknown) => this.fail(error)).finally(() => { this.operation = null; });
    return this.getState();
  }

  activityChanged(): void {
    const active = hasSession(this.options.activity());
    const promptVisible = this.state.status === "ready" && !this.dismissed && !active && !this.installing;
    if (active !== this.state.sessionActive || promptVisible !== this.state.promptVisible) this.patch({});
  }

  defer(): UpdateCheckStatus { this.dismissed = true; this.patch({}); return this.getState(); }

  async install(): Promise<UpdateCheckStatus> {
    if (this.disposed || !this.options.updater || this.installing || this.state.status !== "ready") return this.getState();
    this.installing = true;
    this.patch({});
    try {
      let confirmed: UpdateSessionActivity | null = null;
      // Re-read activity after confirmation; a new player/room requires new consent.
      while (true) {
        const activity = this.options.activity();
        if (!hasSession(activity) || confirmed?.key === activity.key) break;
        if (!await this.options.confirmRestart(activity)) return this.getState();
        confirmed = activity;
      }
      this.patch({ status: "installing", message: null });
      // shutdown() closes command intake synchronously, before its first await.
      await this.options.shutdown();
      this.options.updater.quitAndInstall(true, true);
    } catch (error) { this.fail(error); }
    finally { this.installing = false; this.patch({}); }
    return this.getState();
  }

  dispose(): void {
    if (this.startupTimer) clearTimeout(this.startupTimer);
    if (this.periodicTimer) clearInterval(this.periodicTimer);
    this.startupTimer = this.periodicTimer = null;
    this.disposed = true;
    for (const unsubscribe of this.unsubscribe) unsubscribe();
    this.unsubscribe = [];
    this.listeners.clear();
  }

  private fail(error: unknown): void {
    this.options.logger.warn("Application update failed.", { stage: this.state.status });
    if (this.state.status === "ready" || this.state.status === "installing") {
      this.patch({ status: "ready", message: "The installer could not start. Close and reopen Seeing Stone, then retry Restart & Update." });
    } else this.patch({ status: "error", message: updateError(error) });
  }

  private patch(patch: Partial<UpdateCheckStatus>): void {
    if (this.disposed) return;
    const sessionActive = hasSession(this.options.activity());
    this.state = { ...this.state, ...patch, revision: this.state.revision + 1, sessionActive };
    this.state.promptVisible = this.state.status === "ready" && !this.dismissed && !sessionActive && !this.installing;
    for (const listener of this.listeners) listener(this.getState());
  }
}
