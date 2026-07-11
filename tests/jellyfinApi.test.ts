import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DeviceIdentity } from "../src/main/services/deviceIdentity";
import { JellyfinApi } from "../src/main/services/jellyfinApi";
import { SecureSessionStore, type SessionProtector } from "../src/main/services/secureSession";

const identity: DeviceIdentity = {
  deviceId: "11111111-1111-4111-8111-111111111111",
  clientName: "LocalFirst Jellyfin",
  clientVersion: "0.4.0",
  deviceName: "Windows Desktop",
};

const protector: SessionProtector = {
  async isAvailable() { return false; },
  async encrypt() { throw new Error("disabled"); },
  async decrypt() { throw new Error("disabled"); },
};

const unsafeItem = {
  Id: "movie-1",
  Name: "Movie",
  Type: "Movie",
  Overview: "Overview",
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
  }],
  ImageTags: { Primary: "tag" },
  UserData: { Played: false, PlaybackPositionTicks: 1234, PlayedPercentage: 5 },
  RemoteTrailers: [{ Url: "https://trailers.example/movie" }],
};

describe("JellyfinApi main-side boundary", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("owns authentication, uses stable identity, and returns only allowlisted DTOs", async () => {
    const observedHeaders: string[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const header = new Headers(init?.headers).get("X-Emby-Authorization");
      if (header) observedHeaders.push(header);
      if (url.pathname === "/System/Info/Public") return Response.json({ Id: "server-1", ServerName: "Server", Version: "10.11.11" });
      if (url.pathname === "/Users/AuthenticateByName") return Response.json({ AccessToken: "SECRET_TOKEN_SENTINEL", User: { Id: "user-1", Name: "Viewer" } });
      if (url.pathname.endsWith("/Views")) return Response.json({ Items: [{ Id: "library-1", Name: "Movies", CollectionType: "movies", Path: "D:\\Sensitive" }] });
      if (url.pathname.endsWith("/Items/Resume")) return Response.json({ Items: [unsafeItem] });
      if (url.pathname === "/Shows/NextUp") return Response.json({ Items: [] });
      if (url.pathname.endsWith("/Items") && url.searchParams.get("ParentId")) return Response.json({ Items: [unsafeItem] });
      if (url.pathname.endsWith("/PlaybackInfo")) return Response.json({ MediaSources: unsafeItem.MediaSources });
      throw new Error(`Unexpected mock endpoint: ${url.pathname}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const directory = await mkdtemp(join(tmpdir(), "lf-api-"));
    const api = new JellyfinApi(identity, new SecureSessionStore(directory, protector), async () => undefined);
    const safeSession = await api.login("http://127.0.0.1:8096", "Viewer", "password", true);
    const home = await api.getHome();
    const capabilities = await api.getMediaSourceCapabilities("movie-1");

    const rendererPayload = JSON.stringify({ safeSession, home, capabilities });
    expect(rendererPayload).not.toContain("SECRET_TOKEN_SENTINEL");
    expect(rendererPayload).not.toContain("Sensitive");
    expect(rendererPayload).not.toContain("DirectStreamUrl");
    expect(rendererPayload).not.toContain("TranscodingUrl");
    expect(rendererPayload).not.toContain("RequiredHttpHeaders");
    expect(home.resumeItems[0]).toMatchObject({ id: "movie-1", name: "Movie", playable: true, hasTrailer: true });
    expect(capabilities.sources[0]).toEqual({
      id: "source-1",
      container: "mkv",
      size: 123,
      supportsDirectPlay: true,
      supportsDirectStream: true,
      supportsTranscoding: true,
    });
    expect(observedHeaders.length).toBeGreaterThan(2);
    expect(new Set(observedHeaders.map((value) => value.match(/DeviceId="([^"]+)"/)?.[1])).size).toBe(1);
    expect(observedHeaders.every((value) => value.includes('Client="LocalFirst Jellyfin"') && value.includes('Version="0.4.0"'))).toBe(true);
  });
});
