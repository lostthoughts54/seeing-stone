import type {
  HomePayload,
  LibrarySummary,
  MediaItem,
  MediaSourceCapabilities,
  PublicServerInfo,
  SafeSession,
} from "../../shared/contracts";
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

export function normalizeServerUrl(value: string): string {
  const parsed = new URL(value.trim());
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new AppError("INVALID_SERVER", "Use an HTTP or HTTPS Jellyfin address.");
  if (parsed.username || parsed.password) throw new AppError("INVALID_SERVER", "Server addresses cannot contain credentials.");
  parsed.hash = "";
  parsed.search = "";
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

export class JellyfinApi {
  private session: AuthenticatedState | null = null;

  constructor(
    private readonly identity: DeviceIdentity,
    private readonly sessionStore: SecureSessionStore,
    private readonly openExternal: (url: string) => Promise<void>,
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

  async login(serverUrl: string, username: string, password: string, remember: boolean): Promise<SafeSession> {
    const server = await this.getPublicServerInfo(serverUrl);
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
    this.session = {
      serverUrl: server.address,
      serverId: server.id,
      serverName: server.name,
      serverVersion: server.version,
      userId,
      userName: asString(user.Name, username),
      accessToken,
    };
    await this.sessionStore.save(this.session, remember);
    return this.safeSession();
  }

  async restore(): Promise<SafeSession> {
    const stored = await this.sessionStore.restore();
    if (!stored) {
      this.session = null;
      return this.safeSession();
    }
    this.session = stored;
    try {
      await this.request(`/Users/${encodeURIComponent(stored.userId)}`);
      return this.safeSession();
    } catch {
      this.session = null;
      await this.sessionStore.clear();
      return this.safeSession();
    }
  }

  getSafeSession(): SafeSession {
    return this.safeSession();
  }

  async logout(): Promise<SafeSession> {
    this.session = null;
    await this.sessionStore.clear();
    return this.safeSession();
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
      this.request(`/Users/${encodeURIComponent(session.userId)}/Items/Resume`, { Limit: "20", Fields: ITEM_FIELDS }),
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

  async getMediaSourceCapabilities(itemId: string): Promise<MediaSourceCapabilities> {
    const session = this.requireSession();
    const result = asRecord(await this.request(`/Items/${encodeURIComponent(itemId)}/PlaybackInfo`, {
      UserId: session.userId,
    }, { method: "POST", body: JSON.stringify({ UserId: session.userId }) }));
    const sources = Array.isArray(result.MediaSources) ? result.MediaSources : [];
    return {
      itemId,
      sources: sources.map((entry) => {
        const source = asRecord(entry);
        return {
          id: asString(source.Id),
          container: nullableString(source.Container),
          size: nullableNumber(source.Size),
          supportsDirectPlay: source.SupportsDirectPlay === true,
          supportsDirectStream: source.SupportsDirectStream === true,
          supportsTranscoding: source.SupportsTranscoding === true,
        };
      }).filter((source) => source.id),
    };
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

  async fetchArtwork(itemId: string, kind: string, options: Record<string, string>): Promise<Response> {
    const index = kind === "Backdrop" ? "/0" : "";
    return this.fetchAuthenticated(`/Items/${encodeURIComponent(itemId)}/Images/${encodeURIComponent(kind)}${index}`, options);
  }

  async fetchStaticStream(itemId: string, mediaSourceId: string, range?: string): Promise<Response> {
    const headers: Record<string, string> = {};
    if (range) headers.Range = range;
    return this.fetchAuthenticated(`/Videos/${encodeURIComponent(itemId)}/stream`, {
      static: "true",
      mediaSourceId,
    }, { headers });
  }

  async reportAuthoritativePlayback(event: {
    kind: "start" | "progress" | "stop";
    itemId: string;
    mediaSourceId: string;
    positionTicks: number;
    paused: boolean;
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
        PositionTicks: Math.max(0, Math.floor(event.positionTicks)),
        IsPaused: event.paused,
        PlayMethod: "DirectStream",
      }),
    });
  }

  private async request(path: string, params: Record<string, string> = {}, init: RequestInit = {}): Promise<unknown> {
    const response = await this.fetchAuthenticated(path, params, init);
    if (response.status === 204) return null;
    return response.json();
  }

  private async fetchAuthenticated(path: string, params: Record<string, string> = {}, init: RequestInit = {}): Promise<Response> {
    const session = this.requireSession();
    const url = new URL(`${session.serverUrl}${path}`);
    for (const [key, value] of Object.entries(params)) if (value) url.searchParams.set(key, value);
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
        signal: init.signal ?? AbortSignal.timeout(15000),
        redirect: "manual",
      });
    } catch {
      throw new AppError("SERVER_UNAVAILABLE", "The Jellyfin server is unavailable.");
    }
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
