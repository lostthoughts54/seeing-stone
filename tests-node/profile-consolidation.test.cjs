"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { DatabaseSync } = require("node:sqlite");
const { mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { mergeIptv } = require("../scripts/consolidate-player-profiles.cjs");

function fixture(path, provider, snapshot) {
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA user_version=11;
    CREATE TABLE iptv_providers(provider_id TEXT PRIMARY KEY, protected_configuration BLOB);
    CREATE TABLE iptv_catalogue_snapshots(snapshot_id TEXT PRIMARY KEY, provider_id TEXT REFERENCES iptv_providers(provider_id));
    CREATE TABLE iptv_catalogue_items(provider_id TEXT REFERENCES iptv_providers(provider_id), snapshot_id TEXT REFERENCES iptv_catalogue_snapshots(snapshot_id), item_id TEXT);
    CREATE TABLE iptv_channel_favourites(provider_id TEXT REFERENCES iptv_providers(provider_id), channel_id TEXT);
    CREATE TABLE download_jobs(id TEXT); INSERT INTO download_jobs VALUES ('preserved');`);
  db.prepare("INSERT INTO iptv_providers VALUES (?,?)").run(provider, Buffer.from("encrypted-fixture"));
  db.prepare("INSERT INTO iptv_catalogue_snapshots VALUES (?,?)").run(snapshot, provider);
  db.prepare("INSERT INTO iptv_catalogue_items VALUES (?,?,?)").run(provider, snapshot, "channel");
  db.prepare("INSERT INTO iptv_channel_favourites VALUES (?,?)").run(provider, "channel");
  return db;
}
test("merges IPTV ciphertext/catalogue/favourites once while preserving main data", () => {
  const dir = mkdtempSync(join(tmpdir(), "seeing-stone-merge-"));
  const source = join(dir, "source.db");
  fixture(source, "beta", "snapshot-beta").close();
  const target = fixture(":memory:", "main", "snapshot-main");
  try {
    assert.equal(mergeIptv(target, source).importedProviders, 1);
    assert.equal(mergeIptv(target, source).importedProviders, 0);
    assert.equal(target.prepare("SELECT count(*) n FROM iptv_channel_favourites").get().n, 2);
    assert.deepEqual(Buffer.from(target.prepare("SELECT protected_configuration FROM iptv_providers WHERE provider_id='beta'").get().protected_configuration), Buffer.from("encrypted-fixture"));
    assert.equal(target.prepare("SELECT id FROM download_jobs").get().id, "preserved");
  } finally { target.close(); rmSync(dir, { recursive: true, force: true }); }
});
test("rolls back the entire import on snapshot conflicts", () => {
  const dir = mkdtempSync(join(tmpdir(), "seeing-stone-merge-"));
  const source = join(dir, "source.db");
  fixture(source, "beta", "collision").close();
  const target = fixture(":memory:", "main", "collision");
  try {
    assert.throws(() => mergeIptv(target, source));
    assert.equal(target.prepare("SELECT count(*) n FROM iptv_providers").get().n, 1);
    assert.equal(target.prepare("SELECT id FROM download_jobs").get().id, "preserved");
  } finally { target.close(); rmSync(dir, { recursive: true, force: true }); }
});
