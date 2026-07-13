import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import type { BrowserWindow } from "electron";
import type {
  PlaybackStartResult,
  PlaybackState,
  PlaybackTrack,
} from "../../shared/contracts";
import { AppError } from "./errors";
import { MpvIpcClient, type MpvMessage } from "./mpvIpc";
import type { MpvRuntimePaths } from "./mpvRuntime";
import { PlaybackCompletionCoordinator } from "./playbackCompletion";
import { PlaybackProxy } from "./playbackProxy";
import type { PlayerPreferencesStore } from "./playerPreferences";
import type { PlaybackReportingService } from "./playbackReporting";
import type { PlaybackSessionService, ResolvedPlaybackSource } from "./playbackSession";

const TICKS_PER_SECOND = 10_000_000;

function emptyState(overrides: Partial<PlaybackState> = {}): PlaybackState {
  return {
    playbackId: null,
    itemId: null,
    phase: "idle",
    source: null,
    positionTicks: 0,
    durationTicks: 0,
    paused: false,
    buffering: false,
    seekable: false,
    fullscreen: false,
    audioTracks: [],
    subtitleTracks: [],
    error: null,
    ...overrides,
  };
}

function tracks(value: unknown): { audioTracks: PlaybackTrack[]; subtitleTracks: PlaybackTrack[] } {
  const audioTracks: PlaybackTrack[] = [];
  const subtitleTracks: PlaybackTrack[] = [];
  for (const entry of Array.isArray(value) ? value : []) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const type = record.type === "audio" ? "audio" : record.type === "sub" ? "subtitle" : null;
    if (!type || typeof record.id !== "number") continue;
    const track: PlaybackTrack = {
      id: record.id,
      type,
      title: typeof record.title === "string" ? record.title.slice(0, 256) : null,
      language: typeof record.lang === "string" ? record.lang.slice(0, 32) : null,
      selected: record.selected === true,
    };
    (type === "audio" ? audioTracks : subtitleTracks).push(track);
  }
  return { audioTracks, subtitleTracks };
}

export class MpvPlayerService {
  private state = emptyState();
  private process: ChildProcess | null = null;
  private ipc: MpvIpcClient | null = null;
  private source: ResolvedPlaybackSource | null = null;
  private playbackTarget: string | null = null;
  private proxy: PlaybackProxy;
  private listeners = new Set<(state: PlaybackState) => void>();
  private reportingTimer: ReturnType<typeof setInterval> | null = null;
  private reportingActive = false;
  private stopping = false;
  private playbackRevision = 0;
  private endHandlingRevision: number | null = null;
  private replacingFile = false;
  private eofArmed = false;
  private windowMaximized = true;
  private readonly completion = new PlaybackCompletionCoordinator();

  constructor(
    private readonly mainWindow: BrowserWindow,
    private readonly playback: PlaybackSessionService,
    private readonly reporting: PlaybackReportingService,
    private readonly preferences: PlayerPreferencesStore,
    private readonly runtime: MpvRuntimePaths,
  ) {
    this.proxy = new PlaybackProxy(playback);
  }

