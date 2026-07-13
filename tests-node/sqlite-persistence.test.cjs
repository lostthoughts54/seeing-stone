const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { DatabaseSync } = require("node:sqlite");
const { OfflineSynchronizationService } = require("../dist/main/services/offlineSynchronization.js");
const { SqlitePersistenceService } = require("../dist/main/services/persistence.js");

const identity = {
  serverId: "server-1",
  serverAddress: "http://127.0.0.1:8096",
  serverName: "Server",
  userId: "user-1",
  userName: "Viewer",
};

const media = {
  serverId: identity.serverId,
  userId: identity.userId,
  itemId: "episode-1",
  itemType: "Episode",
  name: "Episode 1",
  seriesId: "series-1",
  seasonId: "season-1",
  runTimeTicks: 1_800_000_000,
};

const source = {
  serverId: identity.serverId,
  userId: identity.userId,
  itemId: media.itemId,
  mediaSourceId: "source-1",
  container: "mkv",
  expectedSize: 100,
};

async function createSeededService(prefix = "lf-sqlite-") {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const service = new SqlitePersistenceService(directory);
  await service.open();
  await service.upsertCatalogIdentity(identity);
  await service.upsertMediaItem(media);
  await service.upsertMediaSource(source);
  return { directory, service };
}

test("SQLite runs off the main thread with WAL, foreign keys, migrations, and integrity checks", async () => {
  const { directory, service } = await createSeededService();
  try {
    const health = await service.health();
    assert.equal(health.schemaVersion, 1);
    assert.equal(health.journalMode, "wal");
    assert.equal(health.foreignKeys, true);
    assert.equal(health.quickCheck, "ok");
    assert.ok(health.workerThreadId > 0);
    const storedMedia = await service.getMediaItem(identity.serverId, identity.userId, media.itemId);
    assert.deepEqual({
      serverId: storedMedia.serverId,
      userId: storedMedia.userId,
      itemId: storedMedia.itemId,
      itemType: storedMedia.itemType,
      name: storedMedia.name,
      seriesId: storedMedia.seriesId,
      seasonId: storedMedia.seasonId,
      runTimeTicks: storedMedia.runTimeTicks,
    }, media);
    assert.ok(storedMedia.createdAt > 0 && storedMedia.updatedAt >= storedMedia.createdAt);
  } finally {
    await service.close();
  }

  const databasePath = path.join(directory, "localfirst.sqlite3");
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    assert.equal(database.prepare("PRAGMA user_version").get().user_version, 1);
    const tables = database.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name").all().map((row) => row.name);
    for (const expected of [
      "download_jobs", "local_versions", "media_items", "media_sources", "playback_heads",
      "playback_revisions", "profiles", "servers",
    ]) assert.ok(tables.includes(expected), expected);
  } finally {
    database.close();
  }
});

