"use strict";

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { copyFile, mkdir, mkdtemp, rm, stat, writeFile } = require("node:fs/promises");
const { existsSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { LocalPlaybackResolver } = require("../dist/main/services/localPlaybackResolver.js");
const { MediaProbeService } = require("../dist/main/services/mediaProbe.js");
const { MpvPlayerService } = require("../dist/main/services/mpvPlayer.js");
const { OfflineSynchronizationService } = require("../dist/main/services/offlineSynchronization.js");
const { PlaybackReportingService } = require("../dist/main/services/playbackReporting.js");
const { PlaybackSessionService } = require("../dist/main/services/playbackSession.js");
const { SqlitePersistenceService } = require("../dist/main/services/persistence.js");

const TICKS_PER_SECOND = 10_000_000;
const root = resolve(__dirname, "..");
const runtime = {
  executable: join(root, ".runtime", "mpv", "mpv.exe"),
  inputConfig: join(root, "assets", "mpv", "input.conf"),
};
const sourceFixture = join(root, ".runtime", "mpv-adapter-acceptance.mkv");
const identity = {
  serverId: "gate6-isolated-server",
  serverAddress: "http://127.0.0.1:1",
  serverName: "Isolated unavailable fixture",
  userId: "gate6-isolated-user",
  userName: "Offline QA",
};
const item = {
  id: "gate6-offline-episode",
  name: "The Offline Gate",
  type: "Episode",
  overview: "Isolated cached metadata for autonomous Gate 6 acceptance.",
  productionYear: 2026,
  premiereYear: 2026,
  officialRating: null,
  communityRating: null,
  runTimeTicks: 12 * TICKS_PER_SECOND,
  genres: ["Adventure"],
  primaryImageAspectRatio: null,
  imageTags: { Primary: "gate6-primary-tag" },
  backdropImageTag: "gate6-backdrop-tag",
  parentThumbItemId: "gate6-series",
  parentThumbImageTag: "gate6-thumb-tag",
  seriesId: "gate6-series",
  seriesName: "Offline QA Series",
  seasonId: "gate6-season",
  indexNumber: 1,
  parentIndexNumber: 1,
  userData: { played: false, playbackPositionTicks: 0, playedPercentage: 0 },
  hasTrailer: false,
  playable: true,
};
const logger = { info() {}, warn() {}, error() {} };

void run().catch((error) => {
  process.stderr.write(`Gate 6 offline runtime acceptance failed: ${safeFailure(error)}\n`);
  process.exitCode = 1;
});

async function run() {
  assert.equal(existsSync(runtime.executable), true, "The pinned mpv runtime is unavailable.");
  assert.equal(existsSync(sourceFixture), true, "The isolated local media fixture is unavailable.");
  const sourceRevision = git(["rev-parse", "HEAD"]);
  const sourceTree = git(["status", "--porcelain"]) ? "working-tree" : "clean";
  const directory = await mkdtemp(join(tmpdir(), "seeing-stone-gate6-runtime-"));
  const storageRoot = join(directory, "verified-local");
  const localPath = join(storageRoot, "media.mkv");
  const persistence = new SqlitePersistenceService(join(directory, "data"));
  let player = null;
  let synchronization = null;
  try {
    await mkdir(storageRoot, { recursive: true });
    await copyFile(sourceFixture, localPath);
    const file = await stat(localPath);
    await persistence.open();
    await persistence.upsertCatalogIdentity(identity);
    await persistence.upsertMediaItem({
      serverId: identity.serverId,
      userId: identity.userId,
      itemId: item.id,
      itemType: "Episode",
      name: item.name,
      seriesId: item.seriesId,
      seasonId: item.seasonId,
      runTimeTicks: item.runTimeTicks,
      metadata: item,
    });
    await persistence.upsertMediaSource({
      serverId: identity.serverId,
      userId: identity.userId,
      itemId: item.id,
      mediaSourceId: "gate6-source",
      container: "mkv",
      expectedSize: file.size,
      diagnostics: {
        sourceKind: "downloaded",
        playbackRate: 1,
        bufferAheadTicks: null,
        container: "mkv",
        videoCodec: "mpeg4",
        audioCodec: "aac",
        audioChannels: "2.0",
        resolution: "640×360",
        bitrate: null,
        videoRange: "SDR",
        transcodeReason: null,
      },
    });
    await persistence.registerLocalVersion({
      serverId: identity.serverId,
      userId: identity.userId,
      itemId: item.id,
      mediaSourceId: "gate6-source",
      downloadId: null,
      storageRoot,
      localPath,
      origin: "imported",
      smartManaged: false,
      keepDownloaded: true,
      fileState: "finalized",
      probeState: "valid",
      expectedSize: file.size,
      actualSize: file.size,
      container: "mkv",
    });

    let playbackJellyfinCalls = 0;
    const playbackApi = {
      getAuthenticatedContext: () => identity,
      getConnectionDiagnostics: () => ({ state: "offline", serverName: identity.serverName, serverVersion: "fixture", requestLatencyMs: null, measuredAt: null }),
      getDetails: async () => { playbackJellyfinCalls += 1; throw new Error("offline fixture"); },
      getMediaSourceCapabilities: async () => { playbackJellyfinCalls += 1; throw new Error("offline fixture"); },
      fetchStaticStream: async () => { playbackJellyfinCalls += 1; throw new Error("offline fixture"); },
      fetchTranscodedStream: async () => { playbackJellyfinCalls += 1; throw new Error("offline fixture"); },
      fetchExternalSubtitle: async () => { playbackJellyfinCalls += 1; throw new Error("offline fixture"); },
    };
    let connected = false;
    let reportingJellyfinCalls = 0;
    const synchronizedReports = [];
    const synchronizationApi = {
      getAuthenticatedContext: () => identity,
      getConnectionDiagnostics: () => ({ state: connected ? "connected" : "offline", serverName: identity.serverName, serverVersion: "fixture", requestLatencyMs: connected ? 1 : null, measuredAt: null }),
      getDetails: async () => {
        reportingJellyfinCalls += 1;
        if (!connected) throw new Error("isolated outage");
        return item;
      },
      synchronizeOfflinePlayback: async (input) => {
        reportingJellyfinCalls += 1;
        if (!connected) throw new Error("isolated outage");
        synchronizedReports.push({ kind: "revision", positionTicks: input.positionTicks });
      },
      reportAuthoritativePlayback: async (input) => {
        reportingJellyfinCalls += 1;
        if (!connected) throw new Error("isolated outage");
        synchronizedReports.push({ kind: input.kind, positionTicks: input.positionTicks });
      },
    };
    const probe = new MediaProbeService(runtime, 15_000);
    const localResolver = new LocalPlaybackResolver(playbackApi, persistence, probe, [storageRoot], 25);
    const playback = new PlaybackSessionService(playbackApi, localResolver, persistence);
    synchronization = new OfflineSynchronizationService(synchronizationApi, persistence, logger, 60_000);
    synchronization.activate();
    const reporting = new PlaybackReportingService(synchronizationApi, synchronization, logger);
    const window = createWindowFixture();
    player = new MpvPlayerService(
      window,
      playback,
      reporting,
      { get: async () => ({ windowMaximized: true }), setWindowMaximized: async () => undefined },
      runtime,
    );
    const spawnProcess = player.spawnProcess.bind(player);
    player.spawnProcess = (executable, args) => {
      const separator = args.indexOf("--");
      const optionsEnd = separator < 0 ? args.length : separator;
      return spawnProcess(executable, [
        ...args.slice(0, optionsEnd),
        "--force-window=no",
        "--vo=null",
        "--ao=null",
        ...args.slice(optionsEnd),
      ]);
    };

    const started = await player.start(item.id, "resume");
    assert.equal(started.source, "local");
    assert.equal(started.sourceKind, "offline-local");
    assert.equal(playbackJellyfinCalls, 0, "Offline local resolution made a Jellyfin request.");
    assert.equal(reportingJellyfinCalls, 0, "Offline playback start made a Jellyfin reporting request.");
    await waitFor(() => player.getState().phase === "playing" && player.getState().positionTicks >= 3_000_000, 15_000);
    const advancedPositionTicks = player.getState().positionTicks;
    await player.stop(started.playbackId);
    assert.equal(reportingJellyfinCalls, 0, "Offline playback stop made a Jellyfin reporting request.");
    const pendingBeforeReconnect = await persistence.listPendingProgressForIdentity(identity.serverId, identity.userId, 100);
    assert.ok(pendingBeforeReconnect.length >= 2, "Offline playback did not leave durable lifecycle reports queued.");
    const reportingJellyfinCallsBeforeReconnect = reportingJellyfinCalls;

    connected = true;
    await synchronization.syncNow();
    const pendingAfterReconnect = await persistence.listPendingProgressForIdentity(identity.serverId, identity.userId, 100);
    assert.equal(pendingAfterReconnect.length, 0, "Queued playback reports did not synchronize after isolated reconnection.");
    assert.ok(synchronizedReports.some((entry) => entry.kind === "start"));
    assert.ok(synchronizedReports.some((entry) => entry.kind === "stop"));
    const head = await persistence.getPlaybackHead(identity.serverId, identity.userId, item.id);
    assert.equal(head.lastSucceededRevision, head.latestRevision);

    const outputDirectory = join(root, "artifacts", "gate-6");
    await mkdir(outputDirectory, { recursive: true });
    const report = {
      schemaVersion: 1,
      gate: 6,
      fixture: "isolated-real-mpv-offline-reconnect",
      sourceRevision,
      sourceTree,
      assertions: {
        verifiedLocalLaunch: true,
        sourceKind: started.sourceKind,
        playbackJellyfinRequestsBeforeReconnect: playbackJellyfinCalls,
        reportingJellyfinRequestsBeforeReconnect: reportingJellyfinCallsBeforeReconnect,
        mpvAdvancedPosition: advancedPositionTicks > 0,
        durableReportsBeforeReconnect: pendingBeforeReconnect.length,
        pendingReportsAfterReconnect: pendingAfterReconnect.length,
        synchronizedStart: synchronizedReports.some((entry) => entry.kind === "start"),
        synchronizedStop: synchronizedReports.some((entry) => entry.kind === "stop"),
        localPathExposed: false,
      },
    };
    await writeFile(join(outputDirectory, "offline-runtime-acceptance.json"), `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write("Gate 6 offline runtime acceptance passed (real mpv, zero pre-reconnect Jellyfin requests, durable reconnect sync).\n");
  } finally {
    if (player?.getState().playbackId) await player.stop(player.getState().playbackId).catch(() => undefined);
    await synchronization?.shutdown().catch(() => undefined);
    await persistence.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

function createWindowFixture() {
  return {
    minimized: false,
    isDestroyed: () => false,
    minimize() { this.minimized = true; },
    isMinimized() { return this.minimized; },
    restore() { this.minimized = false; },
    show() {},
    focus() {},
  };
}

async function waitFor(predicate, timeoutMilliseconds) {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  throw new Error("Timed out waiting for isolated real mpv playback.");
}

function git(args) {
  try { return execFileSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true }).trim(); }
  catch { return "unavailable"; }
}

function safeFailure(error) {
  return String(error?.stack || error?.message || error || "Unknown failure")
    .replace(/https?:\/\/[^\s"')]+/gi, "<url>")
    .replace(/[A-Za-z]:[\\/][^\r\n"')]+/g, "<path>")
    .slice(0, 1200);
}
