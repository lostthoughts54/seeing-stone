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
import { PlaybackProxy, type PlaybackTargets } from "./playbackProxy";
import type { PlayerPreferencesStore } from "./playerPreferences";
import type {
  PlayerAction,
  PlayerCommandContext,
  PlayerController,
  PlayerControllerEvent,
} from "./playerController";
import type { PlaybackReportingService } from "./playbackReporting";
import type { PlaybackSessionService, ResolvedPlaybackSource } from "./playbackSession";
import type { MpvVideoHost } from "./embeddedVideoHost";

const TICKS_PER_SECOND = 10_000_000;

interface MutablePlaybackSnapshot {
  volume: number;
  rate: number;
  fullscreen: boolean;
  audioTracksKnown: boolean;
  subtitleTracksKnown: boolean;
  selectedAudio: PlaybackTrack | null;
  selectedSubtitle: PlaybackTrack | null;
  externalSubtitleStreamIndex: number | null;
}

function emptyState(overrides: Partial<PlaybackState> = {}): PlaybackState {
  return {
    playbackId: null,
    itemId: null,
    phase: "idle",
    source: null,
    diagnostics: {
      sourceKind: null, playbackRate: 1, bufferAheadTicks: null, container: null,
      videoCodec: null, audioCodec: null, audioChannels: null, resolution: null,
      bitrate: null, videoRange: null, transcodeReason: null,
    },
    positionTicks: 0,
    durationTicks: 0,
    paused: false,
    buffering: false,
    seekable: false,
    volume: 100,
    fullscreen: false,
    audioTracks: [],
    subtitleTracks: [],
    error: null,
    ...overrides,
  };
}

export function parsePlaybackTracks(value: unknown): { audioTracks: PlaybackTrack[]; subtitleTracks: PlaybackTrack[] } {
  const audioTracks: PlaybackTrack[] = [];
  const subtitleTracks: PlaybackTrack[] = [];
  for (const entry of Array.isArray(value) ? value : []) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const type = record.type === "audio" ? "audio" : record.type === "sub" ? "subtitle" : null;
    if (!type || typeof record.id !== "number") continue;
    const track: PlaybackTrack = {
      id: record.id,
      streamIndex: typeof record["ff-index"] === "number" && Number.isSafeInteger(record["ff-index"])
        ? record["ff-index"]
        : null,
      type,
      title: typeof record.title === "string" ? record.title.slice(0, 256) : null,
      language: typeof record.lang === "string" ? record.lang.slice(0, 32) : null,
      selected: record.selected === true,
      codec: typeof record.codec === "string" ? record.codec.slice(0, 32) : null,
      channels: typeof record["demux-channel-count"] === "number" ? record["demux-channel-count"] : null,
      isDefault: record.default === true,
      isForced: record.forced === true,
      external: record.external === true,
    };
    (type === "audio" ? audioTracks : subtitleTracks).push(track);
  }
  return { audioTracks, subtitleTracks };
}

export class MpvPlayerService implements PlayerController {
  private state = emptyState();
  private process: ChildProcess | null = null;
  private ipc: MpvIpcClient | null = null;
  private source: ResolvedPlaybackSource | null = null;
  private playbackTarget: PlaybackTargets | null = null;
  private proxy: PlaybackProxy;
  private listeners = new Set<(state: PlaybackState) => void>();
  private eventListeners = new Set<(event: PlayerControllerEvent) => void>();
  private reportingTimer: ReturnType<typeof setInterval> | null = null;
  private stalledTimer: ReturnType<typeof setTimeout> | null = null;
  private reportingActive = false;
  private stopping = false;
  private playbackRevision = 0;
  private endHandlingRevision: number | null = null;
  private replacingFile = false;
  private eofArmed = false;
  private windowMaximized = true;
  private readonly completion = new PlaybackCompletionCoordinator();
  private controllerRevision = 0;
  private playbackRate = 1;
  private automaticTransitionsEnabled = true;
  private pendingPause: { paused: boolean; expiresAt: number } | null = null;
  private pendingSeek: { positionTicks: number; expiresAt: number } | null = null;
  private pendingFullscreen: { fullscreen: boolean; expiresAt: number } | null = null;
  private timelineBaseTicks = 0;
  private rawTimePositionSeconds = 0;
  private demuxerCacheTimeSeconds: number | null = null;
  private readonly externalSubtitleStreamByTrackId = new Map<number, number>();

  constructor(
    private readonly mainWindow: BrowserWindow,
    private readonly playback: PlaybackSessionService,
    private readonly reporting: PlaybackReportingService,
    private readonly preferences: PlayerPreferencesStore,
    private readonly runtime: MpvRuntimePaths,
    private readonly videoHost?: MpvVideoHost,
  ) {
    this.proxy = new PlaybackProxy(playback);
  }

