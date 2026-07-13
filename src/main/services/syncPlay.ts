import { z } from "zod";
import type {
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
  LastUpdate: z.string().datetime(),
  Playlist: z.array(queueItemSchema).min(1).max(1000),
  PlayingItemIndex: z.number().int().min(0),
  StartPositionTicks: z.number().int().min(0),
  IsPlaying: z.boolean(),
}).passthrough();
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

const TICKS_PER_SECOND = 10_000_000;
const DRIFT_TOLERANCE_TICKS = 7_500_000;
const DRIFT_RATE_RESET_TICKS = 3_500_000;
const DRIFT_SEEK_TICKS = 30_000_000;

const emptyState = (): WatchPartyViewState => ({
  availability: "signed-out",
  connection: "disconnected",
  groups: [],
  joinedGroup: null,
  sharedControls: true,
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
  private messageHistory: MessageEntry[] = [];
  private appliedMessageIds = new Set<string>();
  private currentPlaylistItemId: string | null = null;
  private playerUnsubscribe: (() => void) | null = null;
  private queueTask: Promise<void> = Promise.resolve();
  private syncAnchor: SyncAnchor | null = null;
  private driftCorrectionInFlight = false;

  constructor(
    private readonly api: JellyfinApi,
    private readonly player: PlayerController,
    private readonly logger: AppLogger,
    private readonly refreshIntervalMs = 5000,
  ) {}

  onState(listener: (state: WatchPartyViewState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getState(): WatchPartyViewState {
    return structuredClone(this.state);
  }

  isJoined(): boolean {
    return this.state.joinedGroup !== null;
  }

  async activate(): Promise<WatchPartyViewState> {
    await this.deactivate(false);
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
    this.setState({ ...emptyState(), availability: "connecting", connection: "connecting" });
    try {
      await this.openSocket(revision);
      if (revision !== this.activationRevision) throw new AppError("SESSION_CHANGED", "The Jellyfin session changed.");
      this.playerUnsubscribe = this.player.onEvent((event) => { void this.handlePlayerEvent(event); });
      await this.refreshGroups();
      this.refreshTimer = setInterval(() => { void this.refreshGroups().catch(() => undefined); }, this.refreshIntervalMs);
      this.driftTimer = setInterval(() => { void this.correctDrift().catch(() => undefined); }, 1000);
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
    this.syncAnchor = null;
    this.membershipRevision += 1;
    this.messageHistory = [];
    this.appliedMessageIds.clear();
    await this.restoreNormalRate().catch(() => undefined);
    this.setState(emptyState());
  }

  async list(): Promise<WatchPartyViewState> {
    await this.refreshGroups();
    return this.getState();
  }

  async create(name: string): Promise<WatchPartyViewState> {
    this.requireAvailable();
    const from = this.messageHistory.length;
    await this.api.syncPlayRequest("/SyncPlay/New", { GroupName: name }, "POST");
    const update = await this.waitForGroupUpdate("GroupJoined", from);
    this.applyJoinedGroup(update);
    await this.refreshGroups();
    return this.getState();
  }

  async join(groupId: string): Promise<WatchPartyViewState> {
    this.requireAvailable();
    const from = this.messageHistory.length;
    await this.api.syncPlayRequest("/SyncPlay/Join", { GroupId: groupId }, "POST");
    const update = await this.waitForGroupUpdate("GroupJoined", from, groupId);
    this.applyJoinedGroup(update);
    await this.refreshGroups();
    return this.getState();
  }

  async leave(): Promise<WatchPartyViewState> {
    if (!this.state.joinedGroup) return this.getState();
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
    return {
      playbackId: state.playbackId!,
      resumePositionTicks: state.positionTicks,
      durationTicks: state.durationTicks,
      source: state.source!,
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
      this.setState({ ...this.state, connection: "disconnected", availability: "offline", error: { code: "SYNCPLAY_DISCONNECTED", message: "The watch-party connection was interrupted." } });
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
    this.setState({ ...this.state, availability: "available", connection: "connected", error: null });
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
    void this.handleCommand(envelope.data.MessageId, command.data);
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
      void this.refreshGroups().catch(() => undefined);
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
    } else if (update.Type === "StateUpdate" && update.Data && typeof update.Data === "object") {
      const value = update.Data as Record<string, unknown>;
      if (groupState.safeParse(value.State).success) this.setJoined({ ...joined, playbackState: value.State as WatchPartyPlaybackState });
    } else if (update.Type === "PlayQueue") {
      const queue = playQueueSchema.safeParse(update.Data);
      if (!queue.success || queue.data.PlayingItemIndex >= queue.data.Playlist.length) return;
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
    this.currentPlaylistItemId = selected.PlaylistItemId;
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
    await this.sendReady(false);
  }

  private async handleCommand(messageId: string, command: Command): Promise<void> {
    const joined = this.state.joinedGroup;
    if (!joined || command.GroupId !== joined.groupId) return;
    if (command.Command !== "Stop" && (!this.currentPlaylistItemId || command.PlaylistItemId !== this.currentPlaylistItemId)) return;
    if (Date.parse(command.EmittedAt) < Date.parse(joined.lastUpdatedAt) - 1000) return;
    const membershipRevision = this.membershipRevision;
    const delay = Math.max(0, Math.min(2000, Date.parse(command.When) - Date.now()));
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
      const elapsedTicks = Math.max(0, Math.min(5 * TICKS_PER_SECOND, (Date.now() - Date.parse(command.When)) * 10_000));
      const targetPosition = basePosition + elapsedTicks;
      if (Math.abs(state.positionTicks - targetPosition) >= DRIFT_SEEK_TICKS) {
        await this.player.seek(state.playbackId, targetPosition, context);
      }
      await this.player.setPaused(state.playbackId, false, context);
      this.setSyncAnchor(targetPosition, true);
      await this.correctDrift();
    } else if (command.Command === "Seek" && command.PositionTicks !== null) {
      await this.player.seek(state.playbackId, command.PositionTicks, context);
      this.setSyncAnchor(command.PositionTicks, !state.paused);
    } else if (command.Command === "Stop") {
      this.syncAnchor = null;
      await this.player.stop(state.playbackId, "stopped", context);
    }
  }

  private async handlePlayerEvent(event: PlayerControllerEvent): Promise<void> {
    if (!this.state.joinedGroup || !this.currentPlaylistItemId) return;
    if (event.action === "buffering") {
      await this.sendBuffering(event.state.buffering).catch(() => undefined);
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
      When: new Date().toISOString(),
      PositionTicks: state.positionTicks,
      IsPlaying: isPlaying,
      PlaylistItemId: this.currentPlaylistItemId,
    }, "POST");
  }

  private async sendBuffering(buffering: boolean): Promise<void> {
    const state = this.player.getState();
    if (!this.currentPlaylistItemId) return;
    await this.api.syncPlayRequest(buffering ? "/SyncPlay/Buffering" : "/SyncPlay/Ready", {
      When: new Date().toISOString(),
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
    if (this.state.joinedGroup?.groupId !== group.groupId) this.membershipRevision += 1;
    this.currentPlaylistItemId = null;
    this.syncAnchor = null;
    this.setJoined({ ...group, currentItemId: null, playlistItemId: null });
  }

  private setJoined(group: JoinedWatchParty): void {
    this.setState({ ...this.state, joinedGroup: group, error: null });
  }

  private clearJoinedGroup(): void {
    if (this.state.joinedGroup || this.currentPlaylistItemId) this.membershipRevision += 1;
    this.currentPlaylistItemId = null;
    this.syncAnchor = null;
    this.setState({ ...this.state, joinedGroup: null });
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
    this.driftCorrectionInFlight = true;
    try {
      const context = { origin: "remote-sync" as const, commandRevision: ++this.commandRevision, commandId: `drift:${anchor.playlistItemId}` };
      if (Math.abs(driftTicks) >= DRIFT_SEEK_TICKS) {
        if (this.player.getPlaybackRate() !== 1) await this.player.setPlaybackRate(state.playbackId, 1, context);
        await this.player.seek(state.playbackId, expectedTicks, context);
      } else if (Math.abs(driftTicks) >= DRIFT_TOLERANCE_TICKS) {
        const rate = driftTicks > 0 ? 1.02 : 0.98;
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

  private closeTransport(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = null;
    if (this.driftTimer) clearInterval(this.driftTimer);
    this.driftTimer = null;
    this.playerUnsubscribe?.();
    this.playerUnsubscribe = null;
    const socket = this.socket;
    this.socket = null;
    try { socket?.close(); } catch { socket?.terminate(); }
  }

  private rememberMessage(messageId: string): void {
    this.appliedMessageIds.add(messageId);
    if (this.appliedMessageIds.size > 2048) this.appliedMessageIds.delete(this.appliedMessageIds.values().next().value!);
  }

  private requireAvailable(): void {
    if (this.state.availability === "denied") throw new AppError("SYNCPLAY_ACCESS_DENIED", "Your Jellyfin account is not allowed to use watch parties.", 403);
    if (this.state.availability === "unsupported") throw new AppError("SYNCPLAY_VERSION_UNSUPPORTED", "This Jellyfin server version has not been verified for watch parties.", 409);
    if (this.state.connection !== "connected") throw new AppError("SYNCPLAY_DISCONNECTED", "The watch-party connection is not available.", 503);
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
}
