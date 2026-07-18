import { randomUUID } from "node:crypto";
import type {
  ExternalSubtitleFormat,
  ExternalSubtitleTrack,
  HomePayload,
  LibrarySummary,
  MediaItem,
  MediaSourceCapabilities,
  JellyfinConnectionDiagnostics,
  PublicServerInfo,
  SafeSession,
  ServerConnection,
} from "../../shared/contracts";
import type { PlaybackActionKind } from "./persistenceTypes";
import type { DeviceIdentity } from "./deviceIdentity";
import { AppError } from "./errors";
import type { SecureSessionStore, StoredSession } from "./secureSession";

const ITEM_FIELDS = [
  "Overview",
  "Genres",
  "PrimaryImageAspectRatio",
  "MediaSources",
  "MediaStreams",
  "RemoteTrailers",
  "ParentId",
  "SeriesId",
  "SeriesName",
  "SeasonId",
  "SeasonName",
  "IndexNumber",
  "ParentIndexNumber",
  "RunTimeTicks",
  "ProductionYear",
  "PremiereDate",
  "OfficialRating",
  "CommunityRating",
].join(",");

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" ? value as JsonRecord : {};
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function nullableString(value: unknown): string | null {
  const result = asString(value);
  return result || null;
}

function nullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function boundedNullableString(value: unknown, maximum: number): string | null {
  return nullableString(value)?.slice(0, maximum) ?? null;
}

const SENSITIVE_DIAGNOSTIC = /(?:https?:\/\/|file:\/\/|[a-z]:[\\/]|\\\\|\/[^\s,]+\/|api[_-]?key|access[_-]?token|authorization|bearer\s)/i;

function safeOpaqueIdentifier(value: unknown, maximum = 256): string | null {
  const result = asString(value).trim();
  return result.length > 0 && result.length <= maximum && /^[A-Za-z0-9][A-Za-z0-9._~-]*$/.test(result)
    ? result
    : null;
}

function safeDiagnostic(value: unknown, maximum: number, allowed: RegExp): string | null {
  const result = asString(value).trim().slice(0, maximum);
  if (!result || SENSITIVE_DIAGNOSTIC.test(result) || !allowed.test(result)) return null;
  return result;
}

const safeDiagnosticToken = (value: unknown, maximum = 64): string | null =>
  safeDiagnostic(value, maximum, /^[A-Za-z0-9][A-Za-z0-9 .,_+()~-]*$/);
const safeDiagnosticPhrase = (value: unknown, maximum = 256): string | null =>
  safeDiagnostic(value, maximum, /^[A-Za-z0-9][A-Za-z0-9 .,_+():~-]*$/);

export function seeingStoneMpvDeviceProfile(): JsonRecord {
  return {
    Name: "Seeing Stone mpv",
    DirectPlayProfiles: [
      { Container: "mp4,m4v,mov", Type: "Video", VideoCodec: "h264,hevc,av1,mpeg4", AudioCodec: "aac,ac3,eac3,mp3,flac,alac,opus" },
      { Container: "mkv,webm", Type: "Video", VideoCodec: "h264,hevc,av1,vp9,vp8,mpeg4,mpeg2video,vc1,theora", AudioCodec: "aac,ac3,eac3,mp3,flac,alac,opus,vorbis,dts,truehd" },
      { Container: "ts,mpegts,m2ts", Type: "Video", VideoCodec: "h264,hevc,mpeg2video,vc1", AudioCodec: "aac,ac3,eac3,mp2,mp3,dts" },
      { Container: "avi,flv,ogv", Type: "Video", VideoCodec: "h264,mpeg4,mpeg2video,vc1,theora", AudioCodec: "aac,ac3,mp3,vorbis" },
    ],
    TranscodingProfiles: [{
      Container: "mp4",
      Type: "Video",
      VideoCodec: "h264,hevc,av1",
      AudioCodec: "aac,ac3,eac3,mp3,flac,alac,opus",
      Protocol: "http",
      Context: "Streaming",
      CopyTimestamps: false,
      EnableSubtitlesInManifest: false,
      MaxAudioChannels: "8",
    }],
    CodecProfiles: [],
    ContainerProfiles: [],
    SubtitleProfiles: [
      { Format: "srt", Method: "External" },
      { Format: "subrip", Method: "External" },
      { Format: "ass", Method: "External" },
      { Format: "ssa", Method: "External" },
      { Format: "vtt", Method: "External" },
      { Format: "pgssub,dvdsub", Method: "Embed" },
    ],
  };
}

