const assert = require("node:assert/strict");
const test = require("node:test");
const { mkdtemp } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { randomUUID, randomBytes, createCipheriv, createDecipheriv } = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const { SqlitePersistenceService } = require("../dist/main/services/persistence.js");
const { IptvProviderStore } = require("../dist/main/services/iptvProviderStore.js");
const { IptvService } = require("../dist/main/services/iptvService.js");
const { createLiveTvTestServer } = require("../scripts/live-tv-test-server.cjs");

function testProtector() {
  const key = randomBytes(32);
  return { async isAvailable() { return true; }, async encrypt(value) { const iv = randomBytes(12); const cipher = createCipheriv("aes-256-gcm", key, iv); const data = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), data]); },
    async decrypt(value) { const cipher = createDecipheriv("aes-256-gcm", key, value.subarray(0, 12)); cipher.setAuthTag(value.subarray(12, 28)); return { result: Buffer.concat([cipher.update(value.subarray(28)), cipher.final()]).toString("utf8"), shouldReEncrypt: false }; } };
}
async function fixture(t) {
  const providerState = {};
  const server = createLiveTvTestServer({ port: 0, bind: "127.0.0.1", catalogueSize: 123, providerState });
  await server.listen();
  const address = `http://127.0.0.1:${server.server.address().port}`;
  const directory = await mkdtemp(join(tmpdir(), "ss-iptv-service-"));
  const persistence = new SqlitePersistenceService(directory);
  const protection = testProtector();
  const store = new IptvProviderStore(persistence, protection);
  const service = new IptvService(store, persistence);
  t.after(async () => { await service.shutdown(); await persistence.close(); server.server.closeAllConnections(); await server.close(); });
  return { service, store, persistence, protection, directory, providerState, setup: { kind: "xtream", name: "Synthetic IPTV", address, username: "viewer", password: "fixture-password" } };
}
async function settle(service, providerId) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const status = (await service.list()).find(row => row.provider.providerId === providerId);
    if (status && ["ready", "failed"].includes(status.phase)) return status;
    await new Promise(resolve => setTimeout(resolve, 15));
  }
  throw new Error("Import did not settle");
}

test("real mock-provider authentication, three catalogues, multilingual search, categories and keyset pages", async (t) => {
  const { service, setup } = await fixture(t);
  const provider = await service.setup(setup);
  const status = await settle(service, provider.providerId);
  assert.equal(status.phase, "ready", status.message);
  assert.deepEqual(status.counts, { live: 123, movie: 1, series: 1 });
  const input = { providerId: provider.providerId, contentType: "live" };
  const first = await service.catalogue(input);
  assert.equal(first.items.length, 50);
  const second = await service.catalogue({ ...input, cursor: first.nextCursor });
  const third = await service.catalogue({ ...input, cursor: second.nextCursor });
  assert.equal(third.items.length, 23);
  assert.equal(third.nextCursor, null);
  assert.equal(new Set([...first.items, ...second.items, ...third.items].map(row => row.identity.itemId)).size, 123);
  for (const limit of [100, 150, 200]) {
    const larger = await service.catalogue({ ...input, limit });
    assert.equal(larger.items.length, Math.min(limit, 123));
    if (larger.nextCursor) {
      const remaining = await service.catalogue({ ...input, limit, cursor: larger.nextCursor });
      assert.equal(new Set([...larger.items, ...remaining.items].map(row => row.identity.itemId)).size, 123);
      assert.equal(remaining.nextCursor, null);
    } else assert.equal(larger.items.length, 123);
  }
  assert.equal((await service.catalogue({ ...input, query: "日本" })).items[0].name, "日本語 ニュース");
  assert.equal((await service.catalogue({ ...input, query: "CAFÉ" })).items[0].name, "Café français");
  assert.equal((await service.catalogue({ ...input, query: "Duplicate News" })).items.length, 2);
  assert.ok((await service.catalogue({ ...input, query: "101" })).items.some(item => item.channelNumber === "101"));
  assert.equal((await service.catalogue({ ...input, query: "%" })).items.length, 0);
  assert.equal((await service.groups(provider.providerId, "live")).length, 2);
  assert.ok((await service.catalogue({ ...input, groupId: "1" })).items.every(item => item.groupId === "1"));
  const movie = (await service.catalogue({ ...input, contentType: "movie" })).items[0];
  const series = (await service.catalogue({ ...input, contentType: "series" })).items[0];
  assert.equal(movie.identity.itemId, series.identity.itemId);
  assert.notEqual(movie.identity.contentType, series.identity.contentType);
  assert.doesNotMatch(JSON.stringify([status, first, movie]), /fixture-password|stream_icon|direct_source|127\.0\.0\.1/);
  await assert.rejects(service.catalogue({ ...input, query: "different", cursor: first.nextCursor }), { code: "IPTV_SNAPSHOT_STALE" });
});

