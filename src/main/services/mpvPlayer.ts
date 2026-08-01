import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import type { BrowserWindow } from "electron";
import type {
  MediaItem,
  PlaybackStartResult,
  PlaybackState,
  PlaybackTrack,
} from "../../shared/contracts";
import { AppError } from "./errors";
import { MpvIpcClient, type MpvCommandClient, type MpvMessage } from "./mpvIpc";
import { LibMpvCommandClient } from "./libMpvIpc";
import type { LibMpvHost } from "./libMpvHost";
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
import type { PlaybackContinuationResult } from "./playbackContinuationResolver";
import type { MpvVideoHost } from "./embeddedVideoHost";

const TICKS_PER_SECOND = 10_000_000;
const NEXT_EPISODE_COUNTDOWN_SECONDS = 10;
const VIDEO_OUTPUT_TIMEOUT_MS = 5000;

type MpvRenderProfile = "legacy" | "d3d11" | "opengl-software" | "libmpv-opengl-angle";

export function embeddedRenderProfileArgs(profile: "d3d11" | "opengl-software"): string[] {
  return profile === "d3d11"
    ? ["--vo=gpu-next", "--gpu-api=d3d11", "--gpu-context=d3d11", "--hwdec=auto-safe", "--panscan=0"]
    : ["--vo=gpu", "--gpu-api=opengl", "--gpu-context=win", "--hwdec=no", "--panscan=0"];
}

export function embeddedVideoWindowArgs(title: string): string[] {
  return [
    "--border=no",
    "--focus-on=never",
    "--geometry=16x16-10000-10000",
    `--title=${title}`,
  ];
}

function hasVideoTrack(value: unknown): boolean {
  return Array.isArray(value) && value.some((entry) => Boolean(entry)
    && typeof entry === "object"
    && (entry as Record<string, unknown>).type === "video");
}

function hasAudioOrVideoTrack(value: unknown): boolean {
  return Array.isArray(value) && value.some((entry) => Boolean(entry)
    && typeof entry === "object"
    && ["audio", "video"].includes(String((entry as Record<string, unknown>).type)));
}

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

interface PendingAutomaticTransition {
  revision: number;
  source: ResolvedPlaybackSource;
  resolve(decision: "continue" | "cancel"): void;
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
      videoOutput: null, videoOutputHealthy: null, hardwareDecoding: null,
      renderFallbackUsed: false,
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
    nextEpisodeCountdown: null,
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
  private ipc: MpvCommandClient | null = null;
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
  private readonly completion = new PlaybackCompletionCoordinator(NEXT_EPISODE_COUNTDOWN_SECONDS);
  private controllerRevision = 0;
  private playbackRate = 1;
  private automaticTransitionsEnabled = true;
  private pendingAutomaticTransition: PendingAutomaticTransition | null = null;
  private pendingPause: { paused: boolean; expiresAt: number } | null = null;
  private pendingSeek: { positionTicks: number; expiresAt: number } | null = null;
  private pendingFullscreen: { fullscreen: boolean; expiresAt: number } | null = null;
  private timelineBaseTicks = 0;
  private rawTimePositionSeconds = 0;
  private demuxerCacheTimeSeconds: number | null = null;
  private activeRenderProfile: MpvRenderProfile = "legacy";
  private readonly externalSubtitleStreamByTrackId = new Map<number, number>();

