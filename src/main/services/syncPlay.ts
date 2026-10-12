import { z } from "zod";
import type {
  BufferingPolicyMode,
  JoinedWatchParty,
  PlaybackStartResult,
  PlaybackState,
  WatchPartyPlaybackState,
  WatchPartySummary,
  WatchPartyViewState,
} from "../../shared/contracts";
import { AppError } from "./errors";
import type { JellyfinApi } from "./jellyfinApi";
import type { AppLogger } from "./logger";
import type { PlayerController, PlayerControllerEvent } from "./playerController";
import type { ApplicationPreferences } from "./applicationPreferences";
import {
  DisabledParticipantTelemetryTransport,
  ENHANCED_TELEMETRY_DISABLED_REASON,
  ParticipantTelemetryCoordinator,
  type ParticipantTelemetryTransport,
} from "./participantTelemetry";

// `ws` intentionally stays main-only. Its API is typed locally so no browser
// WebSocket or renderer networking can accidentally enter this service.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const WebSocketClient = require("ws") as new (
  address: string,
  options: { headers: Record<string, string>; handshakeTimeout: number },
) => MainWebSocket;

interface MainWebSocket {
  readyState: number;
  on(event: "open" | "close" | "error" | "message", listener: (...args: any[]) => void): this;
  once(event: "open" | "close" | "error", listener: (...args: any[]) => void): this;
  close(): void;
  terminate(): void;
}