test("provider section headings are excluded from existing snapshots, counts, groups and playback", async (t) => {
  const { service, setup, persistence } = await fixture(t);
  const { providerId } = await service.setup(setup);
  await settle(service, providerId);
  const snapshotId = randomUUID();
  const row = { contentType: "live", itemId: "1", name: "##### FOX TEXAS #####", nameKey: "##### fox texas #####", groupId: "texas", groupName: "FOX", channelNumber: "1" };
  await persistence.iptvCatalogue({ action: "begin", providerId, snapshotId });
  await persistence.iptvCatalogue({ action: "batch", providerId, snapshotId, items: [row, { ...row, itemId: "2", name: "FOX 4 Dallas", nameKey: "fox 4 dallas" }] });
  await persistence.iptvCatalogue({ action: "publish", providerId, snapshotId, completedAt: Date.now() });
  const page = await service.catalogue({ providerId, contentType: "live", limit: 1 });
  assert.deepEqual(page.items.map(item => item.name), ["FOX 4 Dallas"]);
  assert.equal(page.nextCursor, null);
  assert.equal((await service.list())[0].counts.live, 1);
  assert.equal((await service.groups(providerId, "live"))[0].count, 1);
  await assert.rejects(service.resolveLive({ providerId, contentType: "live", itemId: "1" }, new AbortController().signal), { code: "IPTV_CHANNEL_HEADING" });
});

test("failed refresh retains the published catalogue; successful refresh invalidates old cursors", async (t) => {
  const { service, setup, providerState, persistence } = await fixture(t);
  const { providerId } = await service.setup(setup);
  await settle(service, providerId);
  const before = await service.catalogue({ providerId, contentType: "live" });
  providerState.failAction = "get_series";
  await service.refresh(providerId);
  assert.equal((await settle(service, providerId)).phase, "failed");
  assert.deepEqual(await service.catalogue({ providerId, contentType: "live" }), before);
  providerState.failAction = null;
  await service.refresh(providerId); await settle(service, providerId);
  await assert.rejects(service.catalogue({ providerId, contentType: "live", cursor: before.nextCursor }), { code: "IPTV_SNAPSHOT_STALE" });
  const snapshot = await persistence.iptvCatalogue({ action: "status", providerId });
  assert.notEqual(snapshot.snapshotId, before.snapshotId);
});

test("expired and invalid credentials expose safe status without a Jellyfin login", async (t) => {
  const { service, setup } = await fixture(t);
  for (const override of [{ username: "expired" }, { password: "invalid-private-password" }]) {
    const { providerId } = await service.setup({ ...setup, ...override });
    const status = await settle(service, providerId);
    assert.equal(status.phase, "failed");
    assert.match(status.message, /rejected or expired/);
    assert.equal(status.lastSuccessfulAt, null);
    assert.doesNotMatch(JSON.stringify(status), /invalid-private-password|fixture-password/);
    await service.remove(providerId);
  }
  assert.deepEqual(await service.list(), []);
});

test("saved catalogue survives restart; interrupted staging is discarded; deletion cascades only IPTV", async (t) => {
  const { service, setup, persistence, directory, protection } = await fixture(t);
  const { providerId } = await service.setup(setup); await settle(service, providerId);
  const before = await service.catalogue({ providerId, contentType: "live" });
  await persistence.iptvCatalogue({ action: "begin", providerId, snapshotId: randomUUID() });
  await service.shutdown(); await persistence.close();
  const reopened = new SqlitePersistenceService(directory);
  const restored = new IptvService(new IptvProviderStore(reopened, protection), reopened);
  t.after(async () => { await restored.shutdown(); await reopened.close(); });
  assert.deepEqual(await restored.catalogue({ providerId, contentType: "live" }), before);
  const db = new DatabaseSync(join(directory, "localfirst.sqlite3"), { readOnly: true });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM iptv_catalogue_snapshots").get().n, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM servers").get().n, 0);
  db.close();
  await restored.remove(providerId);
  assert.equal((await restored.catalogue({ providerId, contentType: "live" })).items.length, 0);
});

