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

test("schema v1 upgrades additively to v3 while preserving existing rows", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "lf-sqlite-v1-upgrade-"));
  const databasePath = path.join(directory, "localfirst.sqlite3");
  const v1Schema = await fs.readFile(path.join(__dirname, "fixtures", "persistence-schema-v1.sql"), "utf8");
  const seed = new DatabaseSync(databasePath);
  try {
    seed.exec(v1Schema);
    seed.prepare("INSERT INTO servers VALUES (?, ?, ?, ?, ?)").run("server-v1", "http://127.0.0.1:8096", "Server", 1, 1);
    seed.prepare("INSERT INTO profiles VALUES (?, ?, ?, ?, ?)").run("server-v1", "user-v1", "Viewer", 1, 1);
    seed.prepare("INSERT INTO media_items VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
      "server-v1", "user-v1", "episode-v1", "Episode", "Episode", "series-v1", "season-v1", 1_000, 1, 1,
    );
    seed.prepare("INSERT INTO media_sources VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
      "server-v1", "user-v1", "episode-v1", "source-v1", "mkv", 100, 1, 1,
    );
    seed.prepare(`INSERT INTO download_jobs(
      download_id, server_id, user_id, item_id, media_source_id, origin, state,
      smart_managed, keep_downloaded, quality_profile, bytes_downloaded, expected_size,
      retry_count, error_code, error_message, created_at, updated_at, completed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      "download-v1", "server-v1", "user-v1", "episode-v1", "source-v1", "manual", "paused",
      0, 1, "original", 100, 100, 0, null, null, 1, 1, null,
    );
    seed.prepare(`INSERT INTO local_versions(
      local_version_id, server_id, user_id, item_id, media_source_id, download_id,
      storage_root, local_path, path_key, origin, smart_managed, keep_downloaded,
      file_state, probe_state, expected_size, actual_size, container, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      "local-v1", "server-v1", "user-v1", "episode-v1", "source-v1", "download-v1",
      "C:\\Synthetic", "C:\\Synthetic\\media.mkv", "c:\\synthetic\\media.mkv", "manual", 0, 1,
      "finalized", "valid", 100, 100, "mkv", 1, 1,
    );
    seed.prepare("INSERT INTO playback_heads VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
      "server-v1", "user-v1", "episode-v1", 1, "progress", 400, 0, 1, 0, 0, 0, 1,
    );
    seed.prepare(`INSERT INTO playback_revisions(
      server_id, user_id, item_id, local_revision, action_kind, position_ticks,
      watched, completion_event, occurred_at, sync_state, attempt_count, last_error, synced_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      "server-v1", "user-v1", "episode-v1", 1, "progress", 400, 0, 0, 1, "pending", 0, null, null,
    );
  } finally {
    seed.close();
  }

  const service = new SqlitePersistenceService(directory);
  try {
    assert.equal((await service.open()).schemaVersion, 3);
    const bundle = await service.getDownloadBundle("download-v1");
    assert.equal(bundle.job.state, "paused");
    assert.equal(bundle.localVersion.localVersionId, "local-v1");
    const head = await service.getPlaybackHead("server-v1", "user-v1", "episode-v1");
    assert.deepEqual(
      { latestRevision: head.latestRevision, positionTicks: head.positionTicks, conflictPolicy: head.conflictPolicy },
      { latestRevision: 1, positionTicks: 400, conflictPolicy: "automatic" },
    );
    const [legacyRevision] = await service.listPendingProgressForIdentity("server-v1", "user-v1", 10);
    assert.equal(legacyRevision.localRevision, 1);
    assert.equal(legacyRevision.report, null);
    const v3Revision = await service.recordPlaybackRevision({
      serverId: "server-v1",
      userId: "user-v1",
      itemId: "episode-v1",
      actionKind: "progress",
      positionTicks: 500,
      watched: false,
      occurredAt: 2,
      report: {
        kind: "progress",
        mediaSourceId: "source-v1",
        playMethod: "DirectPlay",
        playSessionId: "session-v2",
        paused: false,
        canSeek: true,
        audioStreamIndex: null,
        subtitleStreamIndex: null,
        conflictPolicy: "automatic",
      },
    });
    assert.equal(v3Revision.localRevision, 2);
    assert.equal(v3Revision.report.playSessionId, "session-v2");
    assert.equal(v3Revision.report.conflictPolicy, "automatic");
  } finally {
    await service.close();
  }

  const verify = new DatabaseSync(databasePath, { readOnly: true });
  try {
    assert.equal(verify.prepare("PRAGMA user_version").get().user_version, 3);
    const columns = verify.prepare("PRAGMA table_info(playback_revisions)").all().map((row) => row.name);
    for (const name of [
      "report_kind", "report_media_source_id", "report_play_method", "report_play_session_id",
      "report_paused", "report_can_seek", "report_audio_stream_index", "report_subtitle_stream_index",
      "report_conflict_policy",
    ]) assert.ok(columns.includes(name), name);
    assert.equal(verify.prepare("SELECT COUNT(*) AS count FROM download_jobs").get().count, 1);
    assert.equal(verify.prepare("SELECT COUNT(*) AS count FROM local_versions").get().count, 1);
    assert.equal(verify.prepare("SELECT COUNT(*) AS count FROM playback_revisions").get().count, 2);
  } finally {
    verify.close();
  }
});

test("SQLite runs off the main thread with WAL, foreign keys, migrations, and integrity checks", async () => {
  const { directory, service } = await createSeededService();
  try {
    const health = await service.health();
    assert.equal(health.schemaVersion, 3);
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
    assert.equal(database.prepare("PRAGMA user_version").get().user_version, 3);
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

test("authoritative playback reports survive a SQLite close and reopen", async () => {
  const { directory, service } = await createSeededService("lf-report-roundtrip-");
  const report = {
    kind: "progress",
    mediaSourceId: "source-1",
    playMethod: "DirectStream",
    playSessionId: "play-session-1",
    paused: true,
    canSeek: true,
    audioStreamIndex: 2,
    subtitleStreamIndex: 4,
    conflictPolicy: "explicit",
  };
  try {
    const captured = await service.recordPlaybackRevision({
      serverId: identity.serverId,
      userId: identity.userId,
      itemId: media.itemId,
      actionKind: "progress",
      positionTicks: 123_000_000,
      watched: false,
      occurredAt: 1000,
      report,
    });
    assert.deepEqual(captured.report, report);
    await service.recordPlaybackRevision({
      serverId: identity.serverId,
      userId: identity.userId,
      itemId: media.itemId,
      actionKind: "progress",
      positionTicks: 130_000_000,
      watched: false,
      occurredAt: 1100,
      report: { ...report, paused: false, conflictPolicy: "automatic" },
    });
    const pendingHead = await service.getPlaybackHead(identity.serverId, identity.userId, media.itemId);
    assert.equal(pendingHead.positionTicks, 130_000_000);
    assert.equal(pendingHead.conflictPolicy, "explicit");
  } finally {
    await service.close();
  }

  const reopened = new SqlitePersistenceService(directory);
  try {
    await reopened.open();
    const pending = await reopened.listPendingProgress();
    const captured = pending[0];
    assert.deepEqual(captured.report, report);
    assert.equal(captured.positionTicks, 123_000_000);
    assert.equal((await reopened.getPlaybackHead(identity.serverId, identity.userId, media.itemId)).conflictPolicy, "explicit");
    await reopened.markProgressSucceeded(identity.serverId, identity.userId, media.itemId, captured.localRevision, 1200);
    assert.equal((await reopened.getPlaybackHead(identity.serverId, identity.userId, media.itemId)).conflictPolicy, "automatic");
  } finally {
    await reopened.close();
  }
});

test("pending playback selection applies identity scope before its limit", async () => {
  const { service } = await createSeededService("lf-pending-scope-");
  const otherIdentity = {
    serverId: "server-2",
    serverAddress: "http://127.0.0.2:8096",
    serverName: "Other Server",
    userId: "user-2",
    userName: "Other Viewer",
  };
  const otherMedia = {
    ...media,
    serverId: otherIdentity.serverId,
    userId: otherIdentity.userId,
    itemId: "episode-other",
  };
  try {
    await service.upsertCatalogIdentity(otherIdentity);
    await service.upsertMediaItem(otherMedia);
    await service.recordPlaybackRevision({
      serverId: otherIdentity.serverId,
      userId: otherIdentity.userId,
      itemId: otherMedia.itemId,
      actionKind: "progress",
      positionTicks: 100,
      watched: false,
      occurredAt: 1,
    });
    const current = await service.recordPlaybackRevision({
      serverId: identity.serverId,
      userId: identity.userId,
      itemId: media.itemId,
      actionKind: "progress",
      positionTicks: 200,
      watched: false,
      occurredAt: 2,
    });

    const [globalFirst] = await service.listPendingProgress(1);
    assert.equal(globalFirst.serverId, otherIdentity.serverId);
    const [scopedFirst] = await service.listPendingProgressForIdentity(identity.serverId, identity.userId, 1);
    assert.equal(scopedFirst.serverId, identity.serverId);
    assert.equal(scopedFirst.localRevision, current.localRevision);
  } finally {
    await service.close();
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
