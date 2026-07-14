const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { DownloadManager } = require("../dist/main/services/downloadManager.js");
const { AppError } = require("../dist/main/services/errors.js");
const { LocalPlaybackResolver } = require("../dist/main/services/localPlaybackResolver.js");
const { SqlitePersistenceService } = require("../dist/main/services/persistence.js");

const identity = {
  serverId: "download-server",
  serverAddress: "http://127.0.0.1:8096",
  serverName: "Test Server",
  userId: "download-user",
  userName: "Viewer",
};

const logger = { info() {}, warn() {}, error() {} };

function mediaItem(itemId) {
  return {
    id: itemId,
    name: `Title ${itemId}`,
    type: itemId.startsWith("movie") ? "Movie" : "Episode",
    seriesId: itemId.startsWith("movie") ? null : "series-1",
    seasonId: itemId.startsWith("movie") ? null : "season-1",
    runTimeTicks: 1_800_000_000,
    userData: { played: false, playbackPositionTicks: 0, playedPercentage: 0 },
  };
}

function createApi(content, options = {}) {
  return {
    getAuthenticatedContext: () => identity,
    getDetails: async (itemId) => mediaItem(itemId),
    getMediaSourceCapabilities: async (itemId) => ({
      itemId,
      sources: [{
        id: `source-${itemId}`,
        container: "mkv",
        size: options.omitExpectedSize ? null : content.length,
        supportsDirectPlay: true,
        supportsDirectStream: true,
        supportsTranscoding: true,
      }],
    }),
    fetchStaticStream: async (_itemId, _sourceId, range, signal) => {
      const match = /^bytes=(\d+)-$/.exec(range || "");
      const offset = match ? Number(match[1]) : 0;
      const body = options.slow
        ? new ReadableStream({
          start(controller) {
            let position = offset;
            const send = () => {
              if (signal?.aborted) {
                controller.error(new Error("aborted"));
                return;
              }
              if (position >= content.length) {
                controller.close();
                return;
              }
              const next = Math.min(content.length, position + 32 * 1024);
              controller.enqueue(content.subarray(position, next));
              position = next;
              setTimeout(send, 25);
            };
            setTimeout(send, 25);
          },
        })
        : content.subarray(offset);
      return new Response(body, {
        status: offset ? 206 : 200,
        headers: {
          "content-length": String(content.length - offset),
          ...(offset ? { "content-range": `bytes ${offset}-${content.length - 1}/${content.length}` } : {}),
        },
      });
    },
  };
}

async function waitForState(manager, itemId, state, timeout = 6000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const found = (await manager.list()).find((entry) => entry.itemId === itemId && entry.state === state);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`Timed out waiting for ${itemId} to reach ${state}.`);
}

async function fixture(api, probe, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "lf-download-manager-"));
  const storageRoot = path.join(directory, "downloads");
  const persistence = new SqlitePersistenceService(path.join(directory, "data"));
  await persistence.open();
  const manager = new DownloadManager(api, persistence, probe, storageRoot, logger, {
    storageReserveBytes: 0,
    ...options,
  });
  await manager.activate();
  return { directory, storageRoot, persistence, manager };
}

async function closeFixture(value) {
  await value.manager.shutdown();
  await value.persistence.close();
  await fs.rm(value.directory, { recursive: true, force: true });
}

test("manual download finalizes only after size and probe checks, exposes no path, and deletes explicitly", async () => {
  const content = Buffer.alloc(192 * 1024, 7);
  const api = createApi(content, { omitExpectedSize: true });
  const probe = {
    async probe(_root, target) {
      const file = await fs.stat(target);
      return { actualSize: file.size, container: "mkv" };
    },
  };
  const value = await fixture(api, probe);
  try {
    await value.manager.start("movie-1");
    const completed = await waitForState(value.manager, "movie-1", "downloaded");
    assert.equal(completed.expectedSize, content.length, "Content-Length becomes the durable expected size");
    assert.equal(completed.bytesDownloaded, content.length);
    assert.equal(completed.canDelete, true);
    assert.doesNotMatch(JSON.stringify(completed), /localPath|storageRoot|127\.0\.0\.1|token|\.mkv/i);

    const bundle = await value.persistence.getDownloadBundle(completed.downloadId);
    assert.deepEqual(await fs.readFile(bundle.localVersion.localPath), content);
    assert.equal(bundle.localVersion.fileState, "finalized");
    assert.equal(bundle.localVersion.probeState, "valid");

    const localPlayback = new LocalPlaybackResolver(api, value.persistence, probe, [value.storageRoot], 10);
    const resolved = await localPlayback.resolve("movie-1", "start-over");
    assert.equal(resolved.source, "local");
    assert.equal(resolved.delivery, "local");
    assert.equal(resolved.mediaSourceId, bundle.job.mediaSourceId);
    assert.equal(resolved.mediaUrl, bundle.localVersion.localPath);
    assert.equal(resolved.resumePositionTicks, 0);

    const kept = await value.manager.setKeep(completed.downloadId, true);
    assert.equal(kept.keepDownloaded, true);
    assert.equal((await value.persistence.getDownloadBundle(completed.downloadId)).localVersion.keepDownloaded, true);

    const deleted = await value.manager.delete(completed.downloadId);
    assert.equal(deleted.state, "missing");
    await assert.rejects(fs.stat(bundle.localVersion.localPath), { code: "ENOENT" });
  } finally {
    await closeFixture(value);
  }
});