test("download state is durable, rejects invalid transitions and duplicates, and recovers interruption as paused", async () => {
  const { directory, service } = await createSeededService();
  let download;
  let smartDownloadId;
  try {
    download = await service.createDownload({
      serverId: identity.serverId,
      userId: identity.userId,
      itemId: media.itemId,
      mediaSourceId: source.mediaSourceId,
      origin: "manual",
      smartManaged: false,
      keepDownloaded: true,
      qualityProfile: "original",
      expectedSize: 100,
    });
    assert.match(download.downloadId, /^[0-9a-f-]{36}$/);
    assert.equal(download.state, "queued");
    assert.equal(download.keepDownloaded, true);
    assert.equal(download.smartManaged, false);

    const smart = await service.createDownload({
      serverId: identity.serverId,
      userId: identity.userId,
      itemId: media.itemId,
      mediaSourceId: source.mediaSourceId,
      origin: "smart",
      smartManaged: true,
      keepDownloaded: false,
      qualityProfile: "mobile",
      expectedSize: 100,
    });
    assert.equal(smart.origin, "smart");
    assert.equal(smart.smartManaged, true);
    assert.equal(smart.keepDownloaded, false);
    smartDownloadId = smart.downloadId;

    await assert.rejects(service.createDownload({
      ...download,
      downloadId: "duplicate-job",
    }), { code: "PERSISTENCE_CONSTRAINT" });

    const active = await service.transitionDownload({ downloadId: download.downloadId, state: "downloading", bytesDownloaded: 25 });
    assert.equal(active.bytesDownloaded, 25);
    await assert.rejects(
      service.transitionDownload({ downloadId: download.downloadId, state: "downloading", bytesDownloaded: 24 }),
      { code: "INVALID_DOWNLOAD_PROGRESS" },
    );
  } finally {
    await service.close();
  }

  const restarted = new SqlitePersistenceService(directory);
  try {
    await restarted.open();
    const recovered = await restarted.getDownload(download.downloadId);
    assert.equal(recovered.state, "paused");
    assert.equal(recovered.bytesDownloaded, 25);
    assert.equal(recovered.errorCode, "INTERRUPTED");
    assert.equal(recovered.keepDownloaded, true);
    const recoveredSmart = await restarted.getDownload(smartDownloadId);
    assert.equal(recoveredSmart.origin, "smart");
    assert.equal(recoveredSmart.smartManaged, true);
    assert.equal(recoveredSmart.keepDownloaded, false);
    assert.equal((await restarted.getDownload("duplicate-job")), null);
    await restarted.transitionDownload({ downloadId: download.downloadId, state: "downloading", bytesDownloaded: 25 });
    await assert.rejects(
      restarted.transitionDownload({ downloadId: download.downloadId, state: "completed", bytesDownloaded: 99 }),
      { code: "DOWNLOAD_SIZE_MISMATCH" },
    );
    const completed = await restarted.transitionDownload({ downloadId: download.downloadId, state: "completed", bytesDownloaded: 100 });
    assert.equal(completed.state, "completed");
    assert.ok(completed.completedAt > 0);
    await assert.rejects(
      restarted.transitionDownload({ downloadId: download.downloadId, state: "queued" }),
      { code: "INVALID_DOWNLOAD_TRANSITION" },
    );
  } finally {
    await restarted.close();
  }
});

test("local versions require path containment, expected size, finalized state, and successful probing", async () => {
  const { directory, service } = await createSeededService();
  const storageRoot = path.join(directory, "media");
  const localPath = path.join(storageRoot, "Series", "Episode 1.mp4");
  try {
    await assert.rejects(service.registerLocalVersion({
      serverId: identity.serverId,
      userId: identity.userId,
      itemId: media.itemId,
      mediaSourceId: source.mediaSourceId,
      downloadId: null,
      storageRoot,
      localPath: path.join(directory, "outside.mp4"),
      origin: "manual",
      smartManaged: false,
      keepDownloaded: true,
      fileState: "staging",
      probeState: "pending",
      expectedSize: 100,
      actualSize: null,
      container: "mp4",
    }), { code: "INVALID_LOCAL_PATH" });

    const staging = await service.registerLocalVersion({
      serverId: identity.serverId,
      userId: identity.userId,
      itemId: media.itemId,
      mediaSourceId: source.mediaSourceId,
      downloadId: null,
      storageRoot,
      localPath,
      origin: "manual",
      smartManaged: false,
      keepDownloaded: true,
      fileState: "staging",
      probeState: "pending",
      expectedSize: 100,
      actualSize: null,
      container: "mp4",
    });
    assert.equal(staging.localPath, path.resolve(localPath));
    await assert.rejects(service.updateLocalVersion({
      localVersionId: staging.localVersionId,
      fileState: "finalized",
      probeState: "valid",
      actualSize: 99,
    }), { code: "LOCAL_VERSION_NOT_VERIFIED" });
    const finalized = await service.updateLocalVersion({
      localVersionId: staging.localVersionId,
      fileState: "finalized",
      probeState: "valid",
      actualSize: 100,
    });
    assert.equal(finalized.fileState, "finalized");
    assert.equal(finalized.probeState, "valid");
    assert.equal((await service.listLocalVersions(identity.serverId, identity.userId, media.itemId)).length, 1);
  } finally {
    await service.close();
  }
});