const guid = z.string().regex(/^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
const groupState = z.enum(["Idle", "Waiting", "Paused", "Playing"]);
const groupInfoSchema = z.object({
  GroupId: guid,
  GroupName: z.string().max(200),
  State: groupState,
  Participants: z.array(z.string().max(256)).max(128),
  LastUpdatedAt: z.string().datetime(),
}).strict();
const groupUpdateSchema = z.object({
  GroupId: guid,
  Type: z.enum([
    "UserJoined", "UserLeft", "GroupJoined", "GroupLeft", "StateUpdate", "PlayQueue",
    "NotInGroup", "GroupDoesNotExist", "LibraryAccessDenied",
  ]),
  Data: z.unknown(),
}).strict();
const queueItemSchema = z.object({ ItemId: guid, PlaylistItemId: guid }).strict();
const playQueueSchema = z.object({
  Reason: z.enum([
    "NewPlaylist", "SetCurrentItem", "RemoveItems", "MoveItem", "Queue",
    "QueueNext", "NextItem", "PreviousItem", "RepeatMode", "ShuffleMode",
  ]),
  LastUpdate: z.string().datetime(),
  Playlist: z.array(queueItemSchema).min(1).max(1000),
  PlayingItemIndex: z.number().int().min(0),
  StartPositionTicks: z.number().int().min(0),
  IsPlaying: z.boolean(),
  ShuffleMode: z.enum(["Sorted", "Shuffle"]),
  RepeatMode: z.enum(["RepeatOne", "RepeatAll", "RepeatNone"]),
}).strict();
const stateUpdateSchema = z.object({
  State: groupState,
  Reason: z.enum([
    "Play", "SetPlaylistItem", "RemoveFromPlaylist", "MovePlaylistItem", "Queue",
    "Unpause", "Pause", "Stop", "Seek", "Buffer", "Ready", "NextItem",
    "PreviousItem", "SetRepeatMode", "SetShuffleMode", "Ping", "IgnoreWait",
  ]),
}).strict();
const commandSchema = z.object({
  GroupId: guid,
  PlaylistItemId: guid,
  When: z.string().datetime(),
  PositionTicks: z.number().int().min(0).nullable(),
  Command: z.enum(["Unpause", "Pause", "Stop", "Seek"]),
  EmittedAt: z.string().datetime(),
}).strict();
const envelopeSchema = z.object({
  MessageId: guid,
  MessageType: z.enum(["SyncPlayGroupUpdate", "SyncPlayCommand"]),
  Data: z.unknown(),
}).strict();

type Envelope = z.infer<typeof envelopeSchema>;
type GroupUpdate = z.infer<typeof groupUpdateSchema>;
type Command = z.infer<typeof commandSchema>;

interface MessageEntry { envelope: Envelope; sequence: number }
interface SyncAnchor {
  membershipRevision: number;
  playlistItemId: string;
  positionTicks: number;
  playing: boolean;
  monotonicTimestampMs: number;
}
interface TimeMeasurement { offsetMs: number; delayMs: number }

const TICKS_PER_SECOND = 10_000_000;
const MAX_PLAYBACK_TICKS = 864_000_000_000;
const DRIFT_TOLERANCE_TICKS = 1_000_000;
const DRIFT_RATE_RESET_TICKS = 500_000;
const DRIFT_MEDIUM_RATE_TICKS = 4_000_000;
const DRIFT_HIGH_RATE_TICKS = 16_000_000;
const DRIFT_SEEK_TICKS = 30_000_000;

const emptyState = (localSyncOffsetMilliseconds = 0): WatchPartyViewState => ({
  availability: "signed-out",
  connection: "disconnected",
  groups: [],
  joinedGroup: null,
  sharedControls: true,
  preparation: {
    phase: "idle",
    minimumParticipants: 2,
    localSyncOffsetMilliseconds,
    scheduledStartAtUnixMs: null,
  },
  sync: {
    serverLatencyMs: null,
    localDriftTicks: null,
    authoritativeTimelineReady: false,
    measuredAtUnixMs: null,
  },
  telemetry: {
    protocolVersion: 1,
    availability: "disabled",
    transport: "none",
    reason: ENHANCED_TELEMETRY_DISABLED_REASON,
    participants: [],
    incident: null,
    policy: { mode: "wait-for-all", gracePeriodMs: 1500 },
  },
  error: null,
});

function safeGroup(value: z.infer<typeof groupInfoSchema>): WatchPartySummary {
  return {
    groupId: value.GroupId,
    name: value.GroupName,
    playbackState: value.State,
    participants: [...value.Participants],
    participantCount: value.Participants.length,
    lastUpdatedAt: value.LastUpdatedAt,
  };
}

function publicError(error: unknown): { code: string; message: string } {
  if (error instanceof AppError) return { code: error.code, message: error.message };
  return { code: "SYNCPLAY_UNAVAILABLE", message: "Watch parties are temporarily unavailable." };
}

export class SyncPlayService {
  private state = emptyState();
  private listeners = new Set<(state: WatchPartyViewState) => void>();
  private socket: MainWebSocket | null = null;
  private activationRevision = 0;
  private commandRevision = 0;
  private membershipRevision = 0;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private driftTimer: ReturnType<typeof setInterval> | null = null;
  private timeSyncTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private rememberedGroupId: string | null = null;
  private reconciling = false;
  private messageHistory: MessageEntry[] = [];
  private messageSequence = 0;
  private appliedMessageIds = new Set<string>();
  private currentPlaylistItemId: string | null = null;
  private playerUnsubscribe: (() => void) | null = null;
  private queueTask: Promise<void> = Promise.resolve();
  private syncAnchor: SyncAnchor | null = null;
  private driftCorrectionInFlight = false;
  private timeMeasurements: TimeMeasurement[] = [];
  private serverTimeOffsetMs = 0;
  private latencyMs = 0;
  private timeSyncReady = false;
  private currentUserName: string | null = null;
  private transitionItemInFlight: string | null = null;
  private lastPublishedTransitionItemId: string | null = null;
  private viewVisible = false;
  private localResyncInFlight: Promise<PlaybackState> | null = null;
  private lastDriftTicks: number | null = null;
  private driftMeasuredAtUnixMs: number | null = null;
  private localSyncOffsetMilliseconds = 0;
  private appliedLocalOffsetTicks = 0;
  private localOffsetPending = false;
  private localOffsetRevision = 0;
  private localOffsetInFlight = false;
  private timelineCommandsInFlight = 0;
  private localItemPrepared = false;
  private readyReported = false;
  private currentItemStarted = false;
  private scheduledCommandRevision = 0;
  private cancelCommandWait: (() => void) | null = null;
  private latestCommandEmittedAt = 0;
  private preparationRevision = 0;
  private preparationQueue: z.infer<typeof playQueueSchema> | null = null;
  private readyRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private readyAttempts = 0;
  private readyReportRevision = 0;
  private readonly telemetry: ParticipantTelemetryCoordinator;

  constructor(
    private readonly api: JellyfinApi,
    private readonly player: PlayerController,
    private readonly logger: AppLogger,
    private readonly refreshIntervalMs = 5000,
    private readonly preferences?: Pick<ApplicationPreferences, "getBufferingPolicy" | "setBufferingPolicy">
      & Partial<Pick<ApplicationPreferences, "getWatchPartySyncOffset" | "setWatchPartySyncOffset">>,
    telemetryTransport: ParticipantTelemetryTransport = new DisabledParticipantTelemetryTransport(),
  ) {
    this.telemetry = new ParticipantTelemetryCoordinator(
      telemetryTransport,
      () => this.localTelemetrySnapshot(),
      {
        pauseGroup: async () => {
          this.requireJoined();
          await this.api.syncPlayRequest("/SyncPlay/Pause", {}, "POST");
        },
        resumeGroup: async () => {
          this.requireJoined();
          await this.api.syncPlayRequest("/SyncPlay/Unpause", {}, "POST");
        },
      },
    );
    this.telemetry.onState(() => {
      const snapshot = this.getState();
      for (const listener of this.listeners) listener(snapshot);
    });
  }

  onState(listener: (state: WatchPartyViewState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getState(): WatchPartyViewState {
    const authoritativeTimelineReady = this.hasAuthoritativeTimeline();
    return structuredClone({
      ...this.state,
      sync: {
        serverLatencyMs: this.timeSyncReady ? this.latencyMs : null,
        localDriftTicks: authoritativeTimelineReady ? this.lastDriftTicks : null,
        authoritativeTimelineReady,
        measuredAtUnixMs: authoritativeTimelineReady ? this.driftMeasuredAtUnixMs : null,
      },
      telemetry: this.telemetry.getState(),
    });
  }

  isJoined(): boolean {
    return this.state.joinedGroup !== null;
  }

  async activate(): Promise<WatchPartyViewState> {
    await this.deactivate(false);
    this.localSyncOffsetMilliseconds = await this.preferences?.getWatchPartySyncOffset?.().catch(() => 0) ?? 0;
    const policy = await this.preferences?.getBufferingPolicy().catch(() => "wait-for-all" as const) ?? "wait-for-all";
    this.telemetry.setPolicy(policy);
    const revision = ++this.activationRevision;
    let context;
    try { context = this.api.getAuthenticatedSocketContext(); }
    catch {
      this.setState(emptyState(this.localSyncOffsetMilliseconds));
      return this.getState();
    }
    if (context.serverVersion !== "10.11.11") {
      this.setState({
        ...emptyState(this.localSyncOffsetMilliseconds),
        availability: "unsupported",
        error: { code: "SYNCPLAY_VERSION_UNSUPPORTED", message: `Watch parties require the tested Jellyfin 10.11.11 server (this server reports ${context.serverVersion || "an unknown version"}).` },
      });
      return this.getState();
    }
    this.currentUserName = context.userName;
    this.setState({ ...emptyState(this.localSyncOffsetMilliseconds), availability: "connecting", connection: "connecting" });
    this.reconciling = true;
    try {
      await this.openSocket(revision);
      if (revision !== this.activationRevision) throw new AppError("SESSION_CHANGED", "The Jellyfin session changed.");
      await this.synchronizeTime(3);
      this.playerUnsubscribe = this.player.onEvent((event) => { void this.handlePlayerEvent(event).catch((error) => this.handleBackgroundFailure(error)); });
      await this.refreshGroups();
      this.reconciling = false;
      this.reconnectAttempt = 0;
      this.startPeriodicTasks();
      this.setState({ ...this.state, availability: "available", connection: "connected", error: null });
      await this.maybeReportReady();
      context.signal.addEventListener("abort", () => { if (revision === this.activationRevision) void this.deactivate(false); }, { once: true });
    } catch (error) {
      this.closeTransport();
      const denied = error instanceof AppError && error.status === 403;
      this.setState({
        ...this.state,
        availability: denied ? "denied" : "offline",
        connection: "disconnected",
        error: denied
          ? { code: "SYNCPLAY_ACCESS_DENIED", message: "Your Jellyfin account is not allowed to use SyncPlay watch parties." }
          : publicError(error),
      });
      if (!denied) this.scheduleReconnect(revision);
    }
    return this.getState();
  }

  async deactivate(leave = true): Promise<void> {
    this.activationRevision += 1;
    this.cancelPreparation();
    if (leave && this.state.joinedGroup) {
      await this.api.syncPlayRequest("/SyncPlay/Leave", {}, "POST").catch(() => undefined);
    }
    this.closeTransport();
    this.currentPlaylistItemId = null;
    this.rememberedGroupId = null;
    this.reconciling = false;
    this.currentUserName = null;
    this.transitionItemInFlight = null;
    this.lastPublishedTransitionItemId = null;
    this.viewVisible = false;
    this.syncAnchor = null;
    this.lastDriftTicks = null;
    this.driftMeasuredAtUnixMs = null;
    this.localItemPrepared = false;
    this.readyReported = false;
    this.currentItemStarted = false;
    this.timeMeasurements = [];
    this.serverTimeOffsetMs = 0;
    this.latencyMs = 0;
    this.timeSyncReady = false;
    this.membershipRevision += 1;
    this.messageHistory = [];
    this.preparationQueue = null;
    this.latestCommandEmittedAt = 0;
    this.appliedMessageIds.clear();
    await this.telemetry.stop();
    await this.restoreNormalRate().catch(() => undefined);
    this.player.setAutomaticTransitionsEnabled(true);
    this.setState(emptyState(this.localSyncOffsetMilliseconds));
  }

  async list(): Promise<WatchPartyViewState> {
    await this.refreshGroups();
    return this.getState();
  }

  async setViewVisible(visible: boolean): Promise<WatchPartyViewState> {
    this.viewVisible = visible;
    if (!visible) {
      if (this.refreshTimer) clearInterval(this.refreshTimer);
      this.refreshTimer = null;
      return this.getState();
    }
    if (this.state.connection === "connected" && !this.reconciling) {
      await this.refreshGroups();
      this.startRefreshTimer();
    }
    return this.getState();
  }

  async create(name: string): Promise<WatchPartyViewState> {
    this.requireAvailable();
    const from = this.messageSequence;
    await this.api.syncPlayRequest("/SyncPlay/New", { GroupName: name }, "POST");
    await this.waitForGroupUpdate("GroupJoined", from);
    await this.refreshGroups();
    return this.getState();
  }

  async join(groupId: string): Promise<WatchPartyViewState> {
    this.requireAvailable();
    const from = this.messageSequence;
    await this.api.syncPlayRequest("/SyncPlay/Join", { GroupId: groupId }, "POST");
    await this.waitForGroupUpdate("GroupJoined", from, groupId);
    await this.refreshGroups();
    return this.getState();
  }

  async leave(): Promise<WatchPartyViewState> {
    if (!this.state.joinedGroup) return this.getState();
    this.cancelPreparation();
    this.rememberedGroupId = null;
    const from = this.messageSequence;
    await this.api.syncPlayRequest("/SyncPlay/Leave", {}, "POST");
    await this.waitForGroupUpdate("GroupLeft", from).catch(() => undefined);
    this.clearJoinedGroup();
    await this.refreshGroups();
    return this.getState();
  }

  async selectItem(itemId: string, resumeMode: "resume" | "start-over"): Promise<PlaybackStartResult> {
    const group = this.requireJoined();
    const details = await this.api.getDetails(itemId);
    const startPositionTicks = resumeMode === "resume" ? details.userData.playbackPositionTicks : 0;
    await this.api.syncPlayRequest("/SyncPlay/SetNewQueue", {
      PlayingQueue: [itemId],
      PlayingItemPosition: 0,
      StartPositionTicks: startPositionTicks,
    }, "POST");
    const state = await this.waitForPlayerItem(itemId, 30000);
    if (!this.state.joinedGroup || this.state.joinedGroup.groupId !== group.groupId) {
      throw new AppError("SYNCPLAY_GROUP_CHANGED", "The watch party changed while playback was loading.", 409);
    }
    if (!state.playbackId || !state.source || !state.diagnostics?.sourceKind) {
      throw new AppError("SYNCPLAY_PLAYBACK_SOURCE_UNKNOWN", "The shared item started without verified source diagnostics.", 500);
    }
    return {
      playbackId: state.playbackId,
      resumePositionTicks: state.positionTicks,
      durationTicks: state.durationTicks,
      source: state.source,
      sourceKind: state.diagnostics.sourceKind,
    };
  }

  async requestPaused(paused: boolean): Promise<PlaybackState> {
    this.requireJoined();
    if (paused) this.cancelScheduledCommand();
    if (!paused && this.isInitialStartGated()) {
      throw new AppError("SYNCPLAY_WAITING_FOR_PARTICIPANT", "Waiting for another participant. Leave the party to watch solo.", 409);
    }
    await this.api.syncPlayRequest(paused ? "/SyncPlay/Pause" : "/SyncPlay/Unpause", {}, "POST");
    return this.player.getState();
  }

  async setLocalSyncOffset(offsetMilliseconds: number): Promise<WatchPartyViewState> {
    if (!Number.isInteger(offsetMilliseconds) || offsetMilliseconds < -2000 || offsetMilliseconds > 2000 || offsetMilliseconds % 100 !== 0) {
      throw new AppError("SYNCPLAY_OFFSET_INVALID", "Timing adjustment must be between 2 seconds later and 2 seconds earlier in 100 ms steps.", 422);
    }
    await this.preferences?.setWatchPartySyncOffset?.(offsetMilliseconds);
    this.localSyncOffsetMilliseconds = offsetMilliseconds;
    this.localOffsetRevision += 1;
    this.localOffsetPending = true;
    this.setPreparation({ localSyncOffsetMilliseconds: offsetMilliseconds });
    await this.applyLocalSyncOffsetImmediately();
    await this.correctDrift().catch((error) => this.handleBackgroundFailure(error));
    return this.getState();
  }

  async requestSeek(positionTicks: number): Promise<PlaybackState> {
    this.requireJoined();
    this.cancelScheduledCommand();
    await this.api.syncPlayRequest("/SyncPlay/Seek", { PositionTicks: positionTicks }, "POST");
    return this.player.getState();
  }

  async requestStop(): Promise<PlaybackState> {
    this.requireJoined();
    this.cancelPreparation();
    await this.api.syncPlayRequest("/SyncPlay/Stop", {}, "POST");
    return this.player.getState();
  }

  async waitForAll(): Promise<WatchPartyViewState> {
    this.requireJoined();
    this.cancelScheduledCommand();
    await this.telemetry.wait();
    return this.getState();
  }

  async continueAfterBuffering(): Promise<WatchPartyViewState> {
    this.requireJoined();
    await this.telemetry.continue();
    return this.getState();
  }

  async setBufferingPolicy(mode: BufferingPolicyMode): Promise<WatchPartyViewState> {
    await this.preferences?.setBufferingPolicy(mode);
    this.telemetry.setPolicy(mode);
    return this.getState();
  }

  async resyncGroup(): Promise<WatchPartyViewState> {
    const joined = this.requireJoined();
    const anchor = this.syncAnchor;
    if (!anchor || !this.hasAuthoritativeTimeline() || !joined.playlistItemId || anchor.playlistItemId !== joined.playlistItemId) {
      throw new AppError("SYNCPLAY_RESYNC_NOT_READY", "Choose and start a shared item before resyncing the watch party.", 409);
    }
    const elapsedTicks = anchor.playing ? Math.max(0, (performance.now() - anchor.monotonicTimestampMs) * 10_000) : 0;
    const targetTicks = Math.min(MAX_PLAYBACK_TICKS, Math.max(0, Math.round(anchor.positionTicks + elapsedTicks)));
    await this.api.syncPlayRequest("/SyncPlay/Seek", { PositionTicks: targetTicks }, "POST");
    return this.getState();
  }

  async resyncLocal(): Promise<PlaybackState> {
    if (this.localResyncInFlight) return this.localResyncInFlight;
    const operation = this.performLocalResync();
    this.localResyncInFlight = operation;
    try {
      return await operation;
    } finally {
      if (this.localResyncInFlight === operation) this.localResyncInFlight = null;
      await this.applyLocalSyncOffsetImmediately();
    }
  }

  async retryPreparation(): Promise<WatchPartyViewState> {
    this.requireJoined();
    const queue = this.preparationQueue;
    if (!queue || this.currentItemStarted || this.state.preparation.phase !== "error") {
      throw new AppError("SYNCPLAY_RETRY_NOT_READY", "Preparation can be retried after a startup failure.", 409);
    }
    this.enqueuePreparation(queue);
    await this.queueTask;
    return this.getState();
  }

  private async performLocalResync(): Promise<PlaybackState> {
    const joined = this.requireJoined();
    const anchor = this.syncAnchor;
    const itemId = joined.currentItemId;
    if (!anchor || !itemId || !joined.playlistItemId || anchor.playlistItemId !== joined.playlistItemId) {
      throw new AppError("SYNCPLAY_RESYNC_NOT_READY", "Choose and start a shared item before resyncing this computer.", 409);
    }
    const membershipRevision = this.membershipRevision;
    const context = {
      origin: "remote-sync" as const,
      commandRevision: ++this.commandRevision,
      commandId: `manual-resync:${joined.playlistItemId}:${this.commandRevision}`,
    };
    let state = this.player.getState();
    if (state.itemId !== itemId || !state.playbackId) {
      await this.player.loadItem(itemId, "start-over", context);
      state = await this.waitForPlayerItem(itemId, 30000);
    }
    if (!this.state.joinedGroup || membershipRevision !== this.membershipRevision || !state.playbackId) {
      throw new AppError("SYNCPLAY_GROUP_CHANGED", "The watch party changed while this computer was resyncing.", 409);
    }
    const playbackId = state.playbackId;
    const isCurrent = () => membershipRevision === this.membershipRevision && this.syncAnchor === anchor
      && this.player.getState().playbackId === playbackId;
    const offsetRevision = this.localOffsetRevision;
    const groupTargetTicks = this.authoritativeTargetTicks(anchor);
    const targetTicks = this.currentItemStarted ? this.offsetTargetTicks(groupTargetTicks, state.durationTicks) : groupTargetTicks;
    if (this.player.getPlaybackRate() !== 1) state = await this.player.setPlaybackRate(playbackId, 1, context);
    if (!isCurrent()) throw new AppError("SYNCPLAY_PREPARATION_CANCELLED", "The shared timeline changed.");
    if (!state.paused) state = await this.player.setPaused(playbackId, true, context);
    if (!isCurrent()) throw new AppError("SYNCPLAY_PREPARATION_CANCELLED", "The shared timeline changed.");
    state = await this.player.seek(playbackId, targetTicks, context);
    state = await this.waitForPlayerTarget(itemId, targetTicks, true, 15000, isCurrent);
    this.appliedLocalOffsetTicks = targetTicks - groupTargetTicks;
    if (this.currentItemStarted && offsetRevision === this.localOffsetRevision) this.localOffsetPending = false;
    if (anchor.playing) state = await this.player.setPaused(playbackId, false, context);
    if (!isCurrent()) {
      throw new AppError("SYNCPLAY_GROUP_CHANGED", "The watch party changed while this computer was resyncing.", 409);
    }
    // Keep Jellyfin's anchor separate from this computer's shifted target.
    if (this.currentItemStarted) await this.sendReady(anchor.playing);
    else {
      this.localItemPrepared = true;
      await this.maybeReportReady();
    }
    this.setState({ ...this.state, error: null });
    return state;
  }

  private async openSocket(revision: number): Promise<void> {
    const context = this.api.getAuthenticatedSocketContext();
    const url = new URL(context.serverAddress);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = `${url.pathname.replace(/\/$/, "")}/socket`;
    url.search = "";
    const socket = new WebSocketClient(url.toString(), {
      headers: { "X-Emby-Authorization": context.authorizationHeader },
      handshakeTimeout: 10000,
    });
    this.socket = socket;
    socket.on("message", (data: unknown) => {
      if (revision !== this.activationRevision || socket !== this.socket) return;
      this.receiveMessage(data);
    });
    socket.on("close", () => {
      if (revision !== this.activationRevision || socket !== this.socket) return;
      this.socket = null;
      this.cancelPreparation();
      this.stopPeriodicTasks();
      this.reconciling = true;
      this.timeSyncReady = false;
      this.updateTransitionAuthority();
      this.setState({ ...this.state, connection: "disconnected", availability: "offline", error: { code: "SYNCPLAY_RECONNECTING", message: "The watch-party connection was interrupted. Reconnecting..." } });
      this.scheduleReconnect(revision);
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new AppError("SYNCPLAY_CONNECT_TIMEOUT", "The watch-party connection timed out.")), 10000);
      socket.once("open", () => { clearTimeout(timer); resolve(); });
      socket.once("error", () => { clearTimeout(timer); reject(new AppError("SYNCPLAY_CONNECT_FAILED", "The Jellyfin watch-party connection could not be opened.")); });
    });
    if (revision !== this.activationRevision) {
      socket.close();
      throw new AppError("SESSION_CHANGED", "The Jellyfin session changed.");
    }
  }

  private receiveMessage(raw: unknown): void {
    let parsed: unknown;
    try {
      const text = typeof raw === "string" ? raw : Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw);
      parsed = JSON.parse(text);
    } catch { return; }
    const envelope = envelopeSchema.safeParse(parsed);
    if (!envelope.success) return;
    if (this.appliedMessageIds.has(envelope.data.MessageId)) return;
    this.messageHistory.push({ envelope: envelope.data, sequence: ++this.messageSequence });
    if (this.messageHistory.length > 200) this.messageHistory.splice(0, this.messageHistory.length - 200);
    if (envelope.data.MessageType === "SyncPlayGroupUpdate") {
      const update = groupUpdateSchema.safeParse(envelope.data.Data);
      if (!update.success) return;
      this.rememberMessage(envelope.data.MessageId);
      this.handleGroupUpdate(update.data);
      return;
    }
    const command = commandSchema.safeParse(envelope.data.Data);
    if (!command.success) return;
    this.rememberMessage(envelope.data.MessageId);
    void this.handleCommand(envelope.data.MessageId, command.data).catch((error) => this.handleBackgroundFailure(error));
  }

  private handleGroupUpdate(update: GroupUpdate): void {
    const joined = this.state.joinedGroup;
    if (update.Type === "GroupJoined") {
      this.applyJoinedGroup(update);
      return;
    }
    if (joined && update.GroupId !== joined.groupId) return;
    if (update.Type === "GroupLeft" || update.Type === "NotInGroup" || update.Type === "GroupDoesNotExist") {
      this.clearJoinedGroup();
      if (update.Type === "GroupDoesNotExist") {
        void this.refreshGroups().then(() => {
          if (!this.state.joinedGroup) this.setState({ ...this.state, error: { code: "SYNCPLAY_GROUP_ENDED", message: "That watch party no longer exists." } });
        }).catch(() => undefined);
      } else {
        void this.refreshGroups().catch(() => undefined);
      }
      return;
    }
    if (update.Type === "LibraryAccessDenied") {
      this.setState({ ...this.state, error: { code: "SYNCPLAY_LIBRARY_ACCESS_DENIED", message: "This account cannot access every item in that watch party." } });
      return;
    }
    if (!joined) return;
    if (update.Type === "UserJoined" && typeof update.Data === "string") {
      const participants = [...new Set([...joined.participants, update.Data])];
      this.setJoined({ ...joined, participants, participantCount: participants.length });
      void this.maybeReportReady().catch((error) => this.handleBackgroundFailure(error));
    } else if (update.Type === "UserLeft" && typeof update.Data === "string") {
      const participants = joined.participants.filter((name) => name !== update.Data);
      this.setJoined({ ...joined, participants, participantCount: participants.length });
      if (!this.currentItemStarted && participants.length < 2 && this.localItemPrepared) {
        this.cancelScheduledCommand();
        this.clearReadyRetry();
        this.readyReported = false;
        this.setPreparation({ phase: "waiting-for-participant", scheduledStartAtUnixMs: null });
        void this.sendBuffering(true).catch((error) => this.handleBackgroundFailure(error));
      }
    } else if (update.Type === "StateUpdate") {
      const value = stateUpdateSchema.safeParse(update.Data);
      if (value.success) this.setJoined({ ...joined, playbackState: value.data.State as WatchPartyPlaybackState });
    } else if (update.Type === "PlayQueue") {
      const queue = playQueueSchema.safeParse(update.Data);
      if (!queue.success || queue.data.PlayingItemIndex >= queue.data.Playlist.length) {
        this.logger.warn("SyncPlay queue update rejected.", { code: "SYNCPLAY_PROTOCOL_INVALID" });
        this.setState({
          ...this.state,
          error: { code: "SYNCPLAY_PROTOCOL_INVALID", message: "Jellyfin sent an invalid shared playlist. Leave and rejoin the watch party." },
        });
        return;
      }
      this.enqueuePreparation(queue.data);
    }
  }

  private enqueuePreparation(queue: z.infer<typeof playQueueSchema>): void {
    this.cancelPreparation();
    this.preparationQueue = queue;
    this.latestCommandEmittedAt = 0;
    this.localItemPrepared = false;
    this.readyReported = false;
    this.readyAttempts = 0;
    this.currentItemStarted = false;
    this.appliedLocalOffsetTicks = 0;
    const membershipRevision = this.membershipRevision;
    const revision = this.preparationRevision;
    this.setState({ ...this.state, error: null });
    this.setPreparation({ phase: "preparing", scheduledStartAtUnixMs: null });
    this.queueTask = this.queueTask.then(async () => {
      if (revision !== this.preparationRevision) return;
      await this.applyPlayQueue(queue, membershipRevision, revision);
    }).catch((error) => {
      if (revision !== this.preparationRevision) return;
      this.logger.warn("SyncPlay queue application failed.", { code: error instanceof AppError ? error.code : "SYNCPLAY_QUEUE_FAILED" });
      this.setPreparation({ phase: "error", scheduledStartAtUnixMs: null });
      this.setState({ ...this.state, error: publicError(error) });
    });
  }

  private async applyPlayQueue(queue: z.infer<typeof playQueueSchema>, membershipRevision: number, revision = this.preparationRevision): Promise<void> {
    const joined = this.state.joinedGroup;
    const isCurrent = () => Boolean(this.state.joinedGroup && membershipRevision === this.membershipRevision && revision === this.preparationRevision);
    if (!joined || !isCurrent()) return;
    const selected = queue.Playlist[queue.PlayingItemIndex];
    this.lastDriftTicks = null;
    this.driftMeasuredAtUnixMs = null;
    this.currentPlaylistItemId = selected.PlaylistItemId;
    this.localItemPrepared = false;
    this.readyReported = false;
    this.currentItemStarted = false;
    this.setPreparation({ phase: "preparing", scheduledStartAtUnixMs: null });
    if (this.lastPublishedTransitionItemId !== selected.ItemId) this.lastPublishedTransitionItemId = null;
    this.setJoined({ ...joined, currentItemId: selected.ItemId, playlistItemId: selected.PlaylistItemId });
    this.syncAnchor = {
      membershipRevision,
      playlistItemId: selected.PlaylistItemId,
      positionTicks: queue.StartPositionTicks,
      playing: false,
      monotonicTimestampMs: performance.now(),
    };
    const state = this.player.getState();
    if (state.itemId !== selected.ItemId || !state.playbackId || ["error", "stopped", "ended", "disconnected"].includes(state.phase) || state.diagnostics?.sourceKind === "downloading") {
      await this.player.loadItem(selected.ItemId, "start-over", {
        origin: "remote-sync",
        commandRevision: ++this.commandRevision,
        commandId: `queue:${selected.PlaylistItemId}`,
      });
    }
    if (!isCurrent()) return;
    let loaded = this.player.getState();
    if (loaded.playbackId && !loaded.paused) {
      loaded = await this.player.setPaused(loaded.playbackId, true, {
        origin: "remote-sync",
        commandRevision: this.commandRevision,
        commandId: `queue-pause:${selected.PlaylistItemId}`,
      });
    }
    if (!isCurrent()) return;
    if (loaded.playbackId && Math.abs(loaded.positionTicks - queue.StartPositionTicks) > 1_000_000) {
      await this.player.seek(loaded.playbackId, queue.StartPositionTicks, {
        origin: "remote-sync",
        commandRevision: this.commandRevision,
        commandId: `queue-seek:${selected.PlaylistItemId}`,
      });
    }
    if (!isCurrent()) return;
    this.setPreparation({ phase: "buffering" });
    loaded = await this.waitForPlayerTarget(selected.ItemId, queue.StartPositionTicks, true, 30000, isCurrent);
    if (!isCurrent() || !loaded.playbackId) return;
    this.localItemPrepared = true;
    await this.maybeReportReady();
  }

  private async handleCommand(messageId: string, command: Command): Promise<void> {
    if (this.reconciling) return;
    const joined = this.state.joinedGroup;
    if (!joined || command.GroupId !== joined.groupId) return;
    if (command.Command !== "Stop" && (!this.currentPlaylistItemId || command.PlaylistItemId !== this.currentPlaylistItemId)) return;
    const emittedAt = Date.parse(command.EmittedAt);
    if (emittedAt < Date.parse(joined.lastUpdatedAt) - 1000 || emittedAt < this.latestCommandEmittedAt) return;
    const membershipRevision = this.membershipRevision;
    if (!this.timeSyncReady) return;
    this.latestCommandEmittedAt = emittedAt;
    this.cancelScheduledCommand();
    const revision = this.scheduledCommandRevision;
    const isCurrent = () => revision === this.scheduledCommandRevision
      && membershipRevision === this.membershipRevision
      && this.state.joinedGroup?.groupId === command.GroupId
      && (command.Command === "Stop" || command.PlaylistItemId === this.currentPlaylistItemId);
    const localCommandTime = Date.parse(command.When) - this.serverTimeOffsetMs;
    const delay = Math.max(0, localCommandTime - Date.now());
    if (command.Command === "Unpause" && !this.currentItemStarted) {
      if (this.isInitialStartGated() || !this.localItemPrepared || !this.isPlayerReady(this.player.getState())) {
        this.readyReported = false;
        if (this.isInitialStartGated()) this.setPreparation({ phase: "waiting-for-participant", scheduledStartAtUnixMs: null });
        await this.sendBuffering(true).catch(() => undefined);
        return;
      }
      this.setPreparation({ phase: "starting", scheduledStartAtUnixMs: Math.round(Date.now() + delay) });
      this.clearReadyRetry();
      this.readyAttempts = 0;
      const current = this.player.getState();
      if (current.playbackId) {
        void this.player.showMessage(current.playbackId, "Starting…", Math.min(5000, Math.max(500, delay))).catch(() => undefined);
      }
    }
    while (isCurrent() && Date.now() < localCommandTime) {
      await new Promise<void>((resolve) => {
        const finish = () => {
          clearTimeout(timer);
          if (this.cancelCommandWait === finish) this.cancelCommandWait = null;
          resolve();
        };
        const timer = setTimeout(finish, Math.min(2_147_483_647, Math.max(1, localCommandTime - Date.now())));
        this.cancelCommandWait = finish;
      });
    }
    if (!isCurrent()) return;
    const state = this.player.getState();
    if (!state.playbackId) return;
    const context = { origin: "remote-sync" as const, commandRevision: ++this.commandRevision, commandId: messageId };
    this.timelineCommandsInFlight += 1;
    try {
      if (command.Command === "Pause") {
        const paused = await this.player.setPaused(state.playbackId, true, context);
        if (!isCurrent()) return;
        const positionTicks = command.PositionTicks ?? this.groupPositionTicks(paused);
        const localTarget = this.currentItemStarted ? this.offsetTargetTicks(positionTicks, paused.durationTicks) : positionTicks;
        if (Math.abs(paused.positionTicks - localTarget) > DRIFT_TOLERANCE_TICKS
          || (this.currentItemStarted && this.localOffsetPending && paused.positionTicks !== localTarget)) {
          await this.player.seek(state.playbackId, localTarget, context);
        }
        if (!isCurrent()) return;
        this.appliedLocalOffsetTicks = localTarget - positionTicks;
        this.setSyncAnchor(positionTicks, false);
        if (!this.currentItemStarted && this.localItemPrepared) this.setPreparation({ phase: "ready", scheduledStartAtUnixMs: null });
      } else if (command.Command === "Unpause") {
        if (!this.isPlayerReady(state) || (!this.currentItemStarted && (this.isInitialStartGated() || !this.localItemPrepared))) {
          this.readyReported = false;
          this.setPreparation({ phase: "buffering", scheduledStartAtUnixMs: null });
          await this.sendBuffering(true).catch(() => undefined);
          return;
        }
        const basePosition = command.PositionTicks ?? this.groupPositionTicks(state);
        const serverNow = Date.now() + this.serverTimeOffsetMs;
        const elapsedTicks = Math.max(0, Math.min(5 * TICKS_PER_SECOND, (serverNow - Date.parse(command.When)) * 10_000));
        const targetPosition = basePosition + elapsedTicks;
        const startingAnchor: SyncAnchor = {
          membershipRevision,
          playlistItemId: command.PlaylistItemId,
          positionTicks: targetPosition,
          playing: true,
          monotonicTimestampMs: performance.now(),
        };
        const localTargetPosition = this.localAuthoritativeTargetTicks(startingAnchor, state.durationTicks);
        const offsetRevision = this.localOffsetRevision;
        const needsOffsetCorrection = (this.localSyncOffsetMilliseconds !== 0 || this.appliedLocalOffsetTicks !== 0 || this.localOffsetPending)
          && Math.abs(state.positionTicks - localTargetPosition) > 0;
        if (needsOffsetCorrection || Math.abs(state.positionTicks - targetPosition) >= DRIFT_SEEK_TICKS) {
          if (needsOffsetCorrection && Math.abs(state.positionTicks - targetPosition) < DRIFT_SEEK_TICKS) {
            await this.player.adjustLocalTimeline(state.playbackId, localTargetPosition - state.positionTicks, context);
          } else {
            await this.player.seek(state.playbackId, localTargetPosition, context);
          }
        }
        if (!isCurrent()) return;
        await this.player.setPaused(state.playbackId, false, context);
        if (!isCurrent()) return;
        this.appliedLocalOffsetTicks = localTargetPosition - targetPosition;
        if (offsetRevision === this.localOffsetRevision) this.localOffsetPending = false;
        this.setSyncAnchor(targetPosition, true);
        this.currentItemStarted = true;
        this.setPreparation({ phase: "playing", scheduledStartAtUnixMs: null });
        await this.correctDrift();
      } else if (command.Command === "Seek" && command.PositionTicks !== null) {
        const localTarget = this.currentItemStarted ? this.offsetTargetTicks(command.PositionTicks, state.durationTicks) : command.PositionTicks;
        const sought = await this.player.seek(state.playbackId, localTarget, context);
        if (!isCurrent()) return;
        const settled = await this.waitForPlayerTarget(state.itemId!, localTarget, sought.paused, 15000, isCurrent);
        if (!isCurrent()) return;
        this.appliedLocalOffsetTicks = localTarget - command.PositionTicks;
        this.setSyncAnchor(command.PositionTicks, !settled.paused);
        if (this.currentItemStarted) await this.sendReady(!settled.paused);
        else await this.maybeReportReady();
      } else if (command.Command === "Stop") {
        this.cancelPreparation();
        this.syncAnchor = null;
        this.lastDriftTicks = null;
        this.driftMeasuredAtUnixMs = null;
        await this.player.stop(state.playbackId, "stopped", context);
      }
    } finally {
      this.timelineCommandsInFlight -= 1;
      await this.applyLocalSyncOffsetImmediately();
    }
  }

  private async handlePlayerEvent(event: PlayerControllerEvent): Promise<void> {
    // Optional status publishing must never delay authoritative Jellyfin SyncPlay commands.
    void this.telemetry.notifyLocalStateTransition().catch(() => undefined);
    if (event.action === "resync-request" && event.origin === "local-user") {
      try {
        const state = await this.resyncLocal();
        if (state.playbackId) {
          await this.player.showMessage(state.playbackId, "Resynced this computer to the watch party.", 2500).catch(() => undefined);
        }
      } catch (error) {
        this.setState({ ...this.state, error: publicError(error) });
        const state = this.player.getState();
        if (state.playbackId) {
          await this.player.showMessage(state.playbackId, "Resync unavailable. Restore the app for details.", 3000).catch(() => undefined);
        }
      }
      return;
    }
    if (!this.state.joinedGroup || !this.currentPlaylistItemId) return;
    if (event.action === "buffering") {
      if (event.state.itemId !== this.state.joinedGroup.currentItemId || event.state.playbackId !== this.player.getState().playbackId) return;
      if (event.state.buffering) {
        if (!this.timelineCommandsInFlight && !this.localResyncInFlight && !this.localOffsetInFlight) this.cancelScheduledCommand();
        this.clearReadyRetry();
        this.readyReported = false;
        if (!this.currentItemStarted && this.state.preparation.phase !== "error") this.setPreparation({ phase: "buffering", scheduledStartAtUnixMs: null });
        await this.restoreNormalRate().catch(() => undefined);
      } else if (!this.currentItemStarted) {
        await this.maybeReportReady();
        return;
      }
      if (!event.state.buffering) await this.applyLocalSyncOffsetImmediately();
      await this.sendBuffering(event.state.buffering).catch(() => undefined);
      return;
    }
    if (event.action === "item-transition" && event.origin === "system") {
      await this.publishAutomaticTransition(event);
      return;
    }
    if (event.action === "error") {
      this.cancelScheduledCommand();
      this.clearReadyRetry();
      if (!this.currentItemStarted) this.setPreparation({ phase: "error", scheduledStartAtUnixMs: null });
      await this.restoreNormalRate().catch(() => undefined);
      this.setState({ ...this.state, error: { code: "SYNCPLAY_PLAYBACK_FAILED", message: event.state.error || "This item could not be played on this computer." } });
      await this.sendBuffering(true).catch(() => undefined);
      return;
    }
    if (["state", "ready", "load-item"].includes(event.action)) {
      if (!this.currentItemStarted) await this.maybeReportReady();
      else await this.applyLocalSyncOffsetImmediately();
    }
    if (event.origin !== "local-user") return;
    if (event.action === "pause") {
      this.cancelScheduledCommand();
      await this.api.syncPlayRequest("/SyncPlay/Pause", {}, "POST");
    }
    else if (event.action === "play") {
      if (this.isInitialStartGated()) {
        if (event.state.playbackId && !event.state.paused) {
          await this.player.setPaused(event.state.playbackId, true, { origin: "system" }).catch(() => undefined);
          await this.player.showMessage(event.state.playbackId, "Waiting for another participant.", 2500).catch(() => undefined);
        }
        this.setPreparation({ phase: "waiting-for-participant", scheduledStartAtUnixMs: null });
        return;
      }
      await this.api.syncPlayRequest("/SyncPlay/Unpause", {}, "POST");
    }
    else if (event.action === "seek") {
      this.cancelScheduledCommand();
      await this.api.syncPlayRequest("/SyncPlay/Seek", { PositionTicks: event.state.positionTicks }, "POST");
    }
    else if (event.action === "stop") {
      this.cancelPreparation();
      await this.api.syncPlayRequest("/SyncPlay/Stop", {}, "POST");
    }
  }

  private async sendReady(isPlaying: boolean): Promise<void> {
    const state = this.player.getState();
    if (!this.currentPlaylistItemId) return;
    await this.api.syncPlayRequest("/SyncPlay/Ready", {
      When: this.serverNowIso(),
      PositionTicks: this.groupPositionTicks(state),
      IsPlaying: isPlaying,
      PlaylistItemId: this.currentPlaylistItemId,
    }, "POST");
  }

  private async maybeReportReady(): Promise<void> {
    const joined = this.state.joinedGroup;
    if (this.reconciling || this.state.connection !== "connected"
      || !joined || !this.currentPlaylistItemId || !this.localItemPrepared || this.currentItemStarted) return;
    const state = this.player.getState();
    if (!this.isPlayerReady(state) || state.itemId !== joined.currentItemId || !state.paused) return;
    if (this.state.preparation.phase === "error" || this.readyRetryTimer) return;
    if (joined.participantCount < 2) {
      this.setPreparation({ phase: "waiting-for-participant", scheduledStartAtUnixMs: null });
      return;
    }
    if (this.readyReported) return;
    this.setPreparation({ phase: "ready", scheduledStartAtUnixMs: null });
    this.readyReported = true;
    this.readyAttempts += 1;
    const revision = this.readyReportRevision;
    try {
      await this.sendReady(false);
      if (revision !== this.readyReportRevision) return;
      this.readyAttempts = 0;
      this.setState({ ...this.state, error: null });
    } catch (error) {
      if (revision !== this.readyReportRevision) return;
      this.readyReported = false;
      const status = error instanceof AppError ? error.status : undefined;
      const retryable = !(status && status >= 400 && status < 500 && status !== 408 && status !== 429)
        && !(error instanceof AppError && ["SESSION_EXPIRED", "NOT_AUTHENTICATED", "SESSION_CHANGED"].includes(error.code));
      if (!retryable || this.readyAttempts >= 5) {
        this.setPreparation({ phase: "error", scheduledStartAtUnixMs: null });
        this.setState({ ...this.state, error: {
          code: "SYNCPLAY_READY_FAILED",
          message: "This computer could not confirm readiness. Retry preparation to try again.",
        } });
        if (error instanceof AppError && ["SESSION_EXPIRED", "NOT_AUTHENTICATED", "SESSION_CHANGED"].includes(error.code)) {
          this.handleBackgroundFailure(error);
        }
        return;
      }
      this.setPreparation({ phase: "retrying", scheduledStartAtUnixMs: null });
      this.readyRetryTimer = setTimeout(() => {
        this.readyRetryTimer = null;
        if (revision === this.readyReportRevision) void this.maybeReportReady().catch((failure) => this.handleBackgroundFailure(failure));
      }, 500 * 2 ** (this.readyAttempts - 1));
    }
  }

  private isPlayerReady(state: PlaybackState): boolean {
    return Boolean(state.playbackId && !state.buffering && !state.seeking && ["ready", "paused", "playing"].includes(state.phase));
  }

  private clearReadyRetry(): void {
    this.readyReportRevision += 1;
    if (this.readyRetryTimer) clearTimeout(this.readyRetryTimer);
    this.readyRetryTimer = null;
  }

  private cancelScheduledCommand(): void {
    this.scheduledCommandRevision += 1;
    this.cancelCommandWait?.();
    this.cancelCommandWait = null;
    if (this.state.preparation.phase === "starting") {
      this.setPreparation({ phase: this.localItemPrepared ? "ready" : "preparing", scheduledStartAtUnixMs: null });
    }
  }

  private cancelPreparation(): void {
    this.preparationRevision += 1;
    this.localOffsetRevision += 1;
    this.localOffsetPending = false;
    this.appliedLocalOffsetTicks = 0;
    this.cancelScheduledCommand();
    this.clearReadyRetry();
    this.localItemPrepared = false;
    this.readyReported = false;
  }

  private async sendBuffering(buffering: boolean): Promise<void> {
    const state = this.player.getState();
    if (!this.currentPlaylistItemId) return;
    if (!buffering && !this.currentItemStarted) return this.maybeReportReady();
    await this.api.syncPlayRequest(buffering ? "/SyncPlay/Buffering" : "/SyncPlay/Ready", {
      When: this.serverNowIso(),
      PositionTicks: this.groupPositionTicks(state),
      IsPlaying: !state.paused,
      PlaylistItemId: this.currentPlaylistItemId,
    }, "POST");
  }

  private async refreshGroups(): Promise<void> {
    let raw: unknown;
    try { raw = await this.api.syncPlayRequest("/SyncPlay/List", undefined, "GET"); }
    catch (error) {
      if (error instanceof AppError && error.status === 403) {
        this.setState({ ...this.state, availability: "denied", error: { code: "SYNCPLAY_ACCESS_DENIED", message: "Your Jellyfin account is not allowed to list watch parties." } });
      }
      throw error;
    }
    const parsed = z.array(groupInfoSchema).safeParse(raw);
    if (!parsed.success) throw new AppError("SYNCPLAY_PROTOCOL_INVALID", "The Jellyfin server returned an incompatible watch-party list.");
    const groups = parsed.data.map(safeGroup);
    const joined = this.state.joinedGroup;
    const matching = joined ? groups.find((group) => group.groupId === joined.groupId) : null;
    if (joined && !matching && !this.reconciling) {
      this.clearJoinedGroup();
      this.setState({ ...this.state, groups, error: { code: "SYNCPLAY_GROUP_ENDED", message: "The watch party ended or was removed from the server." } });
      return;
    }
    this.setState({
      ...this.state,
      availability: "available",
      groups,
      joinedGroup: matching && joined ? { ...joined, ...matching } : joined,
      error: this.state.preparation.phase === "error" ? this.state.error : null,
    });
    await this.maybeReportReady();
  }

  private applyJoinedGroup(update: GroupUpdate): void {
    const parsed = groupInfoSchema.safeParse(update.Data);
    if (!parsed.success || parsed.data.GroupId !== update.GroupId) return;
    const group = safeGroup(parsed.data);
    this.rememberedGroupId = group.groupId;
    const existing = this.state.joinedGroup?.groupId === group.groupId ? this.state.joinedGroup : null;
    if (existing && !this.reconciling) {
      this.setJoined({
        ...group,
        playbackState: existing.currentItemId ? existing.playbackState : group.playbackState,
        currentItemId: existing.currentItemId,
        playlistItemId: existing.playlistItemId,
      });
      void this.reportPing().catch(() => undefined);
      return;
    }
    this.membershipRevision += 1;
    this.cancelPreparation();
    this.latestCommandEmittedAt = 0;
    this.preparationQueue = null;
    this.currentPlaylistItemId = null;
    this.lastPublishedTransitionItemId = null;
    this.syncAnchor = null;
    this.setJoined({ ...group, currentItemId: null, playlistItemId: null });
    void this.telemetry.start(group.groupId).catch(() => undefined);
    void this.reportPing().catch(() => undefined);
  }

  private setJoined(group: JoinedWatchParty): void {
    this.setState({ ...this.state, joinedGroup: group, error: this.state.preparation.phase === "error" ? this.state.error : null });
    this.updateTransitionAuthority();
  }

  private clearJoinedGroup(): void {
    this.cancelPreparation();
    this.preparationQueue = null;
    this.latestCommandEmittedAt = 0;
    if (this.state.joinedGroup || this.currentPlaylistItemId) this.membershipRevision += 1;
    this.currentPlaylistItemId = null;
    this.rememberedGroupId = null;
    this.syncAnchor = null;
    this.lastDriftTicks = null;
    this.driftMeasuredAtUnixMs = null;
    this.localItemPrepared = false;
    this.readyReported = false;
    this.currentItemStarted = false;
    this.setState({
      ...this.state,
      joinedGroup: null,
      preparation: {
        phase: "idle",
        minimumParticipants: 2,
        localSyncOffsetMilliseconds: this.localSyncOffsetMilliseconds,
        scheduledStartAtUnixMs: null,
      },
    });
    void this.telemetry.stop();
    this.player.setAutomaticTransitionsEnabled(true);
    void this.restoreNormalRate().catch(() => undefined);
  }

  private async restoreNormalRate(): Promise<void> {
    const state = this.player.getState();
    if (state.playbackId && this.player.getPlaybackRate() !== 1) {
      await this.player.setPlaybackRate(state.playbackId, 1, { origin: "system" });
    }
  }

  private setSyncAnchor(positionTicks: number, playing: boolean): void {
    if (!this.currentPlaylistItemId) return;
    this.syncAnchor = {
      membershipRevision: this.membershipRevision,
      playlistItemId: this.currentPlaylistItemId,
      positionTicks,
      playing,
      monotonicTimestampMs: performance.now(),
    };
  }

  /**
   * Calculates this computer's target from the group anchor without changing
   * the anchor itself. Positive offsets intentionally put this player ahead.
   */
  private localAuthoritativeTargetTicks(anchor: SyncAnchor, durationTicks: number): number {
    return this.offsetTargetTicks(this.authoritativeTargetTicks(anchor), durationTicks);
  }

  private authoritativeTargetTicks(anchor: SyncAnchor): number {
    const elapsedTicks = anchor.playing ? Math.max(0, (performance.now() - anchor.monotonicTimestampMs) * 10_000) : 0;
    return Math.min(MAX_PLAYBACK_TICKS, Math.max(0, Math.round(anchor.positionTicks + elapsedTicks)));
  }

  private offsetTargetTicks(groupPositionTicks: number, durationTicks: number): number {
    return Math.min(
      durationTicks || Number.MAX_SAFE_INTEGER,
      Math.max(0, Math.round(groupPositionTicks + this.localSyncOffsetMilliseconds * 10_000)),
    );
  }

  private groupPositionTicks(state: PlaybackState): number {
    return Math.max(0, Math.round(state.positionTicks - this.appliedLocalOffsetTicks));
  }

  /** Applies a timing preference to this player only; it never sends a SyncPlay command. */
  private async applyLocalSyncOffsetImmediately(): Promise<void> {
    const anchor = this.syncAnchor;
    const joined = this.state.joinedGroup;
    const state = this.player.getState();
    if (
      !this.localOffsetPending || this.localOffsetInFlight || this.timelineCommandsInFlight
      || this.localResyncInFlight || this.driftCorrectionInFlight || !this.currentItemStarted
      || !this.hasAuthoritativeTimeline()
      || !anchor
      || !joined
      || !state.playbackId
      || state.itemId !== joined.currentItemId
      || !this.isPlayerReady(state)
      || (anchor.playing && state.paused)
    ) return;

    const membershipRevision = this.membershipRevision;
    const revision = this.localOffsetRevision;
    const commandRevision = this.scheduledCommandRevision;
    const isCurrent = () => membershipRevision === this.membershipRevision && anchor === this.syncAnchor
      && commandRevision === this.scheduledCommandRevision && this.hasAuthoritativeTimeline()
      && state.playbackId === this.player.getState().playbackId;
    const context = {
      origin: "remote-sync" as const,
      commandRevision: ++this.commandRevision,
      commandId: `local-offset:${anchor.playlistItemId}:${this.commandRevision}`,
    };
    this.localOffsetInFlight = true;
    try {
      if (this.player.getPlaybackRate() !== 1) await this.player.setPlaybackRate(state.playbackId, 1, context);
      if (!isCurrent()) return;
      const current = this.player.getState();
      if (!this.isPlayerReady(current)) return;
      const groupTarget = this.authoritativeTargetTicks(anchor);
      const targetTicks = this.offsetTargetTicks(groupTarget, current.durationTicks);
      const delta = targetTicks - current.positionTicks;
      if (Math.abs(delta) > 20 * TICKS_PER_SECOND) await this.player.seek(state.playbackId, targetTicks, context);
      else if (delta !== 0) await this.player.adjustLocalTimeline(state.playbackId, delta, context);
      if (!isCurrent()) return;
      this.appliedLocalOffsetTicks = targetTicks - groupTarget;
      if (revision === this.localOffsetRevision) this.localOffsetPending = false;
    } catch (error) {
      if (revision === this.localOffsetRevision) this.localOffsetPending = false;
      throw error;
    } finally {
      this.localOffsetInFlight = false;
      if (revision !== this.localOffsetRevision && this.localOffsetPending) await this.applyLocalSyncOffsetImmediately();
    }
  }

  private async correctDrift(): Promise<void> {
    if (this.driftCorrectionInFlight || this.localOffsetInFlight || this.timelineCommandsInFlight || this.localResyncInFlight) return;
    await this.applyLocalSyncOffsetImmediately();
    if (this.driftCorrectionInFlight || this.localOffsetInFlight || this.timelineCommandsInFlight || this.localResyncInFlight) return;
    const anchor = this.syncAnchor;
    const joined = this.state.joinedGroup;
    const state = this.player.getState();
    if (!this.hasAuthoritativeTimeline() || !anchor || !joined || !state.playbackId || !this.isPlayerReady(state) || state.paused || !anchor.playing) return;
    if (anchor.membershipRevision !== this.membershipRevision || anchor.playlistItemId !== this.currentPlaylistItemId) return;
    const localTargetTicks = this.localAuthoritativeTargetTicks(anchor, state.durationTicks);
    const driftTicks = localTargetTicks - state.positionTicks;
    this.lastDriftTicks = Math.round(driftTicks);
    this.driftMeasuredAtUnixMs = Date.now();
    this.driftCorrectionInFlight = true;
    try {
      const context = { origin: "remote-sync" as const, commandRevision: ++this.commandRevision, commandId: `drift:${anchor.playlistItemId}` };
      if (Math.abs(driftTicks) >= DRIFT_SEEK_TICKS) {
        if (this.player.getPlaybackRate() !== 1) await this.player.setPlaybackRate(state.playbackId, 1, context);
        await this.player.seek(state.playbackId, localTargetTicks, context);
      } else if (Math.abs(driftTicks) >= DRIFT_TOLERANCE_TICKS) {
        const magnitude = Math.abs(driftTicks);
        const adjustment = magnitude >= DRIFT_HIGH_RATE_TICKS
          ? 0.06
          : magnitude >= DRIFT_MEDIUM_RATE_TICKS ? 0.04 : 0.02;
        const rate = driftTicks > 0 ? 1 + adjustment : 1 - adjustment;
        if (this.player.getPlaybackRate() !== rate) await this.player.setPlaybackRate(state.playbackId, rate, context);
      } else if (Math.abs(driftTicks) <= DRIFT_RATE_RESET_TICKS && this.player.getPlaybackRate() !== 1) {
        await this.player.setPlaybackRate(state.playbackId, 1, context);
      }
    } finally {
      this.driftCorrectionInFlight = false;
    }
  }

  private setState(state: WatchPartyViewState): void {
    this.state = structuredClone(state);
    const snapshot = this.getState();
    for (const listener of this.listeners) listener(snapshot);
  }

  private setPreparation(patch: Partial<WatchPartyViewState["preparation"]>): void {
    const current = this.state.preparation ?? emptyState(this.localSyncOffsetMilliseconds).preparation;
    this.setState({
      ...this.state,
      preparation: {
        ...current,
        localSyncOffsetMilliseconds: this.localSyncOffsetMilliseconds,
        ...patch,
      },
    });
  }

  private isInitialStartGated(): boolean {
    return Boolean(
      this.state.joinedGroup
      && this.currentPlaylistItemId
      && !this.currentItemStarted
      && this.state.joinedGroup.participantCount < 2,
    );
  }

  private localTelemetrySnapshot() {
    const state = this.player.getState();
    const telemetryState = state.phase === "buffering"
      ? "buffering" as const
      : state.phase === "stalled" ? "stalled" as const
        : state.phase === "paused" ? "paused" as const
          : state.phase === "playing" ? "playing" as const
            : state.phase === "loading" || state.phase === "resolving" ? "recovering" as const
              : state.phase === "disconnected" || state.phase === "error" || state.phase === "stopped" || state.phase === "ended"
                ? "disconnected" as const
                : "ready" as const;
    return {
      state: telemetryState,
      positionTicks: state.positionTicks,
      driftTicks: this.hasAuthoritativeTimeline() ? this.lastDriftTicks : null,
      jellyfinLatencyMs: this.timeSyncReady ? this.latencyMs : null,
      bufferAheadTicks: state.diagnostics?.bufferAheadTicks ?? null,
      sourceKind: state.diagnostics?.sourceKind ?? null,
    };
  }

  private hasAuthoritativeTimeline(): boolean {
    return Boolean(
      this.timeSyncReady
      && this.state.connection === "connected"
      && !this.reconciling
      && this.syncAnchor
      && this.state.joinedGroup
      && this.syncAnchor.membershipRevision === this.membershipRevision
      && this.syncAnchor.playlistItemId === this.currentPlaylistItemId
      && this.syncAnchor.playlistItemId === this.state.joinedGroup.playlistItemId
    );
  }

  private closeTransport(): void {
    this.cancelPreparation();
    this.stopPeriodicTasks();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.playerUnsubscribe?.();
    this.playerUnsubscribe = null;
    const socket = this.socket;
    this.socket = null;
    try { socket?.close(); } catch { socket?.terminate(); }
  }

  private startPeriodicTasks(): void {
    this.stopPeriodicTasks();
    this.startRefreshTimer();
    this.driftTimer = setInterval(() => { void this.correctDrift().catch((error) => this.handleBackgroundFailure(error)); }, 1000);
    this.timeSyncTimer = setInterval(() => { void this.synchronizeTime(1).catch((error) => this.handleBackgroundFailure(error)); }, 60000);
  }

  private startRefreshTimer(): void {
    if (!this.viewVisible || this.refreshTimer) return;
    this.refreshTimer = setInterval(() => { void this.refreshGroups().catch((error) => this.handleBackgroundFailure(error)); }, this.refreshIntervalMs);
  }

  private stopPeriodicTasks(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = null;
    if (this.driftTimer) clearInterval(this.driftTimer);
    this.driftTimer = null;
    if (this.timeSyncTimer) clearInterval(this.timeSyncTimer);
    this.timeSyncTimer = null;
  }

  private scheduleReconnect(revision: number): void {
    if (revision !== this.activationRevision || this.reconnectTimer) return;
    if (this.reconnectAttempt >= 6) {
      this.setState({ ...this.state, availability: "offline", connection: "disconnected", error: { code: "SYNCPLAY_RECONNECT_FAILED", message: "The watch-party connection could not be restored. Sign in again or retry later." } });
      return;
    }
    const delay = Math.min(15000, 1000 * (2 ** this.reconnectAttempt));
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.reconnect(revision);
    }, delay);
  }

  private async reconnect(revision: number): Promise<void> {
    if (revision !== this.activationRevision) return;
    this.setState({ ...this.state, availability: "connecting", connection: "connecting", error: null });
    try {
      let reconciliationError: WatchPartyViewState["error"] = null;
      await this.openSocket(revision);
      this.timeMeasurements = [];
      this.timeSyncReady = false;
      await this.synchronizeTime(3);
      if (!this.playerUnsubscribe) this.playerUnsubscribe = this.player.onEvent((event) => { void this.handlePlayerEvent(event).catch((error) => this.handleBackgroundFailure(error)); });
      await this.refreshGroups();
      const rememberedGroupId = this.rememberedGroupId;
      if (rememberedGroupId) {
        if (this.state.groups.some((group) => group.groupId === rememberedGroupId)) {
          const from = this.messageSequence;
          await this.api.syncPlayRequest("/SyncPlay/Join", { GroupId: rememberedGroupId }, "POST");
          await this.waitForGroupUpdate("GroupJoined", from, rememberedGroupId);
        } else {
          this.clearJoinedGroup();
          reconciliationError = { code: "SYNCPLAY_GROUP_ENDED", message: "The watch party ended while this computer was disconnected." };
        }
      }
      if (revision !== this.activationRevision) return;
      this.reconciling = false;
      this.reconnectAttempt = 0;
      this.startPeriodicTasks();
      this.setState({ ...this.state, availability: "available", connection: "connected", error: reconciliationError });
      await this.maybeReportReady();
      this.updateTransitionAuthority();
    } catch (error) {
      const socket = this.socket;
      this.socket = null;
      try { socket?.close(); } catch { socket?.terminate(); }
      this.setState({ ...this.state, availability: "offline", connection: "disconnected", error: publicError(error) });
      this.scheduleReconnect(revision);
    }
  }

  private rememberMessage(messageId: string): void {
    this.appliedMessageIds.add(messageId);
    if (this.appliedMessageIds.size > 2048) this.appliedMessageIds.delete(this.appliedMessageIds.values().next().value!);
  }

  private async synchronizeTime(samples: number): Promise<void> {
    for (let index = 0; index < samples; index += 1) {
      const requestSent = Date.now();
      const value = await this.api.getServerTime();
      const responseReceived = Date.now();
      const requestReceived = Date.parse(value.requestReceptionTime);
      const responseSent = Date.parse(value.responseTransmissionTime);
      const delayMs = responseReceived - requestSent - (responseSent - requestReceived);
      const offsetMs = ((requestReceived - requestSent) + (responseSent - responseReceived)) / 2;
      if (!Number.isFinite(delayMs) || !Number.isFinite(offsetMs) || delayMs < 0 || delayMs > 30000) continue;
      this.timeMeasurements.push({ delayMs, offsetMs });
      if (this.timeMeasurements.length > 8) this.timeMeasurements.shift();
    }
    const best = [...this.timeMeasurements].sort((left, right) => left.delayMs - right.delayMs)[0];
    if (!best) throw new AppError("SYNCPLAY_TIME_UNAVAILABLE", "Jellyfin time synchronization failed.", 503);
    this.serverTimeOffsetMs = best.offsetMs;
    this.latencyMs = Math.max(0, best.delayMs / 2);
    this.timeSyncReady = true;
    if (this.state.joinedGroup) await this.reportPing();
  }

  private reportPing(): Promise<unknown> {
    return this.api.syncPlayRequest("/SyncPlay/Ping", { Ping: this.latencyMs }, "POST");
  }

  private handleBackgroundFailure(error: unknown): void {
    if (error instanceof AppError && error.code === "SYNCPLAY_PREPARATION_CANCELLED") return;
    if (error instanceof AppError && (error.code === "SESSION_EXPIRED" || error.code === "NOT_AUTHENTICATED" || error.code === "SESSION_CHANGED")) {
      void this.deactivate(false);
      return;
    }
    if (this.state.connection === "connected" && this.state.joinedGroup) {
      this.setState({ ...this.state, error: publicError(error) });
    }
  }

  private serverNowIso(): string {
    return new Date(Date.now() + this.serverTimeOffsetMs).toISOString();
  }

  private updateTransitionAuthority(): void {
    const joined = this.state.joinedGroup;
    const leader = joined ? [...joined.participants].sort((left, right) => left.localeCompare(right, undefined, { sensitivity: "base" }))[0] : null;
    const enabled = Boolean(
      joined
      && this.currentUserName
      && leader
      && leader.localeCompare(this.currentUserName, undefined, { sensitivity: "base" }) === 0
      && this.state.connection === "connected"
      && !this.reconciling,
    );
    this.player.setAutomaticTransitionsEnabled(enabled || !joined);
  }

  private async publishAutomaticTransition(event: PlayerControllerEvent): Promise<void> {
    const itemId = event.state.itemId;
    const joined = this.state.joinedGroup;
    if (!itemId || !joined || itemId === joined.currentItemId || this.transitionItemInFlight === itemId || this.lastPublishedTransitionItemId === itemId) return;
    const leader = [...joined.participants].sort((left, right) => left.localeCompare(right, undefined, { sensitivity: "base" }))[0];
    if (!this.currentUserName || !leader || leader.localeCompare(this.currentUserName, undefined, { sensitivity: "base" }) !== 0) return;
    const membershipRevision = this.membershipRevision;
    this.transitionItemInFlight = itemId;
    try {
      await this.waitForPlayerItemReady(itemId, 30000);
      if (membershipRevision !== this.membershipRevision || this.reconciling || this.state.connection !== "connected") return;
      await this.api.syncPlayRequest("/SyncPlay/SetNewQueue", {
        PlayingQueue: [itemId],
        PlayingItemPosition: 0,
        StartPositionTicks: 0,
      }, "POST");
      this.lastPublishedTransitionItemId = itemId;
    } finally {
      if (this.transitionItemInFlight === itemId) this.transitionItemInFlight = null;
    }
  }

  private requireAvailable(): void {
    if (this.state.availability === "denied") throw new AppError("SYNCPLAY_ACCESS_DENIED", "Your Jellyfin account is not allowed to use watch parties.", 403);
    if (this.state.availability === "unsupported") throw new AppError("SYNCPLAY_VERSION_UNSUPPORTED", "This Jellyfin server version has not been verified for watch parties.", 409);
    if (this.reconciling || this.state.connection !== "connected") throw new AppError("SYNCPLAY_DISCONNECTED", "The watch-party connection is not available.", 503);
  }

  private requireJoined(): JoinedWatchParty {
    this.requireAvailable();
    if (!this.state.joinedGroup) throw new AppError("SYNCPLAY_NOT_JOINED", "Join a watch party first.", 409);
    return this.state.joinedGroup;
  }

  private waitForGroupUpdate(type: GroupUpdate["Type"], from: number, groupId?: string): Promise<GroupUpdate> {
    return this.waitForMessage((envelope) => {
      if (envelope.MessageType !== "SyncPlayGroupUpdate") return null;
      const update = groupUpdateSchema.safeParse(envelope.Data);
      if (!update.success || update.data.Type !== type || (groupId && update.data.GroupId !== groupId)) return null;
      return update.data;
    }, from, 10000);
  }

  private async waitForMessage<T>(predicate: (envelope: Envelope) => T | null, from: number, timeoutMs: number): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    const revision = this.activationRevision;
    while (Date.now() < deadline) {
      if (revision !== this.activationRevision) throw new AppError("SESSION_CHANGED", "The Jellyfin session changed.");
      for (const entry of this.messageHistory) {
        if (entry.sequence <= from) continue;
        const value = predicate(entry.envelope);
        if (value !== null) return value;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new AppError("SYNCPLAY_RESPONSE_TIMEOUT", "Jellyfin did not confirm the watch-party action in time.", 504);
  }

  private async waitForPlayerItem(itemId: string, timeoutMs: number): Promise<PlaybackState> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const state = this.player.getState();
      if (state.itemId === itemId && state.playbackId && ["loading", "playing", "paused", "buffering"].includes(state.phase)) return state;
      if (state.itemId === itemId && state.phase === "error") throw new AppError("SYNCPLAY_PLAYBACK_FAILED", state.error || "The shared item could not be played.");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new AppError("SYNCPLAY_PLAYBACK_TIMEOUT", "The shared item did not start in time.", 504);
  }

  private async waitForPlayerTarget(
    itemId: string,
    positionTicks: number,
    paused: boolean,
    timeoutMs: number,
    isCurrent: () => boolean = () => true,
  ): Promise<PlaybackState> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!isCurrent()) throw new AppError("SYNCPLAY_PREPARATION_CANCELLED", "The watch-party playback request was replaced.");
      const state = this.player.getState();
      if (state.itemId === itemId && state.phase === "error") {
        throw new AppError("SYNCPLAY_PLAYBACK_FAILED", state.error || "The shared position could not be applied.");
      }
      if (state.itemId === itemId && this.isPlayerReady(state) && state.paused === paused
        && Math.abs(state.positionTicks - positionTicks) <= DRIFT_TOLERANCE_TICKS) return state;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new AppError("SYNCPLAY_PLAYER_NOT_READY", "The player did not reach the shared position in time.", 504);
  }

  private async waitForPlayerItemReady(itemId: string, timeoutMs: number): Promise<PlaybackState> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const state = this.player.getState();
      if (state.itemId === itemId && state.playbackId && ["playing", "paused", "buffering"].includes(state.phase)) return state;
      if (state.itemId === itemId && state.phase === "error") throw new AppError("SYNCPLAY_PLAYBACK_FAILED", state.error || "The next shared episode could not be played.");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new AppError("SYNCPLAY_PLAYBACK_TIMEOUT", "The next shared episode did not start in time.", 504);
  }
}