  onState(listener: (state: PlaybackState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getState(): PlaybackState {
    return structuredClone(this.state);
  }

  async start(itemId: string, resumeMode: "resume" | "start-over"): Promise<PlaybackStartResult> {
    if (this.source) await this.stop(this.source.playbackId);
    const revision = ++this.playbackRevision;
    const preferences = await this.preferences.get().catch(() => ({ windowMaximized: true }));
    this.windowMaximized = preferences.windowMaximized;
    this.update(emptyState({ itemId, phase: "resolving" }));
    let source: ResolvedPlaybackSource;
    try {
      source = await this.playback.start(itemId, resumeMode);
    } catch (error) {
      if (revision === this.playbackRevision) {
        const message = error instanceof AppError ? error.message : "Playback could not be resolved.";
        this.update(emptyState({ itemId, phase: "error", error: message }));
      }
      throw error;
    }
    if (revision !== this.playbackRevision) throw new AppError("PLAYBACK_CANCELLED", "Playback was cancelled.");
    this.source = source;
    this.update(emptyState({
      playbackId: source.playbackId,
      itemId,
      phase: "loading",
      source: source.source,
      positionTicks: source.resumePositionTicks,
      durationTicks: source.durationTicks,
    }));
    try {
      const playbackTarget = await this.openPlaybackTarget(source);
      this.playbackTarget = playbackTarget;
      await this.launchProcess(playbackTarget, source.resumePositionTicks, false, this.windowMaximized);
      this.mainWindow.hide();
      await this.report("start");
      this.update({ ...this.state, phase: this.state.paused ? "paused" : "playing" });
      this.startReportingTimer();
      return {
        playbackId: source.playbackId,
        resumePositionTicks: source.resumePositionTicks,
        durationTicks: source.durationTicks,
        source: source.source,
      };
    } catch (error) {
      await this.failAndClean(error);
      throw error;
    }
  }

  async setPaused(playbackId: string, paused: boolean): Promise<PlaybackState> {
    this.assertPlayback(playbackId);
    await this.command(["set_property", "pause", paused]);
    return this.getState();
  }

  async seek(playbackId: string, positionTicks: number): Promise<PlaybackState> {
    this.assertPlayback(playbackId);
    const bounded = Math.max(0, Math.min(positionTicks, this.state.durationTicks || positionTicks));
    try {
      await this.command(["seek", bounded / TICKS_PER_SECOND, "absolute+exact"]);
    } catch {
      try {
        await this.command(["seek", bounded / TICKS_PER_SECOND, "absolute"]);
      } catch {
        await this.restartAt(bounded);
      }
    }
    return this.getState();
  }

  async selectAudio(playbackId: string, trackId: number | null): Promise<PlaybackState> {
    this.assertPlayback(playbackId);
    if (trackId !== null && !this.state.audioTracks.some((track) => track.id === trackId)) throw new AppError("INVALID_TRACK", "That audio track is unavailable.", 422);
    await this.command(["set_property", "aid", trackId ?? "no"]);
    return this.getState();
  }

  async selectSubtitle(playbackId: string, trackId: number | null): Promise<PlaybackState> {
    this.assertPlayback(playbackId);
    if (trackId !== null && !this.state.subtitleTracks.some((track) => track.id === trackId)) throw new AppError("INVALID_TRACK", "That subtitle track is unavailable.", 422);
    await this.command(["set_property", "sid", trackId ?? "no"]);
    return this.getState();
  }

  async setFullscreen(playbackId: string, fullscreen: boolean): Promise<PlaybackState> {
    this.assertPlayback(playbackId);
    await this.command(["set_property", "fullscreen", fullscreen]);
    this.update({ ...this.state, fullscreen });
    return this.getState();
  }

  async setWindowScale(scale: number): Promise<{ width: number; height: number }> {
    const safeScale = Math.max(0.25, Math.min(3, scale));
    await this.command(["set_property", "window-scale", safeScale]);
    await new Promise((resolve) => setTimeout(resolve, 250));
    return this.getOutputDimensions();
  }

  async getOutputDimensions(): Promise<{ width: number; height: number }> {
    const ipc = this.ipc;
    if (!ipc) throw new AppError("PLAYER_UNAVAILABLE", "The player is unavailable.", 409);
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const value = await ipc.command(["get_property", "osd-dimensions"]).catch(() => null);
      if (value && typeof value === "object") {
        const record = value as Record<string, unknown>;
        const width = typeof record.w === "number" ? record.w : 0;
        const height = typeof record.h === "number" ? record.h : 0;
        if (width > 0 && height > 0) return { width, height };
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new AppError("PLAYER_DIMENSIONS_UNAVAILABLE", "Player dimensions are unavailable.", 409);
  }

  async stop(playbackId: string, phase: "stopped" | "ended" = "stopped"): Promise<PlaybackState> {
    this.assertPlayback(playbackId);
    if (this.stopping) return this.getState();
    this.playbackRevision += 1;
    this.endHandlingRevision = null;
    this.replacingFile = false;
    this.eofArmed = false;
    this.stopping = true;
    try {
      await this.persistWindowStateIfWindowed(this.ipc).catch(() => undefined);
      await this.report("stop");
      this.stopReportingTimer();
      const process = this.process;
      this.process = null;
      const ipc = this.ipc;
      this.ipc = null;
      await ipc?.command(["quit"]).catch(() => undefined);
      ipc?.close();
      if (process && !process.killed) process.kill();
      await this.proxy.close();
      this.playbackTarget = null;
      try { this.playback.stop(playbackId); } catch { /* Already cleared. */ }
      this.source = null;
      this.update(emptyState({ phase }));
      if (!this.mainWindow.isDestroyed()) {
        this.mainWindow.show();
        this.mainWindow.focus();
      }
      return this.getState();
    } finally {
      this.stopping = false;
    }
  }

  async clear(): Promise<void> {
    if (this.source) await this.stop(this.source.playbackId);
    else {
      this.playbackRevision += 1;
      this.playback.clear();
      this.update(emptyState());
    }
  }

  private async openPlaybackTarget(source: ResolvedPlaybackSource): Promise<string> {
    await this.proxy.close();
    return source.source === "local" ? source.mediaUrl : this.proxy.open(source);
  }

  private async launchProcess(playbackTarget: string, positionTicks: number, paused: boolean, windowMaximized: boolean): Promise<void> {
    this.eofArmed = false;
    const pipePath = `\\\\.\\pipe\\localfirst-jellyfin-${randomUUID()}`;
    const args = [
      "--no-config",
      "--terminal=no",
      "--force-window=immediate",
      "--keep-open=yes",
      "--hwdec=auto-safe",
      "--osc=yes",
      "--input-default-bindings=yes",
      "--title=LocalFirst Jellyfin Player",
      "--geometry=1280x720",
      `--window-maximized=${windowMaximized ? "yes" : "no"}`,
      `--input-conf=${this.runtime.inputConfig}`,
      `--input-ipc-server=${pipePath}`,
      `--start=${positionTicks / TICKS_PER_SECOND}`,
      ...(paused ? ["--pause=yes"] : []),
      "--",
      playbackTarget,
    ];
    const child = spawn(this.runtime.executable, args, { windowsHide: true, stdio: ["ignore", "ignore", "ignore"] });
    this.process = child;
    child.once("exit", () => {
      if (this.process !== child) return;
      this.process = null;
      if (!this.stopping && this.source) void this.stop(this.source.playbackId, "ended");
    });
    const ipc = new MpvIpcClient();
    this.ipc = ipc;
    ipc.onMessage((message) => { if (this.ipc === ipc) this.handleMessage(message); });
    await ipc.connect(pipePath);
    await Promise.all([
      ipc.observe(1, "time-pos"),
      ipc.observe(2, "duration"),
      ipc.observe(3, "pause"),
      ipc.observe(4, "paused-for-cache"),
      ipc.observe(5, "track-list"),
      ipc.observe(6, "seekable"),
      ipc.observe(7, "fullscreen"),
      ipc.observe(8, "window-maximized"),
      ipc.observe(9, "eof-reached"),
    ]);
    const authoritativePosition = await this.waitForPropertyNumber(ipc, "time-pos");
    this.update({
      ...this.state,
      positionTicks: Math.max(0, Math.round(authoritativePosition * TICKS_PER_SECOND)),
      paused,
      phase: this.reportingActive ? (paused ? "paused" : "playing") : "loading",
    });
  }

  private async restartAt(positionTicks: number): Promise<void> {
    const playbackTarget = this.playbackTarget;
    if (!playbackTarget) throw new AppError("SEEK_UNAVAILABLE", "Seeking is unavailable for this media.", 422);
    const paused = this.state.paused;
    const oldProcess = this.process;
    const oldIpc = this.ipc;
    this.process = null;
    this.ipc = null;
    await oldIpc?.command(["quit"]).catch(() => undefined);
    oldIpc?.close();
    if (oldProcess && !oldProcess.killed) oldProcess.kill();
    this.update({ ...this.state, phase: "loading", buffering: true });
    try {
      await this.launchProcess(playbackTarget, positionTicks, paused, this.windowMaximized);
      await this.report("progress");
    } catch {
      throw new AppError("SEEK_UNAVAILABLE", "Seeking is unavailable for this stream.", 422);
    }
  }

  private async handleNaturalEnd(revision: number, completedSource: ResolvedPlaybackSource): Promise<void> {
    try {
      if (!this.isCurrent(revision, completedSource)) return;
      this.update({
        ...this.state,
        phase: "ended",
        paused: true,
        buffering: false,
        positionTicks: Math.max(this.state.positionTicks, this.state.durationTicks),
      });
      await this.report("stop", "completed");
      this.stopReportingTimer();
      if (!this.isCurrent(revision, completedSource)) return;

      try { this.playback.stop(completedSource.playbackId); } catch { /* Already finalized. */ }
      await this.proxy.close();
      this.playbackTarget = null;

      if (completedSource.itemType !== "Episode" || !completedSource.seriesId) {
        await this.stop(completedSource.playbackId, "ended");
        return;
      }

      const nextEpisode = await this.completion.findNextEpisode(
        completedSource.itemId,
        () => this.playback.getNextUpForSeries(completedSource.seriesId!),
        () => this.isCurrent(revision, completedSource),
      );
      if (!nextEpisode || !this.isCurrent(revision, completedSource)) {
        if (this.isCurrent(revision, completedSource)) await this.stop(completedSource.playbackId, "ended");
        return;
      }

      const continuePlayback = await this.completion.countdown({
        isCurrent: () => this.isCurrent(revision, completedSource),
        show: (remaining) => this.command(["show-text", `Next episode in ${remaining} seconds\nEsc to exit`, 1100]),
      });
      if (!continuePlayback || !this.isCurrent(revision, completedSource)) return;
      await this.transitionToNextEpisode(revision, completedSource, nextEpisode.id);
    } catch {
      if (this.isCurrent(revision, completedSource)) await this.stop(completedSource.playbackId, "ended").catch(() => undefined);
    } finally {
      if (this.endHandlingRevision === revision) this.endHandlingRevision = null;
    }
  }

  private async transitionToNextEpisode(
    completedRevision: number,
    completedSource: ResolvedPlaybackSource,
    nextItemId: string,
  ): Promise<void> {
    const ipc = this.ipc;
    if (!ipc || !this.isCurrent(completedRevision, completedSource)) return;
    const nextSource = await this.playback.start(nextItemId, "start-over");
    if (!this.isCurrent(completedRevision, completedSource)) {
      try { this.playback.stop(nextSource.playbackId); } catch { /* Cancelled concurrently. */ }
      return;
    }
    const playbackTarget = await this.openPlaybackTarget(nextSource);
    if (!this.isCurrent(completedRevision, completedSource)) {
      await this.proxy.close();
      try { this.playback.stop(nextSource.playbackId); } catch { /* Cancelled concurrently. */ }
      return;
    }

    const revision = ++this.playbackRevision;
    this.source = nextSource;
    this.playbackTarget = playbackTarget;
    this.reportingActive = false;
    this.update(emptyState({
      playbackId: nextSource.playbackId,
      itemId: nextSource.itemId,
      phase: "loading",
      source: nextSource.source,
      durationTicks: nextSource.durationTicks,
    }));

    try {
      this.replacingFile = true;
      this.eofArmed = false;
      try {
        const fileLoaded = this.waitForEvent(ipc, "file-loaded", 15000);
        void fileLoaded.catch(() => undefined);
        await ipc.command(["loadfile", playbackTarget, "replace"]);
        await fileLoaded;
      } finally {
        this.replacingFile = false;
      }
      if (!this.isCurrent(revision, nextSource)) return;
      const position = await this.waitForPropertyNumber(ipc, "time-pos");
      this.update({
        ...this.state,
        positionTicks: Math.max(0, Math.round(position * TICKS_PER_SECOND)),
        paused: false,
        phase: "loading",
      });
      await this.report("start");
      if (!this.isCurrent(revision, nextSource)) return;
      this.update({ ...this.state, phase: "playing" });
      this.startReportingTimer();
    } catch (error) {
      if (this.isCurrent(revision, nextSource)) {
        await this.stop(nextSource.playbackId, "ended").catch(() => undefined);
      }
      throw error;
    }
  }

  private isCurrent(revision: number, source: ResolvedPlaybackSource): boolean {
    return this.playbackRevision === revision && this.source === source && !this.stopping;
  }

  private waitForEvent(ipc: MpvIpcClient, eventName: string, timeoutMilliseconds: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let unsubscribe: () => void = () => undefined;
      const timer = setTimeout(() => {
        unsubscribe();
        reject(new Error(`Timed out waiting for mpv ${eventName}.`));
      }, timeoutMilliseconds);
      unsubscribe = ipc.onMessage((message) => {
        if (message.event !== eventName) return;
        clearTimeout(timer);
        unsubscribe();
        resolve();
      });
    });
  }

  private startReportingTimer(): void {
    this.stopReportingTimer();
    this.reportingTimer = setInterval(() => { void this.report("progress"); }, 10000);
  }

  private stopReportingTimer(): void {
    if (this.reportingTimer) clearInterval(this.reportingTimer);
    this.reportingTimer = null;
  }

  private async persistWindowStateIfWindowed(ipc: MpvIpcClient | null): Promise<void> {
    if (!ipc) return;
    const fullscreen = await ipc.command(["get_property", "fullscreen"]).catch(() => this.state.fullscreen);
    if (fullscreen === true) return;
    const maximized = await ipc.command(["get_property", "window-maximized"]).catch(() => this.windowMaximized);
    if (typeof maximized !== "boolean") return;
    this.windowMaximized = maximized;
    await this.preferences.setWindowMaximized(maximized);
  }

  private async waitForPropertyNumber(ipc: MpvIpcClient, property: string): Promise<number> {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const value = await ipc.command(["get_property", property]).catch(() => null);
      if (typeof value === "number" && Number.isFinite(value)) return value;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`mpv property ${property} was unavailable.`);
  }

