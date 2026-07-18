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

interface MessageEntry { envelope: Envelope; receivedAt: number }
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

const emptyState = (): WatchPartyViewState => ({
  availability: "signed-out",
  connection: "disconnected",
  groups: [],
  joinedGroup: null,
  sharedControls: true,
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
  private readonly telemetry: ParticipantTelemetryCoordinator;

  constructor(
    private readonly api: JellyfinApi,
    private readonly player: PlayerController,
    private readonly logger: AppLogger,
    private readonly refreshIntervalMs = 5000,
    private readonly preferences?: Pick<ApplicationPreferences, "getBufferingPolicy" | "setBufferingPolicy">,
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
    const policy = await this.preferences?.getBufferingPolicy().catch(() => "wait-for-all" as const) ?? "wait-for-all";
    this.telemetry.setPolicy(policy);
    const revision = ++this.activationRevision;
    let context;
    try { context = this.api.getAuthenticatedSocketContext(); }
    catch {
      this.setState(emptyState());
      return this.getState();
    }
    if (context.serverVersion !== "10.11.11") {
      this.setState({
        ...emptyState(),
        availability: "unsupported",
        error: { code: "SYNCPLAY_VERSION_UNSUPPORTED", message: `Watch parties require the tested Jellyfin 10.11.11 server (this server reports ${context.serverVersion || "an unknown version"}).` },
      });
      return this.getState();
    }
    this.currentUserName = context.userName;
    this.setState({ ...emptyState(), availability: "connecting", connection: "connecting" });
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
    this.timeMeasurements = [];
    this.serverTimeOffsetMs = 0;
    this.latencyMs = 0;
    this.timeSyncReady = false;
    this.membershipRevision += 1;
    this.messageHistory = [];
    this.appliedMessageIds.clear();
    await this.telemetry.stop();
    await this.restoreNormalRate().catch(() => undefined);
    this.player.setAutomaticTransitionsEnabled(true);
    this.setState(emptyState());
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
    const from = this.messageHistory.length;
    await this.api.syncPlayRequest("/SyncPlay/New", { GroupName: name }, "POST");
    await this.waitForGroupUpdate("GroupJoined", from);
    await this.refreshGroups();
    return this.getState();
  }

  async join(groupId: string): Promise<WatchPartyViewState> {
    this.requireAvailable();
    const from = this.messageHistory.length;
    await this.api.syncPlayRequest("/SyncPlay/Join", { GroupId: groupId }, "POST");
    await this.waitForGroupUpdate("GroupJoined", from, groupId);
    await this.refreshGroups();
    return this.getState();
  }

  async leave(): Promise<WatchPartyViewState> {
    if (!this.state.joinedGroup) return this.getState();
    this.rememberedGroupId = null;
    const from = this.messageHistory.length;
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
    await this.api.syncPlayRequest(paused ? "/SyncPlay/Pause" : "/SyncPlay/Unpause", {}, "POST");
    return this.player.getState();
  }

  async requestSeek(positionTicks: number): Promise<PlaybackState> {
    this.requireJoined();
    await this.api.syncPlayRequest("/SyncPlay/Seek", { PositionTicks: positionTicks }, "POST");
    return this.player.getState();
  }

  async requestStop(): Promise<PlaybackState> {
    this.requireJoined();
    await this.api.syncPlayRequest("/SyncPlay/Stop", {}, "POST");
    return this.player.getState();
  }

  async waitForAll(): Promise<WatchPartyViewState> {
    this.requireJoined();
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
    }
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
    const elapsedTicks = anchor.playing ? Math.max(0, (performance.now() - anchor.monotonicTimestampMs) * 10_000) : 0;
    const targetTicks = Math.min(state.durationTicks || Number.MAX_SAFE_INTEGER, Math.max(0, anchor.positionTicks + elapsedTicks));
    if (this.player.getPlaybackRate() !== 1) state = await this.player.setPlaybackRate(playbackId, 1, context);
    if (!state.paused) state = await this.player.setPaused(playbackId, true, context);
    state = await this.player.seek(playbackId, targetTicks, context);
    if (anchor.playing) state = await this.player.setPaused(playbackId, false, context);
    if (!this.state.joinedGroup || membershipRevision !== this.membershipRevision) {
      throw new AppError("SYNCPLAY_GROUP_CHANGED", "The watch party changed while this computer was resyncing.", 409);
    }
    state = await this.waitForPlayerTarget(itemId, targetTicks, !anchor.playing, 15000);
    this.setSyncAnchor(targetTicks, anchor.playing);
    await this.sendReady(anchor.playing);
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
    this.messageHistory.push({ envelope: envelope.data, receivedAt: performance.now() });
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
    } else if (update.Type === "UserLeft" && typeof update.Data === "string") {
      const participants = joined.participants.filter((name) => name !== update.Data);
      this.setJoined({ ...joined, participants, participantCount: participants.length });
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
      const membershipRevision = this.membershipRevision;
      this.queueTask = this.queueTask.then(() => this.applyPlayQueue(queue.data, membershipRevision)).catch((error) => {
        this.logger.warn("SyncPlay queue application failed.", { code: error instanceof AppError ? error.code : "SYNCPLAY_QUEUE_FAILED" });
        this.setState({ ...this.state, error: publicError(error) });
      });
    }
  }

  private async applyPlayQueue(queue: z.infer<typeof playQueueSchema>, membershipRevision: number): Promise<void> {
    const joined = this.state.joinedGroup;
    if (!joined || membershipRevision !== this.membershipRevision) return;
    const selected = queue.Playlist[queue.PlayingItemIndex];
    this.lastDriftTicks = null;
    this.driftMeasuredAtUnixMs = null;
    this.currentPlaylistItemId = selected.PlaylistItemId;
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
    if (state.itemId !== selected.ItemId || !state.playbackId) {
      await this.player.loadItem(selected.ItemId, "start-over", {
        origin: "remote-sync",
        commandRevision: ++this.commandRevision,
        commandId: `queue:${selected.PlaylistItemId}`,
      });
    }
    if (!this.state.joinedGroup || membershipRevision !== this.membershipRevision) return;
    let loaded = this.player.getState();
    if (loaded.playbackId && !loaded.paused) {
      loaded = await this.player.setPaused(loaded.playbackId, true, {
        origin: "remote-sync",
        commandRevision: this.commandRevision,
        commandId: `queue-pause:${selected.PlaylistItemId}`,
      });
    }
    if (!this.state.joinedGroup || membershipRevision !== this.membershipRevision) return;
    if (loaded.playbackId && Math.abs(loaded.positionTicks - queue.StartPositionTicks) > 1_000_000) {
      await this.player.seek(loaded.playbackId, queue.StartPositionTicks, {
        origin: "remote-sync",
        commandRevision: this.commandRevision,
        commandId: `queue-seek:${selected.PlaylistItemId}`,
      });
    }
    if (!this.state.joinedGroup || membershipRevision !== this.membershipRevision) return;
    loaded = await this.waitForPlayerTarget(selected.ItemId, queue.StartPositionTicks, true, 15000);
    if (!loaded.playbackId) return;
    await this.sendReady(false);
  }

  private async handleCommand(messageId: string, command: Command): Promise<void> {
    if (this.reconciling) return;
    const joined = this.state.joinedGroup;
    if (!joined || command.GroupId !== joined.groupId) return;
    if (command.Command !== "Stop" && (!this.currentPlaylistItemId || command.PlaylistItemId !== this.currentPlaylistItemId)) return;
    if (Date.parse(command.EmittedAt) < Date.parse(joined.lastUpdatedAt) - 1000) return;
    const membershipRevision = this.membershipRevision;
    if (!this.timeSyncReady) return;
    const localCommandTime = Date.parse(command.When) - this.serverTimeOffsetMs;
    const delay = Math.max(0, Math.min(2000, localCommandTime - Date.now()));
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    if (!this.state.joinedGroup || this.state.joinedGroup.groupId !== command.GroupId || membershipRevision !== this.membershipRevision) return;
    if (command.Command !== "Stop" && command.PlaylistItemId !== this.currentPlaylistItemId) return;
    const state = this.player.getState();
    if (!state.playbackId) return;
    const context = { origin: "remote-sync" as const, commandRevision: ++this.commandRevision, commandId: messageId };
    if (command.Command === "Pause") {
      const paused = await this.player.setPaused(state.playbackId, true, context);
      const positionTicks = command.PositionTicks ?? paused.positionTicks;
      if (Math.abs(paused.positionTicks - positionTicks) > DRIFT_TOLERANCE_TICKS) {
        await this.player.seek(state.playbackId, positionTicks, context);
      }
      this.setSyncAnchor(positionTicks, false);
    } else if (command.Command === "Unpause") {
      const basePosition = command.PositionTicks ?? state.positionTicks;
      const serverNow = Date.now() + this.serverTimeOffsetMs;
      const elapsedTicks = Math.max(0, Math.min(5 * TICKS_PER_SECOND, (serverNow - Date.parse(command.When)) * 10_000));
      const targetPosition = basePosition + elapsedTicks;
      if (Math.abs(state.positionTicks - targetPosition) >= DRIFT_SEEK_TICKS) {
        await this.player.seek(state.playbackId, targetPosition, context);
      }
      await this.player.setPaused(state.playbackId, false, context);
      this.setSyncAnchor(targetPosition, true);
      await this.correctDrift();
    } else if (command.Command === "Seek" && command.PositionTicks !== null) {
      const sought = await this.player.seek(state.playbackId, command.PositionTicks, context);
      const settled = await this.waitForPlayerTarget(state.itemId!, command.PositionTicks, sought.paused, 15000);
      this.setSyncAnchor(command.PositionTicks, !settled.paused);
      await this.sendReady(!settled.paused);
    } else if (command.Command === "Stop") {
      this.syncAnchor = null;
      this.lastDriftTicks = null;
      this.driftMeasuredAtUnixMs = null;
      await this.player.stop(state.playbackId, "stopped", context);
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
      if (event.state.buffering) await this.restoreNormalRate().catch(() => undefined);
      await this.sendBuffering(event.state.buffering).catch(() => undefined);
      return;
    }
    if (event.action === "item-transition" && event.origin === "system") {
      await this.publishAutomaticTransition(event);
      return;
    }
    if (event.action === "error") {
      await this.restoreNormalRate().catch(() => undefined);
      this.setState({ ...this.state, error: { code: "SYNCPLAY_PLAYBACK_FAILED", message: event.state.error || "This item could not be played on this computer." } });
      await this.sendBuffering(true).catch(() => undefined);
      return;
    }
    if (event.origin !== "local-user") return;
    if (event.action === "pause") await this.api.syncPlayRequest("/SyncPlay/Pause", {}, "POST");
    else if (event.action === "play") await this.api.syncPlayRequest("/SyncPlay/Unpause", {}, "POST");
    else if (event.action === "seek") await this.api.syncPlayRequest("/SyncPlay/Seek", { PositionTicks: event.state.positionTicks }, "POST");
    else if (event.action === "stop") await this.api.syncPlayRequest("/SyncPlay/Stop", {}, "POST");
  }

  private async sendReady(isPlaying: boolean): Promise<void> {
    const state = this.player.getState();
    if (!this.currentPlaylistItemId) return;
    await this.api.syncPlayRequest("/SyncPlay/Ready", {
      When: this.serverNowIso(),
      PositionTicks: state.positionTicks,
      IsPlaying: isPlaying,
      PlaylistItemId: this.currentPlaylistItemId,
    }, "POST");
  }

  private async sendBuffering(buffering: boolean): Promise<void> {
    const state = this.player.getState();
    if (!this.currentPlaylistItemId) return;
    await this.api.syncPlayRequest(buffering ? "/SyncPlay/Buffering" : "/SyncPlay/Ready", {
      When: this.serverNowIso(),
      PositionTicks: state.positionTicks,
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
      error: null,
    });
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
    this.currentPlaylistItemId = null;
    this.lastPublishedTransitionItemId = null;
    this.syncAnchor = null;
    this.setJoined({ ...group, currentItemId: null, playlistItemId: null });
    void this.telemetry.start(group.groupId).catch(() => undefined);
    void this.reportPing().catch(() => undefined);
  }

  private setJoined(group: JoinedWatchParty): void {
    this.setState({ ...this.state, joinedGroup: group, error: null });
    this.updateTransitionAuthority();
  }

  private clearJoinedGroup(): void {
    if (this.state.joinedGroup || this.currentPlaylistItemId) this.membershipRevision += 1;
    this.currentPlaylistItemId = null;
    this.rememberedGroupId = null;
    this.syncAnchor = null;
    this.lastDriftTicks = null;
    this.driftMeasuredAtUnixMs = null;
    this.setState({ ...this.state, joinedGroup: null });
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

  private async correctDrift(): Promise<void> {
    if (this.driftCorrectionInFlight) return;
    const anchor = this.syncAnchor;
    const joined = this.state.joinedGroup;
    const state = this.player.getState();
    if (!anchor || !joined || !state.playbackId || state.buffering || state.paused || !anchor.playing) return;
    if (anchor.membershipRevision !== this.membershipRevision || anchor.playlistItemId !== this.currentPlaylistItemId) return;
    const elapsedTicks = Math.max(0, (performance.now() - anchor.monotonicTimestampMs) * 10_000);
    const expectedTicks = Math.min(state.durationTicks || Number.MAX_SAFE_INTEGER, anchor.positionTicks + elapsedTicks);
    const driftTicks = expectedTicks - state.positionTicks;
    this.lastDriftTicks = Math.round(driftTicks);
    this.driftMeasuredAtUnixMs = Date.now();
    this.driftCorrectionInFlight = true;
    try {
      const context = { origin: "remote-sync" as const, commandRevision: ++this.commandRevision, commandId: `drift:${anchor.playlistItemId}` };
      if (Math.abs(driftTicks) >= DRIFT_SEEK_TICKS) {
        if (this.player.getPlaybackRate() !== 1) await this.player.setPlaybackRate(state.playbackId, 1, context);
        await this.player.seek(state.playbackId, expectedTicks, context);
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
    );
  }

  private closeTransport(): void {
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
          const from = this.messageHistory.length;
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
    while (Date.now() < deadline) {
      for (const entry of this.messageHistory.slice(from)) {
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
  ): Promise<PlaybackState> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const state = this.player.getState();
      if (state.itemId === itemId && state.playbackId && state.paused === paused
        && Math.abs(state.positionTicks - positionTicks) <= DRIFT_TOLERANCE_TICKS) return state;
      if (state.itemId === itemId && state.phase === "error") {
        throw new AppError("SYNCPLAY_PLAYBACK_FAILED", state.error || "The shared position could not be applied.");
      }
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
