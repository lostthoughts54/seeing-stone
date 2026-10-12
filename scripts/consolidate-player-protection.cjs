"use strict";
// Run with Electron after consolidate-player-profiles.cjs, while both players are closed.
// Decrypted values travel only over a one-use local named pipe, never via disk or logs.
const assert = require("node:assert/strict");
const { app, safeStorage } = require("electron");
const { DatabaseSync } = require("node:sqlite");
const { readFileSync, writeFileSync, renameSync, existsSync, copyFileSync } = require("node:fs");
const { join, resolve } = require("node:path");
const { randomUUID } = require("node:crypto");
const { createServer, connect } = require("node:net");
const { spawn } = require("node:child_process");
const sourceMode = process.argv.includes("--source");
const main = join(app.getPath("appData"), "Seeing Stone");
const beta = join(app.getPath("appData"), "Seeing Stone IPTV Beta");
const backupRoot = resolve(__dirname, "../.runtime/consolidation-backup");
app.setPath("userData", sourceMode ? beta : main);
if (!app.requestSingleInstanceLock()) app.exit(1);
let stage = "availability";
const open = async file => JSON.parse((await safeStorage.decryptStringAsync(readFileSync(file))).result);
const pairingFile = "companion-devices.safe";
const loadPairings = async profile => existsSync(join(profile, pairingFile))
  ? open(join(profile, pairingFile)) : { schemaVersion: 1, devices: [] };

async function receiveSource() {
  const pipe = `\\\\.\\pipe\\seeing-stone-consolidation-${randomUUID()}`;
  return new Promise((resolvePromise, reject) => {
    let child;
    let connection;
    let done = false;
    const server = createServer(socket => {
      if (connection) { socket.destroy(); return; }
      connection = socket;
      let bytes = 0;
      const chunks = [];
      socket.on("data", chunk => {
        bytes += chunk.length;
        if (bytes > 4 * 1024 * 1024) finish(new Error("Transfer too large"));
        else chunks.push(chunk);
      });
      socket.on("error", finish);
      socket.on("end", () => {
        try { finish(null, JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
        catch { finish(new Error("Invalid transfer")); }
        finally { chunks.forEach(chunk => chunk.fill(0)); }
      });
    });
    const timer = setTimeout(() => finish(new Error("Transfer timeout")), 30000);
    function finish(error, value) {
      if (done) return;
      done = true;
      clearTimeout(timer); connection?.destroy(); server.close(); child?.kill();
      error ? reject(error) : resolvePromise(value);
    }
    server.on("error", finish);
    server.listen(pipe, () => {
      const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
      child = spawn(process.execPath, [__filename, "--source", `--pipe=${pipe}`], { env, windowsHide: true, stdio: "ignore" });
      child.on("error", finish);
      child.on("exit", code => { if (code) finish(new Error("Source protection failed")); });
    });
  });
}

app.whenReady().then(async () => {
  assert(await safeStorage.isAsyncEncryptionAvailable());
  if (sourceMode) {
    stage = "source-protection";
    const pipe = process.argv.find(value => value.startsWith("--pipe="))?.slice(7);
    assert(pipe?.startsWith("\\\\.\\pipe\\seeing-stone-consolidation-"));
    const database = new DatabaseSync(join(beta, "localfirst.sqlite3"), { readOnly: true });
    const rows = database.prepare("SELECT provider_id, protected_configuration FROM iptv_providers").all();
    database.close();
    const providers = [];
    for (const row of rows) providers.push({
      id: row.provider_id,
      original: Buffer.from(row.protected_configuration).toString("base64"),
      cleartext: (await safeStorage.decryptStringAsync(Buffer.from(row.protected_configuration))).result,
    });
    const pairings = await loadPairings(beta);
    const youtubeKey = existsSync(join(beta, "youtube-api-key.safe"))
      ? (await safeStorage.decryptStringAsync(readFileSync(join(beta, "youtube-api-key.safe")))).result : null;
    await new Promise((resolvePromise, reject) => {
      const socket = connect(pipe);
      socket.on("error", reject);
      socket.on("connect", () => socket.end(JSON.stringify({ providers, pairings, youtubeKey }), resolvePromise));
    });
    app.exit(0); return;
  }
  stage = "main-session";
  const session = await open(join(main, "session.safe"));
  assert(session.accessToken && session.serverId && session.userId);
  stage = "source-transfer";
  const source = await receiveSource();
  stage = "reprotect-iptv";
  const replacements = [];
  for (const provider of source.providers) {
    const configuration = JSON.parse(provider.cleartext);
    assert.equal(configuration.providerId, provider.id);
    assert.equal(configuration.version, 1);
    replacements.push({ ...provider, encrypted: await safeStorage.encryptStringAsync(provider.cleartext) });
  }
  const database = new DatabaseSync(join(main, "localfirst.sqlite3"));
  try {
    database.exec("BEGIN IMMEDIATE");
    for (const row of replacements) database.prepare("UPDATE iptv_providers SET protected_configuration=? WHERE provider_id=? AND protected_configuration=?")
      .run(row.encrypted, row.id, Buffer.from(row.original, "base64"));
    database.exec("COMMIT");
    for (const row of database.prepare("SELECT provider_id, protected_configuration FROM iptv_providers").all()) {
      const decrypted = JSON.parse((await safeStorage.decryptStringAsync(Buffer.from(row.protected_configuration))).result);
      assert.equal(decrypted.providerId, row.provider_id);
    }
  } finally { database.close(); }
  stage = "phone-pairings";
  const current = await loadPairings(main);
  assert.equal(current.schemaVersion, 1); assert.equal(source.pairings.schemaVersion, 1);
  const devices = new Map(current.devices.map(device => [device.deviceId, device]));
  for (const device of source.pairings.devices) {
    const existing = devices.get(device.deviceId);
    if (existing) assert.equal(existing.credentialHash, device.credentialHash);
    else devices.set(device.deviceId, device);
  }
  assert(devices.size <= 32);
  if (devices.size > current.devices.length) {
    const saved = join(backupRoot, "companion-devices-before-merge.safe");
    if (existsSync(join(main, pairingFile)) && !existsSync(saved)) copyFileSync(join(main, pairingFile), saved);
    const encrypted = await safeStorage.encryptStringAsync(JSON.stringify({ schemaVersion: 1, devices: [...devices.values()] }));
    const temporary = join(main, `${pairingFile}.consolidating`);
    writeFileSync(temporary, encrypted); renameSync(temporary, join(main, pairingFile));
    assert.equal((await loadPairings(main)).devices.length, devices.size);
  }
  if (source.youtubeKey && !existsSync(join(main, "youtube-api-key.safe"))) {
    writeFileSync(join(main, "youtube-api-key.safe"), await safeStorage.encryptStringAsync(source.youtubeKey));
  }
  const result = { savedJellyfinLoginReadable: true, readableIptvProviders: replacements.length, preservedPhonePairings: devices.size };
  writeFileSync(join(backupRoot, "protected-storage-result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result)); app.exit(0);
}).catch(() => { console.error(`Profile protection failed at ${stage}; no credentials printed.`); app.exit(1); });