test("playback revisions preserve completion and allow newer explicit lower positions without stale success rollback", async () => {
  const { directory, service } = await createSeededService();
  try {
    const first = await service.recordPlaybackRevision({
      serverId: identity.serverId,
      userId: identity.userId,
      itemId: media.itemId,
      actionKind: "progress",
      positionTicks: 500_000_000,
      watched: false,
      occurredAt: 1000,
    });
    const completed = await service.recordPlaybackRevision({
      serverId: identity.serverId,
      userId: identity.userId,
      itemId: media.itemId,
      actionKind: "completed",
      positionTicks: media.runTimeTicks,
      watched: true,
      occurredAt: 2000,
    });
    const startOver = await service.recordPlaybackRevision({
      serverId: identity.serverId,
      userId: identity.userId,
      itemId: media.itemId,
      actionKind: "start_over",
      positionTicks: 0,
      watched: false,
      occurredAt: 3000,
    });
    assert.deepEqual([first.localRevision, completed.localRevision, startOver.localRevision], [1, 2, 3]);
    assert.equal(completed.completionEvent, true);

    await service.markProgressSucceeded(identity.serverId, identity.userId, media.itemId, completed.localRevision, 4000);
    await service.markProgressSucceeded(identity.serverId, identity.userId, media.itemId, first.localRevision, 5000);
    const head = await service.getPlaybackHead(identity.serverId, identity.userId, media.itemId);
    assert.equal(head.latestRevision, 3);
    assert.equal(head.positionTicks, 0);
    assert.equal(head.watched, false);
    assert.equal(head.lastSucceededRevision, 2);
    assert.equal(head.lastSucceededPositionTicks, media.runTimeTicks);
    assert.equal(head.lastSucceededWatched, true);

    const failedStartOver = await service.markProgressFailed(
      identity.serverId, identity.userId, media.itemId, startOver.localRevision, "NETWORK_ERROR",
    );
    assert.equal(failedStartOver.syncState, "failed");
    assert.equal(failedStartOver.attemptCount, 1);
    assert.equal(failedStartOver.lastError, "NETWORK_ERROR");

    const concurrent = await Promise.all(Array.from({ length: 20 }, (_, index) => service.recordPlaybackRevision({
      serverId: identity.serverId,
      userId: identity.userId,
      itemId: media.itemId,
      actionKind: "progress",
      positionTicks: index,
      watched: false,
      occurredAt: 6000 + index,
    })));
    assert.equal(new Set(concurrent.map((entry) => entry.localRevision)).size, 20);
    assert.equal((await service.getPlaybackHead(identity.serverId, identity.userId, media.itemId)).latestRevision, 23);
    const superseded = await service.markPlaybackSuperseded(
      identity.serverId, identity.userId, media.itemId, concurrent[0].localRevision,
    );
    assert.equal(superseded.syncState, "superseded");
    const pending = await service.listPendingProgress();
    assert.ok(pending.some((entry) => entry.localRevision === startOver.localRevision));
    assert.equal(pending.some((entry) => entry.localRevision === completed.localRevision), false);
    assert.equal(pending.some((entry) => entry.localRevision === concurrent[0].localRevision), false);
  } finally {
    await service.close();
  }

  const reopened = new SqlitePersistenceService(directory);
  try {
    await reopened.open();
    assert.equal((await reopened.getPlaybackHead(identity.serverId, identity.userId, media.itemId)).latestRevision, 23);
  } finally {
    await reopened.close();
  }
});