  onState(listener: (state: PlaybackState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onEvent(listener: (event: PlayerControllerEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  getState(): PlaybackState {
    return structuredClone(this.state);
  }

  getControllerRevision(): number {
    return this.controllerRevision;
  }

  getPlaybackRate(): number {
    return this.playbackRate;
  }

  setAutomaticTransitionsEnabled(enabled: boolean): void {
    this.automaticTransitionsEnabled = enabled;
  }

  load(
    itemId: string,
    resumeMode: "resume" | "start-over",
    context: PlayerCommandContext = { origin: "local-user" },
  ): Promise<PlaybackStartResult> {
    return this.loadItem(itemId, resumeMode, context);
  }

  play(playbackId: string, context: PlayerCommandContext = { origin: "local-user" }): Promise<PlaybackState> {
    return this.setPaused(playbackId, false, context);
  }

  pause(playbackId: string, context: PlayerCommandContext = { origin: "local-user" }): Promise<PlaybackState> {
    return this.setPaused(playbackId, true, context);
  }

  setRate(
    playbackId: string,
    rate: number,
    context: PlayerCommandContext = { origin: "local-user" },
  ): Promise<PlaybackState> {
    return this.setPlaybackRate(playbackId, rate, context);
  }

  async setVolume(
    playbackId: string,
    volume: number,
    context: PlayerCommandContext = { origin: "local-user" },
  ): Promise<PlaybackState> {
    this.assertPlayback(playbackId);
    if (!Number.isFinite(volume) || volume < 0 || volume > 100) {
      throw new AppError("INVALID_PLAYBACK_VOLUME", "Playback volume must be between 0 and 100.", 422);
    }
    await this.command(["set_property", "volume", volume]);
    this.update({ ...this.state, volume }, "volume", context);
    return this.getState();
  }

  loadItem(
    itemId: string,
    resumeMode: "resume" | "start-over",
    context: PlayerCommandContext = { origin: "local-user" },
  ): Promise<PlaybackStartResult> {
    return this.start(itemId, resumeMode, context);
  }

  async start(
    itemId: string,
    resumeMode: "resume" | "start-over",
    context: PlayerCommandContext = { origin: "local-user" },
  ): Promise<PlaybackStartResult> {
    if (this.source) await this.stop(this.source.playbackId, "stopped", { origin: "system" });
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
    while (true) {
      this.adoptResolvedSource(source, itemId);
      try {
        const playbackTargets = await this.openPlaybackTarget(source);
        this.playbackTarget = playbackTargets;
        await this.launchProcess(
          playbackTargets,
          source.usesServerTimelineOffset ? 0 : source.resumePositionTicks,
          false,
          this.windowMaximized,
        );
        break;
      } catch (error) {
        if (source.source !== "local") {
          await this.failAndClean(error);
          throw error;
        }
        await this.discardLaunchAttempt();
        try {
          source = await this.playback.retryAfterLocalFailure(source.playbackId, resumeMode);
        } catch (fallbackError) {
          this.source = null;
          await this.failAndClean(fallbackError);
          throw fallbackError;
        }
        if (revision !== this.playbackRevision) throw new AppError("PLAYBACK_CANCELLED", "Playback was cancelled.");
      }
    }
    try {
      if (!this.videoHost && !this.mainWindow.isDestroyed()) this.mainWindow.minimize();
      await this.report("start");
      this.update({ ...this.state, phase: this.state.buffering ? "buffering" : this.state.paused ? "paused" : "playing" });
      this.startReportingTimer();
      this.emitEvent("load-item", context);
      return {
        playbackId: source.playbackId,
        resumePositionTicks: source.resumePositionTicks,
        durationTicks: source.durationTicks,
        source: source.source,
        sourceKind: source.sourceKind,
      };
    } catch (error) {
      await this.failAndClean(error);
      throw error;
    }
  }

  async setPaused(
    playbackId: string,
    paused: boolean,
    context: PlayerCommandContext = { origin: "local-user" },
  ): Promise<PlaybackState> {
    this.assertPlayback(playbackId);
    this.pendingPause = { paused, expiresAt: performance.now() + 3000 };
    await this.command(["set_property", "pause", paused]);
    this.update({
      ...this.state,
      paused,
      phase: this.state.buffering ? this.state.phase : paused ? "paused" : "playing",
    }, paused ? "pause" : "play", context);
    await this.report("progress", undefined, context.origin === "local-user" ? "explicit" : "automatic");
    return this.getState();
  }

  async seek(
    playbackId: string,
    positionTicks: number,
    context: PlayerCommandContext = { origin: "local-user" },
  ): Promise<PlaybackState> {
    this.assertPlayback(playbackId);
    const bounded = Math.max(0, Math.min(positionTicks, this.state.durationTicks || positionTicks));
    this.pendingSeek = { positionTicks: bounded, expiresAt: performance.now() + 5000 };
    if (this.source?.usesServerTimelineOffset) {
      await this.restartAt(bounded);
    } else {
      try {
        await this.command(["seek", bounded / TICKS_PER_SECOND, "absolute+exact"]);
      } catch {
        try {
          await this.command(["seek", bounded / TICKS_PER_SECOND, "absolute"]);
        } catch {
          await this.restartAt(bounded);
        }
      }
    }
    this.update({ ...this.state, positionTicks: bounded }, "seek", context);
    await this.report("progress", undefined, context.origin === "local-user" ? "explicit" : "automatic");
    return this.getState();
  }

  async setPlaybackRate(
    playbackId: string,
    rate: number,
    context: PlayerCommandContext = { origin: "system" },
  ): Promise<PlaybackState> {
    this.assertPlayback(playbackId);
    const correctionOnly = context.origin !== "local-user";
    const minimum = correctionOnly ? 0.9 : 0.25;
    const maximum = correctionOnly ? 1.1 : 4;
    if (!Number.isFinite(rate) || rate < minimum || rate > maximum) {
      throw new AppError("INVALID_PLAYBACK_RATE", "That playback rate is outside the supported range.", 422);
    }
    await this.command(["set_property", "speed", rate]);
    this.playbackRate = rate;
    this.update({ ...this.state, diagnostics: { ...this.state.diagnostics!, playbackRate: rate } }, "rate", context);
    return this.getState();
  }

  async selectAudio(playbackId: string, trackId: number | null): Promise<PlaybackState> {
    this.assertPlayback(playbackId);
    if (trackId !== null && !this.state.audioTracks.some((track) => track.id === trackId)) throw new AppError("INVALID_TRACK", "That audio track is unavailable.", 422);
    await this.command(["set_property", "aid", trackId ?? "no"]);
    this.update({ ...this.state, audioTracks: this.state.audioTracks.map((track) => ({ ...track, selected: trackId !== null && track.id === trackId })) }, "tracks");
    await this.report("progress");
    return this.getState();
  }

  async selectSubtitle(playbackId: string, trackId: number | null): Promise<PlaybackState> {
    this.assertPlayback(playbackId);
    if (trackId !== null && !this.state.subtitleTracks.some((track) => track.id === trackId)) throw new AppError("INVALID_TRACK", "That subtitle track is unavailable.", 422);
    await this.command(["set_property", "sid", trackId ?? "no"]);
    this.update({ ...this.state, subtitleTracks: this.state.subtitleTracks.map((track) => ({ ...track, selected: trackId !== null && track.id === trackId })) }, "tracks");
    await this.report("progress");
    return this.getState();
  }

  async setFullscreen(
    playbackId: string,
    fullscreen: boolean,
    context: PlayerCommandContext = { origin: "local-user" },
  ): Promise<PlaybackState> {
    this.assertPlayback(playbackId);
    this.pendingFullscreen = { fullscreen, expiresAt: performance.now() + 3000 };
    if (this.videoHost) this.videoHost.setFullscreen(fullscreen);
    else await this.command(["set_property", "fullscreen", fullscreen]);
    this.update({ ...this.state, fullscreen }, "fullscreen", context);
    return this.getState();
  }

  async showMessage(playbackId: string, message: string, durationMilliseconds = 2500): Promise<void> {
    this.assertPlayback(playbackId);
    const safeMessage = message.replace(/[\r\n]+/g, " ").slice(0, 160);
    const safeDuration = Math.max(500, Math.min(5000, Math.floor(durationMilliseconds)));
    await this.command(["show-text", safeMessage, safeDuration]);
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

  async stop(
    playbackId: string,
    phase: "stopped" | "ended" = "stopped",
    context: PlayerCommandContext = { origin: "local-user" },
  ): Promise<PlaybackState> {
    this.assertPlayback(playbackId);
    if (this.stopping) return this.getState();
    this.playbackRevision += 1;
    this.endHandlingRevision = null;
    this.replacingFile = false;
    this.eofArmed = false;
    this.stopping = true;
    try {
      await this.persistWindowStateIfWindowed(this.ipc).catch(() => undefined);
      await this.report("stop", undefined, context.origin === "local-user" ? "explicit" : "automatic");
      this.stopReportingTimer();
      const process = this.process;
      this.process = null;
      const ipc = this.ipc;
      this.ipc = null;
      await ipc?.command(["quit"]).catch(() => undefined);
      ipc?.close();
      if (process && !process.killed) process.kill();
      await this.proxy.close();
      this.videoHost?.hide();
      this.playbackTarget = null;
      try { this.playback.stop(playbackId); } catch { /* Already cleared. */ }
      this.source = null;
      this.timelineBaseTicks = 0;
      this.rawTimePositionSeconds = 0;
      this.demuxerCacheTimeSeconds = null;
      this.playbackRate = 1;
      this.pendingPause = null;
      this.pendingSeek = null;
      this.pendingFullscreen = null;
      this.update(emptyState({ phase }), phase === "ended" ? "completed" : "stop", context);
      if (!this.mainWindow.isDestroyed()) {
        if (this.mainWindow.isMinimized()) this.mainWindow.restore();
        this.mainWindow.show();
        this.mainWindow.focus();
      }
      return this.getState();
    } finally {
      this.stopping = false;
    }
  }

  async clear(): Promise<void> {
    if (this.source) await this.stop(this.source.playbackId, "stopped", { origin: "system" });
    else {
      this.playbackRevision += 1;
      this.playback.clear();
      this.playbackRate = 1;
      this.timelineBaseTicks = 0;
      this.rawTimePositionSeconds = 0;
      this.demuxerCacheTimeSeconds = null;
      this.videoHost?.hide();
      this.update(emptyState(), "stop", { origin: "system" });
    }
  }

  private async handleUnexpectedProcessExit(): Promise<void> {
    const source = this.source;
    if (!source || this.stopping) return;
    this.playbackRevision += 1;
    this.endHandlingRevision = null;
    this.replacingFile = false;
    this.eofArmed = false;
    await this.report("stop").catch(() => undefined);
    this.stopReportingTimer();
    this.ipc?.close();
    this.ipc = null;
    await this.proxy.close().catch(() => undefined);
    this.videoHost?.hide();
    this.playbackTarget = null;
    try { this.playback.stop(source.playbackId); } catch { /* Already cleared. */ }
    this.source = null;
    this.timelineBaseTicks = 0;
    this.rawTimePositionSeconds = 0;
    this.demuxerCacheTimeSeconds = null;
    this.externalSubtitleStreamByTrackId.clear();
    this.playbackRate = 1;
    this.pendingPause = null;
    this.pendingSeek = null;
    this.pendingFullscreen = null;
    this.update(emptyState({
      itemId: source.itemId,
      phase: "disconnected",
      error: "The playback engine disconnected unexpectedly.",
    }), "disconnected", { origin: "system" });
    if (!this.mainWindow.isDestroyed()) {
      if (this.mainWindow.isMinimized()) this.mainWindow.restore();
      this.mainWindow.show();
    }
  }

  private adoptResolvedSource(
    source: ResolvedPlaybackSource,
    itemId: string,
    action: PlayerAction = "state",
    context: PlayerCommandContext = { origin: "system" },
    retained: { volume?: number; fullscreen?: boolean } = {},
  ): void {
    this.source = source;
    this.timelineBaseTicks = source.usesServerTimelineOffset ? source.resumePositionTicks : 0;
    this.update(emptyState({
      playbackId: source.playbackId,
      itemId,
      phase: "loading",
      source: source.source,
      diagnostics: source.diagnostics ?? {
        ...emptyState().diagnostics!,
        sourceKind: source.sourceKind,
      },
      positionTicks: source.resumePositionTicks,
      durationTicks: source.durationTicks,
      seekable: source.usesServerTimelineOffset,
      volume: retained.volume ?? 100,
      fullscreen: retained.fullscreen ?? false,
    }), action, context);
  }

  private async discardLaunchAttempt(): Promise<void> {
    const process = this.process;
    const ipc = this.ipc;
    this.process = null;
    this.ipc = null;
    await ipc?.command(["quit"]).catch(() => undefined);
    ipc?.close();
    if (process && !process.killed) process.kill();
    await this.proxy.close().catch(() => undefined);
    this.playbackTarget = null;
    this.source = null;
    this.timelineBaseTicks = 0;
    this.rawTimePositionSeconds = 0;
    this.demuxerCacheTimeSeconds = null;
  }

  private async openPlaybackTarget(source: ResolvedPlaybackSource): Promise<PlaybackTargets> {
    await this.proxy.close();
    if (source.source === "local" && (source.externalSubtitles?.length ?? 0) === 0) {
      return { media: source.mediaUrl, subtitles: [] };
    }
    return this.proxy.open(source);
  }

  private spawnProcess(executable: string, args: string[]): ChildProcess {
    return spawn(executable, args, { windowsHide: true, stdio: ["ignore", "ignore", "ignore"] });
  }

  private createIpcClient(): MpvIpcClient {
    return new MpvIpcClient();
  }

  private async launchProcess(playbackTargets: PlaybackTargets, positionTicks: number, paused: boolean, windowMaximized: boolean): Promise<void> {
    this.eofArmed = false;
    this.rawTimePositionSeconds = 0;
    this.demuxerCacheTimeSeconds = null;
    const pipePath = `\\\\.\\pipe\\seeing-stone-${randomUUID()}`;
    const windowId = this.videoHost?.getWindowId();
    const args = [
      "--no-config",
      "--terminal=no",
      "--force-window=immediate",
      "--keep-open=yes",
      "--hwdec=auto-safe",
      `--osc=${this.videoHost ? "no" : "yes"}`,
      `--input-default-bindings=${this.videoHost ? "no" : "yes"}`,
      `--input-vo-keyboard=${this.videoHost ? "no" : "yes"}`,
      ...(this.videoHost ? ["--gpu-api=opengl"] : []),
      "--title=Seeing Stone Player",
      ...(windowId ? [`--wid=${windowId}`] : ["--geometry=1280x720", `--window-maximized=${windowMaximized ? "yes" : "no"}`]),
      `--input-conf=${this.runtime.inputConfig}`,
      `--input-ipc-server=${pipePath}`,
      `--start=${positionTicks / TICKS_PER_SECOND}`,
      ...(paused ? ["--pause=yes"] : []),
      "--",
      playbackTargets.media,
    ];
    const child = this.spawnProcess(this.runtime.executable, args);
    this.process = child;
    let launchReady = false;
    let failureHandled = false;
    let rejectStartup!: (reason: Error) => void;
    const startupFailure = new Promise<never>((_resolve, reject) => { rejectStartup = reject; });
    const handleChildFailure = () => {
      if (this.process !== child) return;
      if (failureHandled) return;
      failureHandled = true;
      this.process = null;
      if (!launchReady) {
        rejectStartup(new AppError("PLAYER_LAUNCH_FAILED", "The playback engine could not start.", 503));
        return;
      }
      if (!this.stopping && this.source) void this.handleUnexpectedProcessExit();
    };
    // A failed Windows spawn emits `error`; without a listener Electron would
    // treat it as an uncaught process error. Exit is also a startup failure
    // until IPC, observations, and the initial authoritative position succeed.
    child.once("error", handleChildFailure);
    child.once("exit", handleChildFailure);
    const ipc = this.createIpcClient();
    this.ipc = ipc;
    ipc.onMessage((message) => { if (this.ipc === ipc) this.handleMessage(message); });
    const initialize = async () => {
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
        ipc.observe(10, "demuxer-cache-duration"),
        ipc.observe(11, "demuxer-cache-time"),
        ipc.observe(12, "volume"),
      ]);
      const authoritativePosition = await this.waitForPropertyNumber(ipc, "time-pos");
      const rawPositionTicks = Math.max(0, Math.round(authoritativePosition * TICKS_PER_SECOND));
      await this.addExternalSubtitles(ipc, playbackTargets);
      this.update({
        ...this.state,
        positionTicks: Math.max(0, this.timelineBaseTicks + rawPositionTicks),
        paused,
        seekable: this.source?.usesServerTimelineOffset ? true : this.state.seekable,
        phase: "ready",
      }, "ready", { origin: "system" });
    };
    await Promise.race([initialize(), startupFailure]);
    if (this.process !== child) {
      throw new AppError("PLAYER_LAUNCH_FAILED", "The playback engine could not start.", 503);
    }
    launchReady = true;
  }

  private async restartAt(positionTicks: number): Promise<void> {
    const source = this.source;
    let playbackTargets = this.playbackTarget;
    if (!source || !playbackTargets) throw new AppError("SEEK_UNAVAILABLE", "Seeking is unavailable for this media.", 422);
    const paused = this.state.paused;
    const retained = this.captureMutablePlaybackState();
    const oldProcess = this.process;
    const oldIpc = this.ipc;
    this.process = null;
    this.ipc = null;
    await oldIpc?.command(["quit"]).catch(() => undefined);
    oldIpc?.close();
    if (oldProcess && !oldProcess.killed) oldProcess.kill();
    this.update({ ...this.state, phase: "loading", buffering: true });
    try {
      if (source.usesServerTimelineOffset) {
        this.playback.setStreamStart(source.playbackId, positionTicks);
        playbackTargets = await this.openPlaybackTarget(source);
        this.playbackTarget = playbackTargets;
        this.timelineBaseTicks = positionTicks;
      } else {
        this.timelineBaseTicks = 0;
      }
      await this.launchProcess(
        playbackTargets,
        source.usesServerTimelineOffset ? 0 : positionTicks,
        paused,
        this.windowMaximized,
      );
      await this.restoreMutablePlaybackState(retained);
    } catch {
      await this.report("stop").catch(() => undefined);
      await this.discardLaunchAttempt().catch(() => undefined);
      this.playback.clear();
      this.stopReportingTimer();
      this.playbackRate = 1;
      this.pendingPause = null;
      this.pendingSeek = null;
      this.pendingFullscreen = null;
      this.videoHost?.hide();
      this.update(emptyState({
        itemId: source.itemId,
        phase: "error",
        error: "Playback could not resume after seeking.",
      }), "error", { origin: "system" });
      if (!this.mainWindow.isDestroyed()) {
        if (this.mainWindow.isMinimized()) this.mainWindow.restore();
        this.mainWindow.show();
        this.mainWindow.focus();
      }
      throw new AppError("SEEK_UNAVAILABLE", "Seeking is unavailable for this stream.", 422);
    }
  }

  private captureMutablePlaybackState(): MutablePlaybackSnapshot {
    const selectedAudio = this.state.audioTracks.find((track) => track.selected) ?? null;
    const selectedSubtitle = this.state.subtitleTracks.find((track) => track.selected) ?? null;
    return {
      volume: this.state.volume,
      rate: this.playbackRate,
      fullscreen: this.state.fullscreen,
      audioTracksKnown: this.state.audioTracks.length > 0,
      subtitleTracksKnown: this.state.subtitleTracks.length > 0,
      selectedAudio: selectedAudio ? { ...selectedAudio } : null,
      selectedSubtitle: selectedSubtitle ? { ...selectedSubtitle } : null,
      externalSubtitleStreamIndex: selectedSubtitle?.external
        ? this.externalSubtitleStreamByTrackId.get(selectedSubtitle.id) ?? null
        : null,
    };
  }

  private async restoreMutablePlaybackState(snapshot: MutablePlaybackSnapshot): Promise<void> {
    const currentTrackList = await this.ipc?.command(["get_property", "track-list"]).catch(() => null);
    const parsed = parsePlaybackTracks(currentTrackList);
    const audioTracks = parsed.audioTracks.length > 0 ? parsed.audioTracks : this.state.audioTracks;
    const subtitleTracks = parsed.subtitleTracks.length > 0 ? parsed.subtitleTracks : this.state.subtitleTracks;
    const selectedAudio = this.matchRetainedTrack(audioTracks, snapshot.selectedAudio);
    let selectedSubtitle: PlaybackTrack | null = null;
    if (snapshot.externalSubtitleStreamIndex !== null) {
      const replacementId = [...this.externalSubtitleStreamByTrackId]
        .find(([, streamIndex]) => streamIndex === snapshot.externalSubtitleStreamIndex)?.[0] ?? null;
      selectedSubtitle = replacementId === null
        ? null
        : subtitleTracks.find((track) => track.id === replacementId) ?? null;
      if (!selectedSubtitle && replacementId !== null) {
        selectedSubtitle = { ...snapshot.selectedSubtitle!, id: replacementId };
      }
    } else {
      selectedSubtitle = this.matchRetainedTrack(subtitleTracks, snapshot.selectedSubtitle);
    }
    const restoredSubtitleTracks = selectedSubtitle
      && !subtitleTracks.some((track) => track.id === selectedSubtitle.id)
      ? [...subtitleTracks, selectedSubtitle]
      : subtitleTracks;

    await this.command(["set_property", "volume", snapshot.volume]);
    await this.command(["set_property", "speed", snapshot.rate]);
    if (snapshot.fullscreen && !this.videoHost) {
      await this.command(["set_property", "fullscreen", true]);
    }
    if (snapshot.audioTracksKnown) {
      await this.command(["set_property", "aid", selectedAudio?.id ?? "no"]);
    }
    if (snapshot.subtitleTracksKnown) {
      await this.command(["set_property", "sid", selectedSubtitle?.id ?? "no"]);
    }

    this.playbackRate = snapshot.rate;
    this.update({
      ...this.state,
      volume: snapshot.volume,
      fullscreen: snapshot.fullscreen,
      diagnostics: { ...this.state.diagnostics!, playbackRate: snapshot.rate },
      audioTracks: snapshot.audioTracksKnown
        ? audioTracks.map((track) => ({ ...track, selected: track.id === selectedAudio?.id }))
        : audioTracks,
      subtitleTracks: snapshot.subtitleTracksKnown
        ? restoredSubtitleTracks.map((track) => ({ ...track, selected: track.id === selectedSubtitle?.id }))
        : restoredSubtitleTracks,
    });
  }

  private matchRetainedTrack(tracks: PlaybackTrack[], retained: PlaybackTrack | null): PlaybackTrack | null {
    if (!retained) return null;
    if (retained.streamIndex !== null) {
      const byStream = tracks.find((track) => track.streamIndex === retained.streamIndex);
      if (byStream) return byStream;
    }
    const byId = tracks.find((track) => track.id === retained.id);
    if (byId) return byId;
    return tracks.find((track) => track.type === retained.type
      && track.title === retained.title
      && track.language === retained.language
      && track.codec === retained.codec) ?? null;
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
      }, "completed", { origin: "system" });
      await this.report("stop", "completed");
      this.stopReportingTimer();
      if (!this.isCurrent(revision, completedSource)) return;

      try { this.playback.stop(completedSource.playbackId); } catch { /* Already finalized. */ }
      await this.proxy.close();
      this.playbackTarget = null;

      if (!this.automaticTransitionsEnabled) {
        await this.stop(completedSource.playbackId, "ended", { origin: "system" });
        return;
      }

      if (completedSource.itemType !== "Episode" || !completedSource.seriesId) {
        await this.stop(completedSource.playbackId, "ended", { origin: "system" });
        return;
      }

      const nextEpisode = await this.completion.findNextEpisode(
        completedSource.itemId,
        () => this.playback.getNextUpForSeries(completedSource.seriesId!),
        () => this.isCurrent(revision, completedSource),
      );
      if (!nextEpisode || !this.isCurrent(revision, completedSource)) {
        if (this.isCurrent(revision, completedSource)) await this.stop(completedSource.playbackId, "ended", { origin: "system" });
        return;
      }

      const continuePlayback = await this.completion.countdown({
        isCurrent: () => this.isCurrent(revision, completedSource),
        show: (remaining) => this.command(["show-text", `Next episode in ${remaining} seconds\nEsc to exit`, 1100]),
      });
      if (!continuePlayback || !this.isCurrent(revision, completedSource)) return;
      await this.transitionToNextEpisode(revision, completedSource, nextEpisode.id);
    } catch {
      if (this.isCurrent(revision, completedSource)) await this.stop(completedSource.playbackId, "ended", { origin: "system" }).catch(() => undefined);
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
    let nextSource = await this.playback.start(nextItemId, "start-over");
    if (!this.isCurrent(completedRevision, completedSource)) {
      try { this.playback.stop(nextSource.playbackId); } catch { /* Cancelled concurrently. */ }
      return;
    }
    let playbackTargets: PlaybackTargets | null = null;
    while (playbackTargets === null) {
      try {
        const candidateTargets = await this.openPlaybackTarget(nextSource);
        if (!this.isCurrent(completedRevision, completedSource)) {
          await this.proxy.close();
          try { this.playback.stop(nextSource.playbackId); } catch { /* Cancelled concurrently. */ }
          return;
        }
        this.replacingFile = true;
        this.eofArmed = false;
        try {
          const fileLoaded = this.waitForEvent(ipc, "file-loaded", 15000);
          void fileLoaded.catch(() => undefined);
          await ipc.command(["loadfile", candidateTargets.media, "replace"]);
          await fileLoaded;
        } finally {
          this.replacingFile = false;
        }
        playbackTargets = candidateTargets;
      } catch (error) {
        this.replacingFile = false;
        await this.proxy.close().catch(() => undefined);
        if (!this.isCurrent(completedRevision, completedSource)) {
          try { this.playback.stop(nextSource.playbackId); } catch { /* Cancelled concurrently. */ }
          return;
        }
        if (nextSource.source !== "local") {
          try { this.playback.stop(nextSource.playbackId); } catch { /* Resolution already finalized. */ }
          throw error;
        }
        try {
          nextSource = await this.playback.retryAfterLocalFailure(nextSource.playbackId, "start-over");
        } catch (fallbackError) {
          try { this.playback.stop(nextSource.playbackId); } catch { /* Resolution already finalized. */ }
          throw fallbackError;
        }
      }
    }
    if (!this.isCurrent(completedRevision, completedSource)) {
      await this.proxy.close();
      try { this.playback.stop(nextSource.playbackId); } catch { /* Cancelled concurrently. */ }
      return;
    }

    const retained = { volume: this.state.volume, fullscreen: this.state.fullscreen };
    const revision = ++this.playbackRevision;
    this.playbackTarget = playbackTargets;
    this.reportingActive = false;
    this.adoptResolvedSource(nextSource, nextItemId, "item-transition", { origin: "system" }, retained);

    try {
      if (!this.isCurrent(revision, nextSource)) return;
      await this.addExternalSubtitles(ipc, playbackTargets);
      const position = await this.waitForPropertyNumber(ipc, "time-pos");
      this.update({
        ...this.state,
        positionTicks: Math.max(0, this.timelineBaseTicks + Math.round(position * TICKS_PER_SECOND)),
        paused: false,
        phase: "loading",
      });
      await this.report("start");
      if (!this.isCurrent(revision, nextSource)) return;
      this.update({ ...this.state, phase: "playing" });
      this.startReportingTimer();
    } catch (error) {
      if (this.isCurrent(revision, nextSource)) {
        await this.stop(nextSource.playbackId, "ended", { origin: "system" }).catch(() => undefined);
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

  private async addExternalSubtitles(ipc: MpvIpcClient, targets: PlaybackTargets): Promise<void> {
    this.externalSubtitleStreamByTrackId.clear();
    for (const subtitle of targets.subtitles) {
      const beforeValue = await ipc.command(["get_property", "track-list"]).catch(() => null);
      const beforeIds = new Set(parsePlaybackTracks(beforeValue).subtitleTracks
        .filter((track) => track.external)
        .map((track) => track.id));
      let result: unknown;
      try {
        result = await ipc.command([
          "sub-add",
          subtitle.url,
          subtitle.isDefault ? "select" : "auto",
          subtitle.title ?? "Jellyfin subtitle",
          subtitle.language ?? "",
        ]);
      } catch {
        continue;
      }
      const returnedTrackId = typeof result === "number" && Number.isSafeInteger(result) && result > 0
        ? result
        : null;
      const afterValue = returnedTrackId === null
        ? await ipc.command(["get_property", "track-list"]).catch(() => null)
        : null;
      const discoveredTrackId = returnedTrackId ?? parsePlaybackTracks(afterValue).subtitleTracks
        .find((track) => track.external && !beforeIds.has(track.id)
          && !this.externalSubtitleStreamByTrackId.has(track.id))?.id ?? null;
      if (discoveredTrackId !== null) {
        this.externalSubtitleStreamByTrackId.set(discoveredTrackId, subtitle.streamIndex);
      }
    }
  }

  private startReportingTimer(): void {
    this.stopReportingTimer();
    this.reportingTimer = setInterval(() => { void this.report("progress"); }, 10000);
    if (this.state.buffering) this.scheduleStalledState();
  }

  private stopReportingTimer(): void {
    if (this.reportingTimer) clearInterval(this.reportingTimer);
    this.reportingTimer = null;
    this.clearStalledTimer();
  }

  private scheduleStalledState(): void {
    this.clearStalledTimer();
    this.stalledTimer = setTimeout(() => {
      this.stalledTimer = null;
      if (!this.source || !this.reportingActive || !this.state.buffering) return;
      this.update({ ...this.state, phase: "stalled" }, "stalled", { origin: "system" });
    }, 10_000);
  }

  private clearStalledTimer(): void {
    if (this.stalledTimer) clearTimeout(this.stalledTimer);
    this.stalledTimer = null;
  }

  private async persistWindowStateIfWindowed(ipc: MpvIpcClient | null): Promise<void> {
    if (!ipc || this.videoHost) return;
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
      void this.stop(this.source.playbackId, "stopped", { origin: "local-user" });
      return;
    }
    if (message.event === "client-message" && message.args?.[0] === "jellyfin-fullscreen" && this.source) {
      void this.setFullscreen(this.source.playbackId, !this.state.fullscreen, { origin: "local-user" }).catch(() => undefined);
      return;
    }
    if (message.event === "client-message" && message.args?.[0] === "jellyfin-resync" && this.source) {
      this.emitEvent("resync-request", { origin: "local-user" });
      return;
    }
    if (message.event === "end-file" && this.source) {
      if (this.replacingFile) return;
      if (message.reason === "eof") {
        this.eofArmed = false;
        const revision = this.playbackRevision;
        if (this.endHandlingRevision === revision) return;
        this.endHandlingRevision = revision;
        void this.handleNaturalEnd(revision, this.source);
      } else if (!this.stopping) {
        void this.stop(this.source.playbackId, "ended", { origin: "system" }).catch(() => undefined);
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
    let action: PlayerAction = "state";
    let context: PlayerCommandContext = { origin: "system" };
    const now = performance.now();
    if (message.name === "time-pos" && typeof message.data === "number") {
      this.rawTimePositionSeconds = Math.max(0, message.data);
      next.positionTicks = Math.max(0, this.timelineBaseTicks + Math.round(message.data * TICKS_PER_SECOND));
      if (this.demuxerCacheTimeSeconds !== null) {
        next.diagnostics = {
          ...next.diagnostics!,
          bufferAheadTicks: Math.max(0, Math.round((this.demuxerCacheTimeSeconds - this.rawTimePositionSeconds) * TICKS_PER_SECOND)),
        };
      }
    }
    if (message.name === "duration" && typeof message.data === "number") next.durationTicks = Math.max(next.durationTicks, Math.round(message.data * TICKS_PER_SECOND));
    if (message.name === "time-pos" && typeof message.data === "number") {
      const pending = this.pendingSeek;
      if (pending && now > pending.expiresAt) this.pendingSeek = null;
      else if (pending && Math.abs(next.positionTicks - pending.positionTicks) <= 2 * TICKS_PER_SECOND) this.pendingSeek = null;
      else if (!pending && this.reportingActive && Math.abs(next.positionTicks - this.state.positionTicks) > 2 * TICKS_PER_SECOND) {
        action = "seek";
        context = { origin: "local-user" };
      }
    }
    if (message.name === "pause" && typeof message.data === "boolean") {
      next.paused = message.data;
      const pending = this.pendingPause;
      if (pending && now <= pending.expiresAt && pending.paused === message.data) this.pendingPause = null;
      else if (!pending || now > pending.expiresAt) {
        this.pendingPause = null;
        action = message.data ? "pause" : "play";
        context = { origin: "local-user" };
      }
    }
    if (message.name === "paused-for-cache" && typeof message.data === "boolean") {
      next.buffering = message.data;
      if (next.buffering !== this.state.buffering) {
        action = "buffering";
        if (next.buffering) this.scheduleStalledState();
        else this.clearStalledTimer();
      }
    }
    if (message.name === "seekable" && typeof message.data === "boolean") {
      next.seekable = this.source?.usesServerTimelineOffset ? true : message.data;
    }
    if (message.name === "volume" && typeof message.data === "number" && Number.isFinite(message.data)) {
      next.volume = Math.max(0, Math.min(100, message.data));
      action = "volume";
    }
    if (message.name === "demuxer-cache-time" && typeof message.data === "number" && Number.isFinite(message.data)) {
      this.demuxerCacheTimeSeconds = Math.max(0, message.data);
      next.diagnostics = {
        ...next.diagnostics!,
        bufferAheadTicks: Math.max(0, Math.round((this.demuxerCacheTimeSeconds - this.rawTimePositionSeconds) * TICKS_PER_SECOND)),
      };
    }
    if (message.name === "demuxer-cache-duration" && typeof message.data === "number" && Number.isFinite(message.data)) {
      if (this.demuxerCacheTimeSeconds === null) {
        next.diagnostics = { ...next.diagnostics!, bufferAheadTicks: Math.max(0, Math.round(message.data * TICKS_PER_SECOND)) };
      }
    }
    if (message.name === "fullscreen" && typeof message.data === "boolean") {
      next.fullscreen = message.data;
      const pending = this.pendingFullscreen;
      if (pending && now <= pending.expiresAt && pending.fullscreen === message.data) this.pendingFullscreen = null;
      else if (!pending || now > pending.expiresAt) {
        this.pendingFullscreen = null;
        action = "fullscreen";
        context = { origin: "local-user" };
      }
    }
    if (message.name === "window-maximized" && typeof message.data === "boolean") {
      void this.persistWindowStateIfWindowed(this.ipc).catch(() => undefined);
    }
    if (message.name === "track-list") {
      Object.assign(next, parsePlaybackTracks(message.data));
      action = "tracks";
    }
    next.phase = this.reportingActive
      ? (next.buffering ? (this.state.phase === "stalled" ? "stalled" : "buffering") : next.paused ? "paused" : "playing")
      : "loading";
    this.update(next, action, context);
    if (action === "pause" || action === "play" || action === "seek") {
      void this.report("progress", undefined, context.origin === "local-user" ? "explicit" : "automatic");
    }
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
    conflictPolicy?: "automatic" | "explicit",
  ): Promise<void> {
    if (!this.source) return;
    if (kind !== "start" && !this.reportingActive) return;
    if (kind === "stop") this.reportingActive = false;
    const selectedAudio = this.state.audioTracks.find((track) => track.selected);
    const selectedSubtitle = this.state.subtitleTracks.find((track) => track.selected);
    const resolvedActionKind = actionKind ?? (kind === "start" ? this.source.initialAction : "progress");
    await this.reporting.acceptAuthoritativeEvent({
      kind,
      itemId: this.source.itemId,
      mediaSourceId: this.source.mediaSourceId,
      playMethod: this.source.source === "local" || this.source.sourceKind === "direct-play"
        ? "DirectPlay"
        : this.source.delivery === "transcode" ? "Transcode" : "DirectStream",
      positionTicks: this.state.positionTicks,
      paused: this.state.paused,
      playSessionId: this.source.serverPlaySessionId,
      canSeek: this.state.seekable,
      audioStreamIndex: selectedAudio?.streamIndex ?? null,
      subtitleStreamIndex: selectedSubtitle?.external
        ? this.externalSubtitleStreamByTrackId.get(selectedSubtitle.id) ?? null
        : selectedSubtitle?.streamIndex ?? null,
      actionKind: resolvedActionKind,
      watched: resolvedActionKind === "completed" || resolvedActionKind === "mark_watched",
      conflictPolicy: conflictPolicy
        ?? (resolvedActionKind !== "progress" ? "explicit" : "automatic"),
    });
    if (kind === "start") this.reportingActive = true;
  }

  private update(
    state: PlaybackState,
    action: PlayerAction = "state",
    context: PlayerCommandContext = { origin: "system" },
  ): void {
    this.state = state;
    const snapshot = this.getState();
    for (const listener of this.listeners) listener(snapshot);
    this.emitEvent(action, context, snapshot);
  }

  private emitEvent(
    action: PlayerAction,
    context: PlayerCommandContext,
    state: PlaybackState = this.getState(),
  ): void {
    this.controllerRevision += 1;
    const event: PlayerControllerEvent = {
      action,
      origin: context.origin,
      commandRevision: context.commandRevision ?? null,
      commandId: context.commandId ?? null,
      controllerRevision: this.controllerRevision,
      monotonicTimestampMs: performance.now(),
      state,
    };
    for (const listener of this.eventListeners) listener(structuredClone(event));
  }

  private async failAndClean(error: unknown): Promise<void> {
    const playbackId = this.source?.playbackId;
    if (playbackId) {
      try { await this.stop(playbackId); } catch { /* Preserve original failure. */ }
    }
    const message = error instanceof AppError ? error.message : "mpv playback could not be started.";
    this.update(emptyState({ phase: "error", error: message }), "error", { origin: "system" });
  }
}

export class LegacyExternalMpvAdapter extends MpvPlayerService {}

export class EmbeddedMpvAdapter extends MpvPlayerService {
  constructor(
    mainWindow: BrowserWindow,
    playback: PlaybackSessionService,
    reporting: PlaybackReportingService,
    preferences: PlayerPreferencesStore,
    runtime: MpvRuntimePaths,
    videoHost: MpvVideoHost,
  ) {
    super(mainWindow, playback, reporting, preferences, runtime, videoHost);
  }
}