function mediaSourceCapabilities(itemId: string, value: unknown): MediaSourceCapabilities {
  const result = asRecord(value);
  const sources = Array.isArray(result.MediaSources) ? result.MediaSources : [];
  return {
    itemId,
    sources: sources.map((entry) => {
      const source = asRecord(entry);
      const streams = Array.isArray(source.MediaStreams) ? source.MediaStreams.map(asRecord) : [];
      const video = streams.find((stream) => stream.Type === "Video");
      const audio = streams.find((stream) => stream.Type === "Audio");
      const width = nullableNumber(video?.Width);
      const height = nullableNumber(video?.Height);
      const transcodeReasons = Array.isArray(source.TranscodingReasons)
        ? source.TranscodingReasons.map((reason) => safeDiagnosticPhrase(reason, 128)).filter((reason): reason is string => Boolean(reason)).slice(0, 16).join(", ") || null
        : safeDiagnosticPhrase(source.TranscodingReasons, 512);
      return {
        id: safeOpaqueIdentifier(source.Id) ?? "",
        container: safeDiagnosticToken(source.Container),
        size: nullableNumber(source.Size),
        supportsDirectPlay: source.SupportsDirectPlay === true,
        supportsDirectStream: source.SupportsDirectStream === true,
        supportsTranscoding: source.SupportsTranscoding === true,
        videoCodec: safeDiagnosticToken(video?.Codec),
        audioCodec: safeDiagnosticToken(audio?.Codec),
        audioChannels: safeDiagnosticToken(audio?.ChannelLayout) ?? (nullableNumber(audio?.Channels)?.toString() ?? null),
        width,
        height,
        bitrate: nullableNumber(source.Bitrate) ?? nullableNumber(video?.BitRate),
        videoRange: safeDiagnosticToken(video?.VideoRange),
        transcodeReason: transcodeReasons,
        externalSubtitles: externalSubtitles(source.MediaStreams),
      };
    }).filter((source) => source.id),
  };
}

export interface PlaybackSourceInfo {
  capabilities: MediaSourceCapabilities;
  playSessionId: string | null;
}

function externalSubtitleFormat(value: unknown): ExternalSubtitleFormat {
  const codec = asString(value).trim().toLocaleLowerCase("en-US");
  if (codec === "ass") return "ass";
  if (codec === "ssa") return "ssa";
  if (codec === "vtt" || codec === "webvtt") return "vtt";
  return "srt";
}

function externalSubtitles(value: unknown): ExternalSubtitleTrack[] {
  const result: ExternalSubtitleTrack[] = [];
  const seen = new Set<number>();
  for (const entry of Array.isArray(value) ? value : []) {
    const stream = asRecord(entry);
    const streamType = typeof stream.Type === "string" ? stream.Type.toLocaleLowerCase("en-US") : stream.Type;
    const streamIndex = stream.Index;
    if ((streamType !== 2 && streamType !== "subtitle")
      || stream.IsExternal !== true
      || stream.IsTextSubtitleStream === false
      || stream.SupportsExternalStream === false
      || !Number.isSafeInteger(streamIndex)
      || (streamIndex as number) < 0
      || seen.has(streamIndex as number)) continue;
    seen.add(streamIndex as number);
    result.push({
      streamIndex: streamIndex as number,
      format: externalSubtitleFormat(stream.Codec),
      title: safeDiagnosticPhrase(nullableString(stream.DisplayTitle) ?? nullableString(stream.Title), 256),
      language: safeDiagnosticToken(stream.Language, 32),
      isDefault: stream.IsDefault === true,
      isForced: stream.IsForced === true,
    });
    if (result.length === 32) break;
  }
  return result;
}

function premiereYear(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{4})-/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  return year >= 1000 && year <= 9999 ? year : null;
}

export function normalizeServerUrl(value: string): string {
  const parsed = new URL(value.trim());
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new AppError("INVALID_SERVER", "Use an HTTP or HTTPS Jellyfin address.", 400);
  if (parsed.username || parsed.password) throw new AppError("INVALID_SERVER", "Server addresses cannot contain credentials.", 400);
  if (parsed.search || parsed.hash) throw new AppError("INVALID_SERVER", "Server addresses cannot contain a query or fragment.", 400);
  return parsed.toString().replace(/\/$/, "");
}

export function sanitizeMediaItem(value: unknown): MediaItem {
  const item = asRecord(value);
  const imageTags = asRecord(item.ImageTags);
  const userData = asRecord(item.UserData);
  const remoteTrailers = Array.isArray(item.RemoteTrailers) ? item.RemoteTrailers : [];
  const type = asString(item.Type, "Video") as MediaItem["type"];
  return {
    id: asString(item.Id),
    name: asString(item.Name, "Untitled"),
    type: ["Movie", "Series", "Season", "Episode", "BoxSet", "Video"].includes(type) ? type : "Video",
    overview: asString(item.Overview),
    productionYear: nullableNumber(item.ProductionYear),
    premiereYear: premiereYear(item.PremiereDate),
    officialRating: nullableString(item.OfficialRating)?.slice(0, 32) ?? null,
    communityRating: nullableNumber(item.CommunityRating),
    runTimeTicks: asNumber(item.RunTimeTicks),
    genres: Array.isArray(item.Genres) ? item.Genres.filter((entry): entry is string => typeof entry === "string").slice(0, 32) : [],
    primaryImageAspectRatio: nullableNumber(item.PrimaryImageAspectRatio),
    imageTags: {
      Primary: nullableString(imageTags.Primary) ?? undefined,
      Backdrop: nullableString(imageTags.Backdrop) ?? undefined,
      Thumb: nullableString(imageTags.Thumb) ?? undefined,
    },
    backdropImageTag: Array.isArray(item.BackdropImageTags) ? nullableString(item.BackdropImageTags[0]) : null,
    parentThumbItemId: nullableString(item.ParentThumbItemId),
    parentThumbImageTag: nullableString(item.ParentThumbImageTag),
    seriesId: nullableString(item.SeriesId),
    seriesName: nullableString(item.SeriesName),
    seasonId: nullableString(item.SeasonId),
    indexNumber: nullableNumber(item.IndexNumber),
    parentIndexNumber: nullableNumber(item.ParentIndexNumber),
    userData: {
      played: userData.Played === true,
      playbackPositionTicks: asNumber(userData.PlaybackPositionTicks),
      playedPercentage: asNumber(userData.PlayedPercentage),
    },
    hasTrailer: remoteTrailers.some((entry) => {
      const url = asString(asRecord(entry).Url);
      try { return ["http:", "https:"].includes(new URL(url).protocol); } catch { return false; }
    }),
    playable: type === "Movie" || type === "Episode" || type === "Video",
  };
}