test("corrupt or newer databases are preserved and refused rather than silently replaced", async () => {
  const corruptDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "lf-sqlite-corrupt-"));
  const corruptPath = path.join(corruptDirectory, "localfirst.sqlite3");
  const corruptBytes = Buffer.from("not-a-sqlite-database");
  await fs.writeFile(corruptPath, corruptBytes);
  const corrupt = new SqlitePersistenceService(corruptDirectory);
  await assert.rejects(corrupt.open(), { code: "PERSISTENCE_CORRUPT" });
  assert.deepEqual(await fs.readFile(corruptPath), corruptBytes);
  await corrupt.close();

  const newerDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "lf-sqlite-newer-"));
  const newerPath = path.join(newerDirectory, "localfirst.sqlite3");
  const database = new DatabaseSync(newerPath);
  database.exec("PRAGMA user_version = 99");
  database.close();
  const newer = new SqlitePersistenceService(newerDirectory);
  await assert.rejects(newer.open(), { code: "PERSISTENCE_SCHEMA_NEWER" });
  const verify = new DatabaseSync(newerPath, { readOnly: true });
  assert.equal(verify.prepare("PRAGMA user_version").get().user_version, 99);
  verify.close();
  await newer.close();
});

test("offline playback survives a failed attempt and synchronizes after reconnect through the SQLite worker", async () => {
  const { service } = await createSeededService("lf-offline-sync-");
  let online = false;
  const sent = [];
  const synchronization = new OfflineSynchronizationService({
    getAuthenticatedContext: () => identity,
    getDetails: async () => ({
      userData: { played: false, playbackPositionTicks: 0 },
    }),
    synchronizeOfflinePlayback: async (input) => {
      if (!online) throw Object.assign(new Error("offline"), { code: "NETWORK_ERROR" });
      sent.push(input);
    },
  }, service, { info() {}, warn() {}, error() {} }, 1_000_000);
  try {
    const captured = await synchronization.capture({
      itemId: media.itemId,
      actionKind: "progress",
      positionTicks: 450_000_000,
      watched: false,
    });
    synchronization.activate();
    await synchronization.syncNow();
    let pending = await service.listPendingProgress();
    assert.deepEqual(pending.find((entry) => entry.localRevision === captured.localRevision), {
      ...captured,
      syncState: "failed",
      attemptCount: 1,
      lastError: "NETWORK_ERROR",
      syncedAt: null,
    });

    online = true;
    await synchronization.syncNow();
    pending = await service.listPendingProgress();
    assert.equal(pending.some((entry) => entry.localRevision === captured.localRevision), false);
    assert.deepEqual(sent, [{
      itemId: media.itemId,
      actionKind: "progress",
      positionTicks: 450_000_000,
      watched: false,
    }]);
    const head = await service.getPlaybackHead(identity.serverId, identity.userId, media.itemId);
    assert.equal(head.lastSucceededRevision, captured.localRevision);
    assert.equal(head.lastSucceededPositionTicks, 450_000_000);
    assert.equal(head.lastSucceededWatched, false);

    assert.deepEqual(await synchronization.setWatched(media.itemId, true), {
      itemId: media.itemId,
      watched: true,
      synchronization: "synchronized",
    });
    assert.deepEqual(await synchronization.setWatched(media.itemId, false), {
      itemId: media.itemId,
      watched: false,
      synchronization: "synchronized",
    });
    assert.deepEqual(sent.slice(1), [
      { itemId: media.itemId, actionKind: "mark_watched", positionTicks: 0, watched: true },
      { itemId: media.itemId, actionKind: "mark_unwatched", positionTicks: 0, watched: false },
    ]);
    const toggledHead = await service.getPlaybackHead(identity.serverId, identity.userId, media.itemId);
    assert.equal(toggledHead.lastSucceededRevision, captured.localRevision + 2);
    assert.equal(toggledHead.lastSucceededPositionTicks, 0);
    assert.equal(toggledHead.lastSucceededWatched, false);
  } finally {
    await synchronization.shutdown();
    await service.close();
  }
});
