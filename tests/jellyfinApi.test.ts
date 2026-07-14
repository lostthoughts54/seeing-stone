import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DeviceIdentity } from "../src/main/services/deviceIdentity";
import { JellyfinApi, normalizeServerUrl } from "../src/main/services/jellyfinApi";
import { SecureSessionStore, type SessionProtector } from "../src/main/services/secureSession";

const identity: DeviceIdentity = {
  deviceId: "11111111-1111-4111-8111-111111111111",
  clientName: "LocalFirst Jellyfin",
  clientVersion: "0.4.2",
  deviceName: "Windows Desktop",
};

const protector: SessionProtector = {
  async isAvailable() { return false; },
  async encrypt() { throw new Error("disabled"); },
  async decrypt() { throw new Error("disabled"); },
};

const protectedProtector: SessionProtector = {
  async isAvailable() { return true; },
  async encrypt(value) { return Buffer.from(`protected:${Buffer.from(value).toString("base64")}`); },
  async decrypt(value) {
    const encoded = value.toString().replace(/^protected:/, "");
    return { result: Buffer.from(encoded, "base64").toString(), shouldReEncrypt: false };
  },
};

const unsafeItem = {
  Id: "movie-1",
  Name: "Movie",
  Type: "Movie",
  Overview: "Overview",
  PremiereDate: "1999-03-31T00:00:00.0000000Z",
  OfficialRating: "R",
  CommunityRating: 8.7,
  Path: "D:\\Sensitive\\movie.mkv",
  DirectStreamUrl: "https://server/stream?api_key=SECRET_TOKEN_SENTINEL",
  MediaSources: [{
    Id: "source-1",
    Path: "D:\\Sensitive\\movie.mkv",
    Container: "mkv",
    Size: 123,
    SupportsDirectPlay: true,
    SupportsDirectStream: true,
    SupportsTranscoding: true,
    TranscodingUrl: "/transcode?api_key=SECRET_TOKEN_SENTINEL",
    RequiredHttpHeaders: { Authorization: "SECRET_TOKEN_SENTINEL" },
    MediaStreams: [{
      Type: 2,
      Index: 4,
      Codec: "subrip",
      Language: "eng",
      DisplayTitle: "English - SRT - External",
      IsExternal: true,
      IsTextSubtitleStream: true,
      SupportsExternalStream: true,
      IsDefault: false,
      IsForced: false,
      Path: "D:\\Sensitive\\movie.eng.srt",
      DeliveryUrl: "/subtitle?api_key=SECRET_TOKEN_SENTINEL",
    }],
  }],
  ImageTags: { Primary: "tag" },
  UserData: { Played: false, PlaybackPositionTicks: 1234, PlayedPercentage: 5 },
  RemoteTrailers: [{ Url: "https://trailers.example/movie" }],
};