  constructor(
    private readonly mainWindow: BrowserWindow,
    private readonly playback: PlaybackSessionService,
    private readonly reporting: PlaybackReportingService,
    private readonly preferences: PlayerPreferencesStore,
    private readonly runtime: MpvRuntimePaths,
    private readonly videoHost?: MpvVideoHost,
    private readonly libMpvHost?: LibMpvHost,
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
      if (!this.isCurrent(revision, source)) throw new AppError("PLAYBACK_CANCELLED", "Playback was cancelled.");
      if (!this.videoHost && !this.libMpvHost && !this.mainWindow.isDestroyed()) this.mainWindow.minimize();
      await this.report("start");
      if (!this.isCurrent(revision, source)) throw new AppError("PLAYBACK_CANCELLED", "Playback was cancelled.");
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
      if (this.isCurrent(revision, source)) await this.failAndClean(error);
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
    if (this.videoHost || this.libMpvHost) {
      if (fullscreen && context.origin === "companion") {
        if (!this.mainWindow.isKiosk()) this.mainWindow.setKiosk(true);
      } else {
        if (!fullscreen && this.mainWindow.isKiosk()) this.mainWindow.setKiosk(false);
        if (!this.videoHost && this.mainWindow.isFullScreen() !== fullscreen) {
          this.mainWindow.setFullScreen(fullscreen);
        }
      }
      this.videoHost?.setFullscreen(fullscreen);
    }
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

  async continueNextEpisode(
    playbackId: string,
    _context: PlayerCommandContext = { origin: "local-user" },
  ): Promise<PlaybackState> {
    this.assertPlayback(playbackId);
    this.resolveAutomaticTransition("continue");
    return this.getState();
  }

  async cancelNextEpisode(
    playbackId: string,
    _context: PlayerCommandContext = { origin: "local-user" },
  ): Promise<PlaybackState> {
    this.assertPlayback(playbackId);
    this.resolveAutomaticTransition("cancel");
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

  async stop(
    playbackId: string,
    phase: "stopped" | "ended" = "stopped",
    context: PlayerCommandContext = { origin: "local-user" },
  ): Promise<PlaybackState> {
    this.assertPlayback(playbackId);
    if (this.stopping) return this.getState();
    this.resolveAutomaticTransition("cancel");
    this.playbackRevision += 1;
    this.endHandlingRevision = null;
    this.replacingFile = false;
    this.eofArmed = false;
    this.stopping = true;
    try {
      await this.persistWindowStateIfWindowed(this.ipc).catch(() => undefined);
      this.stopReportingTimer();
      const process = this.process;
      this.process = null;
      const ipc = this.ipc;
      this.ipc = null;
      // Silence and tear down playback before network reporting. Reporting or
      // shared-texture cleanup must never leave audio running after the user
      // has closed the player.
      await ipc?.command(["quit"]).catch(() => undefined);
      ipc?.close();
      if (process && !process.killed) process.kill();
      await this.libMpvHost?.stop().catch(() => undefined);
      this.exitIntegratedFullscreen();
      await this.report("stop", undefined, context.origin === "local-user" ? "explicit" : "automatic");
      await this.proxy.close();
      this.videoHost?.detachWindow();
      this.playbackTarget = null;
      try { this.playback.stop(playbackId); } catch { /* Already cleared. */ }
      this.source = null;
      this.timelineBaseTicks = 0;
      this.rawTimePositionSeconds = 0;
      this.demuxerCacheTimeSeconds = null;
      this.activeRenderProfile = "legacy";
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
    this.resolveAutomaticTransition("cancel");
    if (this.source) await this.stop(this.source.playbackId, "stopped", { origin: "system" });
    else {
      this.playbackRevision += 1;
      this.exitIntegratedFullscreen();
      this.playback.clear();
      this.playbackRate = 1;
      this.timelineBaseTicks = 0;
      this.rawTimePositionSeconds = 0;
      this.demuxerCacheTimeSeconds = null;
      this.activeRenderProfile = "legacy";
      this.videoHost?.detachWindow();
      await this.libMpvHost?.stop().catch(() => undefined);
      this.update(emptyState(), "stop", { origin: "system" });
    }
  }

  private async handleUnexpectedProcessExit(): Promise<void> {
    const source = this.source;
    if (!source || this.stopping) return;
    this.resolveAutomaticTransition("cancel");
    this.playbackRevision += 1;
    this.endHandlingRevision = null;
    this.replacingFile = false;
    this.eofArmed = false;
    await this.report("stop").catch(() => undefined);
    this.stopReportingTimer();
    this.ipc?.close();
    this.ipc = null;
    await this.proxy.close().catch(() => undefined);
    this.exitIntegratedFullscreen();
    this.videoHost?.detachWindow();
    this.playbackTarget = null;
    try { this.playback.stop(source.playbackId); } catch { /* Already cleared. */ }
    this.source = null;
    this.timelineBaseTicks = 0;
    this.rawTimePositionSeconds = 0;
    this.demuxerCacheTimeSeconds = null;
    this.activeRenderProfile = "legacy";
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
      seekable: source.usesServerTimelineOffset && source.contentKind !== "live-tv",
      volume: retained.volume ?? 100,
      fullscreen: retained.fullscreen ?? false,
      contentKind: source.contentKind ?? "on-demand",
    }), action, context);
  }