  private handleMessage(message: MpvMessage): void {
    if (message.event === "client-message" && message.args?.[0] === "jellyfin-close" && this.source) {
      void this.stop(this.source.playbackId);
      return;
    }
    if (message.event === "client-message" && message.args?.[0] === "jellyfin-fullscreen" && this.source) {
      void this.setFullscreen(this.source.playbackId, !this.state.fullscreen).catch(() => undefined);
      return;
    }
    if (message.event === "end-file" && this.source) {
      if (this.replacingFile && message.reason === "stop") return;
      if (message.reason === "eof") {
        this.eofArmed = false;
        const revision = this.playbackRevision;
        if (this.endHandlingRevision === revision) return;
        this.endHandlingRevision = revision;
        void this.handleNaturalEnd(revision, this.source);
      } else if (!this.stopping) {
        void this.stop(this.source.playbackId, "ended").catch(() => undefined);
      }
      return;
    }
    if (message.event !== "property-change") return;
    if (message.name === "eof-reached" && message.data === false) {
      this.eofArmed = true;
      return;
    }
    if (message.name === "eof-reached" && message.data === true && this.source) {
      if (this.replacingFile || !this.eofArmed) return;
      this.eofArmed = false;
      const revision = this.playbackRevision;
      if (this.endHandlingRevision === revision) return;
      this.endHandlingRevision = revision;
      void this.handleNaturalEnd(revision, this.source);
      return;
    }
    const next = { ...this.state };
    if (message.name === "time-pos" && typeof message.data === "number") next.positionTicks = Math.max(0, Math.round(message.data * TICKS_PER_SECOND));
    if (message.name === "duration" && typeof message.data === "number") next.durationTicks = Math.max(next.durationTicks, Math.round(message.data * TICKS_PER_SECOND));
    if (message.name === "pause" && typeof message.data === "boolean") next.paused = message.data;
    if (message.name === "paused-for-cache" && typeof message.data === "boolean") next.buffering = message.data;
    if (message.name === "seekable" && typeof message.data === "boolean") next.seekable = message.data;
    if (message.name === "fullscreen" && typeof message.data === "boolean") next.fullscreen = message.data;
    if (message.name === "window-maximized" && typeof message.data === "boolean") {
      void this.persistWindowStateIfWindowed(this.ipc).catch(() => undefined);
    }
    if (message.name === "track-list") Object.assign(next, tracks(message.data));
    next.phase = this.reportingActive
      ? (next.buffering ? "buffering" : next.paused ? "paused" : "playing")
      : "loading";
    this.update(next);
    if (message.name === "pause") void this.report("progress");
  }