describe("JellyfinApi main-side boundary", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("rejects credentials, queries, fragments, and non-HTTP server addresses", () => {
    expect(() => normalizeServerUrl("ftp://server.example")).toThrow();
    expect(() => normalizeServerUrl("http://user:password@server.example")).toThrow();
    expect(() => normalizeServerUrl("http://server.example?api_key=secret")).toThrow();
    expect(() => normalizeServerUrl("http://server.example/#fragment")).toThrow();
    expect(normalizeServerUrl("https://server.example/jellyfin/")).toBe("https://server.example/jellyfin");
    const api = new JellyfinApi(identity, {} as SecureSessionStore, async () => undefined);
    expect(() => api.syncPlayRequest("/SyncPlay/../Users" as never)).toThrow("The SyncPlay endpoint is invalid.");
  });

  it("owns authentication, uses stable identity, and returns only allowlisted DTOs", async () => {
    const observedHeaders: string[] = [];
    const observedTokenHeaders: Array<string | null> = [];
    const observedRequests: Array<{ url: URL; init: RequestInit | undefined }> = [];
    const openedUrls: string[] = [];
    let streamSignal: AbortSignal | undefined;
    let transcodeSignal: AbortSignal | undefined;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const headers = new Headers(init?.headers);
      const header = headers.get("X-Emby-Authorization");
      if (header) observedHeaders.push(header);
      observedTokenHeaders.push(headers.get("X-MediaBrowser-Token"));
      observedRequests.push({ url, init });
      if (url.pathname === "/System/Info/Public") return Response.json({ Id: "server-1", ServerName: "Server", Version: "10.11.11" });
      if (url.pathname === "/Users/AuthenticateByName") return Response.json({ AccessToken: "SECRET_TOKEN_SENTINEL", User: { Id: "user-1", Name: "Viewer" } });
      if (url.pathname.endsWith("/Views")) return Response.json({ Items: [{ Id: "library-1", Name: "Movies", CollectionType: "movies", Path: "D:\\Sensitive" }] });
      if (url.pathname.endsWith("/Items/Resume")) return Response.json({ Items: [unsafeItem] });
      if (url.pathname === "/Shows/NextUp") return Response.json({
        Items: url.searchParams.get("SeriesId") === "series-1"
          ? [{ ...unsafeItem, Id: "episode-2", Name: "Episode 2", Type: "Episode", SeriesId: "series-1", SeasonId: "season-2" }]
          : [],
      });
      if (url.pathname === "/Users/user-1/Items/movie-1") return Response.json(unsafeItem);
      if (url.pathname === "/Shows/series-1/Seasons") return Response.json({ Items: [{ ...unsafeItem, Id: "season-1", Name: "Season 1", Type: "Season" }] });
      if (url.pathname === "/Shows/series-1/Episodes") return Response.json({ Items: [{ ...unsafeItem, Id: "episode-1", Name: "Episode 1", Type: "Episode", SeriesId: "series-1", SeasonId: "season-1" }] });
      if (url.pathname.endsWith("/Items") && url.searchParams.get("ParentId")) return Response.json({ Items: [unsafeItem] });
      if (url.pathname.endsWith("/Items") && url.searchParams.get("SearchTerm")) return Response.json({ Items: [unsafeItem] });
      if (url.pathname.endsWith("/Items") && url.searchParams.get("IncludeItemTypes")) return Response.json({ Items: [unsafeItem] });
      if (url.pathname.endsWith("/PlaybackInfo")) return Response.json({ MediaSources: unsafeItem.MediaSources });
      if (url.pathname === "/Videos/movie-1/source-1/Subtitles/4/Stream.srt") {
        return new Response("1\n00:00:00,000 --> 00:00:01,000\nSubtitle\n", { headers: { "Content-Type": "application/x-subrip" } });
      }
      if (url.pathname === "/Items/movie-1/Images/Primary") return new Response("image", { headers: { "Content-Type": "image/jpeg" } });
      if (url.pathname.endsWith("/Videos/movie-1/stream")) {
        streamSignal = init?.signal ?? undefined;
        return new Response("video", { headers: { "Content-Type": "video/mp4" } });
      }
      if (url.pathname.endsWith("/Videos/movie-1/stream.mp4")) {
        transcodeSignal = init?.signal ?? undefined;
        return new Response("transcoded-video", { headers: { "Content-Type": "video/mp4" } });
      }
      if (url.pathname.startsWith("/Sessions/Playing")) return new Response(null, { status: 204 });
      if (url.pathname === "/UserPlayedItems/movie-1") return Response.json({ Played: init?.method === "POST" });
      throw new Error(`Unexpected mock endpoint: ${url.pathname}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const directory = await mkdtemp(join(tmpdir(), "lf-api-"));
    const api = new JellyfinApi(identity, new SecureSessionStore(directory, protector), async (url) => { openedUrls.push(url); });
    await expect(api.login("22222222-2222-4222-8222-222222222222", "Viewer", "password", true))
      .rejects.toMatchObject({ code: "INVALID_CONNECTION" });
    const connection = await api.connect("http://127.0.0.1:8096");
    const safeSession = await api.login(connection.connectionId, "Viewer", "password", true);
    const home = await api.getHome();
    const libraries = await api.getLibraries();
    const libraryItems = await api.getLibraryItems("Movie", 100);
    const searchItems = await api.search("movie");
    const details = await api.getDetails("movie-1");
    const seasons = await api.getSeasons("series-1");
    const episodes = await api.getEpisodes("series-1", "season-1");
    const nextUp = await api.getNextUpForSeries("series-1");
    const capabilities = await api.getMediaSourceCapabilities("movie-1");
    const externalSubtitle = await api.fetchExternalSubtitle("movie-1", "source-1", 4, "srt");
    expect(await externalSubtitle.text()).toContain("Subtitle");
    const artwork = await api.fetchArtwork("movie-1", "Primary", { maxWidth: "500" });
    expect(await artwork.text()).toBe("image");
    expect(await api.openTrailer("movie-1")).toBe(true);
    await api.reportAuthoritativePlayback({
      kind: "progress",
      itemId: "movie-1",
      mediaSourceId: "source-1",
      playMethod: "DirectPlay",
      positionTicks: 1234,
      paused: false,
    });
    await api.synchronizeOfflinePlayback({
      itemId: "movie-1",
      actionKind: "completed",
      positionTicks: 100000000,
      watched: true,
    });
    await api.synchronizeOfflinePlayback({
      itemId: "movie-1",
      actionKind: "replay",
      positionTicks: 1000,
      watched: false,
    });
    await api.synchronizeOfflinePlayback({
      itemId: "movie-1",
      actionKind: "mark_watched",
      positionTicks: 0,
      watched: true,
    });
    await api.synchronizeOfflinePlayback({
      itemId: "movie-1",
      actionKind: "mark_unwatched",
      positionTicks: 0,
      watched: false,
    });

    const rendererPayload = JSON.stringify({
      safeSession,
      home,
      libraries,
      libraryItems,
      searchItems,
      details,
      seasons,
      episodes,
      nextUp,
      capabilities,
    });
    expect(rendererPayload).not.toContain("SECRET_TOKEN_SENTINEL");
    expect(rendererPayload).not.toContain("Sensitive");
    expect(rendererPayload).not.toContain("DirectStreamUrl");
    expect(rendererPayload).not.toContain("TranscodingUrl");
    const playbackRequest = observedRequests.find((entry) => entry.url.pathname === "/Sessions/Playing/Progress");
    expect(JSON.parse(String(playbackRequest?.init?.body))).toMatchObject({
      ItemId: "movie-1",
      MediaSourceId: "source-1",
      PositionTicks: 1234,
      PlayMethod: "DirectPlay",
    });
    const watchedRequests = observedRequests.filter((entry) => entry.url.pathname === "/UserPlayedItems/movie-1");
    expect(watchedRequests.map((entry) => entry.init?.method)).toEqual(["POST", "DELETE", "POST", "DELETE"]);
    const offlineStops = observedRequests.filter((entry) => entry.url.pathname === "/Sessions/Playing/Stopped");
    expect(offlineStops.map((entry) => JSON.parse(String(entry.init?.body)).PositionTicks)).toEqual([100000000, 1000]);
    expect(rendererPayload).not.toContain("RequiredHttpHeaders");
    expect(home.resumeItems[0]).toMatchObject({
      id: "movie-1",
      name: "Movie",
      premiereYear: 1999,
      officialRating: "R",
      communityRating: 8.7,
      playable: true,
      hasTrailer: true,
    });
    expect(libraries[0]).toEqual({ id: "library-1", name: "Movies", collectionType: "movies" });
    expect(libraryItems[0].id).toBe("movie-1");
    expect(searchItems[0].id).toBe("movie-1");
    expect(details.id).toBe("movie-1");
    expect(seasons[0]).toMatchObject({ id: "season-1", type: "Season" });
    expect(episodes[0]).toMatchObject({ id: "episode-1", type: "Episode", seriesId: "series-1", seasonId: "season-1" });
    expect(nextUp).toMatchObject({ id: "episode-2", type: "Episode", seriesId: "series-1", seasonId: "season-2" });
    expect(capabilities.sources[0]).toEqual({
      id: "source-1",
      container: "mkv",
      size: 123,
      supportsDirectPlay: true,
      supportsDirectStream: true,
      supportsTranscoding: true,
      externalSubtitles: [{
        streamIndex: 4,
        format: "srt",
        title: "English - SRT - External",
        language: "eng",
        isDefault: false,
        isForced: false,
      }],
    });
    expect(observedHeaders.length).toBeGreaterThan(2);
    expect(new Set(observedHeaders.map((value) => value.match(/DeviceId="([^"]+)"/)?.[1])).size).toBe(1);
    expect(observedHeaders.every((value) => value.includes('Client="LocalFirst Jellyfin"') && value.includes('Version="0.4.2"'))).toBe(true);
    expect(observedTokenHeaders.filter(Boolean).every((value) => value === "SECRET_TOKEN_SENTINEL")).toBe(true);
    expect(observedRequests.every(({ init }) => init?.redirect === "manual")).toBe(true);
    expect(openedUrls).toEqual(["https://trailers.example/movie"]);
    const requestedPaths = observedRequests.map(({ url }) => url.pathname);
    for (const expected of [
      "/Users/user-1/Views",
      "/Users/user-1/Items/Resume",
      "/Shows/NextUp",
      "/Users/user-1/Items/movie-1",
      "/Shows/series-1/Seasons",
      "/Shows/series-1/Episodes",
      "/Items/movie-1/PlaybackInfo",
      "/Videos/movie-1/source-1/Subtitles/4/Stream.srt",
      "/Items/movie-1/Images/Primary",
      "/Sessions/Playing/Progress",
    ]) expect(requestedPaths).toContain(expected);
    const resumeRequest = observedRequests.find(({ url }) => url.pathname.endsWith("/Items/Resume"));
    expect(resumeRequest?.url.searchParams.get("MediaTypes")).toBe("Video");
    const seriesNextUpRequest = observedRequests.find(({ url }) => url.pathname === "/Shows/NextUp" && url.searchParams.has("SeriesId"));
    expect(seriesNextUpRequest?.url.searchParams.get("SeriesId")).toBe("series-1");
    expect(seriesNextUpRequest?.url.searchParams.get("Limit")).toBe("1");

    vi.useFakeTimers();
    await api.fetchStaticStream("movie-1", "source-1");
    const transcoded = await api.fetchTranscodedStream("movie-1", "source-1", "33333333-3333-4333-8333-333333333333");
    expect(await transcoded.text()).toBe("transcoded-video");
    await vi.advanceTimersByTimeAsync(15001);
    expect(streamSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(30000);
    expect(transcodeSignal?.aborted).toBe(false);
    const transcodeRequest = observedRequests.find(({ url }) => url.pathname.endsWith("/stream.mp4"));
    expect(transcodeRequest?.url.searchParams.get("static")).toBe("false");
    expect(transcodeRequest?.url.searchParams.get("mediaSourceId")).toBe("source-1");
    expect(transcodeRequest?.url.searchParams.get("deviceId")).toBe(identity.deviceId);
    expect(transcodeRequest?.url.searchParams.get("playSessionId")).toBe("33333333-3333-4333-8333-333333333333");
    expect(transcodeRequest?.url.searchParams.get("videoCodec")).toBe("h264");
    expect(transcodeRequest?.url.searchParams.get("audioCodec")).toBe("aac");
    expect(transcodeRequest?.url.searchParams.get("transcodingMaxAudioChannels")).toBe("2");
    expect(transcodeRequest?.url.searchParams.get("maxVideoBitDepth")).toBe("8");
    expect(transcodeRequest?.url.searchParams.get("requireAvc")).toBe("true");
    expect(transcodeRequest?.url.searchParams.has("api_key")).toBe(false);
    vi.useRealTimers();
  });

  it("keeps a protected session on transient restore failures and clears it only after a 401", async () => {
    const directory = await mkdtemp(join(tmpdir(), "lf-api-restore-"));
    const stored = {
      serverUrl: "http://127.0.0.1:8096",
      serverId: "server-1",
      serverName: "Server",
      serverVersion: "10.11.11",
      userId: "user-1",
      userName: "Viewer",
      accessToken: "SECRET_TOKEN_SENTINEL",
    };
    await new SecureSessionStore(directory, protectedProtector).save(stored, true);

    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    const offlineApi = new JellyfinApi(identity, new SecureSessionStore(directory, protectedProtector), async () => undefined);
    expect(await offlineApi.restore()).toMatchObject({ authenticated: true, persistence: "protected" });
    await expect(stat(join(directory, "session.safe"))).resolves.toBeDefined();

    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 401 })));
    const expiredApi = new JellyfinApi(identity, new SecureSessionStore(directory, protectedProtector), async () => undefined);
    expect(await expiredApi.restore()).toMatchObject({ authenticated: false, persistence: "none" });
    await expect(stat(join(directory, "session.safe"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("revokes authenticated requests that finish after logout", async () => {
    let releaseSearch: ((response: Response) => void) | undefined;
    let searchSignal: AbortSignal | undefined;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === "/System/Info/Public") return Response.json({ Id: "server-1", ServerName: "Server", Version: "10.11.11" });
      if (url.pathname === "/Users/AuthenticateByName") return Response.json({ AccessToken: "SECRET_TOKEN_SENTINEL", User: { Id: "user-1", Name: "Viewer" } });
      if (url.pathname.endsWith("/Items") && url.searchParams.get("SearchTerm") === "slow") {
        searchSignal = init?.signal ?? undefined;
        return new Promise<Response>((resolve) => { releaseSearch = resolve; });
      }
      throw new Error(`Unexpected mock endpoint: ${url.pathname}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const directory = await mkdtemp(join(tmpdir(), "lf-api-revoke-"));
    const api = new JellyfinApi(identity, new SecureSessionStore(directory, protector), async () => undefined);
    const connection = await api.connect("http://127.0.0.1:8096");
    await api.login(connection.connectionId, "Viewer", "password", false);
    const pendingSearch = api.search("slow");
    await vi.waitFor(() => expect(releaseSearch).toBeTypeOf("function"));
    await api.logout();
    expect(searchSignal?.aborted).toBe(true);
    releaseSearch?.(Response.json({ Items: [unsafeItem] }));
    await expect(pendingSearch).rejects.toMatchObject({ code: "SESSION_CHANGED" });
  });

  it("serializes logout behind an in-flight login so logout remains authoritative", async () => {
    let releaseLogin: ((response: Response) => void) | undefined;
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === "/System/Info/Public") return Response.json({ Id: "server-1", ServerName: "Server", Version: "10.11.11" });
      if (url.pathname === "/Users/AuthenticateByName") {
        return new Promise<Response>((resolve) => { releaseLogin = resolve; });
      }
      throw new Error(`Unexpected mock endpoint: ${url.pathname}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const directory = await mkdtemp(join(tmpdir(), "lf-api-login-race-"));
    const api = new JellyfinApi(identity, new SecureSessionStore(directory, protectedProtector), async () => undefined);
    const connection = await api.connect("http://127.0.0.1:8096");
    const pendingLogin = api.login(connection.connectionId, "Viewer", "password", true);
    await vi.waitFor(() => expect(releaseLogin).toBeTypeOf("function"));
    const pendingLogout = api.logout();
    releaseLogin?.(Response.json({ AccessToken: "SECRET_TOKEN_SENTINEL", User: { Id: "user-1", Name: "Viewer" } }));
    await expect(pendingLogin).resolves.toMatchObject({ authenticated: true, persistence: "protected" });
    await expect(pendingLogout).resolves.toMatchObject({ authenticated: false, persistence: "none" });
    expect(api.getSafeSession().authenticated).toBe(false);
    await expect(stat(join(directory, "session.safe"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("serializes logout behind an in-flight restore so restore cannot undo it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "lf-api-restore-race-"));
    const stored = {
      serverUrl: "http://127.0.0.1:8096",
      serverId: "server-1",
      serverName: "Server",
      serverVersion: "10.11.11",
      userId: "user-1",
      userName: "Viewer",
      accessToken: "SECRET_TOKEN_SENTINEL",
    };
    await new SecureSessionStore(directory, protectedProtector).save(stored, true);
    let releaseValidation: ((response: Response) => void) | undefined;
    vi.stubGlobal("fetch", vi.fn(async () => new Promise<Response>((resolve) => { releaseValidation = resolve; })));

    const api = new JellyfinApi(identity, new SecureSessionStore(directory, protectedProtector), async () => undefined);
    const pendingRestore = api.restore();
    await vi.waitFor(() => expect(releaseValidation).toBeTypeOf("function"));
    const pendingLogout = api.logout();
    releaseValidation?.(Response.json({ Id: "user-1", Name: "Viewer" }));
    await expect(pendingRestore).resolves.toMatchObject({ authenticated: true, persistence: "protected" });
    await expect(pendingLogout).resolves.toMatchObject({ authenticated: false, persistence: "none" });
    expect(api.getSafeSession().authenticated).toBe(false);
    await expect(stat(join(directory, "session.safe"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
