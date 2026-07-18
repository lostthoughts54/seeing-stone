const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { ArtworkService } = require("../dist/main/services/artwork.js");
const { DeviceIdentityService } = require("../dist/main/services/deviceIdentity.js");
const { JellyfinApi, sanitizeMediaItem } = require("../dist/main/services/jellyfinApi.js");
const { redactText, sanitizeLogValue } = require("../dist/main/services/logger.js");
const { PlaybackSessionService } = require("../dist/main/services/playbackSession.js");
const { SecureSessionStore } = require("../dist/main/services/secureSession.js");
const { connectionScore } = require("../dist/main/services/serverDiscovery.js");
const { downloadIdSchema, downloadStartSchema, loginSchema, playbackStartSchema, searchSchema, watchPartyCreateSchema, watchPartyGroupSchema, watchPartyVisibilitySchema } = require("../dist/shared/schemas.js");

const secretSession = {
  serverUrl: "http://127.0.0.1:8096",
  serverId: "server-id",
  serverName: "Server",
  serverVersion: "10.11.11",
  userId: "user-id",
  userName: "Viewer",
  accessToken: "SECRET_TOKEN_SENTINEL",
};

const protector = {
  async isAvailable() { return true; },
  async encrypt(value) { return Buffer.from(`protected:${Buffer.from(value).toString("base64")}`); },
  async decrypt(value) {
    return { result: Buffer.from(value.toString().slice(10), "base64").toString(), shouldReEncrypt: false };
  },
};

test("protected sessions never write plaintext and restore successfully", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "lf-core-session-"));
  const store = new SecureSessionStore(directory, protector);
  assert.equal(await store.save(secretSession, true), "protected");
  const bytes = await fs.readFile(path.join(directory, "session.safe"));
  assert.equal(bytes.includes(Buffer.from(secretSession.accessToken)), false);
  assert.deepEqual(await new SecureSessionStore(directory, protector).restore(), secretSession);
});

test("unavailable protection keeps the session only in memory", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "lf-core-session-"));
  const unavailable = {
    async isAvailable() { return false; },
    async encrypt() { throw new Error("unavailable"); },
    async decrypt() { throw new Error("unavailable"); },
  };
  const store = new SecureSessionStore(directory, unavailable);
  assert.equal(await store.save(secretSession, true), "memory-only");
  await assert.rejects(fs.stat(path.join(directory, "session.safe")), { code: "ENOENT" });
});

test("device identity is stable across concurrency, restart, and version changes", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "lf-core-identity-"));
  const service = new DeviceIdentityService(directory, "Windows Desktop", "Client", "1.0.0");
  const identities = await Promise.all([service.get(), service.get(), service.get()]);
  assert.equal(new Set(identities.map((entry) => entry.deviceId)).size, 1);
  const restarted = await new DeviceIdentityService(directory, "Windows Desktop", "Client", "1.0.1").get();
  assert.equal(restarted.deviceId, identities[0].deviceId);
  assert.equal(restarted.clientVersion, "1.0.1");
});

test("safe DTOs and logs remove paths, tokens, and server-only fields", () => {
  const item = sanitizeMediaItem({
    Id: "movie-1",
    Name: "Movie",
    Type: "Movie",
    Path: "D:\\Sensitive\\movie.mkv",
    DirectStreamUrl: "/stream?api_key=SECRET_TOKEN_SENTINEL",
    MediaSources: [{ Path: "D:\\Sensitive\\movie.mkv", RequiredHttpHeaders: { Authorization: "SECRET_TOKEN_SENTINEL" } }],
    UserData: { PlaybackPositionTicks: 10 },
  });
  const serialized = JSON.stringify(item);
  assert.equal(serialized.includes("Sensitive"), false);
  assert.equal(serialized.includes("SECRET_TOKEN_SENTINEL"), false);
  assert.equal(serialized.includes("MediaSources"), false);
  const unsafeLog = [
    "x?api_key=SECRET_TOKEN_SENTINEL",
    'X-Emby-Authorization: MediaBrowser Client="LocalFirst Jellyfin", Token="SECRET_TOKEN_SENTINEL"',
    '{"Authorization":"Bearer JSON_SECRET_TOKEN_SENTINEL"}',
    "D:\\Sensitive Folder\\Private Movie.mkv",
    "D:/Forward Slash Secret/Private Movie.mkv",
  ].join("\n");
  const safeLog = redactText(unsafeLog);
  assert.equal(safeLog.includes("SECRET_TOKEN_SENTINEL"), false);
  assert.equal(safeLog.includes("Sensitive Folder"), false);
  assert.equal(safeLog.includes("Private Movie"), false);
  assert.equal(JSON.stringify(sanitizeLogValue({ accessToken: "SECRET_TOKEN_SENTINEL" })).includes("SECRET_TOKEN_SENTINEL"), false);
});

