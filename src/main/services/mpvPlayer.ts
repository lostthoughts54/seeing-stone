import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { BaseWindow, BrowserWindow } from "electron";
import type {
  PlaybackStartResult,
  PlaybackState,
  PlaybackTrack,
} from "../../shared/contracts";
import { AppError } from "./errors";
import { MpvIpcClient, type MpvMessage } from "./mpvIpc";
import type { MpvRuntimePaths } from "./mpvRuntime";
import { PlaybackProxy } from "./playbackProxy";
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

function hwnd(window: BaseWindow): number {
  const value = window.getNativeWindowHandle();
  const handle = value.length >= 8 ? value.readBigUInt64LE() : BigInt(value.readUInt32LE());
  return Number(handle & 0xffffffffn);
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
  private host: BaseWindow | null = null;
  private process: ChildProcess | null = null;
  private ipc: MpvIpcClient | null = null;
  private source: ResolvedPlaybackSource | null = null;
  private proxyUrl: string | null = null;
  private proxy: PlaybackProxy;
  private listeners = new Set<(state: PlaybackState) => void>();
  private reportingTimer: ReturnType<typeof setInterval> | null = null;
  private reportingActive = false;
  private stopping = false;

  constructor(
    private readonly mainWindow: BrowserWindow,
    private readonly playback: PlaybackSessionService,
    private readonly reporting: PlaybackReportingService,
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
    this.update(emptyState({ itemId, phase: "resolving", source: "server" }));
    const source = await this.playback.start(itemId, resumeMode);
    this.source = source;
    this.update(emptyState({
      playbackId: source.playbackId,
      itemId,
      phase: "loading",
      source: "server",
      positionTicks: source.resumePositionTicks,
      durationTicks: source.durationTicks,
    }));
    try {
      const mediaUrl = await this.proxy.open(source);
      this.proxyUrl = mediaUrl;
      const host = this.createHost();
      this.host = host;
      await this.launchProcess(mediaUrl, source.resumePositionTicks, false);
      host.show();
      host.focus();
      await this.report("start");
      this.update({ ...this.state, phase: this.state.paused ? "paused" : "playing" });
      this.reportingTimer = setInterval(() => { void this.report("progress"); }, 10000);
      return {
        playbackId: source.playbackId,
        resumePositionTicks: source.resumePositionTicks,
        durationTicks: source.durationTicks,
        source: "server",
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

  setFullscreen(playbackId: string, fullscreen: boolean): PlaybackState {
    this.assertPlayback(playbackId);
    this.host?.setFullScreen(fullscreen);
    this.update({ ...this.state, fullscreen });
    return this.getState();
  }

  setWindowSize(width: number, height: number): { width: number; height: number } {
    const host = this.host;
    if (!host || host.isDestroyed()) throw new AppError("PLAYER_UNAVAILABLE", "The player window is unavailable.", 409);
    const safeWidth = Math.max(640, Math.min(7680, Math.round(width)));
    const safeHeight = Math.max(360, Math.min(4320, Math.round(height)));
    host.setSize(safeWidth, safeHeight);
    const bounds = host.getBounds();
    return { width: bounds.width, height: bounds.height };
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
    this.stopping = true;
    await this.report("stop");
    if (this.reportingTimer) clearInterval(this.reportingTimer);
    this.reportingTimer = null;
    const process = this.process;
    this.process = null;
    const ipc = this.ipc;
    this.ipc = null;
    await ipc?.command(["quit"]).catch(() => undefined);
    ipc?.close();
    if (process && !process.killed) process.kill();
    await this.proxy.close();
    this.proxyUrl = null;
    try { this.playback.stop(playbackId); } catch { /* Already cleared. */ }
    const host = this.host;
    this.host = null;
    if (host && !host.isDestroyed()) host.destroy();
    this.source = null;
    this.update(emptyState({ phase }));
    if (!this.mainWindow.isDestroyed()) {
      this.mainWindow.show();
      this.mainWindow.focus();
    }
    this.stopping = false;
    return this.getState();
  }

  async clear(): Promise<void> {
    if (this.source) await this.stop(this.source.playbackId);
    else this.update(emptyState());
  }

  private async launchProcess(mediaUrl: string, positionTicks: number, paused: boolean): Promise<void> {
    const host = this.host;
    if (!host || host.isDestroyed()) throw new AppError("PLAYER_UNAVAILABLE", "The player window is unavailable.", 409);
    const pipePath = `\\\\.\\pipe\\localfirst-jellyfin-${randomUUID()}`;
    const args = [
      "--no-config",
      "--terminal=no",
      "--force-window=yes",
      "--keep-open=no",
      "--hwdec=auto-safe",
      "--osc=yes",
      "--input-default-bindings=yes",
      `--input-conf=${this.runtime.inputConfig}`,
      `--input-ipc-server=${pipePath}`,
      `--wid=${hwnd(host)}`,
      `--start=${positionTicks / TICKS_PER_SECOND}`,
      ...(paused ? ["--pause=yes"] : []),
      "--",
      mediaUrl,
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
    const mediaUrl = this.proxyUrl;
    if (!mediaUrl) throw new AppError("SEEK_UNAVAILABLE", "Seeking is unavailable for this stream.", 422);
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
      await this.launchProcess(mediaUrl, positionTicks, paused);
      await this.report("progress");
    } catch {
      throw new AppError("SEEK_UNAVAILABLE", "Seeking is unavailable for this stream.", 422);
    }
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

  private createHost(): BaseWindow {
    const bounds = this.mainWindow.getBounds();
    // BaseWindow deliberately has no Chromium WebContents surface. On Windows,
    // attaching mpv to a BrowserWindow HWND can leave its native child window
    // behind Chromium's compositor: audio plays, but every video pixel is hidden.
    const host = new BaseWindow({
      parent: this.mainWindow,
      title: "LocalFirst Jellyfin Player",
      x: bounds.x,
      y: bounds.y,
      width: Math.max(720, bounds.width),
      height: Math.max(480, bounds.height),
      minWidth: 640,
      minHeight: 360,
      show: false,
      backgroundColor: "#000000",
      autoHideMenuBar: true,
    });
    host.setMenu(null);
    host.on("close", (event) => {
      if (this.stopping || !this.source) return;
      event.preventDefault();
      void this.stop(this.source.playbackId);
    });
    host.on("enter-full-screen", () => this.update({ ...this.state, fullscreen: true }));
    host.on("leave-full-screen", () => this.update({ ...this.state, fullscreen: false }));
    return host;
  }

  private handleMessage(message: MpvMessage): void {
    if (message.event === "client-message" && message.args?.[0] === "jellyfin-close" && this.source) {
      void this.stop(this.source.playbackId);
      return;
    }
    if (message.event === "client-message" && message.args?.[0] === "jellyfin-fullscreen" && this.source) {
      this.setFullscreen(this.source.playbackId, !this.state.fullscreen);
      return;
    }
    if (message.event === "end-file" && this.source) {
      void this.stop(this.source.playbackId, "ended");
      return;
    }
    if (message.event !== "property-change") return;
    const next = { ...this.state };
    if (message.name === "time-pos" && typeof message.data === "number") next.positionTicks = Math.max(0, Math.round(message.data * TICKS_PER_SECOND));
    if (message.name === "duration" && typeof message.data === "number") next.durationTicks = Math.max(next.durationTicks, Math.round(message.data * TICKS_PER_SECOND));
    if (message.name === "pause" && typeof message.data === "boolean") next.paused = message.data;
    if (message.name === "paused-for-cache" && typeof message.data === "boolean") next.buffering = message.data;
    if (message.name === "seekable" && typeof message.data === "boolean") next.seekable = message.data;
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

  private async report(kind: "start" | "progress" | "stop"): Promise<void> {
    if (!this.source) return;
    if (kind !== "start" && !this.reportingActive) return;
    if (kind === "stop") this.reportingActive = false;
    await this.reporting.acceptAuthoritativeEvent({
      kind,
      itemId: this.source.itemId,
      mediaSourceId: this.source.mediaSourceId,
      positionTicks: this.state.positionTicks,
      paused: this.state.paused,
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
