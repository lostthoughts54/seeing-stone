"use strict";
const assert = require("node:assert/strict");
const { join, resolve } = require("node:path");
const { mkdirSync, readFileSync, existsSync, writeFileSync } = require("node:fs");
const { spawn } = require("node:child_process");
const { WebSocket } = require("ws");
const asar = require("@electron/asar");
const root = resolve(__dirname, "..");
const output = join(root, "artifacts/youtube-package-smoke");
const profile = join(output, `profile-${Date.now()}`);
const packageRoot = join(root, ".runtime/release/win-unpacked");
let child;
let socket;
const pause = ms => new Promise(resolvePromise => setTimeout(resolvePromise, ms));
void run().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => { socket?.close(); child?.kill(); });

async function run() {
  mkdirSync(profile, { recursive: true });
  const archive = join(packageRoot, "resources/app.asar");
  const contents = asar.listPackage(archive);
  for (const suffix of ["companionYouTube.js", "youtubeApiKeyStore.js", "iptvService.js", "youtubeRooms.js"]) assert(contents.some(file => file.endsWith(suffix)), `Missing ${suffix}`);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.SEEING_STONE_YOUTUBE_API_KEY;
  child = spawn(join(packageRoot, "Seeing Stone.exe"), [`--user-data-dir=${profile}`, "--remote-debugging-port=0"], { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  const endpoint = await new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error("Packaged app debugging endpoint did not start")), 30000);
    child.once("error", reject);
    child.once("exit", code => { clearTimeout(timer); reject(new Error(`Packaged app exited early: ${code}`)); });
    child.stderr.on("data", bytes => { const match = bytes.toString().match(/DevTools listening on (ws:\/\/\S+)/); if (match) { clearTimeout(timer); resolvePromise(match[1]); } });
  });
  let page;
  for (let attempt = 0; attempt < 100; attempt++) {
    const pages = await (await fetch(`http://127.0.0.1:${new URL(endpoint).port}/json/list`)).json();
    page = pages.find(value => value.type === "page" && value.url.startsWith("app://"));
    if (page) break;
    await pause(200);
  }
  assert(page, "App page failed to load");
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolvePromise, reject) => { socket.once("open", resolvePromise); socket.once("error", reject); });
  let sequence = 0;
  const pending = new Map();
  socket.on("message", raw => { const value = JSON.parse(raw); const waiter = pending.get(value.id); if (waiter) { pending.delete(value.id); clearTimeout(waiter.timer); value.error ? waiter.reject(new Error(JSON.stringify(value.error))) : waiter.resolve(value.result); } });
  const cdp = (method, params = {}) => new Promise((resolvePromise, reject) => {
    const id = ++sequence; const timer = setTimeout(() => reject(new Error(`${method} timeout`)), 15000);
    pending.set(id, { resolve: resolvePromise, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const result = await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  await evaluate(`new Promise(resolve => { const check = () => document.getElementById('youtubeApiKeyForm') && window.jellyfin?.companion?.setYouTubeApiKey ? resolve() : setTimeout(check, 100); check(); })`);
  const before = await evaluate(`window.jellyfin.companion.getYouTubeSearchSettings()`);
  assert.equal(before.configured, false);
  const key = "fixture_youtube_key_1234567890";
  const saved = await evaluate(`window.jellyfin.companion.setYouTubeApiKey({ apiKey: ${JSON.stringify(key)} })`);
  assert.equal(saved.source, "saved");
  assert(!JSON.stringify(saved).includes(key));
  const encrypted = readFileSync(join(profile, "youtube-api-key.safe"));
  assert(!encrypted.includes(Buffer.from(key)), "Key was not protected on disk");
  const removed = await evaluate(`window.jellyfin.companion.setYouTubeApiKey({ apiKey: '' })`);
  assert.equal(removed.configured, false);
  assert(!existsSync(join(profile, "youtube-api-key.safe")));
  const ui = await evaluate(`({ youtube: !!document.getElementById('youtubeTogetherHeading'), settings: !!document.getElementById('youtubeApiKeyInput'), iptv: !!document.getElementById('loginIptvButton'), type: document.getElementById('youtubeApiKeyInput').type })`);
  assert.deepEqual(ui, { youtube: true, settings: true, iptv: true, type: "password" });
  await evaluate(`document.getElementById('loginIptvButton').click()`);
  const navigation = await evaluate(`({ inline: document.getElementById('iptvView')?.parentElement?.id === 'contentScroller', mainVisible: !document.getElementById('mainView').classList.contains('is-hidden'), active: document.getElementById('navIptvButton').getAttribute('aria-current'), modalCount: document.querySelectorAll('dialog[open]').length })`);
  assert.deepEqual(navigation, { inline: true, mainVisible: true, active: "page", modalCount: 0 });
  const diagnostics = JSON.parse(readFileSync(join(profile, "player-engine-status.json"), "utf8"));
  assert.equal(diagnostics.fallbackActive, false);
  const result = { passed: true, ui, navigation, protectedStorage: true, removedKey: true, engine: diagnostics.active };
  writeFileSync(join(output, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
  await evaluate(`window.jellyfin.application.close()`);
}
