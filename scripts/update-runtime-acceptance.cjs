"use strict";
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { createServer } = require("node:http");
const { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync } = require("node:fs");
const { join, resolve, sep } = require("node:path");
const output = resolve(__dirname, "../artifacts/update-acceptance");

if (!process.versions.electron) {
  mkdirSync(output, { recursive: true });
  const profile = mkdtempSync(join(output, "profile-"));
  const env = { ...process.env, UPDATE_TEST_PROFILE: profile }; delete env.ELECTRON_RUN_AS_NODE;
  try {
    const result = spawnSync(require("electron"), [__filename], { env, windowsHide: true, stdio: "inherit", timeout: 120000 });
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
  } finally {
    if (!resolve(profile).startsWith(output + sep + "profile-")) throw Error("Unexpected test profile path");
    rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
} else main().catch(error => { console.error(error); require("electron").app.exit(1); });

async function main() {
  const { app, BrowserWindow, ipcMain } = require("electron");
  const profile = process.env.UPDATE_TEST_PROFILE;
  assert.ok(profile && resolve(profile).startsWith(output + sep + "profile-"));
  app.setPath("userData", profile); app.setPath("cache", profile); app.disableHardwareAcceleration();
  // electron-updater uses LOCALAPPDATA, independently of Electron's cache path.
  process.env.LOCALAPPDATA = profile;
  await app.whenReady();
  const { NsisUpdater } = require("electron-updater");
  const { UpdateChecker } = require("../dist/main/services/updateChecker.js");
  const payload = Buffer.alloc(512 * 1024, 65); // Inert test bytes; never executed as an installer.
  const sha512 = createHash("sha512").update(payload).digest("base64");
  let mode = "available", downloads = 0, metadata = 0;
  const server = createServer((req, res) => {
    if (req.url.startsWith("/latest.yml")) {
      metadata++;
      if (mode === "missing") { res.writeHead(404).end(); return; }
      const version = mode === "current" ? app.getVersion() : "99.0.0";
      const hash = mode === "corrupt" ? createHash("sha512").update("wrong").digest("base64") : sha512;
      res.end(`version: ${version}\nfiles:\n  - url: fixture.exe\n    sha512: ${hash}\n    size: ${payload.length}\npath: fixture.exe\nsha512: ${hash}\nreleaseDate: '2026-10-14T00:00:00.000Z'\n`);
    } else if (req.url.startsWith("/fixture.exe")) {
      downloads++; res.writeHead(200, { "Content-Length": payload.length });
      let offset = 0;
      const timer = setInterval(() => { const end = Math.min(offset + 65536, payload.length); res.write(payload.subarray(offset, end)); offset = end; if (offset === payload.length) { clearInterval(timer); res.end(); } }, 100);
      res.on("close", () => clearInterval(timer));
    } else res.writeHead(404).end();
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const feed = `http://127.0.0.1:${server.address().port}`;
  const config = join(profile, "app-update.yml");
  writeFileSync(config, `provider: generic\nurl: ${feed}\nupdaterCacheDirName: update-cache\n`);
  const updater = new NsisUpdater({ provider: "generic", url: feed });
  updater.forceDevUpdateConfig = true; updater.updateConfigPath = config; updater.disableDifferentialDownload = true;
  let activity = { playback: true, watchParty: true, key: "test-session" }, confirms = 0, shutdowns = 0;
  // Never allow the test's inert payload to reach installation.
  updater.quitAndInstall = () => { throw Error("This test must never execute an installer"); };
  const service = new UpdateChecker({ appName: "Seeing Stone", currentVersion: app.getVersion(), unavailableReason: null, updater,
    logger: { info() {}, warn() {}, error() {} }, activity: () => activity,
    confirmRestart: async () => { confirms++; return false; }, shutdown: async () => { shutdowns++; } });
  const window = new BrowserWindow({ width: 1100, height: 850, show: false, webPreferences: { preload: join(__dirname, "update-runtime-preload.cjs"), sandbox: false, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  const seen = [];
  service.onState(state => { seen.push(state.status); if (!window.isDestroyed()) window.webContents.send("test-updates:changed", state); });
  ipcMain.handle("test-updates:get", () => service.getState());
  ipcMain.handle("test-updates:check", () => service.check());
  ipcMain.handle("test-updates:install", () => service.install());
  ipcMain.handle("test-updates:defer", () => service.defer());
  const js = source => window.webContents.executeJavaScript(source);
  const until = async condition => { for (let i = 0; i < 300; i++) { if (await condition()) return; await new Promise(resolve => setTimeout(resolve, 30)); } throw Error("Timed out waiting for update state"); };
  const click = id => js(`document.getElementById(${JSON.stringify(id)}).click()`);
  try {
    await window.loadFile(resolve(__dirname, "../dist/renderer/index.html"));
    await until(() => js("document.getElementById('applicationVersionLabel').textContent.includes('" + app.getVersion() + "')"));
    await js("document.querySelector('[data-open-updates]').click()");
    await click("checkForUpdatesButton");
    await until(() => service.getState().status === "downloading");
    await service.check(); await service.check();
    await until(() => service.getState().status === "ready");
    assert.equal(downloads, 1); assert.equal(metadata, 1);
    assert.ok(readFileSync(updater.installerPath).equals(payload));
    assert.ok(seen.includes("checking") && seen.includes("downloading") && seen.includes("ready"));
    assert.equal(service.getState().promptVisible, false);
    await until(() => js("document.getElementById('updateCheckStatus').textContent.includes('99.0.0') && !document.getElementById('updateReadyActions').classList.contains('is-hidden')"));
    await click("closeUpdatesButton"); await js("document.querySelector('[data-open-updates]').click()");
    assert.equal(await js("document.getElementById('checkForUpdatesButton').disabled"), true);
    await click("installUpdateButton"); await until(() => confirms === 1);
    assert.equal(shutdowns, 0); assert.equal(service.getState().status, "ready");
    await click("laterUpdateButton");
    await until(() => !service.getState().promptVisible);
    activity = { playback: false, watchParty: false, key: "idle" }; service.activityChanged();
    await click("closeUpdatesButton"); assert.equal(await js("document.getElementById('updateBanner').classList.contains('is-hidden')"), true);
    await js("document.querySelector('[data-open-updates]').click()");
    assert.equal(await js("document.getElementById('updatesSettings').open"), true);
    await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
    await new Promise(resolve => setTimeout(resolve, 200));
    writeFileSync(join(output, "ready.png"), (await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG());
    // A fresh service exercises metadata/current/error behavior with the real updater.
    service.dispose();
    for (const [testMode, expected] of [["current", "current"], ["missing", "error"], ["corrupt", "error"]]) {
      mode = testMode;
      const next = new NsisUpdater({ provider: "generic", url: feed }); next.forceDevUpdateConfig = true; next.updateConfigPath = config; next.disableDifferentialDownload = true;
      const nextService = new UpdateChecker({ appName: "Seeing Stone", currentVersion: app.getVersion(), unavailableReason: null, updater: next,
        logger: { info() {}, warn() {}, error() {} }, activity: () => activity, confirmRestart: async () => false, shutdown: async () => { throw Error("Unexpected shutdown"); } });
      await nextService.check(); await until(() => nextService.getState().status === expected);
      nextService.dispose();
    }
    writeFileSync(join(output, "result.json"), JSON.stringify({ passed: true, tests: ["real metadata discovery", "automatic HTTP download", "SHA-512 verification", "duplicate checks", "current release", "missing metadata", "corrupt download", "Settings reopen", "active-session confirmation cancellation", "Later retains download"], installedUpgradeTested: false }, null, 2));
    console.log("Update acceptance passed: real downloader + Electron Settings UI (10 scenarios); no installer executed.");
  } finally { service.dispose(); window.destroy(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  app.exit(0);
}
