"use strict";
// Exercises the actual phone bundle against local fixtures; no server or credentials are used.
const { resolve, join } = require("node:path");
const { mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const { pathToFileURL } = require("node:url");
const { spawn } = require("node:child_process");
const { WebSocket } = require("ws");
const root = resolve(__dirname, "..");
const output = join(root, "artifacts/companion-polish");
let browser;
let socket;

void run().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => { socket?.close(); browser?.kill(); });

async function run() {
  mkdirSync(output, { recursive: true });
  require("esbuild").buildSync({ entryPoints: [join(root, "src/companion/app.ts")], bundle: true, format: "iife", outfile: join(output, "fixture.js") });
  browser = spawn(process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe", ["--headless=new", "--disable-gpu", "--no-first-run", "--disable-background-networking", "--remote-debugging-port=0", `--user-data-dir=${join(output, "chrome-profile")}`, "about:blank"], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
  const endpoint = await new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error("Chrome startup timed out")), 15000);
    browser.once("error", reject);
    browser.stderr.on("data", chunk => {
      const match = chunk.toString().match(/DevTools listening on (ws:\/\/\S+)/);
      if (match) { clearTimeout(timer); resolvePromise(match[1]); }
    });
  });
  const pages = await (await fetch(`http://127.0.0.1:${new URL(endpoint).port}/json/list`)).json();
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
  await cdp("Emulation.setDeviceMetricsOverride", { width: 320, height: 900, deviceScaleFactor: 1, mobile: true });
  const html = readFileSync(join(root, "src/companion/index.html"), "utf8")
    .replace(/<link[^>]+>/g, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/g, "")
    .replace("</head>", `<style>${readFileSync(join(root, "src/companion/styles.css"), "utf8")}</style></head>`);
  writeFileSync(join(output, "fixture.html"), html);
  await cdp("Page.navigate", { url: pathToFileURL(join(output, "fixture.html")).href });
  await evaluate(`new Promise(resolve => { const check = () => document.getElementById('remote') ? resolve() : setTimeout(check, 20); check(); })`);
  await evaluate(`(() => {
    window.fixture = { mode: 'offline', requests: [], commands: [], pageFails: true, errors: [], sockets: [] };
    addEventListener('error', event => fixture.errors.push(event.message));
    addEventListener('unhandledrejection', event => fixture.errors.push(String(event.reason)));
    const media = { itemRef: 'movie-ref-1234567890', name: 'An Example Movie', type: 'movie', seriesName: null, seasonNumber: null, episodeNumber: null, productionYear: 2026, runtimeTicks: 9000000000, playable: true, artworkRef: null };
    fixture.media = media;
    fixture.state = { protocolVersion: 3,
      player: { protocolVersion: 3, revision: 1, sentAtUnixMs: Date.now(), playbackId: 'playing-id', phase: 'playing', media, live: null, positionTicks: 300000000, durationTicks: 9000000000, playbackRate: 1, paused: false, buffering: false, seekable: false, seekableUntilTicks: null, skipSegment: null, volume: 60, muted: false,
        audioTracks: [{ id: 1, type: 'audio', label: 'English', language: 'eng', selected: true }], subtitleTracks: [],
        controls: { canPlayPause: false, canStop: false, canSeek: false, canPrevious: false, canNext: false, canGoLive: false, canPreviousChannel: false, canNextChannel: false } },
      queue: { revision: 1, editable: true, blockedReason: null, entries: [{ queueEntryId: 'entry-1', state: 'upcoming', media, reserved: false }] },
      watchParty: { joined: false, phase: 'idle', participantCount: 0, minimumParticipants: 2, localSyncOffsetMilliseconds: 0, scheduledStartAtUnixMs: null }, server: { online: true } };
    window.WebSocket = class extends EventTarget {
      static OPEN = 1;
      constructor() { super(); this.readyState = 0; fixture.sockets.push(this); setTimeout(() => { this.readyState = 1; this.dispatchEvent(new Event('open')); }, 0); }
      close() { if (this.readyState === 3) return; this.readyState = 3; queueMicrotask(() => this.dispatchEvent(new Event('close'))); }
      push(topic, payload) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ topic, payload }) })); }
    };
    window.fetch = async (path, init) => {
      fixture.requests.push(path);
      const response = (value, status = 200) => ({ ok: status < 400, status, json: async () => structuredClone(value) });
      if (path.endsWith('/session')) {
        if (fixture.mode === 'offline') throw new TypeError('Failed to fetch');
        if (fixture.mode === 'unauthorized') return response({ error: { message: 'Pair this phone.' } }, 401);
        return response({ protocolVersion: 3, sessionEpoch: 'epoch', csrfToken: 'csrf', nextSequence: fixture.commands.length, webSocketTicket: 'ticket', bootstrap: fixture.state });
      }
      if (path.endsWith('/commands')) { fixture.commands.push(JSON.parse(init.body)); return response({}); }
      if (path.endsWith('/libraries')) return response([{ itemRef: 'library-ref-123456', name: 'Movies', collectionType: 'movies' }]);
      if (path.includes('/library/')) {
        const offset = Number(new URL(path, 'http://fixture').searchParams.get('offset'));
        if (offset && fixture.pageFails) return response({ error: { message: 'Temporary library failure.' } }, 503);
        if (fixture.browseSeries) return response({ revision: 'series', items: [{ ...media, itemRef: 'series-ref-1234567890', name: 'A Long Series', type: 'series', playable: false }], nextOffset: null });
        return response({ revision: 'page-1', items: [{ ...media, itemRef: media.itemRef + offset, name: offset ? 'The Next Movie' : media.name }], nextOffset: offset ? null : 1 });
      }
      if (path.includes('/series/')) {
        if (fixture.seriesFails) return response({ error: { message: 'Episodes could not be loaded from Jellyfin. Please try again.' } }, 503);
        return response({ revision: 'episodes', items: [
          { ...media, itemRef: 'special-ref-1234567890', name: 'A Special', type: 'episode', seriesName: 'A Long Series', seasonNumber: 0, episodeNumber: 3 },
          { ...media, itemRef: 'episode-ref-1234567890', name: 'The First Episode', type: 'episode', seriesName: 'A Long Series', seasonNumber: 1, episodeNumber: 1 },
        ], nextOffset: null });
      }
      if (path.endsWith('/youtube/state')) return response({ searchConfigured: false, room: null });
      if (path.endsWith('/live-tv/guide')) return response({ availability: 'available', message: null, generatedAtUnixMs: Date.now(), channels: [{ channelRef: 'channel-ref', name: 'News and Current Events', number: '12', isPlaying: false, programs: [] }] });
      if (path.endsWith('/pair')) return response({ error: { message: 'The pairing code expired. Create a new one on your desktop.' } }, 400);
      throw new Error('Unmocked request: ' + path);
    };
  })()`);
  await evaluate(readFileSync(join(output, "fixture.js"), "utf8"));
  const results = await evaluate(`(async () => {
    const checks = [];
    const check = (ok, label) => { if (!ok) throw new Error(label); checks.push(label); };
    const el = id => document.getElementById(id);
    const tick = () => new Promise(resolve => setTimeout(resolve, 40));
    await tick();
    check(!el('connectionRecovery').classList.contains('hidden') && el('pairing').classList.contains('hidden'), 'network failure keeps pairing credentials and offers retry');
    fixture.mode = 'online'; el('retryConnection').click(); await tick();
    check(!el('remote').classList.contains('hidden'), 'retry restores remote');
    check(['playPause', 'stop', 'seekBack', 'seekForward', 'previous', 'next'].every(id => el(id).disabled), 'connecting preserves unavailable player controls');
    check(el('subtitleTrack').disabled, 'empty track picker is disabled');
    document.querySelector('[data-view=queue]').click();
    const queueButton = document.querySelector('#queueList button'); queueButton.focus();
    const trackOption = el('audioTrack').options[0];
    fixture.sockets.at(-1).push('server', { contact: true });
    check(document.activeElement === queueButton && queueButton.isConnected, 'heartbeat preserves queue keyboard focus');
    check(el('audioTrack').options[0] === trackOption, 'heartbeat preserves track options');
    window.dispatchEvent(new Event('offline'));
    check(el('seek').matches(':disabled') && queueButton.matches(':disabled'), 'offline state disables input and button controls');
    fixture.sockets.at(-1).push('server', { contact: true });
    check(!el('remoteControls').disabled && el('playPause').disabled, 'heartbeat recovers without enabling unavailable actions');
    document.querySelector('[data-view=player]').click();
    fixture.state.player.controls.canSeek = true; fixture.sockets.at(-1).push('player', fixture.state.player);
    el('seek').dispatchEvent(new PointerEvent('pointerdown')); el('seek').value = '800000000'; el('seek').dispatchEvent(new Event('input'));
    fixture.state.player.positionTicks = 400000000; fixture.sockets.at(-1).push('player', fixture.state.player);
    check(el('seek').value === '800000000', 'playback updates preserve an in-progress seek gesture');
    el('seek').dispatchEvent(new Event('change')); await tick();
    check(fixture.commands.at(-1).command.positionTicks === 800000000, 'seek sends the position chosen by the user');
    document.querySelector('[data-view=browse]').click(); await tick();
    check(document.querySelectorAll('#browseList article').length === 1, 'library browse loads');
    el('browseMore').click(); await tick();
    check(document.querySelectorAll('#browseList article').length === 1 && !el('browseMore').classList.contains('hidden'), 'paging error retains results and a retry button');
    fixture.pageFails = false; el('browseMore').click(); await tick();
    check(document.querySelectorAll('#browseList article').length === 2, 'paging retry appends the missing page');
    fixture.browseSeries = true; fixture.seriesFails = true;
    document.querySelector('#libraryTabs button').click(); await tick();
    const episodes = document.querySelector('#browseList button'); episodes.focus(); episodes.click(); await tick();
    const episodeRetry = document.querySelector('#browseList button');
    check(episodeRetry?.getAttribute('aria-label') === 'Retry episodes of A Long Series'
      && !el('browseBack').classList.contains('hidden') && el('browseMore').classList.contains('hidden'), 'episode failure keeps series context and offers a direct retry');
    check(document.activeElement === episodeRetry && !el('remoteControls').disabled, 'episode failure retains usable phone connection and restores keyboard focus');
    fixture.seriesFails = false; episodeRetry.click(); await tick();
    check(document.querySelectorAll('#browseList article').length === 2
      && el('browseStatus').textContent === 'A Long Series · 2 episodes', 'retry loads the same series without reopening Browse');
    check(el('browseList').textContent.includes('Special E3') && el('browseList').textContent.includes('S1 E1'), 'episode cards distinguish specials and season numbers');
    check(document.activeElement === document.querySelector('#browseList button'), 'successful episode retry restores focus to the first available action');
    document.querySelector('#browseList button').click(); await tick();
    check(fixture.commands.at(-1).command.itemRef === 'special-ref-1234567890', 'episode playback still uses the opaque selected episode reference');
    fixture.browseSeries = false; el('browseBack').click(); await tick();
    for (const zoom of [100, 200]) {
      document.documentElement.style.fontSize = zoom + '%';
      for (const view of ['player', 'queue', 'browse', 'youtube', 'liveTv', 'settings']) {
        document.querySelector('[data-view=' + view + ']').click(); await tick();
        check(document.documentElement.scrollWidth <= 321, view + ' fits 320px at ' + zoom + '% text zoom (' + document.documentElement.scrollWidth + 'px)');
      }
    }
    document.documentElement.style.fontSize = '100%';
    fixture.mode = 'offline'; window.dispatchEvent(new Event('online')); await tick();
    check(!el('remote').classList.contains('hidden') && el('pairing').classList.contains('hidden') && el('remoteControls').disabled, 'temporary disconnect preserves the current remote view');
    fixture.mode = 'online'; window.dispatchEvent(new Event('online')); await tick();
    check(!el('remoteControls').disabled, 'connection recovers after desktop returns');
    fixture.mode = 'unauthorized'; window.dispatchEvent(new Event('online')); await tick();
    check(!el('pairing').classList.contains('hidden'), 'revoked pairing explicitly shows pairing form');
    el('pairForm').dispatchEvent(new Event('submit', { cancelable: true }));
    check(el('pairError').textContent.includes('8-digit'), 'empty pairing code receives useful validation');
    el('pairCode').value = '12345678'; el('pairForm').dispatchEvent(new Event('submit', { cancelable: true })); await tick();
    check(!el('pairSubmit').disabled && el('pairError').textContent.includes('expired'), 'failed pairing preserves error and permits retry');
    check(fixture.errors.length === 0, 'no uncaught browser errors: ' + fixture.errors.join(', '));
    return checks;
  })()`);
  await evaluate(`(async () => {
    fixture.mode = 'online'; fixture.state.player.controls.canPlayPause = true; fixture.state.player.controls.canStop = true;
    window.dispatchEvent(new Event('online'));
    await new Promise(resolve => setTimeout(resolve, 40));
    document.querySelector('[data-view=player]').click();
  })()`);
  const screenshot = await cdp("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  writeFileSync(join(output, "phone-320.png"), Buffer.from(screenshot.data, "base64"));
  writeFileSync(join(output, "result.json"), JSON.stringify({ passed: results.length, checks: results }, null, 2));
  console.log(JSON.stringify({ passed: results.length, checks: results, screenshot: join(output, "phone-320.png") }, null, 2));
}
