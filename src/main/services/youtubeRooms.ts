import { randomUUID } from "node:crypto";
import { z } from "zod";
import type {
  YouTubeRoomActionInput,
  YouTubeRoomPlaybackStatus,
  YouTubeRoomViewState,
} from "../../shared/contracts";
import { AppError } from "./errors";
import type { JellyfinApi } from "./jellyfinApi";
import { youtubeVideoId } from "./trailerWindow";

const tokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const healthSchema = z.object({
  protocolVersion: z.number().int().min(1),
  roomLifetimeMinutes: z.number().int().positive(),
});
const roomSummarySchema = z.object({
  roomId: tokenSchema,
  name: z.string().min(1).max(80),
  videoId: z.string().regex(/^[A-Za-z0-9_-]{11}$/).nullable(),
  memberCount: z.number().int().min(1).max(32),
  connectedMemberCount: z.number().int().min(0).max(32),
  createdAtUnixMs: z.number().int().nonnegative(),
  expiresAtUnixMs: z.number().int().positive(),
}).strict();
const roomSchema = z.object({
  inviteToken: tokenSchema,
  name: z.string().min(1).max(80),
  serverNowUnixMs: z.number().int().nonnegative(),
  createdAtUnixMs: z.number().int().nonnegative(),
  expiresAtUnixMs: z.number().int().positive(),
  timeline: z.object({
    videoId: z.string().regex(/^[A-Za-z0-9_-]{11}$/).nullable(),
    positionSeconds: z.number().finite().min(0).max(86400),
    playing: z.boolean(),
    anchoredAtUnixMs: z.number().int().nonnegative(),
    version: z.number().int().nonnegative(),
    changedBy: z.string().max(256).nullable(),
  }).strict(),
  members: z.array(z.object({
    memberId: z.string().min(1).max(256),
    displayName: z.string().min(1).max(256),
    status: z.enum(["idle", "playing", "paused", "buffering", "recovering"]),
    connected: z.boolean(),
    lastSeenAtUnixMs: z.number().int().nonnegative(),
  }).strict()).max(32),
}).strict();

function normalizeRoomClock(value: z.infer<typeof roomSchema>, receivedAtUnixMs: number) {
  const offset = receivedAtUnixMs - value.serverNowUnixMs;
  return {
    ...value,
    serverNowUnixMs: receivedAtUnixMs,
    createdAtUnixMs: value.createdAtUnixMs + offset,
    expiresAtUnixMs: value.expiresAtUnixMs + offset,
    timeline: { ...value.timeline, anchoredAtUnixMs: value.timeline.anchoredAtUnixMs + offset },
    members: value.members.map((member) => ({ ...member, lastSeenAtUnixMs: member.lastSeenAtUnixMs + offset })),
  };
}

const emptyState = (clientId: string): YouTubeRoomViewState => ({
  connection: "signed-out",
  room: null,
  openRooms: [],
  clientId,
  error: null,
});

function safeError(error: unknown): { code: string; message: string } {
  if (error instanceof AppError) {
    if (error.code === "YOUTUBE_ROOMS_PLUGIN_OUTDATED") return { code: error.code, message: error.message };
    if (error.status === 404) return { code: "YOUTUBE_ROOMS_PLUGIN_MISSING", message: "Install the Seeing Stone YouTube Rooms plugin on this Jellyfin server." };
    if (error.status === 403) return { code: "YOUTUBE_ROOM_FORBIDDEN", message: "Join that YouTube room before changing it." };
    if (error.status === 410) return { code: "YOUTUBE_ROOM_EXPIRED", message: "That temporary room has expired." };
  }
  return { code: "YOUTUBE_ROOMS_UNAVAILABLE", message: "YouTube Rooms could not reach the Jellyfin server." };
}

export class YouTubeRoomService {
  private readonly clientId = randomUUID();
  private state = emptyState(this.clientId);
  private listeners = new Set<(state: YouTubeRoomViewState) => void>();
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private visible = false;
  private presence: YouTubeRoomPlaybackStatus = "idle";
  private requestInFlight = false;

  constructor(private readonly api: Pick<JellyfinApi, "youtubeRoomRequest" | "getAuthenticatedContext">, private readonly pollIntervalMs = 1000) {}

