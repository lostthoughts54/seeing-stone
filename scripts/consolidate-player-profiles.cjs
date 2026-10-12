"use strict";
// One-time local migration. Run with the player closed; credentials are reprotected
// through an Electron helper using each profile's Windows encryption key.
const assert = require("node:assert/strict");
const { DatabaseSync, backup } = require("node:sqlite");
const { mkdirSync, copyFileSync, readdirSync, writeFileSync } = require("node:fs");
const { spawn } = require("node:child_process");
const { join, resolve } = require("node:path");

const tables = ["iptv_providers", "iptv_catalogue_snapshots", "iptv_catalogue_items", "iptv_channel_favourites"];
function counts(db, schema = "main") {
  return Object.fromEntries(tables.map(table => [table, db.prepare(`SELECT count(*) AS n FROM ${schema}.${table}`).get().n]));
}

function mergeIptv(db, sourcePath) {
  db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
  db.prepare("ATTACH DATABASE ? AS previous_iptv").run(sourcePath);
  try {
    assert.equal(db.prepare("PRAGMA main.user_version").get().user_version, db.prepare("PRAGMA previous_iptv.user_version").get().user_version, "Profile schema versions differ");
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(`CREATE TEMP TABLE imported_providers AS
        SELECT provider_id FROM previous_iptv.iptv_providers
        WHERE provider_id NOT IN (SELECT provider_id FROM main.iptv_providers)`);
      for (const table of tables) {
        const columns = db.prepare(`PRAGMA main.table_info(${table})`).all().map(row => row.name);
        const oldColumns = db.prepare(`PRAGMA previous_iptv.table_info(${table})`).all().map(row => row.name);
        assert.deepEqual(columns, oldColumns, `Schema differs for ${table}`);
        const names = columns.map(column => `"${column}"`).join(",");
        db.exec(`INSERT INTO main.${table} (${names}) SELECT ${names} FROM previous_iptv.${table}
          WHERE provider_id IN (SELECT provider_id FROM imported_providers)`);
      }
      assert.equal(db.prepare("PRAGMA main.foreign_key_check").all().length, 0, "Profile integrity check failed");
      const importedProviders = db.prepare("SELECT count(*) AS n FROM imported_providers").get().n;
      db.exec("DROP TABLE imported_providers; COMMIT;");
      return { importedProviders, counts: counts(db) };
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  } finally { db.exec("DETACH DATABASE previous_iptv"); }
}

async function main() {
  assert(process.argv.includes("--apply"), "Run with --apply only after closing all Seeing Stone players.");
  const root = resolve(__dirname, "..");
  const source = join(process.env.APPDATA, "Seeing Stone IPTV Beta");
  const target = join(process.env.APPDATA, "Seeing Stone");
  const backupRoot = join(root, ".runtime", "consolidation-backup", `profiles-${Date.now()}`);
  mkdirSync(backupRoot, { recursive: true });
  for (const [label, profile] of [["main", target], ["iptv", source]]) {
    const directory = join(backupRoot, label);
    mkdirSync(directory);
    const original = new DatabaseSync(join(profile, "localfirst.sqlite3"), { readOnly: true });
    try { await backup(original, join(directory, "localfirst.sqlite3")); } finally { original.close(); }
    for (const entry of readdirSync(profile, { withFileTypes: true })) {
      if (entry.isFile() && !entry.name.startsWith("localfirst.sqlite3")) copyFileSync(join(profile, entry.name), join(directory, entry.name));
    }
  }
  const db = new DatabaseSync(join(target, "localfirst.sqlite3"));
  let result;
  try {
    result = mergeIptv(db, join(backupRoot, "iptv", "localfirst.sqlite3"));
    assert.equal(db.prepare("PRAGMA quick_check").get().quick_check, "ok");
  } finally { db.close(); }
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  await new Promise((resolvePromise, reject) => {
    const child = spawn(require("electron"), [join(__dirname, "consolidate-player-protection.cjs")], { env, windowsHide: true, stdio: "inherit" });
    const timer = setTimeout(() => { child.kill(); reject(new Error("Protection transfer timeout")); }, 60000);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("exit", code => { clearTimeout(timer); code === 0 ? resolvePromise() : reject(new Error("Protection transfer failed")); });
  });
  writeFileSync(join(backupRoot, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ ...result, backupRoot }));
}

module.exports = { mergeIptv };
if (require.main === module) main().catch(() => {
  console.error("Profile consolidation failed. Backups were retained; no credentials were printed.");
  process.exitCode = 1;
});
