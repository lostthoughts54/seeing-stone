const assert = require("node:assert/strict");
const { mkdtemp, readFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { randomBytes, createCipheriv, createDecipheriv } = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const test = require("node:test");
const { SqlitePersistenceService } = require("../dist/main/services/persistence.js");
const { IptvProviderStore } = require("../dist/main/services/iptvProviderStore.js");

// Test-only authenticated encryption. Production injects Electron's OS protector.
function protector() {
  const key = randomBytes(32);
  return {
    available: true, rotate: false, failEncrypt: false,
    async isAvailable() { return this.available; },
    async encrypt(text) {
      if (this.failEncrypt) throw new Error("upstream contains secret-password and https://secret.example");
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const bytes = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), bytes]);
    },
    async decrypt(bytes) {
      const cipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
      cipher.setAuthTag(bytes.subarray(12, 28));
      return { result: Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString("utf8"), shouldReEncrypt: this.rotate };
    },
  };
}
const setup = { kind: "xtream", name: "Test provider", address: "https://secret.example/base", username: "private-viewer", password: "secret-password", xmltvUrl: "https://guide.example/feed?token=xmltv-secret" };

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "ss-iptv-foundation-"));
  const persistence = new SqlitePersistenceService(directory);
  const protection = protector();
  await persistence.open();
  t.after(() => persistence.close());
  return { directory, persistence, protection, store: new IptvProviderStore(persistence, protection) };
}

test("provider registry works without Jellyfin, returns safe summaries, and survives restart encrypted", async (t) => {
  const { directory, persistence, protection, store } = await fixture(t);
  const summary = await store.create(setup);
  assert.deepEqual(Object.keys(summary).sort(), ["kind", "name", "providerId"]);
  assert.deepEqual(await store.list(), [summary]);
  assert.deepEqual(await store.readConfiguration(summary.providerId), setup);
  const m3u = { kind: "m3u", name: "Test provider", playlistUrl: "https://example.test/list?token=playlist-secret" };
  const other = await store.create(m3u);
  assert.notEqual(other.providerId, summary.providerId);
  await persistence.close();
  const bytes = await readFile(join(directory, "localfirst.sqlite3"));
  for (const secret of [setup.address, setup.username, setup.password, setup.xmltvUrl, m3u.playlistUrl]) assert.equal(bytes.includes(Buffer.from(secret)), false);
  const restarted = new SqlitePersistenceService(directory);
  t.after(() => restarted.close());
  const restored = new IptvProviderStore(restarted, protection);
  assert.deepEqual(await restored.readConfiguration(summary.providerId), setup);
  assert.deepEqual(await restored.readConfiguration(other.providerId), m3u);
  await restored.remove(summary.providerId);
  assert.equal(await restored.readConfiguration(summary.providerId), null);
  assert.deepEqual(await restored.list(), [other]);
});

test("unavailable protection and encryption failures cannot save plaintext or expose secrets", async (t) => {
  const { persistence, protection, store } = await fixture(t);
  protection.available = false;
  await assert.rejects(store.create(setup), { code: "IPTV_PROTECTION_UNAVAILABLE" });
  protection.available = true;
  protection.failEncrypt = true;
  await assert.rejects(store.create(setup), (error) => error.code === "IPTV_PROTECTION_UNAVAILABLE" && !/secret/.test(error.message));
  assert.deepEqual(await persistence.listIptvProviders(), []);
  await assert.rejects(store.create({ ...setup, address: "https://secret.example/?password=secret-password" }), { code: "INVALID_IPTV_SETUP", message: "Provider setup is invalid." });
  await assert.rejects(store.create({ ...setup, address: "invalid address secret-password" }), { code: "INVALID_IPTV_SETUP", message: "Provider setup is invalid." });
});

test("decryption and failed rotation retain ciphertext; successful rotation is durable", async (t) => {
  const { persistence, protection, store } = await fixture(t);
  const { providerId } = await store.create(setup);
  const before = await persistence.getIptvProvider(providerId);
  protection.available = false;
  await assert.rejects(store.readConfiguration(providerId), { code: "IPTV_PROTECTION_UNAVAILABLE" });
  assert.deepEqual(await persistence.getIptvProvider(providerId), before);
  protection.available = true;
  protection.rotate = true;
  protection.failEncrypt = true;
  await assert.rejects(store.readConfiguration(providerId), { code: "IPTV_CREDENTIALS_UNAVAILABLE" });
  assert.deepEqual(await persistence.getIptvProvider(providerId), before);
  protection.failEncrypt = false;
  assert.deepEqual(await store.readConfiguration(providerId), setup);
  assert.notDeepEqual((await persistence.getIptvProvider(providerId)).protectedConfiguration, before.protectedConfiguration);
  const wrongProtector = new IptvProviderStore(persistence, protector());
  await assert.rejects(wrongProtector.readConfiguration(providerId), { code: "IPTV_CREDENTIALS_UNAVAILABLE" });
  assert.equal((await store.list()).length, 1);
});

