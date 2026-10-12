import { z } from "zod";
import type { CompanionCommand, CompanionYouTubePage, CompanionYouTubeState } from "../../shared/companionContracts";
import type { YouTubeApiKeyStore } from "./youtubeApiKeyStore";
import type { YouTubeRoomService } from "./youtubeRooms";
import { AppError } from "./errors";

const videoIdSchema = z.string().regex(/^[A-Za-z0-9_-]{11}$/);
const querySchema = z.string().trim().max(100);
const pageTokenSchema = z.string().max(512).regex(/^[A-Za-z0-9_=-]*$/);
const responseSchema = z.object({
  nextPageToken: pageTokenSchema.optional(),
  items: z.array(z.object({
    id: z.union([videoIdSchema, z.object({ videoId: videoIdSchema })]),
    snippet: z.object({ title: z.string().max(1000), channelTitle: z.string().max(1000) }),
    status: z.object({ embeddable: z.boolean().optional() }).optional(),
  })).max(50),
});

/** Public discovery stays in main: the phone never receives the Google API key. */
export class CompanionYouTubeService {
  private readonly cache = new Map<string, { expires: number; page: CompanionYouTubePage }>();
  private readonly pending = new Map<string, Promise<CompanionYouTubePage>>();
  private keyVersion = 0;

  constructor(
    private readonly rooms: Pick<YouTubeRoomService, "getState" | "addToQueue" | "action" | "advance" | "queueAction">,
    private readonly getKey = () => process.env.SEEING_STONE_YOUTUBE_API_KEY?.trim() ?? "",
    private readonly request: typeof fetch = fetch,
    private readonly keyStore?: YouTubeApiKeyStore,
  ) {}

  getSearchSettings() {
    return this.keyStore?.getStatus() ?? { configured: Boolean(this.getKey()), source: this.getKey() ? "environment" as const : "none" as const, storageUnavailable: false };
  }

  async setApiKey(apiKey: string) {
    if (!this.keyStore) throw new AppError("YOUTUBE_KEY_STORAGE", "YouTube key settings are unavailable in this build.", 503);
    const status = await this.keyStore.setKey(apiKey);
    this.keyVersion++;
    this.cache.clear();
    return status;
  }

  private position(room: NonNullable<ReturnType<YouTubeRoomService["getState"]>["room"]>): number {
    const timeline = room.timeline;
    return Math.min(86400, Math.max(0, timeline.positionSeconds + (timeline.playing ? Math.max(0, Date.now() - timeline.anchoredAtUnixMs) / 1000 : 0)));
  }

  getState(): CompanionYouTubeState {
    const state = this.rooms.getState();
    return {
      searchConfigured: Boolean(this.getKey()),
      room: state.room ? {
        id: state.room.inviteToken,
        name: state.room.name,
        playing: state.room.timeline.playing,
        positionSeconds: this.position(state.room),
        videoId: state.room.timeline.videoId,
        controllable: state.connection === "connected" && !state.room.transition,
        queue: state.room.queue.map(({ queueItemId, videoId }) => ({ queueItemId, videoId })),
      } : null,
    };
  }

  private requireRoom(roomId: string) {
    const room = this.rooms.getState().room;
    if (!room || room.inviteToken !== roomId) {
      throw new AppError("YOUTUBE_ROOM_CHANGED", "Open or join a YouTube room on the desktop, then refresh this tab.", 409);
    }
    if (room.transition) throw new AppError("YOUTUBE_ROOM_TRANSITION", "This room has moved to a Jellyfin party. Open another YouTube room on the desktop.", 409);
    return room;
  }

  async add(videoUrl: string, roomId: string, playNow = false): Promise<void> {
    this.requireRoom(roomId);
    await this.rooms.addToQueue({ youtubeUrls: videoUrl, playNow });
  }

  async control(command: Extract<CompanionCommand, { type: "youtube-control" }>): Promise<void> {
    const room = this.requireRoom(command.roomId);
    if (!room.timeline.videoId || room.queue[0]?.queueItemId !== command.queueItemId) {
      throw new AppError("YOUTUBE_VIDEO_CHANGED", "The YouTube video changed. Refresh and try again.", 409);
    }
    if (command.action === "next") { await this.rooms.advance(room.timeline.videoId); return; }
    const position = this.position(room);
    await this.rooms.action({
      action: command.action === "play" || command.action === "pause" ? command.action : "seek",
      positionSeconds: command.action === "restart" ? 0 : command.action === "back" ? Math.max(0, position - 10) : command.action === "forward" ? Math.min(86400, position + 30) : position,
    });
  }

  async queueAction(command: Extract<CompanionCommand, { type: "youtube-queue" }>): Promise<void> {
    const room = this.requireRoom(command.roomId);
    if (!room.queue.some(item => item.queueItemId === command.queueItemId)) throw new AppError("YOUTUBE_VIDEO_CHANGED", "That video is no longer in the queue. Refresh and try again.", 409);
    await this.rooms.queueAction({ queueItemId: command.queueItemId, action: command.action });
  }

  async browse(query: string, pageToken: string): Promise<CompanionYouTubePage> {
    const q = querySchema.parse(query);
    const token = pageTokenSchema.parse(pageToken);
    const key = this.getKey();
    if (!key) throw new AppError("YOUTUBE_SEARCH_SETUP", "YouTube search needs an API key configured on the desktop. You can still paste a video link below.", 503);
    const cacheKey = JSON.stringify([this.keyVersion, q, token]);
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expires > Date.now()) return structuredClone(cached.page);
    const existing = this.pending.get(cacheKey);
    if (existing) return structuredClone(await existing);
    const work = this.load(q, token, key);
    this.pending.set(cacheKey, work);
    try {
      const page = await work;
      if (this.cache.size >= 100) this.cache.delete(this.cache.keys().next().value!);
      this.cache.set(cacheKey, { expires: Date.now() + 5 * 60_000, page });
      return structuredClone(page);
    } finally { this.pending.delete(cacheKey); }
  }

  private async load(q: string, token: string, key: string): Promise<CompanionYouTubePage> {
    const url = new URL(`https://www.googleapis.com/youtube/v3/${q ? "search" : "videos"}`);
    url.search = new URLSearchParams({
      part: q ? "snippet" : "snippet,status", maxResults: "20", key,
      ...(q ? { q, type: "video", videoEmbeddable: "true" } : { chart: "mostPopular", regionCode: "US" }),
      ...(token ? { pageToken: token } : {}),
    }).toString();
    try {
      const response = await this.request(url, { signal: AbortSignal.timeout(10_000), redirect: "error" });
      if (!response.ok) {
        if (response.status === 403 || response.status === 429) throw new AppError("YOUTUBE_SEARCH_LIMIT", "YouTube search is unavailable. Check the desktop API key and its quota, or paste a video link.", 503);
        throw new AppError("YOUTUBE_SEARCH_FAILED", "YouTube could not load these videos. Try the search again.", 502);
      }
      const data = responseSchema.parse(await response.json());
      return {
        items: data.items.filter((item) => item.status?.embeddable !== false).map((item) => ({
          videoId: typeof item.id === "string" ? item.id : item.id.videoId,
          title: item.snippet.title, channelTitle: item.snippet.channelTitle,
        })),
        nextPageToken: data.nextPageToken ?? null,
      };
    } catch (error) {
      if (error instanceof AppError) throw error;
      // Fetch errors may contain the request URL and key; never forward them.
      throw new AppError("YOUTUBE_SEARCH_UNAVAILABLE", "YouTube could not be reached. Try again shortly.", 502);
    }
  }
}
