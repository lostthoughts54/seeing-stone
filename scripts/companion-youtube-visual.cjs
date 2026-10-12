"use strict";
const { resolve, join } = require("node:path");
const { mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const root = resolve(__dirname, "..");
const output = join(root, "artifacts/companion-youtube");
const { pathToFileURL } = require("node:url");
const { spawn } = require("node:child_process");
const { WebSocket } = require("ws");
let browser;
let socket;

void run().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => { socket?.close(); browser?.kill(); });

async function run() {
  mkdirSync(output, { recursive: true });
  require("esbuild").buildSync({ entryPoints: [join(root, "src/companion/youtube.ts")], bundle: true, format: "iife", globalName: "YouTubeUI", outfile: join(output, "fixture.js") });
  browser = spawn(process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe", ["--headless=new", "--disable-gpu", "--no-first-run", "--disable-background-networking", "--remote-debugging-port=0", `--user-data-dir=${join(output, "chrome-profile")}`, "about:blank"], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
  const endpoint = await new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error("Chrome startup timed out")), 15000);
    browser.once("error", reject);
    browser.stderr.on("data", chunk => {
      const match = chunk.toString().match(/DevTools listening on (ws:\/\/\S+)/);
      if (match) { clearTimeout(timer); resolvePromise(match[1]); }
    });
  });
  const port = new URL(endpoint).port;
  const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  socket = new WebSocket(pages.find(page => page.type === "page").webSocketDebuggerUrl);
  await new Promise((resolvePromise, reject) => { socket.once("open", resolvePromise); socket.once("error", reject); });
  let sequence = 0;
  const pending = new Map();
  socket.on("message", raw => {
    const value = JSON.parse(raw);
    const waiter = pending.get(value.id);
    if (waiter) { pending.delete(value.id); clearTimeout(waiter.timer); value.error ? waiter.reject(new Error(JSON.stringify(value.error))) : waiter.resolve(value.result); }
  });
  const cdp = (method, params = {}) => new Promise((resolvePromise, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, 10000);
    pending.set(id, { resolve: resolvePromise, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const result = await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  await cdp("Page.enable");
  await cdp("Network.enable");
  await cdp("Network.setBlockedURLs", { urls: ["http://*", "https://*"] });
  await cdp("Emulation.setDeviceMetricsOverride", { width: 390, height: 900, deviceScaleFactor: 1, mobile: true });
  const html = readFileSync(join(root, "src/companion/index.html"), "utf8")
    .replace(/<link[^>]+>/g, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/g, "")
    .replace("</head>", `<style>${readFileSync(join(root, "src/companion/styles.css"), "utf8")}</style></head>`);
  writeFileSync(join(output, "fixture.html"), html);
  await cdp("Page.navigate", { url: pathToFileURL(join(output, "fixture.html")).href });
  await evaluate(`new Promise(resolve => { const check = () => document.getElementById('remote') ? resolve() : setTimeout(check, 20); check(); })`);
  await evaluate(`(() => {
    document.getElementById('remote').classList.remove('hidden');
    document.querySelectorAll('.view').forEach(element => element.classList.add('hidden'));
    document.getElementById('youtubeView').classList.remove('hidden');
    document.querySelectorAll('.tabs button').forEach(button => { button.removeAttribute('aria-current'); if (button.dataset.view === 'youtube') button.setAttribute('aria-current', 'page'); });
    document.getElementById('connection').textContent = 'Connected';
    window.fixture = { configured: true, room: { id: 'a'.repeat(43), name: 'Friday videos', queue: [], playing: false, positionSeconds: 42, videoId: 'dQw4w9WgXcQ', controllable: true }, sent: [], fail: false, searches: [] };
    window.fetch = async (path) => {
      if (path.endsWith('/state')) return { ok: true, json: async () => ({ searchConfigured: fixture.configured, room: fixture.room }) };
      fixture.searches.push(path);
      const q = new URL(path, 'http://fixture').searchParams.get('q');
      return { ok: true, json: async () => ({ items: [
        { videoId: 'dQw4w9WgXcQ', title: q ? 'Search result: ' + q : 'Exploring the night sky', channelTitle: 'Space and Science' },
        { videoId: '9bZkp7q19f0', title: 'Music &amp; moments <img src=x onerror=alert(1)>', channelTitle: 'Live Sessions' }
      ], nextPageToken: null }) };
    };
  })()`);
  await evaluate(readFileSync(join(output, "fixture.js"), "utf8"));
  const result = await evaluate(`(async () => {
    const check = (ok, name) => { if (!ok) throw new Error(name); };
    const tick = () => new Promise(resolve => setTimeout(resolve, 30));
    window.openYouTubeFixture = YouTubeUI.initializeYouTube(async command => {
      if (fixture.fail) throw new Error('Room changed. Refresh and try again.');
      fixture.sent.push(command);
      if (command.type === 'youtube-add') fixture.room.queue.push({ queueItemId: String(fixture.sent.length).padStart(32, '0'), videoId: 'dQw4w9WgXcQ' });
      if (command.type === 'youtube-control' && (command.action === 'play' || command.action === 'pause')) fixture.room.playing = command.action === 'play';
    });
    await openYouTubeFixture();
    check(document.querySelectorAll('#youtubeResults article').length === 2, 'popular results');
    check(document.querySelectorAll('#youtubeResults img').length === 2, 'safe text insertion');
    document.querySelector('#youtubeResults button').click(); await tick();
    check(fixture.sent.length === 1 && fixture.sent[0].roomId === fixture.room.id, 'queue command');
    check(document.getElementById('youtubeActionStatus').textContent.includes('Added'), 'success status');
    check(document.getElementById('youtubeQueue').children.length === 1, 'queue refresh');
    document.getElementById('youtubePlayPause').click(); await tick();
    check(fixture.sent.at(-1).action === 'play' && document.getElementById('youtubePlayPause').textContent === 'Pause', 'play transport');
    document.getElementById('youtubePlayPause').click(); await tick();
    check(fixture.sent.at(-1).action === 'pause', 'pause transport');
    document.getElementById('youtubeBack').click(); await tick();
    check(fixture.sent.at(-1).action === 'back', 'skip back transport');
    document.getElementById('youtubeForward').click(); await tick();
    check(fixture.sent.at(-1).action === 'forward', 'skip forward transport');
    document.getElementById('youtubeRestart').click(); await tick();
    check(fixture.sent.at(-1).action === 'restart', 'restart transport');
    check(document.getElementById('youtubeNext').disabled, 'no next video guard');
    document.querySelectorAll('#youtubeResults button')[1].click(); await tick();
    check(fixture.sent.at(-1).playNow === true, 'search play now');
    document.getElementById('youtubeNext').click(); await tick();
    check(fixture.sent.at(-1).action === 'next' && fixture.sent.at(-1).queueItemId === fixture.room.queue[0].queueItemId, 'next transport target');
    document.querySelectorAll('#youtubeQueue li')[1].querySelector('button').click(); await tick();
    check(fixture.sent.at(-1).type === 'youtube-queue' && fixture.sent.at(-1).action === 'play', 'queue play now');
    fixture.fail = true;
    document.querySelector('#youtubeResults button').click(); await tick();
    check(document.getElementById('youtubeActionStatus').textContent.includes('Room changed'), 'error status');
    fixture.fail = false;
    document.getElementById('youtubeSearch').value = 'space';
    document.getElementById('youtubeSearchForm').dispatchEvent(new Event('submit', { cancelable: true })); await tick();
    check(fixture.searches.some(path => path.includes('q=space')), 'search request');
    check(document.getElementById('youtubeResults').textContent.includes('Search result: space'), 'search result rendering');
    fixture.room = null; await openYouTubeFixture();
    check([...document.querySelectorAll('#youtubeResults button')].every(button => button.disabled), 'no room guard');
    fixture.configured = false; await openYouTubeFixture();
    check(!document.getElementById('youtubeSetup').classList.contains('hidden'), 'key setup state');
    fixture.configured = true;
    fixture.room = { id: 'a'.repeat(43), name: 'Friday videos', queue: [], controllable: true, playing: false, positionSeconds: 42, videoId: 'dQw4w9WgXcQ' };
    await openYouTubeFixture();
    document.getElementById('youtubePopular').click(); await tick();
    document.getElementById('youtubeActionStatus').textContent = '';
    check(document.documentElement.scrollWidth <= window.innerWidth, 'mobile horizontal overflow');
    return { passed: true, checks: 19, width: window.innerWidth };
  })()`);
  const screenshot = await cdp("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(output, "phone.png"), Buffer.from(screenshot.data, "base64"));
  require("esbuild").buildSync({ entryPoints: [join(root, "src/renderer/youtubeSettings.ts")], bundle: true, format: "iife", globalName: "YouTubeSettingsUI", outfile: join(output, "settings-fixture.js") });
  const desktop = readFileSync(join(root, "src/renderer/index.html"), "utf8");
  const settingsMarkup = desktop.match(/<form id="youtubeApiKeyForm">[\s\S]*?<p id="youtubeApiKeyStatus"[^>]*>[\s\S]*?<\/p>/)[0];
  await evaluate(`document.getElementById('youtubeView').classList.add('hidden'); document.body.insertAdjacentHTML('beforeend', ${JSON.stringify(settingsMarkup)});`);
  await evaluate(readFileSync(join(output, "settings-fixture.js"), "utf8"));
  const settingsResult = await evaluate(`(async () => {
    const check = (ok, name) => { if (!ok) throw new Error(name); };
    const tick = () => new Promise(resolve => setTimeout(resolve, 30));
    let key = ''; let fail = false;
    const status = () => ({ configured: Boolean(key), source: key ? 'saved' : 'none', storageUnavailable: false });
    const settings = YouTubeSettingsUI.mountYouTubeSettings({ getYouTubeSearchSettings: async () => status(), setYouTubeApiKey: async input => { if(fail) throw new Error('failure'); key = input.apiKey; return status(); } });
    await settings.load();
    const input = document.getElementById('youtubeApiKeyInput');
    check(input.type === 'password', 'masked API key');
    check(document.getElementById('youtubeRemoveKeyButton').disabled, 'no saved key remove guard');
    input.value = 'test_youtube_key_1234567890';
    document.getElementById('youtubeApiKeyForm').dispatchEvent(new Event('submit', { cancelable: true })); await tick();
    check(key === 'test_youtube_key_1234567890' && input.value === '', 'save key and clear input');
    check(!document.getElementById('youtubeApiKeyStatus').textContent.includes(key), 'no key echoed');
    fail = true; input.value = 'replacement_key_1234567890';
    document.getElementById('youtubeApiKeyForm').dispatchEvent(new Event('submit', { cancelable: true })); await tick();
    check(document.getElementById('youtubeApiKeyStatus').textContent.includes('previous setting'), 'save failure visible');
    check(key === 'test_youtube_key_1234567890', 'failed save preserves key');
    settings.clear(); check(input.value === '', 'closing clears input');
    fail = false; document.getElementById('youtubeRemoveKeyButton').click(); await tick();
    check(key === '' && document.getElementById('youtubeRemoveKeyButton').disabled, 'remove saved key');
    return { passed: true, checks: 8 };
  })()`);
  result.settings = settingsResult;
  writeFileSync(join(output, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
}
