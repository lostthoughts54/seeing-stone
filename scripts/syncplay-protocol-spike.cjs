"use strict";

const { randomBytes, randomUUID } = require("node:crypto");
const { spawn, spawnSync } = require("node:child_process");
const { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { hostname } = require("node:os");
const { dirname, join, resolve } = require("node:path");

const CHILD_FLAG = "--syncplay-protocol-child";
const PARENT_ENV = "JELLYFIN_SYNCPLAY_PARENT";
const ROOT = resolve(__dirname, "..");
const RUNTIME_ROOT = resolve(ROOT, ".runtime");
const SECONDARY_ROOT = resolve(RUNTIME_ROOT, "syncplay-secondary-spike");
const SECONDARY_URL = "http://127.0.0.1:18096";
const SECONDARY_EXE = process.env.JELLYFIN_SERVER_EXE || "D:\\Program Files\\Jellyfin\\Server\\jellyfin.exe";
const TEST_COUNT = 15;

if (!process.versions.electron) {
  runParent();
} else {
  void runChild().catch((error) => failHarness(error));
}

function runParent() {
  const electronExecutable = require("electron");
  const env = { ...process.env, [PARENT_ENV]: "1" };
  delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(electronExecutable, [__filename, CHILD_FLAG], {
    cwd: ROOT,
    env,
    stdio: "inherit",
    windowsHide: true,
    timeout: 240000,
  });
  if (result.error) throw coded("ELECTRON_LAUNCH_FAILED");
  if (result.signal) throw coded("ELECTRON_EXITED_UNEXPECTEDLY");
  process.exitCode = result.status ?? 1;
}

async function runChild() {
  const { app } = require("electron");
  if (!process.argv.includes(CHILD_FLAG) || process.env[PARENT_ENV] !== "1") throw coded("INVALID_HARNESS_START");

  const packageJson = require("../package.json");
  const productionUserData = findProductionUserData(packageJson);
  if (!productionUserData) throw coded("NO_PROTECTED_SESSION");

  app.commandLine.appendSwitch("disable-gpu");
  app.commandLine.appendSwitch("no-proxy-server");
  app.disableHardwareAcceleration();
  app.setName(packageJson.productName || packageJson.name);
  app.setVersion(packageJson.version);
  app.setPath("userData", productionUserData);
  app.on("window-all-closed", () => undefined);

  let sequence = 0;
  let failures = 0;
  let temporaryUser = null;
  let primarySocket = null;
  let peerSocket = null;
  let secondary = null;
  let groupId = null;
  let primary = null;

  const test = async (name, callback) => {
    sequence += 1;
    try {
      await callback();
      process.stdout.write(`ok ${sequence} - ${name}\n`);
    } catch (error) {
      failures += 1;
      process.stdout.write(`not ok ${sequence} - ${name} [${safeCode(error)}]\n`);
    }
  };

  process.stdout.write("TAP version 13\n");
  try {
    await app.whenReady();
    const security = require("../dist/main/electronSecurity.js");
    const { DeviceIdentityService } = require("../dist/main/services/deviceIdentity.js");
    const { SecureSessionStore } = require("../dist/main/services/secureSession.js");
    const session = await new SecureSessionStore(productionUserData, security.createSafeStorageProtector()).restore();
    if (!session) throw coded("PROTECTED_SESSION_RESTORE_FAILED");

    const identity = await new DeviceIdentityService(
      productionUserData,
      `Windows Desktop (${hostname()})`,
      app.getName(),
      app.getVersion(),
    ).get();
    primary = makeClient(session.serverUrl, identity, session.accessToken);

    let publicInfo;
    await test("protected production session targets Jellyfin 10.11.11", async () => {
      publicInfo = await jsonRequest(session.serverUrl, "/System/Info/Public");
      requireValue(publicInfo.Version === "10.11.11", "UNEXPECTED_SERVER_VERSION");
      requireValue(publicInfo.Id === session.serverId, "SERVER_ID_MISMATCH");
    });

    await test("signed-out callers cannot list SyncPlay groups", async () => {
      const response = await rawRequest(session.serverUrl, "/SyncPlay/List");
      requireValue(!response.ok, "ANONYMOUS_SYNCPLAY_VISIBLE");
    });

    let primaryUser;
    await test("authenticated session has SyncPlay create and join policy", async () => {
      primaryUser = await primary.json(`/Users/${session.userId}`);
      requireValue(primaryUser.Policy?.SyncPlayAccess === "CreateAndJoinGroups", "PRIMARY_SYNCPLAY_POLICY_DENIED");
      requireValue(primaryUser.Policy?.IsAdministrator === true, "TEMP_USER_REQUIRES_ADMIN");
    });

    const suffix = randomBytes(4).toString("hex");
    const peerName = `syncplay-w1-${suffix}`;
    const peerPassword = randomBytes(24).toString("base64url");
    const peerDevice = {
      clientName: app.getName(),
      clientVersion: app.getVersion(),
      deviceName: `SyncPlay W1 Peer (${hostname()})`,
      deviceId: randomUUID(),
    };
    let peer;

    await test("temporary second user is provisioned with explicit SyncPlay policy", async () => {
      temporaryUser = await primary.json("/Users/New", { method: "POST", body: { Name: peerName, Password: peerPassword } });
      const policy = { ...temporaryUser.Policy, SyncPlayAccess: "CreateAndJoinGroups" };
      await primary.json(`/Users/${temporaryUser.Id}/Policy`, { method: "POST", body: policy, expectJson: false });
      const authenticated = await jsonRequest(session.serverUrl, "/Users/AuthenticateByName", {
        method: "POST",
        body: { Username: peerName, Pw: peerPassword },
        headers: authHeaders(peerDevice),
      });
      requireValue(authenticated.User?.Id === temporaryUser.Id && authenticated.AccessToken, "PEER_AUTH_FAILED");
      peer = makeClient(session.serverUrl, peerDevice, authenticated.AccessToken);
    });

    await test("two distinct authenticated WebSocket sessions connect with header auth", async () => {
      primarySocket = await openSocket(primary);
      peerSocket = await openSocket(peer);
      requireValue(primarySocket.messages.length >= 0 && peerSocket.messages.length >= 0, "WEBSOCKET_SESSION_FAILED");
    });

    const groupName = `LocalFirst W1 ${suffix}`;
    await test("first client creates a server-visible group", async () => {
      await primary.json("/SyncPlay/New", { method: "POST", body: { GroupName: groupName }, expectJson: false });
      const joined = await primarySocket.wait((message) => isGroupUpdate(message, "GroupJoined"));
      groupId = joined.Data.GroupId;
      requireUuid(groupId, "INVALID_GROUP_ID");
      const groups = await primary.json("/SyncPlay/List");
      requireValue(groups.some((group) => group.GroupId === groupId && group.GroupName === groupName), "CREATED_GROUP_NOT_LISTED");
    });

    await test("second client discovers and joins the same group", async () => {
      const listed = await peer.json("/SyncPlay/List");
      requireValue(listed.some((group) => group.GroupId === groupId), "PEER_GROUP_DISCOVERY_FAILED");
      await peer.json("/SyncPlay/Join", { method: "POST", body: { GroupId: groupId }, expectJson: false });
      await peerSocket.wait((message) => isGroupUpdate(message, "GroupJoined") && message.Data.GroupId === groupId);
      await primarySocket.wait((message) => isGroupUpdate(message, "UserJoined"));
      const joined = await primary.json(`/SyncPlay/${groupId}`);
      requireValue(joined.Participants.includes(session.userName) && joined.Participants.includes(peerName), "GROUP_PARTICIPANTS_INVALID");
    });

    let selectedItem;
    let playlistItemId;
    await test("the shared queue identifies an exact Jellyfin item without media URLs", async () => {
      const result = await primary.json(`/Users/${session.userId}/Items?Recursive=true&IncludeItemTypes=Movie,Episode&Limit=25`);
      selectedItem = result.Items?.find((item) => item.Id);
      requireValue(selectedItem, "NO_PLAYABLE_LIBRARY_ITEM");
      await primary.json("/SyncPlay/SetNewQueue", {
        method: "POST",
        body: { PlayingQueue: [selectedItem.Id], PlayingItemPosition: 0, StartPositionTicks: 0 },
        expectJson: false,
      });
      const update = await peerSocket.wait((message) => isGroupUpdate(message, "PlayQueue"));
      const queueItem = update.Data.Data?.Playlist?.[0];
      requireValue(queueItem?.ItemId === selectedItem.Id, "QUEUE_ITEM_ID_MISMATCH");
      requireUuid(queueItem.PlaylistItemId, "INVALID_PLAYLIST_ITEM_ID");
      requireValue(!containsMediaLocation(update), "MEDIA_LOCATION_LEAKED_IN_SYNCPLAY");
      playlistItemId = queueItem.PlaylistItemId;
    });

    await test("both clients publish readiness for the exact playlist item", async () => {
      const beforeA = primarySocket.messages.length;
      const beforeB = peerSocket.messages.length;
      const ready = { When: new Date().toISOString(), PositionTicks: 0, IsPlaying: false, PlaylistItemId: playlistItemId };
      await Promise.all([
        primary.json("/SyncPlay/Ready", { method: "POST", body: ready, expectJson: false }),
        peer.json("/SyncPlay/Ready", { method: "POST", body: ready, expectJson: false }),
      ]);
      const [a, b] = await Promise.all([
        primarySocket.wait((message) => isCommand(message, "Unpause", groupId, playlistItemId), beforeA),
        peerSocket.wait((message) => isCommand(message, "Unpause", groupId, playlistItemId), beforeB),
      ]);
      validateCommand(a); validateCommand(b);
    });

    await test("first participant can pause then unpause playback for both sessions", async () => {
      let beforeA = primarySocket.messages.length;
      let beforeB = peerSocket.messages.length;
      await primary.json("/SyncPlay/Pause", { method: "POST", expectJson: false });
      await Promise.all([
        primarySocket.wait((message) => isCommand(message, "Pause", groupId, playlistItemId), beforeA),
        peerSocket.wait((message) => isCommand(message, "Pause", groupId, playlistItemId), beforeB),
      ]);
      beforeA = primarySocket.messages.length;
      beforeB = peerSocket.messages.length;
      await primary.json("/SyncPlay/Unpause", { method: "POST", expectJson: false });
      const [a, b] = await Promise.all([
        primarySocket.wait((message) => isCommand(message, "Unpause", groupId, playlistItemId), beforeA),
        peerSocket.wait((message) => isCommand(message, "Unpause", groupId, playlistItemId), beforeB),
      ]);
      validateCommand(a); validateCommand(b);
    });

    await test("second participant pauses and both sessions receive a validated command", async () => {
      const beforeA = primarySocket.messages.length;
      const beforeB = peerSocket.messages.length;
      await peer.json("/SyncPlay/Pause", { method: "POST", expectJson: false });
      const [a, b] = await Promise.all([
        primarySocket.wait((message) => isCommand(message, "Pause", groupId, playlistItemId), beforeA),
        peerSocket.wait((message) => isCommand(message, "Pause", groupId, playlistItemId), beforeB),
      ]);
      validateCommand(a); validateCommand(b);
    });

    await test("second participant seeks and both sessions receive the same position", async () => {
      const beforeA = primarySocket.messages.length;
      const beforeB = peerSocket.messages.length;
      await peer.json("/SyncPlay/Seek", { method: "POST", body: { PositionTicks: 10000000 }, expectJson: false });
      const [a, b] = await Promise.all([
        primarySocket.wait((message) => isCommand(message, "Seek", groupId, playlistItemId), beforeA),
        peerSocket.wait((message) => isCommand(message, "Seek", groupId, playlistItemId), beforeB),
      ]);
      requireValue(a.Data.PositionTicks === 10000000 && b.Data.PositionTicks === 10000000, "SEEK_POSITION_MISMATCH");
      validateCommand(a); validateCommand(b);
    });

    await test("an unrelated Jellyfin server cannot see the primary server group", async () => {
      secondary = await startSecondaryServer(app);
      const groups = await secondary.client.json("/SyncPlay/List");
      requireValue(Array.isArray(groups) && groups.length === 0, "CROSS_SERVER_GROUP_VISIBLE");
      const anonymous = await rawRequest(SECONDARY_URL, "/SyncPlay/List");
      requireValue(!anonymous.ok, "SECONDARY_ANONYMOUS_VISIBLE");
    });

    await test("leaving removes both memberships and the empty group", async () => {
      await peer.json("/SyncPlay/Leave", { method: "POST", expectJson: false });
      await peerSocket.wait((message) => isGroupUpdate(message, "GroupLeft"));
      await primarySocket.wait((message) => isGroupUpdate(message, "UserLeft"));
      await primary.json("/SyncPlay/Leave", { method: "POST", expectJson: false });
      await primarySocket.wait((message) => isGroupUpdate(message, "GroupLeft"));
      const listed = await primary.json("/SyncPlay/List");
      requireValue(!listed.some((group) => group.GroupId === groupId), "EMPTY_GROUP_NOT_REMOVED");
      groupId = null;
    });

    await test("temporary user is deleted after the protocol proof", async () => {
      await primary.json(`/Users/${temporaryUser.Id}`, { method: "DELETE", expectJson: false });
      temporaryUser = null;
    });
  } finally {
    if (groupId && primary) await primary.json("/SyncPlay/Leave", { method: "POST", expectJson: false }).catch(() => undefined);
    primarySocket?.close();
    peerSocket?.close();
    if (temporaryUser && primary) await primary.json(`/Users/${temporaryUser.Id}`, { method: "DELETE", expectJson: false }).catch(() => undefined);
    await secondary?.stop().catch(() => undefined);
    process.stdout.write(`1..${TEST_COUNT}\n`);
    app.exit(failures === 0 && sequence === TEST_COUNT ? 0 : 1);
  }
}

function makeClient(serverUrl, identity, token) {
  return {
    serverUrl: serverUrl.replace(/\/$/, ""), identity, token,
    json(path, options = {}) {
      return jsonRequest(this.serverUrl, path, {
        ...options,
        headers: { ...authHeaders(this.identity, this.token), ...options.headers },
      });
    },
  };
}

function authHeaders(identity, token) {
  const escaped = (value) => String(value).replace(/["\\]/g, "");
  const values = [
    `Client="${escaped(identity.clientName)}"`,
    `Device="${escaped(identity.deviceName)}"`,
    `DeviceId="${escaped(identity.deviceId)}"`,
    `Version="${escaped(identity.clientVersion)}"`,
  ];
  if (token) values.push(`Token="${escaped(token)}"`);
  return { "X-Emby-Authorization": `MediaBrowser ${values.join(", ")}` };
}

async function rawRequest(serverUrl, path, options = {}) {
  const headers = { Accept: "application/json", ...options.headers };
  let body;
  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(options.body);
  }
  return fetch(`${serverUrl.replace(/\/$/, "")}${path}`, { method: options.method || "GET", headers, body });
}

async function jsonRequest(serverUrl, path, options = {}) {
  const response = await rawRequest(serverUrl, path, options);
  if (!response.ok) throw coded(`HTTP_${response.status}`);
  if (options.expectJson === false || response.status === 204 || response.headers.get("content-length") === "0") return null;
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

async function openSocket(client) {
  const WebSocket = require("ws");
  const url = new URL(client.serverUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `${url.pathname.replace(/\/$/, "")}/socket`;
  url.search = "";
  const messages = [];
  const socket = new WebSocket(url, { headers: authHeaders(client.identity, client.token), handshakeTimeout: 10000 });
  socket.on("message", (data) => {
    try {
      const parsed = JSON.parse(data.toString());
      if (process.env.SYNCPLAY_DEBUG === "1" && String(parsed?.MessageType || "").startsWith("SyncPlay")) {
        process.stdout.write(`# websocket shape ${JSON.stringify({ keys: Object.keys(parsed), messageType: parsed.MessageType, messageIdType: typeof parsed.MessageId, messageId: parsed.MessageId, dataType: typeof parsed.Data, dataKeys: parsed.Data && typeof parsed.Data === "object" ? Object.keys(parsed.Data) : [] })}\n`);
      }
      if (validEnvelope(parsed)) messages.push(parsed);
    } catch { /* Invalid server data is ignored and cannot satisfy assertions. */ }
  });
  await new Promise((resolvePromise, reject) => {
    const timeout = setTimeout(() => reject(coded("WEBSOCKET_OPEN_TIMEOUT")), 10000);
    socket.once("open", () => { clearTimeout(timeout); resolvePromise(); });
    socket.once("error", () => { clearTimeout(timeout); reject(coded("WEBSOCKET_OPEN_FAILED")); });
  });
  return {
    messages,
    wait(predicate, from = 0, timeoutMs = 10000) {
      return waitFor(() => messages.slice(from).find(predicate), timeoutMs, "WEBSOCKET_MESSAGE_TIMEOUT");
    },
    close() { try { socket.close(); } catch { /* Best effort. */ } },
  };
}

function validEnvelope(message) {
  return message && typeof message === "object" && typeof message.MessageType === "string"
    && typeof message.MessageId === "string" && isUuid(message.MessageId)
    && message.Data && typeof message.Data === "object";
}

function isGroupUpdate(message, type) {
  return message.MessageType === "SyncPlayGroupUpdate" && message.Data?.Type === type;
}

function isCommand(message, command, groupId, playlistItemId) {
  return message.MessageType === "SyncPlayCommand" && message.Data?.Command === command
    && message.Data.GroupId === groupId && message.Data.PlaylistItemId === playlistItemId;
}

function validateCommand(message) {
  requireValue(validEnvelope(message), "INVALID_COMMAND_ENVELOPE");
  requireUuid(message.Data.GroupId, "INVALID_COMMAND_GROUP");
  requireUuid(message.Data.PlaylistItemId, "INVALID_COMMAND_PLAYLIST_ITEM");
  requireValue(!Number.isNaN(Date.parse(message.Data.When)) && !Number.isNaN(Date.parse(message.Data.EmittedAt)), "INVALID_COMMAND_TIME");
}

function containsMediaLocation(value) {
  const serialized = JSON.stringify(value).toLowerCase();
  return serialized.includes("mediastream") || serialized.includes("playbackinfo")
    || serialized.includes("path\\") || serialized.includes("http://") || serialized.includes("https://");
}

async function startSecondaryServer(app) {
  requireValue(existsSync(SECONDARY_EXE), "SECONDARY_JELLYFIN_NOT_FOUND");
  safeRemoveSecondary();
  for (const name of ["data", "config", "cache", "logs"]) mkdirSync(join(SECONDARY_ROOT, name), { recursive: true });
  writeFileSync(join(SECONDARY_ROOT, "config", "network.xml"), `<?xml version="1.0" encoding="utf-8"?>\n<NetworkConfiguration xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">\n  <BaseUrl />\n  <EnableHttps>false</EnableHttps>\n  <RequireHttps>false</RequireHttps>\n  <InternalHttpPort>18096</InternalHttpPort>\n  <PublicHttpPort>18096</PublicHttpPort>\n  <InternalHttpsPort>18920</InternalHttpsPort>\n  <PublicHttpsPort>18920</PublicHttpsPort>\n  <EnableUPnP>false</EnableUPnP>\n  <EnableIPv4>true</EnableIPv4>\n  <EnableIPv6>false</EnableIPv6>\n  <EnableRemoteAccess>false</EnableRemoteAccess>\n  <EnablePublishedServerUriByRequest>false</EnablePublishedServerUriByRequest>\n  <EnableIPV6>false</EnableIPV6>\n  <EnableAutoDiscovery>false</EnableAutoDiscovery>\n</NetworkConfiguration>\n`, "utf8");
  const child = spawn(SECONDARY_EXE, [
    "--nowebclient", "--nonetchange",
    "--datadir", join(SECONDARY_ROOT, "data"),
    "--configdir", join(SECONDARY_ROOT, "config"),
    "--cachedir", join(SECONDARY_ROOT, "cache"),
    "--logdir", join(SECONDARY_ROOT, "logs"),
  ], { cwd: ROOT, windowsHide: true, stdio: "ignore" });

  try {
    await waitFor(async () => {
      try {
        const [publicInfo, startupConfiguration] = await Promise.all([
          rawRequest(SECONDARY_URL, "/System/Info/Public"),
          rawRequest(SECONDARY_URL, "/Startup/Configuration"),
        ]);
        return publicInfo.ok && startupConfiguration.ok;
      } catch { return false; }
    }, 30000, "SECONDARY_START_TIMEOUT");
    const adminName = `w1-admin-${randomBytes(4).toString("hex")}`;
    const adminPassword = randomBytes(24).toString("base64url");
    const setupRequest = async (stage, path, options) => {
      const deadline = Date.now() + 30000;
      let lastError;
      while (Date.now() < deadline) {
        try { return await jsonRequest(SECONDARY_URL, path, options); }
        catch (error) {
          lastError = error;
          if (error?.code !== "HTTP_404" && error?.code !== "HTTP_503") break;
          await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
        }
      }
      throw coded(`SECONDARY_${stage}_${safeCode(lastError)}`);
    };
    await setupRequest("CONFIG", "/Startup/Configuration", {
      method: "POST", body: { ServerName: "SyncPlay W1 Isolated", UICulture: "en-US", MetadataCountryCode: "US", PreferredMetadataLanguage: "en" }, expectJson: false,
    });
    // Jellyfin 10.11 initializes the bootstrap account lazily in this GET.
    await setupRequest("FIRST_USER", "/Startup/User", { method: "GET" });
    await setupRequest("USER", "/Startup/User", { method: "POST", body: { Name: adminName, Password: adminPassword }, expectJson: false });
    await setupRequest("REMOTE", "/Startup/RemoteAccess", { method: "POST", body: { EnableRemoteAccess: false, EnableAutomaticPortMapping: false }, expectJson: false });
    await setupRequest("COMPLETE", "/Startup/Complete", { method: "POST", expectJson: false });
    await waitFor(async () => {
      try {
        const info = await jsonRequest(SECONDARY_URL, "/System/Info/Public");
        return info.StartupWizardCompleted === true;
      } catch { return false; }
    }, 30000, "SECONDARY_SETUP_TIMEOUT");
    const secondaryIdentity = {
      clientName: app.getName(), clientVersion: app.getVersion(),
      deviceName: `SyncPlay W1 Isolated (${hostname()})`, deviceId: randomUUID(),
    };
    const login = await setupRequest("AUTH", "/Users/AuthenticateByName", {
      method: "POST", body: { Username: adminName, Pw: adminPassword }, headers: authHeaders(secondaryIdentity),
    });
    return {
      client: makeClient(SECONDARY_URL, secondaryIdentity, login.AccessToken),
      async stop() { child.kill(); await waitFor(() => child.exitCode !== null, 10000, "SECONDARY_STOP_TIMEOUT").catch(() => undefined); safeRemoveSecondary(); },
    };
  } catch (error) {
    child.kill();
    await waitFor(() => child.exitCode !== null, 10000, "SECONDARY_STOP_TIMEOUT").catch(() => undefined);
    try { safeRemoveSecondary(); } catch { /* Preserve the protocol/startup failure. */ }
    throw error;
  }
}

function safeRemoveSecondary() {
  const target = resolve(SECONDARY_ROOT);
  const allowed = `${resolve(RUNTIME_ROOT)}\\`;
  if (!target.startsWith(allowed)) throw coded("UNSAFE_SECONDARY_PATH");
  rmSync(target, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}

async function waitFor(callback, timeoutMs, code) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await callback();
    if (result) return result;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  throw coded(code);
}

function findProductionUserData(packageJson) {
  const candidates = [];
  if (process.env.LOCALAPPDATA) candidates.push(join(process.env.LOCALAPPDATA, packageJson.productName || packageJson.name));
  if (process.env.APPDATA) candidates.push(join(dirname(process.env.APPDATA), "Local", packageJson.productName || packageJson.name));
  for (const drive of ["C", "D", "E", "F"]) candidates.push(`${drive}:\\user\\lost\\${packageJson.productName || packageJson.name}`);
  return candidates.find((candidate) => existsSync(join(candidate, "session.safe"))) || null;
}

function requireValue(condition, code) { if (!condition) throw coded(code); }
function isUuid(value) { return typeof value === "string" && (/^[0-9a-f]{32}$/i.test(value) || /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(value)); }
function requireUuid(value, code) { requireValue(isUuid(value), code); }
function coded(code) { const error = new Error(code); error.code = code; return error; }
function safeCode(error) { return /^[A-Z0-9_]+$/.test(error?.code || "") ? error.code : "UNEXPECTED_FAILURE"; }
function failHarness(error) {
  process.stdout.write(`not ok 1 - SyncPlay protocol harness setup [${safeCode(error)}]\n1..${TEST_COUNT}\n`);
  require("electron").app.exit(1);
}