test("favourites lead category and search pages without skipping or duplicating other channels", async (t) => {
  const { service, setup } = await fixture(t);
  const { providerId } = await service.setup(setup); await settle(service, providerId);
  const input = { providerId, contentType: "live", limit: 1 };
  for (const channelId of ["120", "121"]) await service.favourite({ providerId, channelId, favourite: true });
  assert.equal((await service.catalogue({ ...input, groupId: "2" })).items[0].identity.itemId, "120");
  assert.equal((await service.catalogue({ ...input, groupId: "1" })).items[0].identity.itemId, "121");
  assert.equal((await service.catalogue({ ...input, query: "Fixture" })).items[0].identity.itemId, "120");
  assert.equal((await service.catalogue({ ...input, query: "Café" })).items[0].favourite, false);
  const items = []; let cursor;
  do {
    const page = await service.catalogue({ ...input, cursor }); items.push(...page.items); cursor = page.nextCursor ?? undefined;
  } while (cursor);
  assert.deepEqual(items.slice(0, 2).map(item => item.identity.itemId), ["120", "121"]);
  assert.equal(items.length, 123); assert.equal(new Set(items.map(item => item.identity.itemId)).size, 123);
  const normal = items.slice(2).map(item => item.name.normalize("NFKC").toLowerCase());
  assert.deepEqual(normal, [...normal].sort());
  await service.favourite({ providerId, channelId: "120", favourite: false });
  assert.equal((await service.catalogue(input)).items[0].identity.itemId, "121");
});

test("favourites survive refresh and restart, filter before pagination, and remain provider-owned", async (t) => {
  const { service, setup, persistence, directory, protection } = await fixture(t);
  const { providerId } = await service.setup(setup); await settle(service, providerId);
  const input = { providerId, contentType: "live", favouritesOnly: true, limit: 1 };
  for (const channelId of ["1", "2"]) await service.favourite({ providerId, channelId, favourite: true });
  const first = await service.catalogue(input);
  assert.equal(first.items.length, 1); assert.equal(first.items[0].favourite, true); assert.ok(first.nextCursor);
  const second = await service.catalogue({ ...input, cursor: first.nextCursor });
  assert.equal(second.items.length, 1); assert.notEqual(second.items[0].identity.itemId, first.items[0].identity.itemId);
  assert.equal(second.nextCursor, null);
  await assert.rejects(service.catalogue({ ...input, favouritesOnly: false, cursor: first.nextCursor }), { code: "IPTV_SNAPSHOT_STALE" });
  assert.equal((await service.catalogue({ ...input, query: "no-match" })).items.length, 0);
  await service.refresh(providerId); await settle(service, providerId);
  await service.shutdown(); await persistence.close();
  const reopened = new SqlitePersistenceService(directory);
  const restored = new IptvService(new IptvProviderStore(reopened, protection), reopened);
  t.after(async () => { await restored.shutdown(); await reopened.close(); });
  assert.equal((await restored.catalogue({ ...input, limit: 50 })).items.length, 2);
  const other = await restored.setup({ ...setup, name: "Other provider" }); await settle(restored, other.providerId);
  assert.equal((await restored.catalogue({ ...input, providerId: other.providerId })).items.length, 0);
  await restored.favourite({ providerId, channelId: "1", favourite: false });
  assert.equal((await restored.catalogue({ ...input, limit: 50 })).items.length, 1);
  await restored.remove(providerId);
  const db = new DatabaseSync(join(directory, "localfirst.sqlite3"), { readOnly: true });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM iptv_channel_favourites").get().n, 0); db.close();
});

test("removal during provider connection cancels the import and cannot recreate a deleted provider", async (t) => {
  const { service, setup, persistence } = await fixture(t);
  const { providerId } = await service.setup(setup);
  await service.remove(providerId);
  assert.deepEqual(await service.list(), []);
  assert.equal(await persistence.iptvCatalogue({ action: "status", providerId }), null);
});

test("v9 migration preserves encrypted provider setup when adding catalogue tables", async (t) => {
  const { store, setup, persistence, directory, protection, service } = await fixture(t);
  const saved = await store.create(setup);
  const protectedBefore = await persistence.getIptvProvider(saved.providerId);
  await service.shutdown(); await persistence.close();
  const db = new DatabaseSync(join(directory, "localfirst.sqlite3"));
  db.exec("DROP TABLE iptv_channel_favourites; DROP TABLE iptv_catalogue_items; DROP TABLE iptv_catalogue_snapshots; PRAGMA user_version = 9"); db.close();
  const upgraded = new SqlitePersistenceService(directory);
  t.after(() => upgraded.close());
  assert.equal((await upgraded.open()).schemaVersion, 11);
  assert.deepEqual(await upgraded.getIptvProvider(saved.providerId), protectedBefore);
  assert.deepEqual(await new IptvProviderStore(upgraded, protection).readConfiguration(saved.providerId), setup);
});