function sanitizeLibrary(value: unknown): LibrarySummary {
  const library = asRecord(value);
  return {
    id: asString(library.Id),
    name: asString(library.Name, "Library"),
    collectionType: nullableString(library.CollectionType),
  };
}

interface AuthenticatedState extends StoredSession {}
export interface AuthenticatedContext {
  serverId: string;
  serverAddress: string;
  serverName: string;
  userId: string;
  userName: string;
}
export interface AuthenticatedSocketContext extends AuthenticatedContext {
  serverVersion: string;
  authorizationHeader: string;
  deviceId: string;
  sessionRevision: number;
  signal: AbortSignal;
}
export interface ServerTimeResponse {
  requestReceptionTime: string;
  responseTransmissionTime: string;
}
export type SyncPlayEndpoint =
  | "/SyncPlay/List"
  | "/SyncPlay/New"
  | "/SyncPlay/Join"
  | "/SyncPlay/Leave"
  | "/SyncPlay/SetNewQueue"
  | "/SyncPlay/Pause"
  | "/SyncPlay/Unpause"
  | "/SyncPlay/Seek"
  | "/SyncPlay/Stop"
  | "/SyncPlay/Ready"
  | "/SyncPlay/Buffering"
  | "/SyncPlay/Ping";
const syncPlayEndpoints = new Set<SyncPlayEndpoint>([
  "/SyncPlay/List", "/SyncPlay/New", "/SyncPlay/Join", "/SyncPlay/Leave", "/SyncPlay/SetNewQueue",
  "/SyncPlay/Pause", "/SyncPlay/Unpause", "/SyncPlay/Seek", "/SyncPlay/Stop", "/SyncPlay/Ready",
  "/SyncPlay/Buffering", "/SyncPlay/Ping",
]);
interface PendingConnection {
  server: PublicServerInfo;
  expiresAt: number;
}

const CONNECTION_TTL_MS = 10 * 60 * 1000;
const MAX_PENDING_CONNECTIONS = 16;

export interface JellyfinConnectionClock {
  monotonicNow(): number;
  wallNow(): number;
}

const systemConnectionClock: JellyfinConnectionClock = {
  monotonicNow: () => performance.now(),
  wallNow: () => Date.now(),
};

interface ConnectionMeasurement {
  requestSequence: number;
  sessionRevision: number;
  state: "connected" | "offline" | "reconnecting";
  requestLatencyMs: number | null;
  measuredAt: string;
}

export class JellyfinApi {
  private session: AuthenticatedState | null = null;
  private sessionController = new AbortController();
  private sessionMutationTail: Promise<void> = Promise.resolve();
  private sessionRevision = 0;
  private readonly pendingConnections = new Map<string, PendingConnection>();
  private requestMeasurementSequence = 0;
  private connectionMeasurement: ConnectionMeasurement | null = null;
  private readonly connectionListeners = new Set<(diagnostics: JellyfinConnectionDiagnostics) => void>();

  constructor(
    private readonly identity: DeviceIdentity,
    private readonly sessionStore: SecureSessionStore,
    private readonly openExternal: (url: string) => Promise<void>,
    private readonly connectionClock: JellyfinConnectionClock = systemConnectionClock,
  ) {}

  async getPublicServerInfo(serverUrl: string): Promise<PublicServerInfo> {
    const address = normalizeServerUrl(serverUrl);
    let response: Response;
    try {
      response = await fetch(`${address}/System/Info/Public`, { signal: AbortSignal.timeout(5000), redirect: "manual" });
    } catch {
      throw new AppError("SERVER_UNREACHABLE", "Could not reach that Jellyfin server.");
    }
    if (!response.ok) throw new AppError("SERVER_UNREACHABLE", "That address did not respond as a Jellyfin server.", response.status);
    const value = asRecord(await response.json());
    const id = asString(value.Id);
    if (!id) throw new AppError("INVALID_SERVER", "That address did not return a Jellyfin server identity.");
    return { address, id, name: asString(value.ServerName, "Jellyfin"), version: asString(value.Version) };
  }

