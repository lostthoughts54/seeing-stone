"use strict";
const { resolve, join } = require("node:path");
const { mkdirSync, readFileSync, writeFileSync, readdirSync } = require("node:fs");
const { pathToFileURL } = require("node:url");
const root = resolve(__dirname, "..");
const output = join(root, "artifacts/player-features-ui");

if (!process.versions.electron) {
  mkdirSync(output, { recursive: true });
  require("esbuild").buildSync({ entryPoints: [join(root, "src/renderer/playerFeatures.ts")], bundle: true, format: "iife", globalName: "FeatureRoomUI", outfile: join(output, "fixture.js") });
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const result = require("node:child_process").spawnSync(require("electron"), [__filename, "--fixture-child"], { env, windowsHide: true, timeout: 45000, stdio: "inherit" });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} else {
  void run().catch(error => { console.error(error); require("electron").app.exit(1); });
}

async function run() {
  const { app, BrowserWindow } = require("electron");
  if (!process.argv.includes("--fixture-child")) throw new Error("Fixture wrapper required.");
  app.disableHardwareAcceleration(); app.commandLine.appendSwitch("disable-gpu");
  app.setPath("userData", join(output, "electron-profile"));
  await app.whenReady();
  const window = new BrowserWindow({ show: false, width: 1280, height: 1000, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
  // This fixture never contacts a Jellyfin server or YouTube.
  window.webContents.session.webRequest.onBeforeRequest({ urls: ["https://*/*", "http://*/*"] }, (_details, callback) => callback({ cancel: true }));
  const css = readdirSync(join(root, "dist/renderer/assets")).find(name => name.endsWith(".css"));
  const html = `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="${pathToFileURL(join(root, "dist/renderer/assets", css))}"><style>body{overflow:auto;padding:24px;background:#080f18;color:white}#watch{max-width:1150px;margin:auto}#playerView{position:static;display:block}#sessionPanel{position:static;width:380px;height:900px;display:flex;flex-direction:column;margin-left:auto}.is-hidden{display:none!important}</style></head><body><main id="watch"></main><section id="playerView" class="is-hidden"><aside id="sessionPanel" class="session-panel"><header>Player session</header><div class="session-panel-tabs">Existing tabs</div><div id="sessionPanelContent">Existing content</div></aside></section></body></html>`;
  writeFileSync(join(output, "fixture.html"), html);
  await window.loadFile(join(output, "fixture.html"));
  await window.webContents.executeJavaScript(`(() => {
    const player = document.getElementById('playerView');
    const video = document.createElement('section'); video.id = 'playerFrame'; video.className = 'seeing-frame';
    video.style.cssText = 'width:780px;height:440px;position:absolute;left:24px;top:24px;background:radial-gradient(ellipse at center,#27374c,#060a12);';
    video.innerHTML = '<div style="padding:24px;color:#bcb4cc">The Shattered Vale · Watch party</div>';
    const controls = document.createElement('div'); controls.id = 'playerControls'; controls.innerHTML = '<div class="player-options"></div>';
    controls.style.cssText = 'position:absolute;left:24px;top:480px'; player.prepend(video, controls);
  })()`);
  await window.webContents.executeJavaScript(`(() => {
    const media = { kind: 'jellyfin', itemId: '1'.repeat(32), mediaSourceId: 'source', title: 'The Shattered Vale — Episode 4', durationTicks: 36000000000, version: 'fixture' };
    window.fixtureState = { connection: 'connected', error: null, rooms: [], local: { preparation: 'Video and subtitle tracks loaded', issue: null, delivery: 'Downloaded copy', subtitles: 3, delaySeconds: 0.4, downloads: '' }, room: {
      id: 'a'.repeat(32), name: 'Friday movie night', serverNow: Date.now(), owner: true, hostOnly: false, waitForAll: true, minimumParticipants: 2, autoNext: true,
      timeline: { version: 1, generation: 1, positionTicks: 0, playing: false, anchoredAt: Date.now(), startAt: null, nextAt: null, phase: 'waiting', targetRevision: 1 }, media,
      queue: [{ id: 'b'.repeat(32), media, addedBy: 'Alice', votes: 2, voted: true }],
      members: [{ id: 'c'.repeat(32), name: 'Alice', host: true, state: 'paused', ready: true, connected: true, source: 'Downloaded copy' }, { id: 'd'.repeat(32), name: 'Bob', host: false, state: 'buffering', ready: false, connected: true, source: 'Direct play' }],
      messages: [{ id: 'e'.repeat(32), author: 'Bob', kind: 'chat', text: '<img src=x onerror=alert(1)>', positionTicks: null }], events: [{ id: 'f'.repeat(32), at: Date.now(), text: 'Waiting for participants to recover.' }]
    }};
    window.fixtureCalls = [];
    window.jellyfin = { playerFeatures: {
      subscribe(listener) { window.fixtureRender = listener; queueMicrotask(() => listener(window.fixtureState)); return () => {}; },
      async command(input) { window.fixtureCalls.push(input); return window.fixtureState; }
    }, search: { async query() { return []; } } };
  })()`);
  await window.webContents.executeJavaScript(readFileSync(join(output, "fixture.js"), "utf8"));
  await window.webContents.executeJavaScript("FeatureRoomUI.mountPlayerFeatures(document.getElementById('watch'))");
  const switching = await window.webContents.executeJavaScript(`(async () => {
    const delay = () => new Promise(r => setTimeout(r, 20));
    await delay();
    const panel = document.querySelector('.player-features');
    const url = panel.querySelector('[data-role=url]');
    url.value = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
    url.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await delay();
    const watchNow = window.fixtureCalls.some(c => c.operation === 'watch-now' && c.kind === 'youtube' && c.itemId === 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    const cleared = url.value === '';
    const movie = window.fixtureState.room.media;
    window.fixtureState.room.media = { kind: 'youtube', itemId: 'dQw4w9WgXcQ', title: 'Trailer', version: 'yt', durationTicks: 0, mediaSourceId: null };
    window.fixtureState.room.queue.unshift({ id: '1'.repeat(32), media: window.fixtureState.room.media, addedBy: 'Alice', votes: 0, voted: false });
    window.fixtureState.room.timeline.generation++;
    window.fixtureRender(window.fixtureState);
    const back = panel.querySelector('[data-command=return-jellyfin]');
    const backVisible = !back.hidden && back.textContent.includes(movie.title);
    back.click(); await delay();
    const backIntent = window.fixtureCalls.some(c => c.operation === 'action' && c.action.action === 'watch-item' && c.action.queueItemId === 'b'.repeat(32));
    window.fixtureState.room.hostOnly = true; window.fixtureState.room.owner = false; window.fixtureRender(window.fixtureState);
    const hostPolicy = back.disabled && panel.querySelector('[data-command=youtube-watch]').disabled;
    window.fixtureState.room.hostOnly = false; window.fixtureState.room.owner = true;
    window.fixtureState.room.media = movie; window.fixtureState.room.queue.shift(); window.fixtureState.room.timeline.generation++;
    window.fixtureRender(window.fixtureState);
    const noBackForMovie = back.hidden;
    window.jellyfin.search.query = async () => [{ id: '2'.repeat(32), name: 'A movie to watch', type: 'Movie' }];
    panel.querySelector('[data-role=search]').value = 'movie';
    panel.querySelector('[data-command=search]').click(); await delay();
    [...panel.querySelectorAll('[data-role=results] button')].find(b => b.textContent === 'Watch now').click(); await delay();
    const libraryWatch = window.fixtureCalls.some(c => c.operation === 'watch-now' && c.kind === 'jellyfin' && c.itemId === '2'.repeat(32));
    panel.querySelector('[data-role=search]').value = ''; panel.querySelector('[data-role=results]').replaceChildren();
    const original = window.jellyfin.playerFeatures.command;
    window.jellyfin.playerFeatures.command = async () => { throw new Error('Switch failed'); };
    url.value = 'https://www.youtube.com/watch?v=9bZkp7q19f0'; panel.querySelector('[data-command=youtube-watch]').click(); await delay();
    const retainedOnError = url.value.includes('9bZkp7q19f0') && panel.querySelector('[data-role=status]').textContent === 'Switch failed';
    window.jellyfin.playerFeatures.command = original; url.value = ''; window.fixtureState.room.timeline.generation = 1; window.fixtureRender(window.fixtureState);
    return { watchNow, cleared, backVisible, backIntent, hostPolicy, noBackForMovie, retainedOnError, libraryWatch };
  })()`);
  const result = await window.webContents.executeJavaScript(`(async () => {
    await new Promise(r => setTimeout(r, 150));
    const panel = document.querySelector('.player-features');
    const input = panel.querySelector('[data-role=message]'); input.value = 'My unsent draft'; input.focus();
    window.fixtureRender(window.fixtureState);
    const preserved = input.value === 'My unsent draft' && document.activeElement === input;
    const escaped = !panel.querySelector('[data-role=messages] img') && panel.querySelector('[data-role=messages]').textContent.includes('<img');
    panel.querySelector('[data-action=play]').click(); await new Promise(r => setTimeout(r, 10));
    const playbackIntent = window.fixtureCalls.some(c => c.operation === 'action' && c.action.action === 'play');
    return { preserved, escaped, playbackIntent, desktopOverflow: document.documentElement.scrollWidth > innerWidth };
  })()`);
  await window.webContents.executeJavaScript("window.scrollTo(0, 0)");
  writeFileSync(join(output, "room-desktop.png"), (await window.webContents.capturePage()).toPNG());
  const player = await window.webContents.executeJavaScript(`(async () => {
    document.getElementById('watch').hidden = true; document.getElementById('playerView').classList.remove('is-hidden');
    await new Promise(r => setTimeout(r, 150));
    const slot = document.querySelector('.feature-player-slot');
    return { moved: !!slot.querySelector('.player-features'), visible: slot.getBoundingClientRect().height > 0 && getComputedStyle(slot).display !== 'none', overflow: slot.scrollWidth > slot.clientWidth + 1 };
  })()`);
  writeFileSync(join(output, "room-player-panel.png"), (await window.webContents.capturePage()).toPNG());
  const reactions = await window.webContents.executeJavaScript(`(async () => {
    const delay = ms => new Promise(r => setTimeout(r, ms));
    const add = (id, text = '👏') => {
      window.fixtureState.room.messages.push({ id, author: 'Bob', kind: 'reaction', text, createdAt: Date.now(), generation: 1, positionTicks: null });
      window.fixtureState.room.serverNow = Date.now(); window.fixtureRender(window.fixtureState);
    };
    const count = () => document.querySelectorAll('#playerFrame .party-reaction-burst').length;
    add('r1');
    const received = count() === 1;
    window.fixtureRender(window.fixtureState);
    const noReplay = count() === 1;
    document.querySelector('#playerControls summary').click();
    document.querySelector('#playerControls [data-reaction]').click(); await delay(20);
    const pickerBounds = document.querySelector('#playerControls .party-reaction-picker').getBoundingClientRect();
    const pickerVisible = pickerBounds.left >= 0 && pickerBounds.right <= innerWidth;
    const sent = window.fixtureCalls.filter(c => c.kind === 'reaction').length === 1;
    const cooldown = document.querySelector('#playerControls [data-reaction]').disabled;
    document.querySelector('#playerControls .party-reaction-toggle').click(); add('r2');
    const hidden = count() === 0;
    document.querySelector('#playerControls .party-reaction-toggle').click();
    window.fixtureRender(window.fixtureState);
    const noReplayAfterToggle = count() === 0;
    for (let i = 0; i < 12; i++) add('burst' + i, ['👏', '❤️', '😂', '🔥'][i % 4]);
    const bounded = count() === 8;
    await delay(350);
    return { received, noReplay, sent, cooldown, hidden, noReplayAfterToggle, bounded, pickerVisible };
  })()`);
  writeFileSync(join(output, "room-reactions.png"), (await window.webContents.capturePage()).toPNG());
  const cleanup = await window.webContents.executeJavaScript(`(async () => {
    await new Promise(r => setTimeout(r, 2900));
    const expired = document.querySelectorAll('.party-reaction-burst').length === 0;
    const saved = window.fixtureState.room;
    window.fixtureState.room = null; window.fixtureRender(window.fixtureState);
    const left = document.querySelector('#playerControls .party-reaction-menu').hidden;
    window.fixtureState.room = saved; window.fixtureRender(window.fixtureState);
    const noReplayOnRejoin = document.querySelectorAll('.party-reaction-burst').length === 0;
    window.fixtureState.connection = 'reconnecting'; window.fixtureRender(window.fixtureState);
    const offlineDisabled = document.querySelector('#playerControls [data-reaction]').disabled;
    window.fixtureState.connection = 'connected'; window.fixtureRender(window.fixtureState);
    window.jellyfin.playerFeatures.command = async () => { throw new Error('Fixture failure'); };
    document.querySelector('#playerControls [data-reaction]').click(); await new Promise(r => setTimeout(r, 20));
    const sendError = document.querySelector('#playerControls .party-reaction-status').textContent.includes('could not be sent');
    window.fixtureState.room.media = { ...saved.media, kind: 'youtube', itemId: 'dQw4w9WgXcQ' };
    window.fixtureState.room.timeline.generation = 2; window.fixtureRender(window.fixtureState);
    window.fixtureState.room.messages.push({ id: 'youtube-reaction', author: 'Alice', kind: 'reaction', text: '❤️', createdAt: Date.now(), generation: 2, positionTicks: null });
    window.fixtureState.room.serverNow = Date.now(); window.fixtureRender(window.fixtureState);
    const youtubeOverlay = document.querySelectorAll('[data-role=youtube-surface] .party-reaction-burst').length === 1;
    return { expired, left, noReplayOnRejoin, offlineDisabled, sendError, youtubeOverlay };
  })()`);
  const report = { ...result, ...player, reactions, cleanup, switching };
  writeFileSync(join(output, "result.json"), JSON.stringify(report, null, 2));
  if (!report.preserved || !report.escaped || !report.playbackIntent || !report.moved || !report.visible || report.overflow || report.desktopOverflow) throw new Error(JSON.stringify(report));
  if (![...Object.values(reactions), ...Object.values(cleanup)].every(Boolean)) throw new Error(JSON.stringify(report));
  if (!Object.values(switching).every(Boolean)) throw new Error(JSON.stringify(report));
  console.log("Player Features UI fixture passed:", report); app.exit(0);
}
