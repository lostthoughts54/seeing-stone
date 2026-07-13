"use strict";

const assert = require("node:assert/strict");
const { randomBytes, randomUUID } = require("node:crypto");
const { existsSync, mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { dirname, join } = require("node:path");
const { spawnSync } = require("node:child_process");

const CHILD_FLAG = "--syncplay-service-child";
const PARENT_ENV = "LOCALFIRST_SYNCPLAY_SERVICE_PARENT";
const TEST_COUNT = 7;

if (!process.versions.electron) runParent();
else void runChild().catch((error) => {
  process.stderr.write(`# syncplay service acceptance failed: ${safeCode(error)}\n`);
  require("electron").app.exit(1);
});

function runParent() {
  const electronExecutable = require("electron");
  const env = { ...process.env, [PARENT_ENV]: "1" };
  delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(electronExecutable, [__filename, CHILD_FLAG], {
    cwd: join(__dirname, ".."),
    env,
    stdio: "inherit",
    windowsHide: true,
    timeout: 180000,
  });
  if (result.error) throw result.error;
  if (result.signal) throw new Error(`Electron acceptance ended with signal ${result.signal}.`);
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
  app.setPath("userData", productionUserData);
  app.on("window-all-closed", () => undefined);
  await app.whenReady();

  const security = require("../dist/main/electronSecurity.js");
  const { DeviceIdentityService } = require("../dist/main/services/deviceIdentity.js");
  const { JellyfinApi } = require("../dist/main/services/jellyfinApi.js");
  const { SecureSessionStore } = require("../dist/main/services/secureSession.js");
  const { SyncPlayService } = require("../dist/main/services/syncPlay.js");

  const peerRoot = mkdtempSync(join(tmpdir(), "localfirst-syncplay-peer-"));
  let primaryService = null;
  let peerService = null;
  let primaryApi = null;
  let temporaryUserId = null;
  let passed = 0;
  const test = async (name, operation) => {
    await operation();
    passed += 1;
    process.stdout.write(`ok ${passed} - ${name}\n`);
  };

  process.stdout.write("TAP version 13\n");
  try {
    const primaryIdentity = await new DeviceIdentityService(
      productionUserData,
      app.getName(),
      packageJson.name,
      packageJson.version,
    ).get();
    primaryApi = new JellyfinApi(
      primaryIdentity,
      new SecureSessionStore(productionUserData, security.createSafeStorageProtector()),
      async () => undefined,
    );
    let primarySession;
    await test("protected session restores on the pinned Jellyfin server", async () => {
      primarySession = await primaryApi.restore();
      assert.equal(primarySession.authenticated, true);
      assert.equal(primarySession.server.version, "10.11.11");
    });

    const primaryContext = primaryApi.getAuthenticatedSocketContext();
    const suffix = randomBytes(5).toString("hex");
    const peerName = `syncplay-w3-${suffix}`;
    const peerPassword = randomBytes(24).toString("base64url");
    const created = await adminJson(primaryContext, "/Users/New", {
      method: "POST",
      body: { Name: peerName, Password: peerPassword },
    });
    temporaryUserId = created.Id;
    await adminJson(primaryContext, `/Users/${encodeURIComponent(temporaryUserId)}/Policy`, {
      method: "POST",
      body: { ...created.Policy, SyncPlayAccess: "CreateAndJoinGroups" },
      expectJson: false,
    });

    const peerIdentity = await new DeviceIdentityService(
      peerRoot,
      `${app.getName()} Acceptance Peer`,
      packageJson.name,
      packageJson.version,
    ).get();
    const unavailableProtector = {
      async isAvailable() { return false; },
      async encrypt() { throw coded("PEER_PERSISTENCE_DISABLED"); },
      async decrypt() { throw coded("PEER_PERSISTENCE_DISABLED"); },
    };
    const peerApi = new JellyfinApi(
      peerIdentity,
      new SecureSessionStore(peerRoot, unavailableProtector),
      async () => undefined,
    );
    const connection = await peerApi.connect(primaryContext.serverAddress);
    const peerSession = await peerApi.login(connection.connectionId, peerName, peerPassword, false);
    assert.equal(peerSession.authenticated, true);

    const primaryPlayer = createPlayer("local");
    const peerPlayer = createPlayer("server");
    const logger = { info() {}, warn() {}, error() {} };
    primaryService = new SyncPlayService(primaryApi, primaryPlayer, logger, 60000);
    peerService = new SyncPlayService(peerApi, peerPlayer, logger, 60000);

    await test("two actual SyncPlayService clients establish authenticated sockets", async () => {
      const [primaryState, peerState] = await Promise.all([primaryService.activate(), peerService.activate()]);
      assert.equal(primaryState.connection, "connected");
      assert.equal(peerState.connection, "connected");
    });

    const groupName = `LocalFirst W3 ${suffix}`;
    let groupId;
    await test("a created group is discoverable and joinable by the second service", async () => {
      const createdState = await primaryService.create(groupName);
      groupId = createdState.joinedGroup?.groupId;
      assert.ok(groupId);
      const discovered = await peerService.list();
      assert.ok(discovered.groups.some((group) => group.groupId === groupId && group.name === groupName));
      const joined = await peerService.join(groupId);
      assert.equal(joined.joinedGroup?.groupId, groupId);
      await waitFor(() => primaryService.getState().joinedGroup?.participantCount === 2);
    });

    let selectedItem;
    await test("the exact item ID resolves independently to local and server playback", async () => {
      const movies = await primaryApi.getLibraryItems("Movie", 25);
      selectedItem = movies.find((item) => item.id);
      assert.ok(selectedItem, "A playable movie is required for live SyncPlay acceptance.");
      const selected = await primaryService.selectItem(selectedItem.id, "start-over");
      assert.equal(selected.source, "local");
      await waitFor(() => peerPlayer.getState().itemId === selectedItem.id);
      assert.equal(primaryPlayer.getState().source, "local");
      assert.equal(peerPlayer.getState().source, "server");
      assert.equal(peerService.getState().joinedGroup?.currentItemId, selectedItem.id);
    });

    await test("pause initiated by the peer converges without a feedback loop", async () => {
      await peerService.requestPaused(false);
      await waitFor(() => !primaryPlayer.getState().paused && !peerPlayer.getState().paused);
      const primaryPauseCount = primaryPlayer.count("pause");
      const peerPauseCount = peerPlayer.count("pause");
      await peerService.requestPaused(true);
      await waitFor(() => primaryPlayer.getState().paused && peerPlayer.getState().paused);
      assert.equal(primaryPlayer.count("pause"), primaryPauseCount + 1);
      assert.equal(peerPlayer.count("pause"), peerPauseCount + 1);
    });

    await test("seek initiated by the creator converges on both players", async () => {
      const target = 90_000_000;
      await primaryService.requestSeek(target);
      await waitFor(() => primaryPlayer.getState().positionTicks === target && peerPlayer.getState().positionTicks === target);
      assert.equal(primaryPlayer.count("seek"), 1);
      assert.equal(peerPlayer.count("seek"), 1);
    });

    await test("leaving restores independent state and the empty group disappears", async () => {
      await peerService.leave();
      assert.equal(peerService.isJoined(), false);
      await primaryService.leave();
      assert.equal(primaryService.isJoined(), false);
      await waitFor(async () => !(await primaryService.list()).groups.some((group) => group.groupId === groupId));
    });

    assert.equal(passed, TEST_COUNT);
    process.stdout.write(`1..${TEST_COUNT}\n# ${passed} passed, 0 failed\n`);
  } finally {
    await peerService?.deactivate().catch(() => undefined);
    await primaryService?.deactivate().catch(() => undefined);
    if (temporaryUserId && primaryApi) {
      const context = primaryApi.getAuthenticatedSocketContext();
      await adminJson(context, `/Users/${encodeURIComponent(temporaryUserId)}`, { method: "DELETE", expectJson: false }).catch(() => undefined);
    }
    rmSync(peerRoot, { recursive: true, force: true });
    app.exit(passed === TEST_COUNT ? 0 : 1);
  }
}

function createPlayer(source) {
  const listeners = new Set();
  const actions = [];
  let rate = 1;
  let revision = 0;
  let state = {
    playbackId: null, itemId: null, phase: "idle", source: null,
    positionTicks: 0, durationTicks: 600_000_000, paused: true, buffering: false,
    seekable: true, fullscreen: false, audioTracks: [], subtitleTracks: [], error: null,
  };
  const snapshot = () => structuredClone(state);
  return {
    onState() { return () => undefined; },
    onEvent(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    getState: snapshot,
    getControllerRevision: () => revision,
    getPlaybackRate: () => rate,
    count: (action) => actions.filter((value) => value === action).length,
    async loadItem(itemId) {
      revision += 1;
      state = { ...state, playbackId: randomUUID(), itemId, phase: "playing", source, positionTicks: 0, paused: false };
      actions.push("load-item");
      return { playbackId: state.playbackId, resumePositionTicks: 0, durationTicks: state.durationTicks, source };
    },
    async setPaused(_playbackId, paused) {
      revision += 1;
      state = { ...state, paused, phase: paused ? "paused" : "playing" };
      actions.push(paused ? "pause" : "play");
      return snapshot();
    },
    async seek(_playbackId, positionTicks) { revision += 1; state = { ...state, positionTicks }; actions.push("seek"); return snapshot(); },
    async setPlaybackRate(_playbackId, value) { rate = value; return snapshot(); },
    async selectAudio() { return snapshot(); },
    async selectSubtitle() { return snapshot(); },
    async setFullscreen(_playbackId, fullscreen) { state = { ...state, fullscreen }; return snapshot(); },
    async stop() { revision += 1; state = { ...state, playbackId: null, itemId: null, phase: "stopped", source: null, paused: true }; actions.push("stop"); return snapshot(); },
    async clear() { state = { ...state, playbackId: null, itemId: null, phase: "idle", source: null, paused: true }; },
  };
}

async function adminJson(context, path, options = {}) {
  const headers = { Accept: "application/json", "X-Emby-Authorization": context.authorizationHeader };
  let body;
  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(options.body);
  }
  const response = await fetch(`${context.serverAddress.replace(/\/$/, "")}${path}`, { method: options.method || "GET", headers, body });
  if (!response.ok) throw coded(`HTTP_${response.status}`);
  if (options.expectJson === false || response.status === 204 || response.headers.get("content-length") === "0") return null;
  return response.json();
}

async function waitFor(predicate, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw coded("WAIT_TIMEOUT");
}

function findProductionUserData(packageJson) {
  const candidates = [];
  if (process.env.LOCALAPPDATA) candidates.push(join(process.env.LOCALAPPDATA, packageJson.productName || packageJson.name));
  if (process.env.APPDATA) candidates.push(join(dirname(process.env.APPDATA), "Local", packageJson.productName || packageJson.name));
  for (const drive of ["C", "D", "E", "F"]) candidates.push(`${drive}:\\user\\lost\\${packageJson.productName || packageJson.name}`);
  return candidates.find((candidate) => existsSync(join(candidate, "session.safe"))) || null;
}

function coded(code) { const error = new Error(code); error.code = code; return error; }
function safeCode(error) { return String(error?.code || error?.message || "UNKNOWN").replace(/[^A-Z0-9_.-]/gi, "_").slice(0, 120); }
