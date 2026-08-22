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
const roomSchema = z.object({
  inviteToken: tokenSchema,
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
  clientId,
  error: null,
});

function safeError(error: unknown): { code: string; message: string } {
  if (error instanceof AppError) {
    if (error.status === 404) return { code: "YOUTUBE_ROOMS_PLUGIN_MISSING", message: "Install the Seeing Stone YouTube Rooms plugin on this Jellyfin server." };
    if (error.status === 403) return { code: "YOUTUBE_ROOM_FORBIDDEN", message: "That private room is unavailable to this Jellyfin account." };
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
    if (this.state.room) await this.poll();
    else {
      try {
        await this.api.youtubeRoomRequest("/SeeingStone/YouTubeRooms");
        this.setState({ ...this.state, connection: "connected", error: null });
      } catch (error) { this.setUnavailable(error); }
    }
    this.reconcilePolling();
    return this.getState();
  }

  deactivate(): void {
    this.stopPolling();
    this.visible = false;
    this.presence = "idle";
    this.setState(emptyState(this.clientId));
  }

  async create(youtubeUrl: string): Promise<YouTubeRoomViewState> {
    const videoId = this.requireVideoId(youtubeUrl);
    return this.mutate("/SeeingStone/YouTubeRooms", { clientId: this.clientId, videoId });
  }

  async join(inviteToken: string): Promise<YouTubeRoomViewState> {
    const token = tokenSchema.parse(inviteToken.trim());
    return this.mutate(`/SeeingStone/YouTubeRooms/${token}/join`, { clientId: this.clientId });
  }

  async leave(): Promise<YouTubeRoomViewState> {
    const token = this.requireToken();
    try { await this.api.youtubeRoomRequest(`/SeeingStone/YouTubeRooms/${token}/leave`, { clientId: this.clientId }); }
    finally {
      this.presence = "idle";
      this.setState({ ...this.state, connection: "connected", room: null, error: null });
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
    if (!this.state.room || this.requestInFlight) return;
    this.requestInFlight = true;
    const token = this.state.room.inviteToken;
    try {
      const value = await this.api.youtubeRoomRequest(`/SeeingStone/YouTubeRooms/${token}/presence`, {
        clientId: this.clientId,
        status: this.presence,
      });
      const room = normalizeRoomClock(roomSchema.parse(value), Date.now());
      this.setState({ ...this.state, connection: "connected", room, error: null });
    } catch (error) {
      this.setUnavailable(error, true);
    } finally { this.requestInFlight = false; }
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
    if (this.visible && this.state.room && !this.pollTimer) {
      this.pollTimer = setInterval(() => { void this.poll(); }, this.pollIntervalMs);
    } else if ((!this.visible || !this.state.room) && this.pollTimer) this.stopPolling();
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