  async connect(serverUrl: string): Promise<ServerConnection> {
    const server = await this.getPublicServerInfo(serverUrl);
    const now = Date.now();
    for (const [id, pending] of this.pendingConnections) {
      if (pending.expiresAt <= now) this.pendingConnections.delete(id);
    }
    while (this.pendingConnections.size >= MAX_PENDING_CONNECTIONS) {
      const oldest = this.pendingConnections.keys().next().value as string | undefined;
      if (!oldest) break;
      this.pendingConnections.delete(oldest);
    }
    const connectionId = randomUUID();
    this.pendingConnections.set(connectionId, { server, expiresAt: now + CONNECTION_TTL_MS });
    return { ...server, connectionId };
  }

  async login(connectionId: string, username: string, password: string, remember: boolean): Promise<SafeSession> {
    return this.runSessionMutation(async () => {
      const pending = this.pendingConnections.get(connectionId);
      if (!pending || pending.expiresAt <= Date.now()) {
        this.pendingConnections.delete(connectionId);
        throw new AppError("INVALID_CONNECTION", "Connect to the Jellyfin server again before signing in.", 400);
      }
      const server = pending.server;
      let response: Response;
      try {
        response = await fetch(`${server.address}/Users/AuthenticateByName`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Emby-Authorization": this.authorizationHeader() },
          body: JSON.stringify({ Username: username, Pw: password }),
          signal: AbortSignal.timeout(10000),
          redirect: "manual",
        });
      } catch {
        throw new AppError("SERVER_UNREACHABLE", "The Jellyfin server could not be reached.");
      }
      if (!response.ok) throw new AppError("AUTH_FAILED", response.status === 401 ? "The username or password was not accepted." : "Jellyfin sign-in failed.", response.status);
      const result = asRecord(await response.json());
      const user = asRecord(result.User);
      const accessToken = asString(result.AccessToken);
      const userId = asString(user.Id);
      if (!accessToken || !userId) throw new AppError("AUTH_FAILED", "Jellyfin returned an incomplete sign-in response.");
      const authenticatedSession: AuthenticatedState = {
        serverUrl: server.address,
        serverId: server.id,
        serverName: server.name,
        serverVersion: server.version,
        userId,
        userName: asString(user.Name, username),
        accessToken,
      };
      await this.sessionStore.save(authenticatedSession, remember);
      this.setSession(authenticatedSession);
      this.pendingConnections.delete(connectionId);
      return this.safeSession();
    });
  }

  async restore(): Promise<SafeSession> {
    return this.runSessionMutation(async () => {
      const stored = await this.sessionStore.restore();
      if (!stored) {
        this.setSession(null);
        return this.safeSession();
      }
      this.setSession(stored);
      try {
        await this.request(`/Users/${encodeURIComponent(stored.userId)}`);
        return this.safeSession();
      } catch (error) {
        if (error instanceof AppError && error.code === "SESSION_EXPIRED") {
          this.setSession(null);
          await this.sessionStore.clear();
          return this.safeSession();
        }
        // A protected session remains authoritative while the server is offline.
        // Only an explicit 401 proves that the token is no longer valid.
        return this.safeSession();
      }
    });
  }

  getSafeSession(): SafeSession {
    return this.safeSession();
  }

  getConnectionDiagnostics(): JellyfinConnectionDiagnostics {
    if (!this.session) {
      return {
        state: "unknown",
        serverName: null,
        serverVersion: null,
        requestLatencyMs: null,
        measuredAt: null,
      };
    }
    const measurement = this.connectionMeasurement?.sessionRevision === this.sessionRevision
      ? this.connectionMeasurement
      : null;
    return {
      state: measurement?.state ?? "unknown",
      serverName: this.session.serverName.slice(0, 256) || "Jellyfin",
      serverVersion: this.session.serverVersion.slice(0, 64) || null,
      requestLatencyMs: measurement?.requestLatencyMs ?? null,
      measuredAt: measurement?.measuredAt ?? null,
    };
  }

  onConnectionDiagnostics(listener: (diagnostics: JellyfinConnectionDiagnostics) => void): () => void {
    this.connectionListeners.add(listener);
    return () => this.connectionListeners.delete(listener);
  }

  getAuthenticatedContext(): AuthenticatedContext {
    const session = this.requireSession();
    return {
      serverId: session.serverId,
      serverAddress: session.serverUrl,
      serverName: session.serverName,
      userId: session.userId,
      userName: session.userName,
    };
  }

  /** Main-process-only transport material for authenticated Jellyfin protocols. */
  getAuthenticatedSocketContext(): AuthenticatedSocketContext {
    const session = this.requireSession();
    return {
      ...this.getAuthenticatedContext(),
      serverVersion: session.serverVersion,
      authorizationHeader: this.authorizationHeader(session.accessToken),
      deviceId: this.identity.deviceId,
      sessionRevision: this.sessionRevision,
      signal: this.sessionController.signal,
    };
  }

  /** Authenticated main-process extension endpoint; never expose this method through preload. */
  syncPlayRequest(path: SyncPlayEndpoint, body?: unknown, method: "GET" | "POST" = body === undefined ? "GET" : "POST"): Promise<unknown> {
    if (!syncPlayEndpoints.has(path)) {
      throw new AppError("INVALID_SYNCPLAY_ENDPOINT", "The SyncPlay endpoint is invalid.", 400);
    }
    return this.request(path, {}, {
      method,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  /** Authenticated NTP-style time sample used only by the main-process SyncPlay coordinator. */
  async getServerTime(): Promise<ServerTimeResponse> {
    const value = asRecord(await this.request("/GetUtcTime"));
    const requestReceptionTime = String(value.RequestReceptionTime || "");
    const responseTransmissionTime = String(value.ResponseTransmissionTime || "");
    if (!Number.isFinite(Date.parse(requestReceptionTime)) || !Number.isFinite(Date.parse(responseTransmissionTime))) {
      throw new AppError("SYNCPLAY_TIME_INVALID", "The Jellyfin server returned an invalid time sample.", 502);
    }
    return { requestReceptionTime, responseTransmissionTime };
  }

  async logout(): Promise<SafeSession> {
    return this.runSessionMutation(async () => {
      await this.sessionStore.clear();
      this.setSession(null);
      this.pendingConnections.clear();
      return this.safeSession();
    });
  }

  async getLibraries(): Promise<LibrarySummary[]> {
    const session = this.requireSession();
    const result = asRecord(await this.request(`/Users/${encodeURIComponent(session.userId)}/Views`));
    return this.items(result).map(sanitizeLibrary).filter((library) => library.id);
  }

  async getHome(): Promise<HomePayload> {
    const libraries = await this.getLibraries();
    const session = this.requireSession();
    const [resumeResult, nextUpResult, ...latestResults] = await Promise.all([
      this.request(`/Users/${encodeURIComponent(session.userId)}/Items/Resume`, { Limit: "20", MediaTypes: "Video", Fields: ITEM_FIELDS }),
      this.request("/Shows/NextUp", { UserId: session.userId, Limit: "20", Fields: ITEM_FIELDS }),
      ...libraries
        .filter((library) => library.collectionType === "movies" || library.collectionType === "tvshows")
        .map((library) => this.request(`/Users/${encodeURIComponent(session.userId)}/Items`, {
          ParentId: library.id,
          SortBy: "DateCreated",
          SortOrder: "Descending",
          Recursive: "true",
          IncludeItemTypes: library.collectionType === "movies" ? "Movie" : "Series",
          Fields: ITEM_FIELDS,
          Limit: "20",
        })),
    ]);
    const rowLibraries = libraries.filter((library) => library.collectionType === "movies" || library.collectionType === "tvshows");
    return {
      libraries,
      resumeItems: this.items(asRecord(resumeResult)).map(sanitizeMediaItem),
      nextUpItems: this.items(asRecord(nextUpResult)).map(sanitizeMediaItem),
      latestRows: rowLibraries.map((library, index) => ({
        library,
        items: this.items(asRecord(latestResults[index])).map(sanitizeMediaItem),
      })),
    };
  }

  async getNextUpForSeries(seriesId: string): Promise<MediaItem | null> {
    const session = this.requireSession();
    const result = asRecord(await this.request("/Shows/NextUp", {
      UserId: session.userId,
      SeriesId: seriesId,
      Limit: "1",
      Fields: ITEM_FIELDS,
      EnableResumable: "true",
    }));
    const item = this.items(result).map(sanitizeMediaItem)
      .find((entry) => entry.type === "Episode" && entry.playable && entry.seriesId === seriesId);
    return item ?? null;
  }

  async getLibraryItems(type: "Movie" | "Series", limit: number): Promise<MediaItem[]> {
    const session = this.requireSession();
    const result = asRecord(await this.request(`/Users/${encodeURIComponent(session.userId)}/Items`, {
      Recursive: "true",
      IncludeItemTypes: type,
      SortBy: "SortName",
      SortOrder: "Ascending",
      Fields: ITEM_FIELDS,
      Limit: String(limit),
    }));
    return this.items(result).map(sanitizeMediaItem);
  }

  async search(query: string): Promise<MediaItem[]> {
    const session = this.requireSession();
    const result = asRecord(await this.request(`/Users/${encodeURIComponent(session.userId)}/Items`, {
      SearchTerm: query,
      Recursive: "true",
      IncludeItemTypes: "Movie,Series,Episode",
      Fields: ITEM_FIELDS,
      Limit: "60",
    }));
    return this.items(result).map(sanitizeMediaItem);
  }

  async getDetails(itemId: string): Promise<MediaItem> {
    const session = this.requireSession();
    return sanitizeMediaItem(await this.request(`/Users/${encodeURIComponent(session.userId)}/Items/${encodeURIComponent(itemId)}`, { Fields: ITEM_FIELDS }));
  }

  async getSeasons(seriesId: string): Promise<MediaItem[]> {
    const session = this.requireSession();
    const result = asRecord(await this.request(`/Shows/${encodeURIComponent(seriesId)}/Seasons`, { UserId: session.userId, Fields: ITEM_FIELDS }));
    return this.items(result).map(sanitizeMediaItem);
  }

  async getEpisodes(seriesId: string, seasonId: string): Promise<MediaItem[]> {
    const session = this.requireSession();
    const result = asRecord(await this.request(`/Shows/${encodeURIComponent(seriesId)}/Episodes`, {
      UserId: session.userId,
      SeasonId: seasonId,
      Fields: ITEM_FIELDS,
    }));
    return this.items(result).map(sanitizeMediaItem);
  }

  async getMediaSourceCapabilities(itemId: string, signal?: AbortSignal): Promise<MediaSourceCapabilities> {
    return mediaSourceCapabilities(itemId, await this.requestPlaybackInfo(itemId, signal));
  }

  async getPlaybackSourceInfo(itemId: string, signal?: AbortSignal): Promise<PlaybackSourceInfo> {
    const result = await this.requestPlaybackInfo(itemId, signal);
    return {
      capabilities: mediaSourceCapabilities(itemId, result),
      playSessionId: safeOpaqueIdentifier(result.PlaySessionId),
    };
  }

  private async requestPlaybackInfo(itemId: string, signal?: AbortSignal): Promise<JsonRecord> {
    const session = this.requireSession();
    return asRecord(await this.request(`/Items/${encodeURIComponent(itemId)}/PlaybackInfo`, {
      UserId: session.userId,
    }, {
      method: "POST",
      body: JSON.stringify({
        UserId: session.userId,
        DeviceProfile: seeingStoneMpvDeviceProfile(),
        EnableDirectPlay: true,
        EnableDirectStream: true,
        EnableTranscoding: true,
        AllowVideoStreamCopy: true,
        AllowAudioStreamCopy: true,
        MaxAudioChannels: 8,
      }),
      signal,
    }));
  }

  async getTrailerUrl(itemId: string): Promise<string | null> {
    const session = this.requireSession();
    const raw = asRecord(await this.request(`/Users/${encodeURIComponent(session.userId)}/Items/${encodeURIComponent(itemId)}`, { Fields: "RemoteTrailers" }));
    for (const value of Array.isArray(raw.RemoteTrailers) ? raw.RemoteTrailers : []) {
      const candidate = asString(asRecord(value).Url);
      try {
        const url = new URL(candidate);
        if (url.protocol === "https:" || url.protocol === "http:") return url.toString();
      } catch { /* Ignore malformed server metadata. */ }
    }
    return null;
  }

  async openTrailer(itemId: string): Promise<boolean> {
    const url = await this.getTrailerUrl(itemId);
    if (!url) return false;
    await this.openExternal(url);
    return true;
  }

  async fetchArtwork(itemId: string, kind: string, options: Record<string, string>, signal?: AbortSignal): Promise<Response> {
    const index = kind === "Backdrop" ? "/0" : "";
    const headersController = new AbortController();
    const requestSignal = signal
      ? AbortSignal.any([signal, headersController.signal])
      : headersController.signal;
    const timeout = setTimeout(() => headersController.abort(), 15000);
    try {
      return await this.fetchAuthenticated(
        `/Items/${encodeURIComponent(itemId)}/Images/${encodeURIComponent(kind)}${index}`,
        options,
        { signal: requestSignal },
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  async fetchStaticStream(itemId: string, mediaSourceId: string, range?: string, signal?: AbortSignal): Promise<Response> {
    const headers: Record<string, string> = {};
    if (range) headers.Range = range;
    const headersController = new AbortController();
    const requestSignal = signal
      ? AbortSignal.any([signal, headersController.signal])
      : headersController.signal;
    const timeout = setTimeout(() => headersController.abort(), 15000);
    try {
      return await this.fetchAuthenticated(`/Videos/${encodeURIComponent(itemId)}/stream`, {
        static: "true",
        mediaSourceId,
      }, { headers, signal: requestSignal });
    } finally {
      clearTimeout(timeout);
    }
  }

  async fetchDirectStream(
    itemId: string,
    mediaSourceId: string,
    playSessionId: string,
    startTimeTicks: number,
    signal?: AbortSignal,
  ): Promise<Response> {
    return this.fetchAuthenticated(`/Videos/${encodeURIComponent(itemId)}/stream`, {
      static: "false",
      container: "mp4",
      mediaSourceId,
      deviceId: this.identity.deviceId,
      playSessionId,
      startTimeTicks: String(Math.max(0, Math.floor(startTimeTicks))),
      copyTimestamps: "false",
      enableAutoStreamCopy: "true",
      allowVideoStreamCopy: "true",
      allowAudioStreamCopy: "true",
      context: "Streaming",
    }, { signal });
  }

  async fetchExternalSubtitle(
    itemId: string,
    mediaSourceId: string,
    streamIndex: number,
    format: ExternalSubtitleFormat,
    signal?: AbortSignal,
  ): Promise<Response> {
    if (!Number.isSafeInteger(streamIndex) || streamIndex < 0) {
      throw new AppError("INVALID_SUBTITLE_STREAM", "That subtitle stream is unavailable.", 422);
    }
    if (!["srt", "ass", "ssa", "vtt"].includes(format)) {
      throw new AppError("INVALID_SUBTITLE_FORMAT", "That subtitle format is unavailable.", 422);
    }
    return this.fetchAuthenticated(
      `/Videos/${encodeURIComponent(itemId)}/${encodeURIComponent(mediaSourceId)}/Subtitles/${streamIndex}/Stream.${format}`,
      {},
      { signal },
    );
  }

  async fetchTranscodedStream(
    itemId: string,
    mediaSourceId: string,
    playSessionId: string,
    startTimeTicks: number,
    signal?: AbortSignal,
  ): Promise<Response> {
    const headersController = new AbortController();
    const requestSignal = signal
      ? AbortSignal.any([signal, headersController.signal])
      : headersController.signal;
    // Starting ffmpeg can take longer than an ordinary API response, while
    // the caller's signal remains authoritative for the response body.
    const timeout = setTimeout(() => headersController.abort(), 45000);
    try {
      return await this.fetchAuthenticated(`/Videos/${encodeURIComponent(itemId)}/stream.mp4`, {
        static: "false",
        mediaSourceId,
        deviceId: this.identity.deviceId,
        playSessionId,
        startTimeTicks: String(Math.max(0, Math.floor(startTimeTicks))),
        copyTimestamps: "false",
        videoCodec: "h264",
        audioCodec: "aac",
        audioBitRate: "256000",
        audioChannels: "2",
        maxAudioChannels: "2",
        transcodingMaxAudioChannels: "2",
        videoBitRate: "40000000",
        maxVideoBitDepth: "8",
        requireAvc: "true",
        enableAutoStreamCopy: "true",
        allowVideoStreamCopy: "true",
        allowAudioStreamCopy: "true",
        context: "Streaming",
        transcodeReasons: "ContainerNotSupported",
      }, { signal: requestSignal });
    } finally {
      clearTimeout(timeout);
    }
  }

  async reportAuthoritativePlayback(event: {
    kind: "start" | "progress" | "stop";
    itemId: string;
    mediaSourceId: string;
    playMethod: "DirectPlay" | "DirectStream" | "Transcode";
    playSessionId: string;
    positionTicks: number;
    paused: boolean;
    canSeek: boolean;
    audioStreamIndex: number | null;
    subtitleStreamIndex: number | null;
  }): Promise<void> {
    const endpoint = event.kind === "start"
      ? "/Sessions/Playing"
      : event.kind === "progress"
        ? "/Sessions/Playing/Progress"
        : "/Sessions/Playing/Stopped";
    await this.request(endpoint, {}, {
      method: "POST",
      body: JSON.stringify({
        ItemId: event.itemId,
        MediaSourceId: event.mediaSourceId,
        PlaySessionId: event.playSessionId,
        PositionTicks: Math.max(0, Math.floor(event.positionTicks)),
        ...(event.kind === "stop" ? {} : {
          IsPaused: event.paused,
          PlayMethod: event.playMethod,
          CanSeek: event.canSeek,
          AudioStreamIndex: event.audioStreamIndex,
          SubtitleStreamIndex: event.subtitleStreamIndex,
        }),
      }),
    });
  }

  async synchronizeOfflinePlayback(input: {
    itemId: string;
    actionKind: PlaybackActionKind;
    positionTicks: number;
    watched: boolean;
  }): Promise<void> {
    const itemPath = `/UserPlayedItems/${encodeURIComponent(input.itemId)}`;
    const reportStopped = async (): Promise<void> => {
      await this.request("/Sessions/Playing/Stopped", {}, {
        method: "POST",
        body: JSON.stringify({
          ItemId: input.itemId,
          PositionTicks: Math.max(0, Math.floor(input.positionTicks)),
        }),
      });
    };
    if (input.actionKind === "completed") {
      await reportStopped();
      await this.request(itemPath, {}, { method: "POST" });
      return;
    }
    if (input.actionKind === "mark_watched") {
      await this.request(itemPath, {}, { method: "POST" });
      return;
    }
    if (input.actionKind === "start_over"
      || input.actionKind === "replay"
      || input.actionKind === "mark_unwatched") {
      await this.request(itemPath, {}, { method: "DELETE" });
      if (input.actionKind !== "mark_unwatched" && input.positionTicks > 0) await reportStopped();
      return;
    }
    await reportStopped();
  }

  private async request(path: string, params: Record<string, string> = {}, init: RequestInit = {}): Promise<unknown> {
    const expectedSession = this.session;
    const expectedController = this.sessionController;
    const response = await this.fetchAuthenticated(path, params, init);
    if (response.status === 204) return null;
    const result = await response.json();
    if (this.session !== expectedSession || this.sessionController !== expectedController) {
      throw new AppError("SESSION_CHANGED", "The Jellyfin session changed while this request was running.");
    }
    return result;
  }

  private async fetchAuthenticated(path: string, params: Record<string, string> = {}, init: RequestInit = {}): Promise<Response> {
    const session = this.requireSession();
    const sessionController = this.sessionController;
    const sessionRevision = this.sessionRevision;
    const requestSequence = ++this.requestMeasurementSequence;
    const startedAt = this.connectionClock.monotonicNow();
    if (this.connectionMeasurement?.sessionRevision === sessionRevision
      && this.connectionMeasurement.state === "offline") {
      this.recordConnectionMeasurement({
        requestSequence,
        sessionRevision,
        state: "reconnecting",
        requestLatencyMs: null,
        measuredAt: new Date(this.connectionClock.wallNow()).toISOString(),
      });
    }
    const url = new URL(`${session.serverUrl}${path}`);
    for (const [key, value] of Object.entries(params)) if (value) url.searchParams.set(key, value);
    const signals = [sessionController.signal];
    if (init.signal) signals.push(init.signal);
    else signals.push(AbortSignal.timeout(15000));
    let response: Response;
    try {
      response = await fetch(url, {
        ...init,
        headers: {
          "Content-Type": "application/json",
          "X-Emby-Authorization": this.authorizationHeader(session.accessToken),
          "X-MediaBrowser-Token": session.accessToken,
          ...(init.headers || {}),
        },
        signal: AbortSignal.any(signals),
        redirect: "manual",
      });
    } catch {
      if (this.session !== session || this.sessionController !== sessionController) {
        throw new AppError("SESSION_CHANGED", "The Jellyfin session changed while this request was running.");
      }
      this.recordConnectionMeasurement({
        requestSequence,
        sessionRevision,
        state: "offline",
        requestLatencyMs: null,
        measuredAt: new Date(this.connectionClock.wallNow()).toISOString(),
      });
      throw new AppError("SERVER_UNAVAILABLE", "The Jellyfin server is unavailable.");
    }
    if (this.session !== session || this.sessionController !== sessionController) {
      void response.body?.cancel().catch(() => undefined);
      throw new AppError("SESSION_CHANGED", "The Jellyfin session changed while this request was running.");
    }
    const elapsed = this.connectionClock.monotonicNow() - startedAt;
    this.recordConnectionMeasurement({
      requestSequence,
      sessionRevision,
      state: "connected",
      requestLatencyMs: Number.isFinite(elapsed) ? Math.max(0, Math.min(120000, Math.round(elapsed))) : null,
      measuredAt: new Date(this.connectionClock.wallNow()).toISOString(),
    });
    if (!response.ok) {
      if (response.status === 401) throw new AppError("SESSION_EXPIRED", "Your Jellyfin session has expired.", 401);
      throw new AppError("JELLYFIN_REQUEST_FAILED", `Jellyfin request failed (${response.status}).`, response.status);
    }
    return response;
  }

  private authorizationHeader(token?: string): string {
    const fields = [
      `Client="${this.identity.clientName.replaceAll('"', '')}"`,
      `Device="${this.identity.deviceName.replaceAll('"', '')}"`,
      `DeviceId="${this.identity.deviceId}"`,
      `Version="${this.identity.clientVersion}"`,
    ];
    if (token) fields.push(`Token="${token}"`);
    return `MediaBrowser ${fields.join(", ")}`;
  }

  private requireSession(): AuthenticatedState {
    if (!this.session) throw new AppError("NOT_AUTHENTICATED", "Sign in to Jellyfin first.", 401);
    return this.session;
  }

  private setSession(session: AuthenticatedState | null): void {
    this.sessionController.abort();
    this.sessionController = new AbortController();
    this.session = session;
    this.sessionRevision += 1;
    this.connectionMeasurement = null;
    this.emitConnectionDiagnostics();
  }

  private recordConnectionMeasurement(measurement: ConnectionMeasurement): void {
    if (measurement.sessionRevision !== this.sessionRevision) return;
    if (this.connectionMeasurement && measurement.requestSequence < this.connectionMeasurement.requestSequence) return;
    this.connectionMeasurement = measurement;
    this.emitConnectionDiagnostics();
  }

  private emitConnectionDiagnostics(): void {
    const diagnostics = this.getConnectionDiagnostics();
    for (const listener of this.connectionListeners) {
      try { listener(diagnostics); } catch { /* Connection observers cannot affect authenticated requests. */ }
    }
  }

  private async runSessionMutation<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.sessionMutationTail;
    let release!: () => void;
    this.sessionMutationTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private safeSession(): SafeSession {
    if (!this.session) return { authenticated: false, persistence: "none", server: null, user: null };
    return {
      authenticated: true,
      persistence: this.sessionStore.getPersistence(),
      server: {
        address: this.session.serverUrl,
        id: this.session.serverId,
        name: this.session.serverName,
        version: this.session.serverVersion,
      },
      user: { id: this.session.userId, name: this.session.userName },
    };
  }

  private items(value: JsonRecord): unknown[] {
    return Array.isArray(value.Items) ? value.Items : [];
  }
}