test("encrypted envelopes cannot be swapped between providers", async (t) => {
  const { persistence, store } = await fixture(t);
  const a = await store.create(setup);
  const b = await store.create(setup);
  const record = await persistence.getIptvProvider(a.providerId);
  await persistence.rotateIptvProviderProtection(b.providerId, record.protectedConfiguration);
  await assert.rejects(store.readConfiguration(b.providerId), { code: "IPTV_CREDENTIALS_UNAVAILABLE" });
  assert.deepEqual(await store.readConfiguration(a.providerId), setup);
});

test("schema v8 upgrades additively and keeps preferences, Smart Downloads and Jellyfin progress", async (t) => {
  const { directory, persistence } = await fixture(t);
  await persistence.upsertCatalogIdentity({ serverId: "server", serverAddress: "http://localhost:8096", serverName: "JF", userId: "user", userName: "Viewer" });
  await persistence.upsertMediaItem({ serverId: "server", userId: "user", itemId: "movie", itemType: "Movie", name: "Saved movie", seriesId: null, seasonId: null, runTimeTicks: 1000 });
  await persistence.recordPlaybackRevision({ serverId: "server", userId: "user", itemId: "movie", actionKind: "progress", positionTicks: 500, watched: false, occurredAt: 1 });
  await persistence.setApplicationPreference("watchparty.sync-offset", { milliseconds: 50 });
  await persistence.close();
  const db = new DatabaseSync(join(directory, "localfirst.sqlite3"));
  // Remove the additive IPTV tables to recreate the exact v8 schema.
  db.exec("DROP TABLE iptv_channel_favourites; DROP TABLE iptv_catalogue_items; DROP TABLE iptv_catalogue_snapshots; DROP TABLE iptv_providers; PRAGMA user_version = 8");
  db.prepare(`INSERT INTO smart_series_rules(server_id,user_id,series_id,series_name,episode_limit,created_at,updated_at) VALUES ('server','user','series','Saved series',3,1,1)`).run();
  const before = Object.fromEntries(["servers", "profiles", "media_items", "playback_heads", "playback_revisions", "application_preferences", "smart_series_rules"].map((table) => [table, db.prepare(`SELECT * FROM ${table}`).all()]));
  db.close();
  const upgraded = new SqlitePersistenceService(directory);
  t.after(() => upgraded.close());
  assert.equal((await upgraded.open()).schemaVersion, 11);
  assert.deepEqual(await upgraded.listIptvProviders(), []);
  await upgraded.close();
  const verify = new DatabaseSync(join(directory, "localfirst.sqlite3"), { readOnly: true });
  try {
    for (const [table, rows] of Object.entries(before)) assert.deepEqual(verify.prepare(`SELECT * FROM ${table}`).all(), rows);
    assert.deepEqual(verify.prepare("PRAGMA foreign_key_list(iptv_providers)").all(), []);
    assert.equal(verify.prepare("PRAGMA quick_check").get().quick_check, "ok");
  } finally { verify.close(); }
});

test("failed provider migration preserves the previous schema version and existing records", async (t) => {
  const { directory, persistence } = await fixture(t);
  await persistence.setApplicationPreference("player.adapter-mode", { mode: "embedded" });
  await persistence.close();
  const databasePath = join(directory, "localfirst.sqlite3");
  const seed = new DatabaseSync(databasePath);
  seed.exec("DROP TABLE iptv_catalogue_items; DROP TABLE iptv_catalogue_snapshots; DROP TABLE iptv_providers; CREATE TABLE iptv_providers (existing_data TEXT); INSERT INTO iptv_providers VALUES ('preserve'); PRAGMA user_version = 8");
  seed.close();
  const upgrading = new SqlitePersistenceService(directory);
  t.after(() => upgrading.close());
  await assert.rejects(upgrading.open(), { code: "PERSISTENCE_CORRUPT" });
  const verify = new DatabaseSync(databasePath, { readOnly: true });
  try {
    assert.equal(verify.prepare("PRAGMA user_version").get().user_version, 8);
    assert.equal(verify.prepare("SELECT existing_data FROM iptv_providers").get().existing_data, "preserve");
    assert.equal(JSON.parse(verify.prepare("SELECT value_json FROM application_preferences WHERE preference_key = 'player.adapter-mode'").get().value_json).mode, "embedded");
  } finally { verify.close(); }
});