test("authenticated networking stays main-side and returns allowlisted payloads", async () => {
  const originalFetch = global.fetch;
  const observedHeaders = [];
  const unsafeItem = {
    Id: "movie-1",
    Name: "Movie",
    Type: "Movie",
    Path: "D:\\Sensitive\\movie.mkv",
    DirectStreamUrl: "/stream?api_key=SECRET_TOKEN_SENTINEL",
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
    UserData: { PlaybackPositionTicks: 10 },
  };
  global.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const header = new Headers(init.headers).get("X-Emby-Authorization");
    if (header) observedHeaders.push(header);
    if (url.pathname === "/System/Info/Public") return Response.json({ Id: "server-1", ServerName: "Server", Version: "10.11.11" });
    if (url.pathname === "/Users/AuthenticateByName") return Response.json({ AccessToken: "SECRET_TOKEN_SENTINEL", User: { Id: "user-1", Name: "Viewer" } });
    if (url.pathname.endsWith("/Views")) return Response.json({ Items: [{ Id: "library-1", Name: "Movies", CollectionType: "movies" }] });
    if (url.pathname.endsWith("/Items/Resume")) return Response.json({ Items: [unsafeItem] });
    if (url.pathname === "/Shows/NextUp") return Response.json({ Items: [] });
    if (url.pathname.endsWith("/Items") && url.searchParams.get("ParentId")) return Response.json({ Items: [unsafeItem] });
    if (url.pathname.endsWith("/PlaybackInfo")) return Response.json({ MediaSources: unsafeItem.MediaSources });
    throw new Error(`Unexpected endpoint: ${url.pathname}`);
  };
  try {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "lf-core-api-"));
    const memoryOnly = {
      async isAvailable() { return false; },
      async encrypt() { throw new Error("disabled"); },
      async decrypt() { throw new Error("disabled"); },
    };
    const api = new JellyfinApi({
      deviceId: "11111111-1111-4111-8111-111111111111",
      clientName: "LocalFirst Jellyfin",
      clientVersion: "0.4.0",
      deviceName: "Windows Desktop",
    }, new SecureSessionStore(directory, memoryOnly), async () => undefined);
    const connection = await api.connect("http://127.0.0.1:8096");
    const safeSession = await api.login(connection.connectionId, "Viewer", "password", true);
    const home = await api.getHome();
    const capabilities = await api.getMediaSourceCapabilities("movie-1");
    const payload = JSON.stringify({ safeSession, home, capabilities });
    for (const forbidden of ["SECRET_TOKEN_SENTINEL", "Sensitive", "DirectStreamUrl", "TranscodingUrl", "RequiredHttpHeaders"]) {
      assert.equal(payload.includes(forbidden), false, forbidden);
    }
    assert.equal(home.resumeItems[0].id, "movie-1");
    assert.equal(capabilities.sources[0].id, "source-1");
    assert.ok(observedHeaders.length > 2);
    assert.equal(new Set(observedHeaders.map((value) => value.match(/DeviceId="([^"]+)"/)?.[1])).size, 1);
    assert.equal(observedHeaders.every((value) => value.includes('Client="LocalFirst Jellyfin"') && value.includes('Version="0.4.0"')), true);
  } finally {
    global.fetch = originalFetch;
  }
});

test("artwork and playback expose only opaque application URLs", async () => {
  let artworkCalls = 0;
  const artwork = new ArtworkService({
    async fetchArtwork() {
      artworkCalls += 1;
      return new Response("image", { headers: { "Content-Type": "image/jpeg" } });
    },
  });
  const artworkUrl = artwork.getUrl({ itemId: "movie-1", kind: "Primary", tag: "private-tag", width: 500 });
  assert.equal(artworkUrl.includes("movie-1"), false);
  assert.equal(artworkUrl.includes("private-tag"), false);
  assert.equal((await artwork.handle(new Request(artworkUrl))).status, 200);
  assert.equal((await artwork.handle(new Request("jellyfin-artwork://asset/unknown"))).status, 404);
  assert.equal(artworkCalls, 1);

  const item = sanitizeMediaItem({ Id: "movie-1", Name: "Movie", Type: "Movie", UserData: { PlaybackPositionTicks: 50 } });
  const playback = new PlaybackSessionService({
    async getDetails() { return item; },
    async getMediaSourceCapabilities() {
      return {
        itemId: "movie-1",
        sources: [{
          id: "private-source-id",
          container: "mp4",
          size: 5,
          supportsDirectPlay: true,
          supportsDirectStream: true,
          supportsTranscoding: true,
        }],
      };
    },
    async fetchStaticStream() { return new Response("video", { headers: { "Content-Type": "video/mp4" } }); },
  });
  const started = await playback.start("movie-1", "resume");
  assert.equal(started.mediaUrl, `jellyfin-media://stream/${started.playbackId}`);
  assert.equal(started.mediaSourceId, "private-source-id");
  assert.equal(JSON.stringify(started).includes("http"), false);
  assert.equal(started.durationTicks, item.runTimeTicks);
});

