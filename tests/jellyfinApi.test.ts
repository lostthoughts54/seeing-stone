import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DeviceIdentity } from "../src/main/services/deviceIdentity";
import { JellyfinApi, normalizeServerUrl, sanitizeMediaItem, sanitizeMediaSegments } from "../src/main/services/jellyfinApi";
import { SecureSessionStore, type SessionProtector } from "../src/main/services/secureSession";
import { browseSchema } from "../src/shared/schemas";

const identity: DeviceIdentity = {
  deviceId: "11111111-1111-4111-8111-111111111111",
  clientName: "Seeing Stone",
  clientVersion: "0.4.3",
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
      TranscodingReasons: [],
      TranscodingUrl: "/transcode?api_key=SECRET_TOKEN_SENTINEL&TranscodeReasons=ContainerNotSupported",
    RequiredHttpHeaders: { Authorization: "SECRET_TOKEN_SENTINEL" },
    MediaStreams: [{
      Type: "Video",
      Codec: "https://server.invalid/SECRET_TOKEN_SENTINEL",
      Width: 1920,
      Height: 1080,
      BitRate: 5_000_000,
      VideoRange: "D:\\Sensitive\\range.txt",
    }, {
      Type: "Audio",
      Codec: "aac",
      ChannelLayout: "https://server.invalid/token",
      Channels: 6,
    }, {
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
  it("sanitizes bounded recognized media segments only", () => {
    expect(sanitizeMediaSegments({ Items: [
      { Type: "Intro", StartTicks: 0, EndTicks: 100 },
      { Type: "Intro", StartTicks: 0, EndTicks: 100 },
      { Type: "Commercial", StartTicks: 100, EndTicks: 200 },
      { Type: "Recap", StartTicks: -1, EndTicks: 5 },
      { Type: "Outro", StartTicks: 200, EndTicks: 200 },
    ] })).toEqual([{ type: "Intro", startTicks: 0, endTicks: 100 }]);
    expect(sanitizeMediaSegments([{ Type: "Outro", StartTicks: 100, EndTicks: 200 }]))
      .toEqual([{ type: "Outro", startTicks: 100, endTicks: 200 }]);
    expect(sanitizeMediaSegments({ Items: Array.from({ length: 257 }, () => ({ Type: "Intro", StartTicks: 0, EndTicks: 1 })) })).toEqual([]);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("sanitizes cast metadata and ignores malformed people", () => {
    const item = sanitizeMediaItem({ ...unsafeItem, People: [
      { Id: "person-1", Name: "Actor", Role: "Lead", Type: "Actor", PrimaryImageTag: "image-1", Path: "D:\\secret" },
      { Id: "../../bad", Name: "Bad" }, { Id: "person-2", Name: 42 },
    ] });
    expect(item.people).toEqual([{ id: "person-1", name: "Actor", role: "Lead", type: "Actor", primaryImageTag: "image-1" }]);
    expect(JSON.stringify(item)).not.toContain("secret");
  });

  it("validates bounded browse input before it reaches Jellyfin", () => {
    expect(browseSchema.parse({ type: "Movie", sort: "rating-descending", startIndex: 0, limit: 50 }).sort).toBe("rating-descending");
    expect(() => browseSchema.parse({ type: "Movie", sort: "bad", startIndex: -1, limit: 5000 })).toThrow();
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
      if (url.pathname === "/Items/Latest") return Response.json([
        { ...unsafeItem, ProviderIds: { Imdb: "tt0133093" } },
        { ...unsafeItem, Id: "movie-2", ProviderIds: { Imdb: "tt0133093" }, MediaSources: [{ ...unsafeItem.MediaSources[0], Id: "source-2" }] },
      ]);
      if (url.pathname === "/Users/user-1/Items/movie-1") return Response.json(unsafeItem);
      if (url.pathname === "/Shows/series-1/Seasons") return Response.json({ Items: [{ ...unsafeItem, Id: "season-1", Name: "Season 1", Type: "Season" }] });
      if (url.pathname === "/Shows/series-1/Episodes") return Response.json({ Items: [{ ...unsafeItem, Id: "episode-1", Name: "Episode 1", Type: "Episode", SeriesId: "series-1", SeasonId: "season-1" }] });
      if (url.pathname.endsWith("/Items") && url.searchParams.get("ParentId") === "series-1" && url.searchParams.get("Recursive") === "true") {
        return Response.json({
          Items: [{ ...unsafeItem, Id: "episode-1", Name: "Episode 1", Type: "Episode", SeriesId: "series-1", SeasonId: "season-1", ParentIndexNumber: 1, IndexNumber: 1 }],
          TotalRecordCount: 1,
        });
      }
      if (url.pathname.endsWith("/Items") && url.searchParams.get("ParentId")) return Response.json({ Items: [unsafeItem], TotalRecordCount: 61 });
      if (url.pathname.endsWith("/Items") && url.searchParams.get("SearchTerm")) return Response.json({ Items: [
        { ...unsafeItem, ProviderIds: { Imdb: "tt0133093" } },
        { ...unsafeItem, Id: "movie-2", ProviderIds: { Imdb: "tt0133093" }, MediaSources: [{ ...unsafeItem.MediaSources[0], Id: "source-2" }] },
      ] });
      if (url.pathname.endsWith("/Items") && url.searchParams.get("IncludeItemTypes")) return Response.json({ Items: [unsafeItem] });
      if (url.pathname.endsWith("/PlaybackInfo")) return Response.json({
        MediaSources: unsafeItem.MediaSources,
        PlaySessionId: "play-session-1",
      });
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
      if (url.pathname === "/transcode") return new Response("live-video", { headers: { "Content-Type": "video/mp2t" } });
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
    const libraryItems = await api.getLibraryItems("library-1", "Movie", 100);
    const libraryPage = await api.getLibraryItemsPage("library-1", "Movie", 30, 30, "recently-added");
    const browsePage = await api.browse({
      libraryId: "library-1", type: "Movie", genres: ["Action", "Comedy"],
      sort: "title-ascending", startIndex: 1_140, limit: 60, enableTotalRecordCount: true,
    });
    const browsePageWithoutCount = await api.browse({
      libraryId: "library-1", type: "Movie", sort: "title-ascending",
      startIndex: 1_200, limit: 60, enableTotalRecordCount: false,
    });
    const searchItems = await api.search("movie");
    const details = await api.getDetails("movie-1");
    const seasons = await api.getSeasons("series-1");
    const episodes = await api.getEpisodes("series-1", "season-1");
    const smartEpisodesPage = await api.getSeriesEpisodesPage("series-1", 0, 200);
    const nextUp = await api.getNextUpForSeries("series-1");
    const sourceInfo = await api.getPlaybackSourceInfo("movie-1");
    const capabilities = sourceInfo.capabilities;
    expect(sourceInfo.playSessionId).toBe("play-session-1");
    const negotiatedLive = await api.fetchNegotiatedLiveStream(sourceInfo.negotiatedSources[0].transcodingUrl!);
    expect(await negotiatedLive.text()).toBe("live-video");
    const negotiatedRequest = observedRequests.find((entry) => entry.url.pathname === "/transcode");
    expect(negotiatedRequest?.url.searchParams.get("api_key")).toBeNull();
    expect(negotiatedRequest?.url.searchParams.get("TranscodeReasons")).toBe("ContainerNotSupported");
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
      playSessionId: "play-session-1",
      positionTicks: 1234,
      paused: false,
      canSeek: true,
      audioStreamIndex: 2,
      subtitleStreamIndex: 4,
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
      smartEpisodesPage,
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
      PlaySessionId: "play-session-1",
      CanSeek: true,
      AudioStreamIndex: 2,
      SubtitleStreamIndex: 4,
    });
    const playbackInfoRequest = observedRequests.find((entry) => entry.url.pathname.endsWith("/PlaybackInfo"));
    const playbackInfoBody = JSON.parse(String(playbackInfoRequest?.init?.body));
    expect(playbackInfoBody).toMatchObject({
      EnableDirectPlay: true,
      EnableDirectStream: true,
      EnableTranscoding: true,
      MaxAudioChannels: 8,
      DeviceProfile: {
        Name: "Seeing Stone mpv",
        MaxStreamingBitrate: 200_000_000,
        MaxStaticBitrate: 200_000_000,
      },
    });
    const watchedRequests = observedRequests.filter((entry) => entry.url.pathname === "/UserPlayedItems/movie-1");
    expect(watchedRequests.map((entry) => entry.init?.method)).toEqual(["POST", "DELETE", "POST", "DELETE"]);
    const offlineStops = observedRequests.filter((entry) => entry.url.pathname === "/Sessions/Playing/Stopped");
    expect(offlineStops.map((entry) => JSON.parse(String(entry.init?.body)).PositionTicks)).toEqual([100000000, 1000]);
    expect(rendererPayload).not.toContain("RequiredHttpHeaders");
    expect(smartEpisodesPage).toMatchObject({ startIndex: 0, totalRecordCount: 1 });
    expect(smartEpisodesPage.items[0]).toMatchObject({ id: "episode-1", type: "Episode", parentIndexNumber: 1, indexNumber: 1 });
    const smartEpisodesRequest = observedRequests.find((entry) => entry.url.searchParams.get("Recursive") === "true"
      && entry.url.searchParams.get("ParentId") === "series-1");
    expect(smartEpisodesRequest?.url.searchParams.get("Limit")).toBe("200");
    expect(smartEpisodesRequest?.url.searchParams.get("StartIndex")).toBe("0");
    expect(smartEpisodesRequest?.url.searchParams.get("EnableTotalRecordCount")).toBe("true");
    await expect(api.getSeriesEpisodesPage("series-1", 0, 199)).rejects.toMatchObject({ code: "INVALID_EPISODE_PAGE" });
    expect(home.resumeItems[0]).toMatchObject({
      id: "movie-1",
      name: "Movie",
      premiereYear: 1999,
      officialRating: "R",
      communityRating: 8.7,
      playable: true,
      hasTrailer: true,
    });
    expect(home.latestRows[0].items).toHaveLength(1);
    expect(home.latestRows[0].items[0].mediaVersions).toHaveLength(2);
    expect(libraries[0]).toEqual({ id: "library-1", name: "Movies", collectionType: "movies" });
    expect(libraryItems[0].id).toBe("movie-1");
    expect(libraryPage).toMatchObject({ totalRecordCount: 61, items: [{ id: "movie-1" }] });
    expect(browsePage).toMatchObject({ totalRecordCount: 61, items: [{ id: "movie-1" }] });
    expect(browsePageWithoutCount.totalRecordCount).toBe(-1);
    const pagedLibraryRequest = observedRequests.find(({ url }) => url.pathname === "/Users/user-1/Items"
      && url.searchParams.get("StartIndex") === "30");
    expect(pagedLibraryRequest?.url.searchParams.get("SortBy")).toBe("DateCreated,SortName");
    expect(pagedLibraryRequest?.url.searchParams.get("SortOrder")).toBe("Descending");
    expect(pagedLibraryRequest?.url.searchParams.get("EnableTotalRecordCount")).toBe("true");
    const browseRequest = observedRequests.find(({ url }) => url.pathname === "/Users/user-1/Items"
      && url.searchParams.get("StartIndex") === "1140");
    expect(browseRequest?.url.searchParams.get("Limit")).toBe("60");
    expect(browseRequest?.url.searchParams.get("Genres")).toBe("Action|Comedy");
    expect(browseRequest?.url.searchParams.get("EnableTotalRecordCount")).toBe("true");
    expect(browseRequest?.url.searchParams.get("Fields")).toBe("Genres,PrimaryImageAspectRatio,DateCreated");
    expect(browseRequest?.url.searchParams.get("Fields")).not.toContain("People");
    expect(browseRequest?.url.searchParams.get("Fields")).not.toContain("MediaStreams");
    const browseRequestWithoutCount = observedRequests.find(({ url }) => url.pathname === "/Users/user-1/Items"
      && url.searchParams.get("StartIndex") === "1200");
    expect(browseRequestWithoutCount?.url.searchParams.get("EnableTotalRecordCount")).toBe("false");
    expect(searchItems[0].id).toBe("movie-1");
    expect(searchItems).toHaveLength(1);
    expect(searchItems[0].mediaVersions).toHaveLength(2);
    expect(details.id).toBe("movie-1");
    expect(seasons[0]).toMatchObject({ id: "season-1", type: "Season" });
    expect(episodes[0]).toMatchObject({ id: "episode-1", type: "Episode", seriesId: "series-1", seasonId: "season-1" });
    expect(nextUp).toMatchObject({ id: "episode-2", type: "Episode", seriesId: "series-1", seasonId: "season-2" });
    expect(capabilities.sources[0]).toEqual({
      id: "source-1",
      name: null,
      container: "mkv",
      size: 123,
      supportsDirectPlay: true,
      supportsDirectStream: true,
      supportsTranscoding: true,
      videoCodec: null,
      audioCodec: "aac",
      audioChannels: "6",
      width: 1920,
      height: 1080,
      bitrate: 5_000_000,
      videoRange: null,
      transcodeReason: "ContainerNotSupported",
      externalSubtitles: [{
        streamIndex: 4,
        format: "srt",
        title: "English - SRT - External",
        language: "eng",
        isDefault: false,
        isForced: false,
      }],
    });
    expect(JSON.stringify(capabilities)).not.toMatch(/SECRET_TOKEN_SENTINEL|Sensitive|https?:\/\//i);
    expect(observedHeaders.length).toBeGreaterThan(2);
    expect(new Set(observedHeaders.map((value) => value.match(/DeviceId="([^"]+)"/)?.[1])).size).toBe(1);
    expect(observedHeaders.every((value) => value.includes('Client="Seeing Stone"') && value.includes('Version="0.4.3"'))).toBe(true);
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
    expect(resumeRequest?.url.searchParams.get("Fields")).not.toContain("MediaSources");
    const latestHomeRequest = observedRequests.find(({ url }) => url.pathname === "/Items/Latest");
    expect(latestHomeRequest?.url.searchParams.get("Limit")).toBe("20");
    expect(latestHomeRequest?.url.searchParams.get("Fields")).not.toContain("MediaStreams");
    expect(latestHomeRequest?.url.searchParams.get("Fields")).not.toContain("People");
    const seriesNextUpRequest = observedRequests.find(({ url }) => url.pathname === "/Shows/NextUp" && url.searchParams.has("SeriesId"));
    expect(seriesNextUpRequest?.url.searchParams.get("SeriesId")).toBe("series-1");
    expect(seriesNextUpRequest?.url.searchParams.get("Limit")).toBe("1");

    vi.useFakeTimers();
    await api.fetchStaticStream("movie-1", "source-1");
    await api.fetchDirectStream("movie-1", "source-1", "22222222-2222-4222-8222-222222222222", 120000000);
    const transcoded = await api.fetchTranscodedStream("movie-1", "source-1", "33333333-3333-4333-8333-333333333333", 340000000);
    expect(await transcoded.text()).toBe("transcoded-video");
    await vi.advanceTimersByTimeAsync(15001);
    expect(streamSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(30000);
    expect(transcodeSignal?.aborted).toBe(false);
    const transcodeRequest = observedRequests.find(({ url }) => url.pathname.endsWith("/stream.mp4"));
    const directStreamRequest = observedRequests.find(({ url }) => url.searchParams.get("playSessionId") === "22222222-2222-4222-8222-222222222222");
    expect(directStreamRequest?.url.pathname).toBe("/Videos/movie-1/stream");
    expect(directStreamRequest?.url.searchParams.get("enableAutoStreamCopy")).toBe("true");
    expect(directStreamRequest?.url.searchParams.get("container")).toBe("mp4");
    expect(directStreamRequest?.url.searchParams.get("startTimeTicks")).toBe("120000000");
    expect(directStreamRequest?.url.searchParams.get("copyTimestamps")).toBe("false");
    expect(directStreamRequest?.url.searchParams.get("deviceId")).toBe(identity.deviceId);
    expect(transcodeRequest?.url.searchParams.get("static")).toBe("false");
    expect(transcodeRequest?.url.searchParams.get("mediaSourceId")).toBe("source-1");
    expect(transcodeRequest?.url.searchParams.get("deviceId")).toBe(identity.deviceId);
    expect(transcodeRequest?.url.searchParams.get("playSessionId")).toBe("33333333-3333-4333-8333-333333333333");
    expect(transcodeRequest?.url.searchParams.get("startTimeTicks")).toBe("340000000");
    expect(transcodeRequest?.url.searchParams.get("copyTimestamps")).toBe("false");
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

  it("preserves Jellyfin's private Live TV service when creating a sanitized timer", async () => {
    let timerBody: Record<string, unknown> | null = null;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === "/System/Info/Public") {
        return Response.json({ Id: "server-1", ServerName: "Server", Version: "10.11.11" });
      }
      if (url.pathname === "/Users/AuthenticateByName") {
        return Response.json({ AccessToken: "token", User: { Id: "user-1", Name: "Viewer" } });
      }
      if (url.pathname === "/LiveTv/Timers/Defaults") {
        return Response.json({
          ProgramId: "server-program",
          ChannelId: "channel-101",
          Name: "Test Program",
          StartDate: "2026-07-29T15:00:00.000Z",
          EndDate: "2026-07-29T15:30:00.000Z",
          ServiceName: "Emby",
          OpenToken: "PRIVATE_OPEN_TOKEN",
          ProviderUrl: "https://provider.example/private",
        });
      }
      if (url.pathname === "/LiveTv/Timers" && init?.method === "POST") {
        timerBody = JSON.parse(String(init.body));
        return new Response(null, { status: 204 });
      }
      throw new Error(`Unexpected mock endpoint: ${url.pathname}`);
    }));

    const directory = await mkdtemp(join(tmpdir(), "seeing-stone-live-tv-timer-"));
    const api = new JellyfinApi(identity, new SecureSessionStore(directory, protector), async () => undefined);
    const connection = await api.connect("http://127.0.0.1:8096");
    await api.login(connection.connectionId, "Viewer", "password", false);
    await api.createLiveTvRecording("program-1", false, { prePaddingSeconds: 60 });

    expect(timerBody).toMatchObject({
      ProgramId: "program-1",
      ChannelId: "channel-101",
      ServiceName: "Emby",
      PrePaddingSeconds: 60,
    });
    expect(timerBody).not.toHaveProperty("OpenToken");
    expect(timerBody).not.toHaveProperty("ProviderUrl");
  });

  it("uses Jellyfin's completed-recording timestamp when StartDate is absent", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === "/System/Info/Public") {
        return Response.json({ Id: "server-1", ServerName: "Server", Version: "10.11.11" });
      }
      if (url.pathname === "/Users/AuthenticateByName") {
        return Response.json({ AccessToken: "token", User: { Id: "user-1", Name: "Viewer" } });
      }
      if (url.pathname === "/LiveTv/Recordings") {
        expect(url.searchParams.get("Fields")).toContain("DateCreated");
        return Response.json({
          Items: [{
            Id: "recording-1",
            Name: "Test Program 74",
            Type: "Video",
            ChannelName: "Seeing Stone Color Bars",
            DateCreated: "2026-07-29T18:50:00.2306631-07:00",
            PremiereDate: "2026-07-29T00:00:00.000Z",
            RunTimeTicks: 3_000_000_000,
            Path: "D:\\Private\\recording.ts",
          }],
        });
      }
      throw new Error(`Unexpected mock endpoint: ${url.pathname}`);
    }));

    const directory = await mkdtemp(join(tmpdir(), "seeing-stone-live-tv-recordings-"));
    const api = new JellyfinApi(identity, new SecureSessionStore(directory, protector), async () => undefined);
    const connection = await api.connect("http://127.0.0.1:8096");
    await api.login(connection.connectionId, "Viewer", "password", false);

    await expect(api.getLiveTvRecordings()).resolves.toEqual([expect.objectContaining({
      id: "recording-1",
      name: "Test Program 74",
      channelName: "Seeing Stone Color Bars",
      startUtc: "2026-07-30T01:50:00.230Z",
      status: "Completed",
    })]);
  });

  it("searches sanitized Live TV guide data with one bounded cache fill and no Search/Hints dependency", async () => {
    const requestedPaths: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      requestedPaths.push(url.pathname);
      if (url.pathname === "/System/Info/Public") return Response.json({ Id: "server-1", ServerName: "Server", Version: "10.11.11" });
      if (url.pathname === "/Users/AuthenticateByName") return Response.json({ AccessToken: "token", User: { Id: "user-1", Name: "Viewer" } });
      if (url.pathname === "/LiveTv/Channels") return Response.json({ Items: [{ Id: "channel-1", Name: "Island TV", Number: "5930", ImageTags: { Primary: "tag" } }] });
      if (url.pathname === "/LiveTv/Programs") return Response.json({ TotalRecordCount: 2, Items: [
        { Id: "program-now", ChannelId: "channel-1", Name: "Love Island", EpisodeTitle: "Episode 1", StartDate: "2026-08-09T18:00:00.000Z", EndDate: "2026-08-09T18:30:00.000Z", IsSeries: true },
        { Id: "program-later", ChannelId: "channel-1", Name: "Love Island", StartDate: "2026-08-10T18:00:00.000Z", EndDate: "2026-08-10T18:30:00.000Z", IsSeries: true },
      ] });
      throw new Error(`Unexpected mock endpoint: ${url.pathname}`);
    }));
    const directory = await mkdtemp(join(tmpdir(), "seeing-stone-live-tv-search-"));
    const api = new JellyfinApi(identity, new SecureSessionStore(directory, protector), async () => undefined);
    const connection = await api.connect("http://127.0.0.1:8096");
    await api.login(connection.connectionId, "Viewer", "password", false);
    const [first, second] = await Promise.all([api.getLiveTvProgramSearch("love island"), api.getLiveTvProgramSearch("episode 1")]);
    expect(first.programs.map((entry) => entry.program.id)).toEqual(["program-now", "program-later"]);
    expect(second.programs.map((entry) => entry.program.id)).toEqual(["program-now"]);
    expect(requestedPaths.filter((path) => path === "/LiveTv/Programs")).toHaveLength(1);
    expect(requestedPaths).not.toContain("/Search/Hints");
    await api.logout();
    await expect(api.getLiveTvProgramSearch("love island")).rejects.toMatchObject({ code: "NOT_AUTHENTICATED" });
  });

  it("paginates, deduplicates, and numerically sorts every Jellyfin Live TV channel", async () => {
    const channelStarts: number[] = [];
    const source = Array.from({ length: 521 }, (_, index) => ({
      Id: `channel-${index + 1}`,
      Name: `Channel ${index + 1}`,
      Number: String(index + 1),
    }));
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === "/System/Info/Public") return Response.json({ Id: "server-1", ServerName: "Server", Version: "10.11.11" });
      if (url.pathname === "/Users/AuthenticateByName") return Response.json({ AccessToken: "token", User: { Id: "user-1", Name: "Viewer" } });
      if (url.pathname === "/LiveTv/Info") return Response.json({ IsEnabled: true });
      if (url.pathname === "/LiveTv/Channels") {
        if (url.searchParams.get("Limit") === "1") return Response.json({ Items: source.slice(0, 1) });
        const start = Number(url.searchParams.get("StartIndex"));
        channelStarts.push(start);
        const items = start === 0
          ? source.slice(0, 250)
          : start === 250
            ? [source[249], ...source.slice(250, 499)]
            : source.slice(499);
        return Response.json({ TotalRecordCount: 522, Items: items });
      }
      if (url.pathname === "/LiveTv/Programs") return Response.json({ TotalRecordCount: 0, Items: [] });
      throw new Error(`Unexpected mock endpoint: ${url.pathname}`);
    }));
    const directory = await mkdtemp(join(tmpdir(), "seeing-stone-live-tv-pagination-"));
    const api = new JellyfinApi(identity, new SecureSessionStore(directory, protector), async () => undefined);
    const connection = await api.connect("http://127.0.0.1:8096");
    await api.login(connection.connectionId, "Viewer", "password", false);
    const guide = await api.getLiveTvGuide("2026-08-10T00:00:00.000Z", "2026-08-11T00:00:00.000Z");
    expect(channelStarts).toEqual([0, 250, 500]);
    expect(guide.channels).toHaveLength(521);
    expect(new Set(guide.channels.map((channel) => channel.id)).size).toBe(521);
    expect(guide.channels.slice(0, 3).map((channel) => channel.number)).toEqual(["1", "2", "3"]);
    expect(guide.channels.at(-1)?.number).toBe("521");
  });

  it("passes a guide window across midnight through to Jellyfin without a date clamp", async () => {
    let programQuery: URLSearchParams | null = null;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === "/System/Info/Public") return Response.json({ Id: "server-1", ServerName: "Server", Version: "10.11.11" });
      if (url.pathname === "/Users/AuthenticateByName") return Response.json({ AccessToken: "token", User: { Id: "user-1", Name: "Viewer" } });
      if (url.pathname === "/LiveTv/Info") return Response.json({ IsEnabled: true });
      if (url.pathname === "/LiveTv/Channels") return Response.json({ Items: [{ Id: "channel-1", Name: "Channel" }] });
      if (url.pathname === "/LiveTv/Programs") {
        programQuery = url.searchParams;
        return Response.json({ Items: [] });
      }
      throw new Error(`Unexpected mock endpoint: ${url.pathname}`);
    }));
    const directory = await mkdtemp(join(tmpdir(), "seeing-stone-live-tv-midnight-"));
    const api = new JellyfinApi(identity, new SecureSessionStore(directory, protector), async () => undefined);
    const connection = await api.connect("http://127.0.0.1:8096");
    await api.login(connection.connectionId, "Viewer", "password", false);
    const startUtc = "2026-08-09T02:00:00.000Z";
    const endUtc = "2026-08-09T14:00:00.000Z";
    await api.getLiveTvGuide(startUtc, endUtc);
    expect(programQuery?.get("MinStartDate")).toBe(startUtc);
    expect(programQuery?.get("MaxStartDate")).toBe(endUtc);
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

  it("preserves custom user-view names and scopes mixed video requests by library ID", async () => {
    const observedRequests: URL[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      observedRequests.push(url);
      if (url.pathname === "/System/Info/Public") return Response.json({ Id: "server-1", ServerName: "Server", Version: "10.11.11" });
      if (url.pathname === "/Users/AuthenticateByName") return Response.json({ AccessToken: "token", User: { Id: "user-1", Name: "Viewer" } });
      if (url.pathname === "/Users/user-1/Views") {
        return Response.json({ Items: [
          { Id: "cool-library", Name: "Cool Stuff", CollectionType: "movies" },
          { Id: "boring-library", Name: "Boring", CollectionType: "tvshows" },
          { Id: "amazing-library", Name: "Amazing", CollectionType: null },
          { Id: "music-library", Name: "My Music", CollectionType: "music" },
        ] });
      }
      if (url.pathname === "/Users/user-1/Items/Resume" || url.pathname === "/Shows/NextUp") return Response.json({ Items: [] });
      if (url.pathname === "/Items/Latest") {
        return Response.json([{ ...unsafeItem, Id: "latest-1", Name: "Latest", Type: "Movie" }]);
      }
      if (url.pathname === "/Users/user-1/Items") {
        return Response.json({ Items: [{ ...unsafeItem, Id: "video-1", Name: "A Video", Type: "Video" }] });
      }
      throw new Error(`Unexpected mock endpoint: ${url.pathname}`);
    }));

    const directory = await mkdtemp(join(tmpdir(), "seeing-stone-custom-views-"));
    const api = new JellyfinApi(identity, new SecureSessionStore(directory, protector), async () => undefined);
    const connection = await api.connect("http://127.0.0.1:8096");
    await api.login(connection.connectionId, "Viewer", "password", false);

    const home = await api.getHome();
    const items = await api.getLibraryItems("amazing-library", "Mixed", 100);

    expect(home.libraries.map((library) => library.name)).toEqual(["Cool Stuff", "Boring", "Amazing", "My Music"]);
    expect(home.latestRows.map((row) => row.library.name)).toEqual(["Cool Stuff", "Boring"]);
    expect(items[0]).toMatchObject({ id: "video-1", type: "Video" });
    const latestRequest = observedRequests.find((url) => url.pathname === "/Items/Latest" && url.searchParams.get("ParentId") === "cool-library");
    expect(latestRequest?.searchParams.get("UserId")).toBe("user-1");
    expect(latestRequest?.searchParams.get("ParentId")).toBe("cool-library");
    expect(latestRequest?.searchParams.get("GroupItems")).toBe("true");
    expect(latestRequest?.searchParams.has("IncludeItemTypes")).toBe(false);
    expect(latestRequest?.searchParams.has("SortBy")).toBe(false);
    const libraryRequests = observedRequests.filter((url) => url.pathname === "/Users/user-1/Items");
    expect(libraryRequests.at(-1)?.searchParams.get("ParentId")).toBe("amazing-library");
    expect(libraryRequests.at(-1)?.searchParams.get("IncludeItemTypes")).toBe("Movie,Series,Video,MusicVideo");
  });