test("downloads pause and resume through ranged transfer, cancel removes staging data, and retry re-probes", async () => {
  const content = Buffer.alloc(768 * 1024, 11);
  let probeAttempts = 0;
  const probe = {
    async probe(_root, target) {
      probeAttempts += 1;
      if (probeAttempts === 1) throw new AppError("MEDIA_PROBE_FAILED", "The downloaded file is not usable media.", 422);
      return { actualSize: (await fs.stat(target)).size, container: "mkv" };
    },
  };
  const value = await fixture(createApi(content, { slow: true }), probe);
  try {
    const first = await value.manager.start("episode-pause");
    await waitForState(value.manager, "episode-pause", "downloading");
    const paused = await value.manager.pause(first.downloadId);
    assert.equal(paused.state, "paused");
    await value.manager.resume(first.downloadId);
    await waitForState(value.manager, "episode-pause", "failed");
    await value.manager.retry(first.downloadId);
    await waitForState(value.manager, "episode-pause", "downloaded");
    assert.equal(probeAttempts, 2);

    const second = await value.manager.start("episode-cancel");
    await waitForState(value.manager, "episode-cancel", "downloading");
    await value.manager.cancel(second.downloadId);
    assert.equal((await value.manager.list()).some((entry) => entry.downloadId === second.downloadId), false);
    const cancelled = await value.persistence.getDownloadBundle(second.downloadId);
    assert.equal(cancelled.job.state, "cancelled");
    await assert.rejects(fs.stat(path.dirname(cancelled.localVersion.localPath)), { code: "ENOENT" });
  } finally {
    await closeFixture(value);
  }
});

test("storage exhaustion pauses for manual cleanup and never removes unrelated media", async () => {
  const content = Buffer.alloc(64 * 1024, 3);
  const probe = { async probe() { assert.fail("Probe must not run without storage."); } };
  const value = await fixture(createApi(content), probe, { availableBytes: async () => 0 });
  try {
    const sentinel = path.join(value.storageRoot, "keep-me.mkv");
    await fs.mkdir(value.storageRoot, { recursive: true });
    await fs.writeFile(sentinel, "existing media");
    await value.manager.start("movie-storage");
    const paused = await waitForState(value.manager, "movie-storage", "paused");
    assert.equal(paused.error.code, "STORAGE_LIMIT");
    assert.match(paused.error.message, /Free space manually/i);
    assert.equal(await fs.readFile(sentinel, "utf8"), "existing media");
  } finally {
    await closeFixture(value);
  }
});

test("changing the download root preserves paused and completed copies in earlier roots", async () => {
  const content = Buffer.alloc(384 * 1024, 17);
  const probe = {
    async probe(root, target) {
      const relativeTarget = path.relative(root, target);
      assert.ok(relativeTarget && !relativeTarget.startsWith("..") && !path.isAbsolute(relativeTarget));
      return { actualSize: (await fs.stat(target)).size, container: "mkv" };
    },
  };
  const value = await fixture(createApi(content, { slow: true }), probe);
  const secondRoot = path.join(value.directory, "larger-drive");
  try {
    const first = await value.manager.start("episode-old-root");
    await waitForState(value.manager, "episode-old-root", "downloading");
    await value.manager.pause(first.downloadId);

    value.manager.setStorageRoot(secondRoot);
    await value.manager.resume(first.downloadId);
    await waitForState(value.manager, "episode-old-root", "downloaded");
    const firstBundle = await value.persistence.getDownloadBundle(first.downloadId);
    assert.equal(path.relative(value.storageRoot, firstBundle.localVersion.localPath).startsWith(".."), false);

    const second = await value.manager.start("episode-new-root");
    await waitForState(value.manager, "episode-new-root", "downloaded");
    const secondBundle = await value.persistence.getDownloadBundle(second.downloadId);
    assert.equal(path.relative(secondRoot, secondBundle.localVersion.localPath).startsWith(".."), false);

    const listed = await value.manager.list();
    assert.equal(listed.find((entry) => entry.downloadId === first.downloadId).state, "downloaded");
    assert.equal(listed.find((entry) => entry.downloadId === second.downloadId).state, "downloaded");

    const localPlayback = new LocalPlaybackResolver(
      createApi(content),
      value.persistence,
      probe,
      [value.storageRoot, secondRoot],
      10,
    );
    assert.equal((await localPlayback.resolve("episode-old-root", "start-over")).source, "local");
    assert.equal((await localPlayback.resolve("episode-new-root", "start-over")).source, "local");

    await value.manager.shutdown();
    const unauthorized = new DownloadManager(
      createApi(content),
      value.persistence,
      probe,
      path.join(value.directory, "unrelated-root"),
      logger,
      { storageReserveBytes: 0 },
    );
    await unauthorized.activate();
    await assert.rejects(unauthorized.delete(first.downloadId), (error) => error.code === "INVALID_LOCAL_PATH");
    assert.equal((await fs.stat(firstBundle.localVersion.localPath)).isFile(), true);
    await unauthorized.shutdown();

    const restarted = new DownloadManager(
      createApi(content),
      value.persistence,
      probe,
      secondRoot,
      logger,
      { storageReserveBytes: 0, authorizedRoots: [value.storageRoot, secondRoot] },
    );
    await restarted.activate();
    value.manager = restarted;
    const afterRestart = await restarted.list();
    assert.equal(afterRestart.find((entry) => entry.downloadId === first.downloadId).state, "downloaded");
    assert.equal(afterRestart.find((entry) => entry.downloadId === second.downloadId).state, "downloaded");
  } finally {
    await closeFixture(value);
  }
});