  private async command(command: unknown[]): Promise<void> {
    if (!this.ipc) throw new AppError("PLAYER_UNAVAILABLE", "The player is unavailable.", 409);
    await this.ipc.command(command);
  }

  private assertPlayback(playbackId: string): void {
    if (!this.source || this.source.playbackId !== playbackId) throw new AppError("INVALID_PLAYBACK", "That playback session is no longer active.", 409);
  }

  private async report(
    kind: "start" | "progress" | "stop",
    actionKind?: "progress" | "completed" | "start_over" | "replay" | "mark_watched" | "mark_unwatched",
  ): Promise<void> {
    if (!this.source) return;
    if (kind !== "start" && !this.reportingActive) return;
    if (kind === "stop") this.reportingActive = false;
    await this.reporting.acceptAuthoritativeEvent({
      kind,
      itemId: this.source.itemId,
      mediaSourceId: this.source.mediaSourceId,
      playMethod: this.source.source === "local"
        ? "DirectPlay"
        : this.source.delivery === "transcode" ? "Transcode" : "DirectStream",
      positionTicks: this.state.positionTicks,
      paused: this.state.paused,
      actionKind: actionKind ?? (kind === "start" ? this.source.initialAction : "progress"),
      watched: actionKind === "completed" || actionKind === "mark_watched",
    });
    if (kind === "start") this.reportingActive = true;
  }

  private update(state: PlaybackState): void {
    this.state = state;
    const snapshot = this.getState();
    for (const listener of this.listeners) listener(snapshot);
  }

  private async failAndClean(error: unknown): Promise<void> {
    const playbackId = this.source?.playbackId;
    if (playbackId) {
      try { await this.stop(playbackId); } catch { /* Preserve original failure. */ }
    }
    const message = error instanceof AppError ? error.message : "mpv playback could not be started.";
    this.update(emptyState({ phase: "error", error: message }));
  }
}