test("renderer/preload boundary contains no privileged escape hatch or report channel", async () => {
  const renderer = await fs.readFile("src/renderer/app.ts", "utf8");
  const preload = await fs.readFile("src/preload/index.ts", "utf8");
  const contracts = await fs.readFile("src/shared/contracts.ts", "utf8");
  const main = [
    await fs.readFile("src/main/index.ts", "utf8"),
    await fs.readFile("src/main/electronSecurity.ts", "utf8"),
  ].join("\n");
  assert.doesNotMatch(renderer, /\bfetch\s*\(|localStorage|sessionStorage|accessToken|api_key|ipcRenderer|window\.open/);
  assert.doesNotMatch(renderer, /from\s+["'](?:node:|electron|.*\/main\/)/);
  assert.doesNotMatch(preload, /exposeInMainWorld\([^,]+,\s*ipcRenderer/);
  assert.doesNotMatch(`${renderer}\n${preload}`, /localPath|storageRoot|mediaSourceId|file:\/\//);
  assert.doesNotMatch(contracts, /reportStart|reportProgress|reportStop|Sessions\/Playing/);
  const downloadContract = contracts.slice(
    contracts.indexOf("export interface DownloadSummary"),
    contracts.indexOf("export type RpcResult"),
  );
  assert.doesNotMatch(downloadContract, /localPath|storageRoot|mediaSourceId|authenticatedUrl|headers|command|args/);
  const watchPartyContract = contracts.slice(
    contracts.indexOf("export type WatchPartyPlaybackState"),
    contracts.indexOf("export interface JellyfinBridge"),
  );
  assert.doesNotMatch(watchPartyContract, /accessToken|authorization|authenticatedUrl|serverUrl|localPath|filePath|headers|rawMessage|webSocket(?:Url|Endpoint|Headers|Token)|mediaUrl|api[_-]?key/i);
  assert.doesNotMatch(watchPartyContract, /(?:url|path|headers|credential|token)\s*:/i);
  for (const setting of [
    "contextIsolation: true",
    "sandbox: true",
    "nodeIntegration: false",
    "nodeIntegrationInWorker: false",
    "nodeIntegrationInSubFrames: false",
    "webSecurity: true",
    "allowRunningInsecureContent: false",
    "webviewTag: false",
  ]) assert.ok(main.includes(setting), setting);
  assert.match(main, /setPermissionRequestHandler/);
  assert.match(main, /setPermissionCheckHandler/);
  assert.match(main, /onBeforeRequest/);
  assert.match(main, /setWindowOpenHandler/);
  assert.match(main, /requestSingleInstanceLock/);
  assert.match(main, /connect-src 'none'/);
  assert.doesNotMatch(main, /unsafe-inline|unsafe-eval/);
});

test("IPC schemas reject extra headers, paths, commands, and arguments", () => {
  assert.throws(() => loginSchema.strict().parse({
    connectionId: "11111111-1111-4111-8111-111111111111",
    username: "Viewer",
    password: "password",
    remember: true,
    headers: { Authorization: "token" },
  }));
  assert.throws(() => searchSchema.strict().parse({ query: "Movie", path: "D:\\Sensitive" }));
  assert.throws(() => playbackStartSchema.strict().parse({ itemId: "movie-1", resumeMode: "resume", command: "mpv", args: ["--script"] }));
  assert.throws(() => downloadStartSchema.strict().parse({
    itemId: "movie-1",
    mediaSourceId: "private-source",
    url: "http://127.0.0.1:8096/video?api_key=token",
    path: "D:\\Sensitive\\movie.mkv",
  }));
  assert.throws(() => downloadIdSchema.strict().parse({ downloadId: "D:\\Sensitive\\movie.mkv" }));
  assert.throws(() => watchPartyCreateSchema.strict().parse({ name: "Movie night", headers: { Authorization: "token" } }));
  assert.throws(() => watchPartyGroupSchema.strict().parse({ groupId: "11111111111141118111111111111111", url: "ws://server/socket?api_key=token" }));
  assert.throws(() => watchPartyGroupSchema.strict().parse({ groupId: "11111111-1111-not-a-guid-111111111111" }));
  assert.throws(() => watchPartyVisibilitySchema.strict().parse({ visible: true, url: "ws://server/socket" }));
});

test("physical LAN discovery outranks VPN and virtual adapters", () => {
  const ethernet = connectionScore("Ethernet", "192.168.1.20");
  assert.ok(ethernet > connectionScore("Tailscale", "100.80.1.2"));
  assert.ok(ethernet > connectionScore("vEthernet (WSL)", "172.20.0.1"));
  assert.ok(ethernet > connectionScore("OpenVPN", "10.8.0.2"));
});
