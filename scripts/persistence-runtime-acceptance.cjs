"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { mkdtemp } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");

if (!process.versions.electron) {
  const electron = require("electron");
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: "1", LOCALFIRST_PERSISTENCE_CHILD: "1" };
  const result = spawnSync(electron, [__filename], {
    cwd: resolve(__dirname, ".."),
    env,
    encoding: "utf8",
    windowsHide: true,
    timeout: 30000,
  });
  process.stdout.write(result.stdout || "");
  process.stderr.write(result.stderr || "");
  if (result.error) throw result.error;
  if (result.signal || result.status !== 0) process.exitCode = result.status || 1;
} else {
  void runChild().catch((error) => {
    process.stderr.write(`${error?.stack || String(error)}\n`);
    process.exitCode = 1;
  });
}

async function runChild() {
  assert.equal(process.env.LOCALFIRST_PERSISTENCE_CHILD, "1");
  const { SqlitePersistenceService } = require("../dist/main/services/persistence.js");
  const directory = await mkdtemp(join(tmpdir(), "lf-electron-sqlite-"));
  const service = new SqlitePersistenceService(directory);
  try {
    const health = await service.open();
    assert.equal(health.schemaVersion, 2);
    assert.equal(health.journalMode, "wal");
    assert.equal(health.foreignKeys, true);
    assert.equal(health.quickCheck, "ok");
    assert.ok(health.workerThreadId > 0);
    assert.ok(Number(process.versions.node.split(".")[0]) >= 24);
    assert.ok(process.versions.sqlite);
    process.stdout.write(`Electron persistence acceptance passed (Electron ${process.versions.electron}, Node ${process.versions.node}, SQLite ${process.versions.sqlite}).\n`);
  } finally {
    await service.close();
  }
}