  onState(listener: (state: YouTubeRoomViewState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getState(): YouTubeRoomViewState { return structuredClone(this.state); }

  async activate(): Promise<YouTubeRoomViewState> {
    try { this.api.getAuthenticatedContext(); }
    catch {
      this.stopPolling();
      this.setState(emptyState(this.clientId));
      return this.getState();
    }
    this.setState({ ...this.state, connection: "checking", error: null });
    try {
      const health = healthSchema.parse(await this.api.youtubeRoomRequest("/SeeingStone/YouTubeRooms"));
      if (health.protocolVersion < 2) throw new AppError("YOUTUBE_ROOMS_PLUGIN_OUTDATED", "Update the Seeing Stone YouTube Rooms plugin on this Jellyfin server.", 409);
      await this.refreshOpenRooms();
      if (this.state.room) await this.poll();
      else this.setState({ ...this.state, connection: "connected", error: null });
    } catch (error) { this.setUnavailable(error, Boolean(this.state.room)); }
    this.reconcilePolling();
    return this.getState();
  }

  deactivate(): void {
    this.stopPolling();
    this.visible = false;
    this.presence = "idle";
    this.setState(emptyState(this.clientId));
  }

  async refresh(): Promise<YouTubeRoomViewState> {
    if (this.state.connection === "signed-out") return this.activate();
    if (this.state.room) await this.poll();
    else await this.refreshOpenRooms();
    return this.getState();
  }

  async create(name: string, youtubeUrl: string): Promise<YouTubeRoomViewState> {
    const videoId = this.requireVideoId(youtubeUrl);
    const roomName = name.trim();
    if (!roomName || roomName.length > 80) throw new AppError("INVALID_YOUTUBE_ROOM_NAME", "Enter a room name up to 80 characters.", 400);
    return this.mutate("/SeeingStone/YouTubeRooms", { clientId: this.clientId, name: roomName, videoId });
  }

  async join(roomId: string): Promise<YouTubeRoomViewState> {
    const token = tokenSchema.parse(roomId.trim());
    return this.mutate(`/SeeingStone/YouTubeRooms/${token}/join`, { clientId: this.clientId });
  }

  async leave(): Promise<YouTubeRoomViewState> {
    const token = this.requireToken();
    try { await this.api.youtubeRoomRequest(`/SeeingStone/YouTubeRooms/${token}/leave`, { clientId: this.clientId }); }
    finally {
      this.presence = "idle";
      this.setState({ ...this.state, connection: "connected", room: null, error: null });
      await this.refreshOpenRooms().catch(() => undefined);
      this.reconcilePolling();
    }
    return this.getState();
  }

  async setVideo(youtubeUrl: string): Promise<YouTubeRoomViewState> {
    const token = this.requireToken();
    return this.mutate(`/SeeingStone/YouTubeRooms/${token}/video`, { clientId: this.clientId, videoId: this.requireVideoId(youtubeUrl) });
  }

  async action(input: YouTubeRoomActionInput): Promise<YouTubeRoomViewState> {
    const token = this.requireToken();
    return this.mutate(`/SeeingStone/YouTubeRooms/${token}/action`, { clientId: this.clientId, ...input });
  }

  async setPresence(status: YouTubeRoomPlaybackStatus): Promise<YouTubeRoomViewState> {
    this.presence = status;
    if (!this.state.room) return this.getState();
    const token = this.requireToken();
    return this.mutate(`/SeeingStone/YouTubeRooms/${token}/presence`, { clientId: this.clientId, status }, false);
  }

  setVisible(visible: boolean): YouTubeRoomViewState {
    this.visible = visible;
    this.reconcilePolling();
    if (visible && this.state.connection === "signed-out") void this.activate();
    return this.getState();
  }

  private async poll(): Promise<void> {
    if (this.requestInFlight) return;
    this.requestInFlight = true;
    try {
      if (this.state.room) {
        const token = this.state.room.inviteToken;
        const value = await this.api.youtubeRoomRequest(`/SeeingStone/YouTubeRooms/${token}/presence`, {
          clientId: this.clientId,
          status: this.presence,
        });
        const room = normalizeRoomClock(roomSchema.parse(value), Date.now());
        this.setState({ ...this.state, connection: "connected", room, error: null });
      } else await this.refreshOpenRooms();
    } catch (error) {
      this.setUnavailable(error, true);
    } finally { this.requestInFlight = false; }
  }

  private async refreshOpenRooms(): Promise<void> {
    const value = await this.api.youtubeRoomRequest("/SeeingStone/YouTubeRooms/open");
    const openRooms = z.array(roomSummarySchema).max(100).parse(value);
    this.setState({ ...this.state, connection: "connected", openRooms, error: null });
  }

  private async mutate(path: string, body: unknown, setChecking = true): Promise<YouTubeRoomViewState> {
    if (setChecking) this.setState({ ...this.state, connection: this.state.room ? "reconnecting" : "checking", error: null });
    try {
      const room = normalizeRoomClock(roomSchema.parse(await this.api.youtubeRoomRequest(path, body)), Date.now());
      this.setState({ ...this.state, connection: "connected", room, error: null });
      this.reconcilePolling();
    } catch (error) {
      this.setUnavailable(error, Boolean(this.state.room));
      throw error;
    }
    return this.getState();
  }

  private setUnavailable(error: unknown, preserveRoom = false): void {
    const safe = safeError(error);
    this.setState({
      ...this.state,
      connection: safe.code === "YOUTUBE_ROOMS_PLUGIN_MISSING" ? "plugin-missing" : "reconnecting",
      room: preserveRoom ? this.state.room : null,
      error: safe,
    });
  }

  private requireVideoId(url: string): string {
    const videoId = youtubeVideoId(url);
    if (!videoId) throw new AppError("INVALID_YOUTUBE_URL", "Paste a supported YouTube video URL.", 400);
    return videoId;
  }

  private requireToken(): string {
    if (!this.state.room) throw new AppError("YOUTUBE_ROOM_NOT_JOINED", "Join a YouTube room first.", 409);
    return this.state.room.inviteToken;
  }

  private reconcilePolling(): void {
    if (this.visible && this.state.connection !== "signed-out" && this.state.connection !== "plugin-missing" && !this.pollTimer) {
      this.pollTimer = setInterval(() => { void this.poll(); }, this.pollIntervalMs);
    } else if ((!this.visible || this.state.connection === "signed-out" || this.state.connection === "plugin-missing") && this.pollTimer) this.stopPolling();
  }

  private stopPolling(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  private setState(state: YouTubeRoomViewState): void {
    this.state = structuredClone(state);
    const snapshot = this.getState();
    for (const listener of this.listeners) listener(snapshot);
  }
}