  private async discardLaunchAttempt(): Promise<void> {
    await this.discardProcessAttempt();
    await this.proxy.close().catch(() => undefined);
    this.playbackTarget = null;
    this.source = null;
    this.timelineBaseTicks = 0;
    this.rawTimePositionSeconds = 0;
    this.demuxerCacheTimeSeconds = null;
  }

  private async discardProcessAttempt(): Promise<void> {
    const process = this.process;
    const ipc = this.ipc;
    this.process = null;
    this.ipc = null;
    await ipc?.command(["quit"]).catch(() => undefined);
    ipc?.close();
    if (process && !process.killed) process.kill();
    this.videoHost?.detachWindow();
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

  private createIpcClient(): MpvCommandClient {
    return new MpvIpcClient();
  }

  private async launchProcess(playbackTargets: PlaybackTargets, positionTicks: number, paused: boolean, windowMaximized: boolean): Promise<void> {
    if (this.libMpvHost) {
      await this.launchLibMpvAttempt(playbackTargets, positionTicks, paused);
      return;
    }
    if (!this.videoHost) {
      await this.launchProcessAttempt(playbackTargets, positionTicks, paused, windowMaximized, "legacy");
      return;
    }
    try {
      await this.launchProcessAttempt(playbackTargets, positionTicks, paused, windowMaximized, "d3d11");
    } catch (error) {
      if (!(error instanceof AppError) || error.code !== "VIDEO_OUTPUT_UNAVAILABLE") throw error;
      await this.discardProcessAttempt();
      this.update({
        ...this.state,
        diagnostics: {
          ...this.state.diagnostics!,
          videoOutput: "opengl-software",
          videoOutputHealthy: false,
          hardwareDecoding: false,
          renderFallbackUsed: true,
        },
      });
      try {
        await this.launchProcessAttempt(playbackTargets, positionTicks, paused, windowMaximized, "opengl-software");
      } catch (fallbackError) {
        await this.discardProcessAttempt();
        if (!(fallbackError instanceof AppError) || fallbackError.code !== "VIDEO_OUTPUT_UNAVAILABLE") {
          throw fallbackError;
        }
        throw new AppError(
          "VIDEO_OUTPUT_UNAVAILABLE",
          "Embedded video output could not be initialized. The legacy player remains available in playback settings.",
          503,
        );
      }
    }
  }

  private async launchLibMpvAttempt(
    playbackTargets: PlaybackTargets,
    positionTicks: number,
    paused: boolean,
  ): Promise<void> {
    if (!this.libMpvHost) throw new AppError("LIBMPV_UNAVAILABLE", "The experimental player is unavailable.", 503);
    this.eofArmed = false;
    this.rawTimePositionSeconds = 0;
    this.demuxerCacheTimeSeconds = null;
    this.activeRenderProfile = "libmpv-opengl-angle";
    const session = await this.libMpvHost.open({ location: playbackTargets.media }, positionTicks);
    const ipc = new LibMpvCommandClient(session, (listener) => this.libMpvHost!.onEvent(listener));
    this.ipc = ipc;
    ipc.onMessage((message) => { if (this.ipc === ipc) this.handleMessage(message); });
    try {
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
        ipc.observe(13, "current-vo"),
        ipc.observe(14, "video-format"),
        ipc.observe(15, "hwdec-current"),
        ipc.observe(16, "vo-configured"),
        ipc.observe(17, "seeing-stone-frame-stats"),
      ]);
      if (paused) await ipc.command(["set_property", "pause", true]);
      const authoritativePosition = await this.waitForPropertyNumber(ipc, "time-pos");
      const readiness = await this.waitForEmbeddedVideoOutput(ipc);
      await this.addExternalSubtitles(ipc, playbackTargets);
      this.update({
        ...this.state,
        positionTicks: Math.max(0, this.timelineBaseTicks + Math.round(authoritativePosition * TICKS_PER_SECOND)),
        paused,
        seekable: this.source?.usesServerTimelineOffset ? true : this.state.seekable,
        phase: "ready",
        diagnostics: {
          ...this.state.diagnostics!,
          videoOutput: "libmpv-opengl-angle",
          videoOutputHealthy: readiness.hasVideo ? true : null,
          hardwareDecoding: readiness.hardwareDecoding,
          directRendering: null,
          frameQueueDepth: 0,
          droppedFrames: 0,
          renderFallbackUsed: false,
        },
      }, "ready", { origin: "system" });
    } catch (error) {
      ipc.close();
      if (this.ipc === ipc) this.ipc = null;
      await session.stop().catch(() => undefined);
      throw error;
    }
  }

  private async launchProcessAttempt(
    playbackTargets: PlaybackTargets,
    positionTicks: number,
    paused: boolean,
    windowMaximized: boolean,
    profile: Exclude<MpvRenderProfile, "libmpv-opengl-angle">,
  ): Promise<void> {
    this.eofArmed = false;
    this.rawTimePositionSeconds = 0;
    this.demuxerCacheTimeSeconds = null;
    this.activeRenderProfile = profile;
    const pipePath = `\\\\.\\pipe\\seeing-stone-${randomUUID()}`;
    const windowTitle = this.videoHost ? `Seeing Stone Video ${randomUUID()}` : "Seeing Stone Player";
    const args = [
      "--no-config",
      "--terminal=no",
      "--force-window=immediate",
      "--keep-open=yes",
      ...(profile === "legacy" ? ["--hwdec=auto-safe"] : embeddedRenderProfileArgs(profile)),
      `--osc=${this.videoHost ? "no" : "yes"}`,
      `--input-default-bindings=${this.videoHost ? "no" : "yes"}`,
      `--input-vo-keyboard=${this.videoHost ? "no" : "yes"}`,
      ...(this.videoHost
        ? embeddedVideoWindowArgs(windowTitle)
        : ["--title=Seeing Stone Player", "--geometry=1280x720", `--window-maximized=${windowMaximized ? "yes" : "no"}`]),
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
      if (this.videoHost) await this.videoHost.attachWindow(windowTitle);
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
        ipc.observe(13, "current-vo"),
        ipc.observe(14, "video-format"),
        ipc.observe(15, "hwdec-current"),
        ipc.observe(16, "vo-configured"),
      ]);
      const authoritativePosition = await this.waitForPropertyNumber(ipc, "time-pos");
      const rawPositionTicks = Math.max(0, Math.round(authoritativePosition * TICKS_PER_SECOND));
      const videoReadiness = profile === "legacy"
        ? { hasVideo: false, hardwareDecoding: null as boolean | null }
        : await this.waitForEmbeddedVideoOutput(ipc);
      if (videoReadiness.hasVideo) this.videoHost?.raise();
      await this.addExternalSubtitles(ipc, playbackTargets);
      this.update({
        ...this.state,
        positionTicks: Math.max(0, this.timelineBaseTicks + rawPositionTicks),
        paused,
        seekable: this.source?.usesServerTimelineOffset ? true : this.state.seekable,
        phase: "ready",
        diagnostics: {
          ...this.state.diagnostics!,
          videoOutput: profile === "legacy" ? null : profile,
          videoOutputHealthy: profile === "legacy" || !videoReadiness.hasVideo ? null : true,
          hardwareDecoding: videoReadiness.hardwareDecoding,
          renderFallbackUsed: profile === "opengl-software",
        },
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
    this.videoHost?.detachWindow();
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
      if (this.state.contentKind === "live-tv") {
        await this.stop(completedSource.playbackId, "ended", { origin: "system" });
        return;
      }

      const continuation = await this.completion.findNextItem(
        async () => {
          const genericResolver = (this.playback as PlaybackSessionService & {
            getNextContinuation?: PlaybackSessionService["getNextContinuation"];
          }).getNextContinuation;
          if (typeof genericResolver === "function") {
            return genericResolver.call(this.playback, {
              itemId: completedSource.itemId,
              itemType: completedSource.itemType,
              seriesId: completedSource.seriesId,
            });
          }
          if (completedSource.itemType !== "Episode" || !completedSource.seriesId) return null;
          const item = await this.playback.getNextUpForSeries(completedSource.seriesId);
          return item && item.id !== completedSource.itemId
            ? { item, source: "jellyfin-next-up" as const, continuationId: null }
            : null;
        },
        () => this.isCurrent(revision, completedSource),
      );
      if (!continuation || !this.isCurrent(revision, completedSource)) {
        if (this.isCurrent(revision, completedSource)) await this.stop(completedSource.playbackId, "ended", { origin: "system" });
        return;
      }

      if (continuation.continuationId) {
        this.playback.reserveContinuation(continuation.continuationId, completedSource.playbackId);
      }
      const decision = await this.waitForAutomaticTransition(revision, completedSource, continuation);
      if (decision === "cancel") {
        this.playback.releaseContinuation(continuation.continuationId);
        if (this.isCurrent(revision, completedSource)) {
          await this.stop(completedSource.playbackId, "ended", { origin: "system" });
        }
        return;
      }
      if (!this.isCurrent(revision, completedSource)) {
        this.playback.releaseContinuation(continuation.continuationId);
        return;
      }
      try {
        await this.transitionToNextItem(revision, completedSource, continuation.item.id);
        if (continuation.continuationId) {
          this.playback.commitContinuation(continuation.continuationId, completedSource.playbackId);
        }
      } catch (error) {
        this.playback.releaseContinuation(continuation.continuationId);
        throw error;
      }
    } catch {
      if (this.isCurrent(revision, completedSource)) await this.stop(completedSource.playbackId, "ended", { origin: "system" }).catch(() => undefined);
    } finally {
      if (this.endHandlingRevision === revision) this.endHandlingRevision = null;
    }
  }

  private async waitForAutomaticTransition(
    revision: number,
    completedSource: ResolvedPlaybackSource,
    continuation: PlaybackContinuationResult,
  ): Promise<"continue" | "cancel"> {
    let resolveDecision!: (decision: "continue" | "cancel") => void;
    const manualDecision = new Promise<"continue" | "cancel">((resolve) => {
      resolveDecision = resolve;
    });
    const pending: PendingAutomaticTransition = {
      revision,
      source: completedSource,
      resolve: resolveDecision,
    };
    this.pendingAutomaticTransition = pending;
    const timedDecision = this.completion.countdown({
      isCurrent: () => this.isCurrent(revision, completedSource) && this.pendingAutomaticTransition === pending,
      show: async (remainingSeconds) => {
        this.update({
          ...this.state,
          nextEpisodeCountdown: {
            nextItemId: continuation.item.id,
            itemType: ["Movie", "Episode", "Video"].includes(continuation.item.type)
              ? continuation.item.type as "Movie" | "Episode" | "Video"
              : "Video",
            title: continuation.item.name,
            seriesName: continuation.item.seriesName,
            seasonNumber: continuation.item.parentIndexNumber,
            episodeNumber: continuation.item.indexNumber,
            remainingSeconds,
            totalSeconds: NEXT_EPISODE_COUNTDOWN_SECONDS,
          },
        });
        const label = continuation.item.type === "Episode" ? "Next episode" : "Next up";
        await this.command(["show-text", `${label} in ${remainingSeconds} seconds\nEsc to exit`, 1100]);
      },
    }).then((continuePlayback) => continuePlayback ? "continue" as const : "cancel" as const);

    const decision = await Promise.race([manualDecision, timedDecision]);
    if (this.pendingAutomaticTransition === pending) this.pendingAutomaticTransition = null;
    if (this.isCurrent(revision, completedSource) && this.state.nextEpisodeCountdown) {
      this.update({ ...this.state, nextEpisodeCountdown: null });
    }
    return decision;
  }

  private resolveAutomaticTransition(decision: "continue" | "cancel"): void {
    const pending = this.pendingAutomaticTransition;
    if (!pending) return;
    this.pendingAutomaticTransition = null;
    if (this.state.nextEpisodeCountdown) this.update({ ...this.state, nextEpisodeCountdown: null });
    pending.resolve(decision);
  }

  private async transitionToNextItem(
    completedRevision: number,
    completedSource: ResolvedPlaybackSource,
    nextItemId: string,
  ): Promise<void> {
    const ipc = this.ipc;
    if (!ipc || !this.isCurrent(completedRevision, completedSource)) {
      throw new AppError("PLAYBACK_TRANSITION_STALE", "Playback changed before the next item could start.", 409);
    }
    let nextSource = await this.playback.start(nextItemId, "start-over");
    if (!this.isCurrent(completedRevision, completedSource)) {
      try { this.playback.stop(nextSource.playbackId); } catch { /* Cancelled concurrently. */ }
      throw new AppError("PLAYBACK_TRANSITION_STALE", "Playback changed before the next item could start.", 409);
    }
    let playbackTargets: PlaybackTargets | null = null;
    while (playbackTargets === null) {
      try {
        const candidateTargets = await this.openPlaybackTarget(nextSource);
        if (!this.isCurrent(completedRevision, completedSource)) {
          await this.proxy.close();
          try { this.playback.stop(nextSource.playbackId); } catch { /* Cancelled concurrently. */ }
          throw new AppError("PLAYBACK_TRANSITION_STALE", "Playback changed before the next item could start.", 409);
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
          throw new AppError("PLAYBACK_TRANSITION_STALE", "Playback changed before the next item could start.", 409);
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
      throw new AppError("PLAYBACK_TRANSITION_STALE", "Playback changed before the next item could start.", 409);
    }

    const retained = { volume: this.state.volume, fullscreen: this.state.fullscreen };
    const revision = ++this.playbackRevision;
    this.playbackTarget = playbackTargets;
    this.reportingActive = false;
    this.adoptResolvedSource(nextSource, nextItemId, "item-transition", { origin: "system" }, retained);

    try {
      if (!this.isCurrent(revision, nextSource)) throw new AppError("PLAYBACK_TRANSITION_STALE", "Playback changed during the item transition.", 409);
      await this.addExternalSubtitles(ipc, playbackTargets);
      // keep-open=yes leaves mpv paused at EOF. Replacing the file does not
      // reliably clear that native pause state, so explicitly re-arm playback
      // after the new source has been adopted and before reporting its start.
      this.pendingPause = { paused: false, expiresAt: performance.now() + 3000 };
      await ipc.command(["set_property", "pause", false]);
      const position = await this.waitForPropertyNumber(ipc, "time-pos");
      this.update({
        ...this.state,
        positionTicks: Math.max(0, this.timelineBaseTicks + Math.round(position * TICKS_PER_SECOND)),
        paused: false,
        phase: "loading",
      });
      await this.report("start");
      if (!this.isCurrent(revision, nextSource)) throw new AppError("PLAYBACK_TRANSITION_STALE", "Playback changed during the item transition.", 409);
      this.update({ ...this.state, phase: "playing" });
      this.startReportingTimer();
      if (!this.isCurrent(revision, nextSource) || this.state.playbackId !== nextSource.playbackId || this.state.itemId !== nextItemId) {
        throw new AppError("PLAYBACK_ADOPTION_UNCONFIRMED", "The next item transition was not confirmed.", 409);
      }
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

  private waitForEvent(ipc: MpvCommandClient, eventName: string, timeoutMilliseconds: number): Promise<void> {
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

  private async addExternalSubtitles(ipc: MpvCommandClient, targets: PlaybackTargets): Promise<void> {
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

  private async persistWindowStateIfWindowed(ipc: MpvCommandClient | null): Promise<void> {
    if (!ipc || this.videoHost || this.libMpvHost) return;
    const fullscreen = await ipc.command(["get_property", "fullscreen"]).catch(() => this.state.fullscreen);
    if (fullscreen === true) return;
    const maximized = await ipc.command(["get_property", "window-maximized"]).catch(() => this.windowMaximized);
    if (typeof maximized !== "boolean") return;
    this.windowMaximized = maximized;
    await this.preferences.setWindowMaximized(maximized);
  }

  private async waitForEmbeddedVideoOutput(ipc: MpvCommandClient): Promise<{ hasVideo: boolean; hardwareDecoding: boolean | null }> {
    const deadline = Date.now() + VIDEO_OUTPUT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const trackList = await ipc.command(["get_property", "track-list"]).catch(() => null);
      const videoPresent = hasVideoTrack(trackList);
      if (!videoPresent && hasAudioOrVideoTrack(trackList)) {
        return { hasVideo: false, hardwareDecoding: null };
      }
      if (videoPresent) {
        const [configured, currentVo, videoFormat, hwdec] = await Promise.all([
          ipc.command(["get_property", "vo-configured"]).catch(() => null),
          ipc.command(["get_property", "current-vo"]).catch(() => null),
          ipc.command(["get_property", "video-format"]).catch(() => null),
          ipc.command(["get_property", "hwdec-current"]).catch(() => null),
        ]);
        if (configured === true && typeof currentVo === "string" && currentVo.length > 0
          && typeof videoFormat === "string" && videoFormat.length > 0) {
          return {
            hasVideo: true,
            hardwareDecoding: typeof hwdec === "string" && hwdec.length > 0 && hwdec !== "no",
          };
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new AppError("VIDEO_OUTPUT_UNAVAILABLE", "Embedded video output did not become ready.", 503);
  }

  private async waitForPropertyNumber(ipc: MpvCommandClient, property: string): Promise<number> {
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
    if (this.activeRenderProfile !== "legacy" && message.name === "current-vo" && typeof message.data === "string") {
      next.diagnostics = {
        ...next.diagnostics!,
        videoOutput: this.activeRenderProfile,
        renderFallbackUsed: this.activeRenderProfile === "opengl-software",
      };
    }
    if (this.activeRenderProfile !== "legacy" && message.name === "vo-configured" && typeof message.data === "boolean") {
      next.diagnostics = { ...next.diagnostics!, videoOutputHealthy: message.data };
    }
    if (this.activeRenderProfile !== "legacy" && message.name === "hwdec-current") {
      next.diagnostics = {
        ...next.diagnostics!,
        hardwareDecoding: typeof message.data === "string" && message.data.length > 0 && message.data !== "no",
      };
    }
    if (message.name === "seeing-stone-frame-stats" && message.data && typeof message.data === "object") {
      const stats = message.data as Record<string, unknown>;
      next.diagnostics = {
        ...next.diagnostics!,
        frameQueueDepth: typeof stats.outstandingFrames === "number"
          ? stats.outstandingFrames
          : next.diagnostics?.frameQueueDepth ?? null,
        droppedFrames: typeof stats.droppedFrames === "number"
          ? stats.droppedFrames
          : next.diagnostics?.droppedFrames ?? null,
        videoOutputHealthy: stats.unusable === true ? false : next.diagnostics?.videoOutputHealthy ?? null,
      };
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

  private exitIntegratedFullscreen(): void {
    if ((!this.videoHost && !this.libMpvHost) || this.mainWindow.isDestroyed()) return;
    if (this.mainWindow.isKiosk()) this.mainWindow.setKiosk(false);
    if (this.mainWindow.isFullScreen()) this.mainWindow.setFullScreen(false);
  }

  private async report(
    kind: "start" | "progress" | "stop",
    actionKind?: "progress" | "completed" | "start_over" | "replay" | "mark_watched" | "mark_unwatched",
    conflictPolicy?: "automatic" | "explicit",
  ): Promise<void> {
    const source = this.source;
    if (!source) return;
    if (kind !== "start" && !this.reportingActive) return;
    if (kind === "start") this.reportingActive = true;
    else if (kind === "stop") this.reportingActive = false;
    const selectedAudio = this.state.audioTracks.find((track) => track.selected);
    const selectedSubtitle = this.state.subtitleTracks.find((track) => track.selected);
    const resolvedActionKind = actionKind ?? (kind === "start" ? source.initialAction : "progress");
    await this.reporting.acceptAuthoritativeEvent({
      kind,
      itemId: source.itemId,
      mediaSourceId: source.mediaSourceId,
      playMethod: source.source === "local" || source.sourceKind === "direct-play"
        ? "DirectPlay"
        : source.delivery === "transcode" ? "Transcode" : "DirectStream",
      positionTicks: this.state.positionTicks,
      paused: this.state.paused,
      playSessionId: source.serverPlaySessionId,
      canSeek: this.state.seekable,
      audioStreamIndex: selectedAudio?.streamIndex ?? null,
      subtitleStreamIndex: selectedSubtitle?.external
        ? this.externalSubtitleStreamByTrackId.get(selectedSubtitle.id) ?? null
        : selectedSubtitle?.streamIndex ?? null,
      actionKind: resolvedActionKind,
      watched: resolvedActionKind === "completed" || resolvedActionKind === "mark_watched",
      conflictPolicy: conflictPolicy
        ?? (resolvedActionKind !== "progress" ? "explicit" : "automatic"),
      contentKind: source.contentKind,
      liveStreamId: source.liveStreamId,
    });
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

export class LibMpvAdapter extends MpvPlayerService {
  constructor(
    mainWindow: BrowserWindow,
    playback: PlaybackSessionService,
    reporting: PlaybackReportingService,
    preferences: PlayerPreferencesStore,
    runtime: MpvRuntimePaths,
    host: LibMpvHost,
  ) {
    super(mainWindow, playback, reporting, preferences, runtime, undefined, host);
  }
}
